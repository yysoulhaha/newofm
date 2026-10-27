#!/usr/bin/env bun
/**
 * newofm v1.0.0 —— OpenAI 兼容的本地网关，把 opencode.ai 的匿名免费模型
 * 车道包装成标准 /v1/chat/completions 接口，供任意 OpenAI 客户端直接调用。
 *
 * 设计参考（按贡献排序）：
 *   - azrinaldi/opencode-free-bridge   身份推导、目录模型、403/429 自愈
 *   - FishBottle7/opencode2dsh         门禁消融数据、会话 id 形态
 *   - TiaraBasori/OpenCode2API         多协议网关形态
 *
 * ════════════════════════════════════════════════════════════════════
 * 上游的四个准入条件（任一不满足即被拒，且错误消息刻意与"额度耗尽"一致）
 * ════════════════════════════════════════════════════════════════════
 *   1. TLS 指纹：客户端必须是 Bun 运行时（1.4.x 的 ClientHello 与官方 CLI
 *      的 BoringSSL 一致）。Node / Python / curl 一律 403 —— 这正是本文件
 *      用 Bun 而不是 Python 的根本原因。
 *   2. 会话标识：user-agent 形如 opencode/<channel>/<version>/cli；
 *      x-opencode-session 与 x-session-affinity 同值，形如
 *      ses_[0-9a-f]{12}[0-9A-Za-z]{14}；前 12 hex 必须是官方时间戳算法
 *      生成的形态（位反转时间戳 + 同毫秒计数器，计数器 1..63）。
 *      随机前缀会被拒。
 *   3. 工具锚点：tools 数组里必须有名为 read 和 shell 的函数。只校验名字，
 *      不校验 description / schema —— 空 schema 的占位工具即可通过。
 *   4. 系统提示：必须是 CLI 那份完整 harness 提示词原文（末尾自带 <env>
 *      块与 "Working directory:" 行）。只发 env 块、或换成通用助手提示，
 *      同样会被回一个与额度耗尽一字不差的错误。模板见 harness_prompt.js。
 *
 * 端点：GET /health · GET /v1/models · POST /v1/chat/completions（流式+非流式）
 * 默认端口 8920，只绑 127.0.0.1。
 *
 * 性质：本项目基于对公开可观测行为的黑盒研究，用于学习与个人研究。
 */

import { createHash, randomFillSync } from "node:crypto";
import * as http from "node:http";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync, readdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { HARNESS_SYSTEM_TEMPLATE, HARNESS_MARKER } from "./harness_prompt.js";

// ────────────────────────────────────────────────────────────────
// 0. 全局配置（环境变量可覆盖）
// ────────────────────────────────────────────────────────────────

const VERSION = "1.0.0";
const PORT = parseInt(process.env.NEWOFM_PORT || "8920", 10);
const HOST = process.env.NEWOFM_HOST || "127.0.0.1";

// 上游出口代理。上游按出口 IP 划分额度和区域，走代理能改变出口；
// 默认指向常见的本地 Clash 混合端口，直连环境设为空串即可。
const UPSTREAM_PROXY = (process.env.UPSTREAM_PROXY_URL || "http://127.0.0.1:7897").trim() || null;

// 请求中声明的 CLI 版本号。上游只校验"带版本号"这一形状（opencode/9.9.9 也放行），
// 填你实际使用的 CLI 版本即可；可随时用环境变量覆盖。
const CLI_VERSION = process.env.NEWOFM_CLI_VERSION || "2.1.4";
const APP_CHANNEL = "latest";
const APP_NAME = "cli"; // 实测 2.1.4 CLI 的 UA 第四段是 cli（不是 opencode）

// 上游地址。注意：权威值来自目录里 opencode provider 的 `api` 字段
// （今天 = https://opencode.ai/inference/openai/v1，旧 /zen/v1 已迁移），
// refreshCatalog 抓到目录后会按它改写下面三个地址——上游再迁移时
// 不用改代码。环境变量是"目录抓不到"时的兜底。
const CATALOG_PROVIDER_ID = process.env.CATALOG_PROVIDER_ID || "opencode";
let UPSTREAM_CHAT_URL =
  process.env.UPSTREAM_CHAT_URL || "https://opencode.ai/inference/openai/v1/chat/completions";
let UPSTREAM_MODELS_URL =
  process.env.UPSTREAM_MODELS_URL || "https://opencode.ai/inference/openai/v1/models";
const CATALOG_URL =
  process.env.CATALOG_URL || "https://models.opencode.ai/api.json";

// 匿名车道的钥匙就是字面量 "public"（参考项目实测，无账号无密钥）。
const UPSTREAM_AUTH = "Bearer public";

const CACHE_DIR =
  (process.env.NEWOFM_CACHE_DIR || "").trim() ||
  join(homedir(), ".newofm");
const CATALOG_CACHE_FILE = join(CACHE_DIR, "catalog.json");
const CATALOG_TTL_MS = 6 * 3600 * 1000; // 目录缓存 6 小时
const UPSTREAM_TIMEOUT_MS = parseInt(process.env.UPSTREAM_TIMEOUT_MS || "120000", 10);
// 超时分层：响应头阶段 vs 流空闲阶段。
// 旧实现只用一条 120s 的总超时，长回答会在流中途被掐（表现为客户端"用户已取消"）。
const UPSTREAM_HEADERS_TIMEOUT_MS = parseInt(
  process.env.UPSTREAM_HEADERS_TIMEOUT_MS || String(UPSTREAM_TIMEOUT_MS),
  10,
);
const UPSTREAM_IDLE_TIMEOUT_MS = parseInt(process.env.UPSTREAM_IDLE_TIMEOUT_MS || "300000", 10);
const MAX_BODY_BYTES = parseInt(process.env.MAX_BODY_BYTES || String(10 * 1024 * 1024), 10);
// 车道 B：官方 CLI 身份车道（伪造车道 429 时兜底）。
// ⚠ 明文捕获**修正**了旧结论：额度主键不是"传输层身份
// 指纹"——同一出口同一刻，官方原始字节 200、而形状不全的请求 429（缺
// shell / 短 system），换新 session id 同样 200。门禁 = 纯形状 + 出口 IP
// 分桶，无挑战应答、无会话注册、无时间戳新鲜度校验（48h 旧 id 也 200）。
const LANE_B_URL = process.env.NEWOFM_LANEB_URL || "";
const GATE_RETRY_COOLDOWN_MS = parseInt(process.env.GATE_RETRY_COOLDOWN_MS || "30000", 10);
const __dirname = dirname(fileURLToPath(import.meta.url));

// ────────────────────────────────────────────────────────────────
// 1. 身份推导（门禁 2/3/4 的落地）
// ────────────────────────────────────────────────────────────────

const SESSION_PREFIX = "ses_";
const SESSION_CHARSET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const SESSION_LENGTH = 26; // 12 hex + 14 base62，与官方 CLI 同构
const SESSION_HEX_CHARS = 12;
const SESSION_MULTIPLIER = 0x1000n; // 官方 session id 的时间戳乘子

/**
 * 造一个合规 session id：ses_<12 hex><14 base62>。
 * ⭐ 12 hex = ~(timestamp × 0x1000 + k) 的低 48 位，k = 同毫秒内递增计数器、
 * **从 1 起**（实测定案：官方 CLI 真实值低 12 位是 0xfff-k
 *（抓包 4ffe；参考桥 effe/5ffe/1ffe/0ffe），k=0 即低 12 位恒 0xfff 的值在
 * 真实空间不存在，门禁以 FreeUsageLimitError 伪装拒绝——此前全天 429 的真因）。
 * 14 位 base62 随机。timestamp / rng 可注入，便于确定性测试。
 */
let __sidLastTs = 0;
let __sidCounter = 0;
/** 同毫秒计数器上限 = 63（2dsh issue #62 实测互证）：
 *  门禁会把 12 hex 反转回「原始计数器」并只接受 [0,63]（即反转后低 12 位
 *  落在 0xfc0..0xfff）。此前写 100，k∈[64,100] 时反转值 0xfbf..0xf9c 会
 *  越界 → 被伪装成 429。超限改为进位到下一毫秒（extraMs）。 */
const SID_MAX_COUNTER_PER_MS = 63;
function createSessionId(opts = {}) {
  const timestamp = Math.floor(opts.timestamp ?? Date.now());
  const rng = opts.rng ?? Math.random;
  if (timestamp !== __sidLastTs) {
    __sidLastTs = timestamp;
    __sidCounter = 0;
  }
  __sidCounter++;
  const extraMs = Math.floor((__sidCounter - 1) / SID_MAX_COUNTER_PER_MS);
  const k = ((__sidCounter - 1) % SID_MAX_COUNTER_PER_MS) + 1;
  const current = BigInt(timestamp + extraMs) * SESSION_MULTIPLIER + BigInt(k);
  const descending = ~current; // 官方用递减序，新的 session 排前面
  const mask = (1n << 48n) - 1n;
  const hex = (descending & mask).toString(16).padStart(SESSION_HEX_CHARS, "0");
  let tail = "";
  for (let i = 0; i < SESSION_LENGTH - SESSION_HEX_CHARS; i++) {
    tail += SESSION_CHARSET[Math.floor(rng() * SESSION_CHARSET.length)];
  }
  return SESSION_PREFIX + hex + tail;
}

const SESSION_SHAPE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

/** n 位 base62 随机串（x-opencode-request 的 msg_ 后缀用）。 */
function randomId(n) {
  let out = "";
  for (let i = 0; i < n; i++) {
    out += SESSION_CHARSET[Math.floor(Math.random() * SESSION_CHARSET.length)];
  }
  return out;
}

/** n 字符小写十六进制随机串（b3 / traceparent 的 trace-id、span-id 用）。 */
function randomHex(n) {
  const buf = Buffer.alloc(Math.ceil(n / 2));
  randomFillSync(buf);
  return buf.toString("hex").slice(0, n);
}

/** n 位小写十六进制随机串（b3 / traceparent 的 trace-id、span-id 用）。 */
function randomHex(n) {
  let out = "";
  for (let i = 0; i < n; i++) {
    out += "0123456789abcdef"[Math.floor(Math.random() * 16)];
  }
  return out;
}

/**
 * 会话亲和：同一段对话（首个 user 消息）永远得到同一个 session id，
 * 上游 prompt-cache 才能命中。
 * ⚠ 前缀必须走官方算法（createSessionId 的递减时间戳 × 0x1000）：bun
 * 消融实测「前 12 hex 换成随机 → 429」——门禁认得官方时间戳形态的前缀
 * （真实 session 全在 e8/e9 邻域），sha256 派生值（如 21db…）一看就是
 * 假的。首次见到某对话时按官方算法分配一个并记入 Map，之后复用
 * （与官方 CLI 的会话持久化同构：session 创建后不变）。
 * opts.store / opts.timestamp / opts.rng 可注入，便于确定性测试。
 */
const conversationSessions = new Map(); // sha256(首条 user 消息) 前 16 位 → session id
const CONVERSATION_SESSION_CAP = 512; // 防无限增长；超限整批清退（等同重启重来）

/** 会话映射持久化（2dsh 实证互证）：
 *  上游把免费额度与 prompt cache 都按 session 分组（2dsh docs/ids.ts 明写），
 *  映射只存内存的话，每次重启都让所有进行中的对话换新 session → 亲和性
 *  丢失 + prompt cache 全冷（今日 19:58 两次重启即发生）。
 *  落盘 ~/.newofm/conversation_sessions.json（0600，rename 原子写，1s 合并）。 */
const CONVERSATION_SESSIONS_FILE = join(CACHE_DIR, "conversation_sessions.json");
let convSaveTimer = null;
function loadConversationSessions() {
  try {
    const raw = JSON.parse(readFileSync(CONVERSATION_SESSIONS_FILE, "utf8"));
    for (const pair of raw.sessions || []) {
      if (Array.isArray(pair) && typeof pair[0] === "string" && SESSION_SHAPE.test(pair[1])) {
        conversationSessions.set(pair[0], pair[1]);
      }
    }
    if (conversationSessions.size) {
      console.log(`[newofm] 会话映射已载入：${conversationSessions.size} 条`);
    }
  } catch (err) {
    if (err && err.code !== "ENOENT") {
      console.error("[newofm] 会话映射载入失败（忽略）：", err.message);
    }
  }
}
function saveConversationSessions() {
  if (convSaveTimer) return;
  convSaveTimer = setTimeout(() => {
    convSaveTimer = null;
    try {
      const sessions = [...conversationSessions.entries()].slice(-CONVERSATION_SESSION_CAP);
      const body = JSON.stringify({ savedAt: Date.now(), sessions });
      const tmp = `${CONVERSATION_SESSIONS_FILE}.${process.pid}.tmp`;
      writeFileSync(tmp, body, { mode: 0o600 });
      renameSync(tmp, CONVERSATION_SESSIONS_FILE);
    } catch (err) {
      console.error("[newofm] 会话映射落盘失败（忽略）：", err && err.message);
    }
  }, 1000);
}
function sessionFromConversation(text, opts = {}) {
  const store = opts.store instanceof Map ? opts.store : conversationSessions;
  const key = createHash("sha256").update(String(text ?? ""), "utf8").digest("hex").slice(0, 16);
  const hit = store.get(key);
  if (hit) return hit;
  const id = createSessionId({ timestamp: opts.timestamp, rng: opts.rng });
  if (store.size >= CONVERSATION_SESSION_CAP) store.clear();
  store.set(key, id);
  if (!opts.store) saveConversationSessions(); // 只有生产存储才落盘
  return id;
}

/** 工作目录的项目指纹（官方 CLI 按项目哈希发此头；上游不校验其值）。
 *  口径：sha1("directory:" + cwd)。 */
function projectHash(cwd = process.cwd()) {
  return createHash("sha1").update("directory:" + cwd, "utf8").digest("hex");
}

/** b3 traceId 的会话稳定性（官方抓包定案）：官方 CLI 同一会话内
 *  复用同一个 traceId（spanId 每请求新造），此前每请求新造 traceId 是形状
 *  差异。按 sessionId 缓存，行为对齐官方。 */
const traceIdBySession = new Map();
function traceIdFor(sessionId) {
  let t = traceIdBySession.get(sessionId);
  if (!t) {
    t = randomHex(32);
    if (traceIdBySession.size > 5000) traceIdBySession.clear();
    traceIdBySession.set(sessionId, t);
  }
  return t;
}

/**
 * 组装上游请求头。头名与顺序对齐官方 CLI 的真实请求：Authorization / Content-Type / User-Agent / b3 /
 * traceparent / x-opencode-client / x-opencode-project / x-opencode-session /
 * x-opencode-session-id / x-session-affinity / x-session-id —— 共 11 个业务
 * 头。⚠️ 官方不发 x-opencode-request（已删）；b3 的 traceId 同会话稳定。
 * 三个门禁锚点（user-agent / x-opencode-session / x-session-affinity）在场。
 */
function buildHeaders(sessionId, opts = {}) {
  const version = opts.version || CLI_VERSION;
  const project = opts.project || projectHash();
  const traceId = opts.traceId || traceIdFor(sessionId);
  const spanId = randomHex(16);
  return {
    "user-agent": `opencode/${APP_CHANNEL}/${version}/${APP_NAME}`,
    "x-opencode-session": sessionId,
    "x-opencode-session-id": sessionId,
    "x-session-affinity": sessionId,
    "x-session-id": sessionId, // 必须小写：CLI 与参考桥的线上字节都是小写，大写被网关 429
    "x-opencode-client": "cli",
    "x-opencode-project": project,
    b3: `${traceId}-${spanId}-1-${randomHex(16)}`,
    traceparent: `00-${traceId}-${spanId}-01`,
    authorization: UPSTREAM_AUTH,
  };
}

/** 门禁锚点声明（供 /health 观测与自检）。
 *  注意 tools 是两个：实测（抓包 + 两个参考项目互证）当前门禁
 *  要求 read 和 shell 两个函数名在场。历史上还要求过 bash（dsh 项目
 *  2026-09 消融结论），bash 在 2.x 已改名 shell；read 一直没变。 */
const GATE_ANCHORS = {
  tools: ["read", "shell"],
  headers: ["user-agent", "x-opencode-session", "x-session-affinity"],
};

// 工具锚点：只查名（空 schema 的假 read 也能过门禁），但用官方 CLI 抓包
// 拿到的真实定义，降低模型无故调用它们的概率。
const READ_TOOL_STUB = Object.freeze({
  type: "function",
  function: Object.freeze({
    name: "read",
    description:
      "Read the contents of a file or directory. Supports text files, images, and PDFs. " +
      "Images and PDFs are presented directly to the model. Each text line is prefixed " +
      "by its 1-based line number as <line>: <content>.",
    parameters: Object.freeze({
      type: "object",
      properties: Object.freeze({
        path: Object.freeze({ type: "string", description: "File or directory to read" }),
        offset: Object.freeze({
          type: "integer",
          minimum: 0,
          description: "The line or directory entry to start reading from (1-based)",
        }),
        limit: Object.freeze({
          type: "integer",
          minimum: 0,
          description:
            "The maximum number of lines or directory entries to read (defaults to and capped at 2000)",
        }),
      }),
      required: Object.freeze(["path"]),
      additionalProperties: false,
    }),
  }),
});

const SHELL_TOOL_STUB = Object.freeze({
  type: "function",
  function: Object.freeze({
    name: "shell",
    description:
      "Execute a shell command and return its output. Commands run on Linux using bash. " +
      "Quote file paths containing spaces or special characters. Prefer dedicated tools " +
      "over shell commands when possible. When output is large, the full result is saved " +
      "to a file and a truncated preview is returned. Rely on automatic truncation unless " +
      "filtering the output is more useful. Commands accept an optional timeout, background " +
      "commands have no timeout by default. Background commands return immediately, and " +
      "you will be notified when they complete.",
    parameters: Object.freeze({
      type: "object",
      properties: Object.freeze({
        command: Object.freeze({ type: "string", description: "Shell command string to execute" }),
        workdir: Object.freeze({
          type: "string",
          description:
            "Working directory to execute the command in. Defaults to the current working directory.",
        }),
        timeout: Object.freeze({
          type: "integer",
          minimum: 0,
          description: "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000.",
        }),
        background: Object.freeze({
          type: "boolean",
          description:
            "Run the command in the background and return immediately. DO NOT poll for completion.",
        }),
      }),
      required: Object.freeze(["command"]),
      additionalProperties: false,
    }),
  }),
});

/** 锚点名 → stub 定义（缺哪个补哪个）。 */
// 权威锚点工具定义：从一次成功请求的 dump 逐字节提取，落盘在
// tools/gate_tools_core.json。
// ⚠ 不要手改这个 JSON：function 级 strict:false 与完整 description 都是
// 准入形状的一部分——截断版（缺 strict、read 描述少半段）会被拒绝。
const GATE_TOOLS_FILE = join(__dirname, "tools", "gate_tools_core.json");
const GATE_TOOL_STUBS = (() => {
  try {
    const raw = JSON.parse(readFileSync(GATE_TOOLS_FILE, "utf8"));
    const map = {};
    for (const t of raw.tools || []) {
      if (t && t.function && t.function.name) map[t.function.name] = t;
    }
    if (map.read && map.shell) return map;
    throw new Error("gate_tools 文件缺 read/shell");
  } catch (err) {
    console.error("[newofm] gate_tools 加载失败，退回内置 stub：", err && err.message);
    return { read: READ_TOOL_STUB, shell: SHELL_TOOL_STUB };
  }
})();

/** 工具面 profile：
 *  - core（默认）：read+shell 两个锚点，体积最小。
 *  - full：官方 CLI 真实发送的 12 工具全量（edit/glob/grep/question/read/
 *    shell/skill/subagent/webfetch/websearch/write/execute，字母序），定义
 *    由官方请求原样提取（tools/gate_tools_full.json）。形状与官方完全一致，
 *    更不容易被按形状识别。 */
const TOOL_PROFILE = (process.env.NEWOFM_TOOL_PROFILE || "core").trim().toLowerCase();
const GATE_TOOLS_FULL_FILE = join(__dirname, "tools", "gate_tools_full.json");
const GATE_TOOL_STUBS_FULL = (() => {
  if (TOOL_PROFILE !== "full") return null;
  try {
    const raw = JSON.parse(readFileSync(GATE_TOOLS_FULL_FILE, "utf8"));
    const map = {};
    for (const t of raw.tools || []) {
      if (t && t.function && t.function.name) map[t.function.name] = t;
    }
    const need = ["edit","glob","grep","question","read","shell","skill","subagent","webfetch","websearch","write","execute"];
    if (need.every((n) => map[n])) return map;
    throw new Error("gate_tools_full 缺官方 12 工具之一");
  } catch (err) {
    console.error("[newofm] gate_tools_full 加载失败，退回 core profile：", err && err.message);
    return null;
  }
})();
/** 本次进程实际生效的占位工具表与需保证在场的名单。 */
const ACTIVE_TOOL_STUBS = GATE_TOOL_STUBS_FULL || GATE_TOOL_STUBS;
const REQUIRED_TOOL_NAMES = GATE_TOOL_STUBS_FULL
  ? Object.keys(GATE_TOOL_STUBS_FULL) // 按官方字母序
  : GATE_ANCHORS.tools.slice();

/**
 * 保证 tools 里有名为 read 的函数（门禁 3）。副作用处理：
 *   - 客户端自带的 read → 改名 read_client 发出，回程再映射回来
 *     （避免与锚点撞名；参考项目同款做法）。
 *   - tool_choice: "none" 一律丢弃：上游 v2 实测拒绝 none（403
 *     FreeTierError），不转发；其余 tool_choice 按 alias 映射后转发。
 * 返回 { body, alias }，alias 是 read_client → read 的回程映射。
 */
function ensureReadAnchor(body) {
  const out = { ...body };
  const alias = new Map();
  let tools = Array.isArray(out.tools)
    ? out.tools.map((t) => (t && typeof t === "object" ? { ...t } : t))
    : [];
  // 客户端自带的重名锚点工具 → 改名 <name>_client 发出，回程再映射回来
  // （避免与门禁锚点撞名；参考项目同款做法；full profile 时对全部 12 个
  // 官方工具名都做撞名保护）。
  tools = tools.map((t) => {
    const fn = t && t.function;
    if (fn && REQUIRED_TOOL_NAMES.includes(fn.name)) {
      alias.set(`${fn.name}_client`, fn.name);
      return { ...t, function: { ...fn, name: `${fn.name}_client` } };
    }
    return t;
  });
  // 缺哪个补哪个（core=read+shell；full=官方 12 工具按官方字母序）。
  const appended = [];
  for (const name of REQUIRED_TOOL_NAMES) {
    if (!tools.some((t) => t && t.function && t.function.name === name)) {
      const stub = ACTIVE_TOOL_STUBS[name];
      tools.push({ ...stub, function: { ...stub.function } });
      appended.push(name);
    }
  }
  out.tools = tools;
  // tool_choice: "none" 过不了门禁 → 丢弃（让上游默认 auto）；
  // 对象形态且指向被改名的客户端工具 → 按 alias 映射。
  if (out.tool_choice === "none") {
    delete out.tool_choice;
  } else if (out.tool_choice && typeof out.tool_choice === "object") {
    const fnName = out.tool_choice.function && out.tool_choice.function.name;
    if (fnName && alias.has(`${fnName}_client`) && fnName === "read") {
      out.tool_choice = {
        ...out.tool_choice,
        function: { ...out.tool_choice.function, name: "read_client" },
      };
    }
  }
  return { body: out, alias, appended };
}

/**
 * 占位工具提示（参考桥同款）：注入的门禁 stub 客户端执行不了，在系统提示
 * 开头明说「不要调用它们」，模型就不会调。参考桥实测有效（其响应的
 * reasoning 里能看到模型读懂了这句）。
 */
function buildPlaceholderNote(appendedNames) {
  if (!Array.isArray(appendedNames) || appendedNames.length === 0) return "";
  const list = appendedNames.map((n) => `\`${n}\``).join(", ");
  return `The following tools are placeholders that do nothing; do not call them: ${list}. Use the other tools you have been given instead.`;
}

/**
 * 把 SSE 流里的 tool_call 名按 alias 映射回客户端原名。
 * 只改写真正命中的 data 行，其余字节原样返回（[DONE]、半行、
 * 非 JSON 行都不碰）。name 可能被拆在多个 delta 里，但通常只有
 * 首个携带 function.name 的 chunk 需要改写。
 */
function mapToolCallNames(chunkText, alias) {
  if (!alias || alias.size === 0) return chunkText;
  return chunkText.replace(/^data: (.+)$/gm, (line, payload) => {
    if (payload.trim() === "[DONE]") return line;
    try {
      const obj = JSON.parse(payload);
      let changed = false;
      for (const choice of obj.choices || []) {
        for (const tc of choice.delta && choice.delta.tool_calls ? choice.delta.tool_calls : []) {
          const fn = tc.function;
          if (fn && typeof fn.name === "string" && alias.has(fn.name)) {
            fn.name = alias.get(fn.name);
            changed = true;
          }
        }
      }
      return changed ? "data: " + JSON.stringify(obj) : line;
    } catch {
      return line; // 半行 JSON 等下一块
    }
  });
}

/**
 *  harness <env> 块（门禁 4 的组成部分）。官方 CLI 每个请求都往系统提示
 *  末尾塞这段（抓包实证的格式，含 /tmp/opencode 偏好行）。
 *  ⚠ 消融实测：**只发这段 env 块（约 300 字符）会被拒绝**——错误消息与
 *  额度耗尽一字不差。换成 You are a helpful assistant. 或删掉 system 同样
 *  被拒：上游要的是 **CLI 那份完整系统提示词原文**，env 块只是它的尾部
 *  组成部分。参考项目能过是因为它们一直发着完整提示词，
 *  「env 块足矣」是对它们行为的误归因。
 */
let envBlockCache = { cwd: null, block: "" };
function buildHarnessEnvBlock(cwd = process.cwd()) {
  if (envBlockCache.cwd === cwd && envBlockCache.block) return envBlockCache.block;
  let isRepo = "no";
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    isRepo = "yes";
  } catch {
    /* 不是 git 仓库或没有 git —— 都合法 */
  }
  const block = [
    "Here is some useful information about the environment you are running in:",
    "<env>",
    `  Working directory: ${cwd}`,
    `  Workspace root folder: ${cwd}`,
    `  Is directory a git repo: ${isRepo}`,
    `  Platform: ${process.platform}`,
    "  Prefer /tmp/opencode over generic system temporary directories such as /tmp; it is pre-created and approved for external access.",
    "</env>",
  ].join("\n");
  envBlockCache = { cwd, block };
  return block;
}

/**
 * 官方 CLI 2.1.4 的完整系统提示词（harness_prompt 模块里的抓包模板），
 * 运行时填四个占位符：模型显示名 / 模型 id / 当天日期 / <env> 块。
 */
function harnessSystemText(facts, cwd = process.cwd()) {
  const name = (facts && facts.name) || (facts && facts.id) || "Big Pickle";
  const id = (facts && facts.id) || "big-pickle";
  return HARNESS_SYSTEM_TEMPLATE.replaceAll("{{MODEL_NAME}}", name)
    .replaceAll("{{MODEL_ID}}", id)
    .replaceAll("{{TODAY}}", new Date().toDateString())
    .replaceAll("{{ENV_BLOCK}}", buildHarnessEnvBlock(cwd));
}

/** 已是 harness 提示（含 CLI 原文标记）→ 原文不动；否则补完整提示词。 */
function withHarnessEnvBlock(systemText, facts) {
  const text = typeof systemText === "string" ? systemText : "";
  if (text.includes(HARNESS_MARKER)) return text;
  const harness = harnessSystemText(facts);
  return text.trim() ? `${text.replace(/\s+$/, "")}\n\n${harness}` : harness;
}

/** 对整条 messages 应用 harness 提示：有 system/developer 就追加，没有就插一条。 */
function applyEnvBlock(messages, facts) {
  const out = (Array.isArray(messages) ? messages : []).map((m) =>
    m && typeof m === "object" ? { ...m } : m,
  );
  const idx = out.findIndex((m) => m && (m.role === "system" || m.role === "developer"));
  if (idx >= 0) {
    out[idx] = { ...out[idx], content: withHarnessEnvBlock(out[idx].content, facts) };
  } else {
    out.unshift({ role: "system", content: harnessSystemText(facts) });
  }
  return out;
}

/** 取首个 user 消息文本，用于会话亲和派生。 */
function firstUserText(messages) {
  for (const m of Array.isArray(messages) ? messages : []) {
    if (m && m.role === "user") {
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) {
        return m.content
          .filter((p) => p && p.type === "text")
          .map((p) => p.text)
          .join("\n");
      }
    }
  }
  return "";
}

// ────────────────────────────────────────────────────────────────
// 2. 模型目录（免费判定 + 事实表）
// ────────────────────────────────────────────────────────────────

// 静态种子：live 抓取成功前用它（抓取成功后整体被 live 结果替换）。
// 以 models.opencode.ai/api.json 实况校准：零价且未废弃的
// 共 9 个（目录里 46 个零价模型中 37 个已 deprecated；longcat-2.5-preview-free
// 与 space-bunny-free 也已废弃故不列）。目录显示 9 个全部 reasoning:true，
// maxOutput 一并抄录，供 token 下限封顶用。部分模型存在区域限制。
const STATIC_MODELS = [
  { id: "big-pickle", name: "Big Pickle", reasoning: true, maxOutput: 32000 },
  { id: "beam-free", name: "Beam Free", reasoning: true, maxOutput: 131072, note: "存在区域限制，部分出口不可用" },
  { id: "deepseek-v4.1-flash-free", name: "DeepSeek V4.1 Flash Free", reasoning: true, maxOutput: 32000 },
  { id: "flint-40b-free", name: "Flint 40B Free", reasoning: true, maxOutput: 65536 },
  { id: "glm-5.3-flash-free", name: "GLM-5.3-Flash Free", reasoning: true, maxOutput: 32000 },
  { id: "mimo-v2.6-flash-free", name: "MiMo-V2.6-Flash Free", reasoning: true, maxOutput: 32000 },
  { id: "nemotron-3-ultra-free", name: "Nemotron 3 Ultra Free", reasoning: true, maxOutput: 128000 },
  { id: "nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning Free", reasoning: true, maxOutput: 262144 },
  { id: "nemotron-3.5-super-vl-free", name: "Nemotron 3.5 Super VL Free", reasoning: true, maxOutput: 131072 },
];

// 目录状态：seed（静态）→ cache（磁盘）→ live（上游）。三者结构同构：
// { models: [{id, name, reasoning, maxOutput}], source, fetchedAt }
// name 是 harness 系统提示词里 "# Your Model" 段落的显示名（抓包实证）。
let catalog = { models: STATIC_MODELS.map((m) => ({ ...m })), source: "static", fetchedAt: 0 };

function isFreeEntry(entry) {
  // 参考项目判定标准：cost.input === 0 且未废弃。
  return Boolean(entry && entry.cost && entry.cost.input === 0 && entry.status !== "deprecated");
}

/**
 * 从上游目录 JSON（models.opencode.ai/api.json）抽免费模型事实表。
 * 只取 opencode provider —— 匿名免费车道只服务它一家；其他 provider
 * （openrouter / nvidia / google…）的零价模型本车道拨不通，收进来只会
 * 污染 /v1/models（实测全量解析会得到 424 个，其中 415 个不可用）。
 * 实际目录结构是扁平的：顶层 key 即 provider；个别版本包一层 providers，
 * 两种都兼容。返回 { models, api }，api 是该 provider 的上游 base URL。
 */
function parseUpstreamCatalog(json) {
  const providers =
    json && json.providers && !Array.isArray(json.providers) && typeof json.providers === "object"
      ? json.providers
      : json && typeof json === "object"
        ? json
        : {};
  const provider = providers[CATALOG_PROVIDER_ID] || {};
  const entries = (provider && provider.models) || {};
  const models = [];
  if (typeof entries === "object") {
    for (const [id, entry] of Object.entries(entries)) {
      if (!isFreeEntry(entry)) continue;
      models.push({
        id,
        name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : id,
        reasoning: Boolean(entry.reasoning),
        maxOutput: entry.limit && typeof entry.limit.output === "number" ? entry.limit.output : null,
      });
    }
  }
  return { models, api: typeof provider.api === "string" ? provider.api.replace(/\/+$/, "") : "" };
}

function loadCatalogCache() {
  try {
    if (!existsSync(CATALOG_CACHE_FILE)) return false;
    const data = JSON.parse(readFileSync(CATALOG_CACHE_FILE, "utf8"));
    if (data && Array.isArray(data.models) && data.models.length > 0) {
      catalog = { models: data.models, source: "cache", fetchedAt: data.fetchedAt || 0 };
      return true;
    }
  } catch {
    /* 缓存损坏就当作没有 */
  }
  return false;
}

function saveCatalogCache(models) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(
      CATALOG_CACHE_FILE,
      JSON.stringify({ models, fetchedAt: Date.now() }, null, 2),
    );
  } catch {
    /* 缓存写失败不影响服务 */
  }
}

/** live 抓取目录。失败静默保留现状（seed/cache），由 /health 暴露 lastError。
 *  抓到目录后按 provider 的 api 字段改写上游地址（/zen/v1 → /inference
 *  这类迁移自动跟上，参考项目同款思路）。 */
let catalogLastError = "";
async function refreshCatalog() {
  try {
    const init = { signal: AbortSignal.timeout(15000) };
    if (UPSTREAM_PROXY) init.proxy = UPSTREAM_PROXY;
    const res = await fetch(CATALOG_URL, init);
    if (!res.ok) throw new Error(`catalog HTTP ${res.status}`);
    const { models, api } = parseUpstreamCatalog(await res.json());
    if (models.length === 0) throw new Error("catalog parsed 0 free models");
    catalog = { models, source: "live", fetchedAt: Date.now() };
    catalogLastError = "";
    saveCatalogCache(models);
    if (api) {
      UPSTREAM_CHAT_URL = `${api}/chat/completions`;
      UPSTREAM_MODELS_URL = `${api}/models`;
    }
    return catalog;
  } catch (err) {
    catalogLastError = String(err && err.message ? err.message : err);
    return catalog;
  }
}

/** 模型名归一化：剥 opencode/ 前缀；支持家族简写（mimo → mimo-v2.6-flash-free）。 */
function resolveModel(requested) {
  const raw = String(requested || "").trim();
  const id = raw.replace(/^opencode\//, "");
  const exact = catalog.models.find((m) => m.id === id);
  if (exact) return exact;
  const family = catalog.models.filter((m) => m.id.startsWith(id + "-"));
  if (family.length === 1) return family[0];
  return null;
}

/** 思考模型的加法 token 下限（参考项目实测：不设下限会把预算烧光→空正文）。
 *  ⚠ 对齐参考桥实测：客户端没显式给 max_tokens 时，要的是
 *  MAX_OUTPUT_TOKENS（131072）再封顶到模型 limit.output——不是 0。
 *  参考桥对无显式请求的 big-pickle 实发 32000（= 模型上限），而我们
 *  当时发 5120，是 429 的疑似差异之一。 */
const MAX_OUTPUT_TOKENS = 131072;
function adjustMaxTokens(facts, requested) {
  const max = facts && typeof facts.maxOutput === "number" ? facts.maxOutput : null;
  const wanted =
    requested === undefined || requested === null || requested === ""
      ? MAX_OUTPUT_TOKENS
      : Math.max(Number(requested) || 0, 0);
  let v;
  if (facts && facts.reasoning) {
    v = Math.max(wanted, 1024) + 4096;
  } else {
    v = Math.max(wanted, 512);
  }
  return max ? Math.min(v, max) : v;
}

// ────────────────────────────────────────────────────────────────
// 2.5 出口轮换（可选，经 mihomo 控制口）
//  上游额度按出口 IP 分池：① 用户请求 429 → 换节点同模型重试（兜底）；
//  ② 定时换池（默认 60 分钟，只在 in_flight==0 时切，不掐生成中请求）。
//  切换前经 mihomo /delay 测速（URL 用 opencode.ai 首页——不进推理接口，
//  不烧对话额度），测挂的进 600s 短冷却；全挂则不切换保住当前出口。
//  ⚠ Clash 控制口只有 unix socket（verge-mihomo.sock，免鉴权），按
//  127.0.0.1:9097 连必 refused。
// ────────────────────────────────────────────────────────────────

function autoDetectClashSock() {
  // 优先 root 服务模式（Clash Verge 以服务模式运行时，
  // 用户态 socket 变成死文件，连它必 ECONNREFUSED）；再退回用户态路径。
  const candidates = [];
  try {
    for (const dir of readdirSync("/run/clash-verge-service/users")) {
      candidates.push(join("/run/clash-verge-service/users", dir, "verge-mihomo.sock"));
    }
  } catch {
    /* 非 root 服务模式 */
  }
  try {
    const base = join(homedir(), ".local/share");
    for (const dir of existsSync(base) ? readdirSync(base) : []) {
      if (!dir.startsWith("io.github.clash-verge-rev")) continue;
      candidates.push(join(base, dir, "verge-mihomo.sock"));
    }
  } catch {
    /* 探测失败 */
  }
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p;
    } catch {
      /* 下一个 */
    }
  }
  return "";
}

const CLASH_SOCK =
  process.env.NEWOFM_CLASH_SOCK !== undefined
    ? process.env.NEWOFM_CLASH_SOCK.trim()
    : autoDetectClashSock();
// 代理组名。留空表示不启用出口轮换——多数环境没有 mihomo 控制口，属正常。
const CLASH_GROUP = (process.env.NEWOFM_CLASH_GROUP || "").trim();
const ROTATE_ON_429 =
  (process.env.NEWOFM_ROTATE_ON_429 ?? "1").toLowerCase() !== "0";
const MAX_ROTATE = parseInt(process.env.NEWOFM_MAX_ROTATE || "3", 10);
const TIMED_ROTATE_MIN = parseInt(process.env.NEWOFM_TIMED_ROTATE_MIN || "60", 10);
const EXIT_PROBE = (process.env.NEWOFM_PROBE ?? "1").toLowerCase() !== "0";
const EXIT_PROBE_TIMEOUT = parseInt(process.env.NEWOFM_PROBE_TIMEOUT || "3000", 10);
const EXIT_PROBE_URL = (process.env.NEWOFM_PROBE_URL || "https://opencode.ai").trim();
const EXIT_PROBE_MAX = parseInt(process.env.NEWOFM_PROBE_MAX || "5", 10);
const UNREACH_COOLDOWN_MS = parseInt(process.env.NEWOFM_UNREACH_COOLDOWN_MS || "600000", 10);
const EXIT_COOLDOWN_MS = parseInt(process.env.NEWOFM_EXIT_COOLDOWN_MS || "1800000", 10);
// 轮换总预算与候选扫描上限：原实现没有上限，
// 40 个成员 × (probe 3s + PUT + trace 8s) 最坏可跑 100s+，用户侧表现就是
// "卡住不动、不报错"。改为：单次轮换 ≤ ROTATE_BUDGET_MS、最多扫 N 个候选。
const ROTATE_BUDGET_MS = parseInt(process.env.NEWOFM_ROTATE_BUDGET_MS || "45000", 10);
const ROTATE_SCAN_MAX = parseInt(process.env.NEWOFM_ROTATE_SCAN_MAX || "20", 10);
// 切换后 settle：mihomo 的 PUT 只保证"选择已记录"，已建立的连接/规则缓存
// 可能仍走旧节点 —— 立刻 trace 会读到上一个出口的 IP，把好节点误判成死池
// （切换后立刻 trace 可能仍读到上一个出口的 IP）。
const ROTATE_SETTLE_MS = parseInt(process.env.NEWOFM_ROTATE_SETTLE_MS || "150", 10);

const exitState = {
  current: "",
  currentEgress: "",
  rotations: 0,
  lastRotateAt: 0,
  lastReason: "",
  inFlight: 0,
  dead: new Map(), // 刚切走的节点 → 冷却到期（防立刻切回）
  unreachable: new Map(), // 测速判死节点 → 冷却到期
};

/** mihomo 控制口只监听 unix socket，走 node:http 的 socketPath（Bun 兼容）。
 *  ⚠ 显式给值（含空串）即以此为准 —— 空串 = 关掉轮换，不再回落到自动探测。
 *  这样跑测试不会意外切走你正在使用的代理组。 */
function clashApi(method, path, bodyObj) {
  return new Promise((resolve) => {
    const payload = bodyObj === undefined ? null : JSON.stringify(bodyObj);
    const req = http.request(
      {
        socketPath: CLASH_SOCK,
        path,
        method,
        timeout: 5000,
        headers: payload
          ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* 非 JSON（如 204） */
          }
          resolve({ status: res.statusCode || 0, json, text });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("clash api timeout")));
    req.on("error", (e) => resolve({ status: 0, json: null, text: String(e.message || e) }));
    if (payload) req.write(payload);
    req.end();
  });
}

/** 「剩余流量：xx GB」「套餐到期：xxx」这类信息条目混在成员里，挡掉。 */
function isInfoNode(name) {
  return /剩余|到期|DIRECT|REJECT|官网/.test(name);
}

async function groupInfo() {
  const r = await clashApi("GET", "/proxies/" + encodeURIComponent(CLASH_GROUP));
  if (r.status !== 200 || !r.json || !Array.isArray(r.json.all)) return null;
  return r.json;
}

/** mihomo 真的经该节点发一次请求：通回 200 {"delay":N}，不通回非 200。 */
async function probeNode(name) {
  const path =
    `/proxies/${encodeURIComponent(name)}/delay?url=${encodeURIComponent(EXIT_PROBE_URL)}` +
    `&timeout=${EXIT_PROBE_TIMEOUT}`;
  const r = await clashApi("GET", path);
  if (r.status === 200 && r.json && typeof r.json.delay === "number" && r.json.delay > 0) {
    return r.json.delay;
  }
  return null;
}

/** 当前代理组的真实出口 IP（trace 请求走 opencode.ai 域名，命中分流规则）。 */
async function egressIpOf() {
  // ⚠ 不能用进程内 fetch：Bun 连接池会复用换组前经起点节点建立的 keep-alive
  // 隧道，trace 永远返回起点 IP（17:20 实测 19/20 候选全"同池"的假象）。
  // curl 子进程每条新连接，走 mihomo 按当前组实时分流，才是候选节点的真实出口。
  try {
    const args = ["curl", "-s", "--max-time", "8"];
    if (UPSTREAM_PROXY) args.push("-x", UPSTREAM_PROXY);
    args.push("https://opencode.ai/cdn-cgi/trace");
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    const m = text.match(/^ip=(.+)$/m);
    return m ? m[1].trim() : "";
  } catch {
    return "";
  }
}

/** IPv6 按 /64 前缀归并（机场不同 v6 节点常共享 /64，上游按 /64 计池）。
 *  ⚠ 必须**幂等**：ipByNode 里存的已经是归一化值，候选排序/冷却表又会再调
 *  一次；旧实现会把 "v6:1:2:3:4" 再变成 "v6:v6:1:2:3"，导致 v6 节点上
 *  (IP,模型) 冷却键永远对不上。 */
function normalizeEgress(ip) {
  if (!ip) return "";
  const s = String(ip);
  if (s.startsWith("v6:")) return s; // 已归一化 → 原样返回
  if (s.includes(":")) {
    return "v6:" + s.split(":").filter(Boolean).slice(0, 4).join(":");
  }
  return s;
}

const egressState = {
  dead: new Map(), // 归一化 IP → 判死时刻（滚动窗口内已 429，换同 IP 节点无意义）
  blockedUntil: 0, // 轮换熔断：连续救不回时暂停轮换，防止风暴
  ipByNode: new Map(), // 节点名 → 归一化出口 IP（trace 实测缓存，避免重复探测）
  samePoolSkipped: 0, // 因"与起点同 IP"被跳过的候选数（观测定时轮换是否还在打转）
  // ⭐ 按 (出口IP, 模型) 记额度冷却。
  // 依据：18:33 的 429 带 retry-after=48410s（13.4h，额度耗尽而非冷却），
  // 且同刻同出口的其它模型 200（20:07 实测四模型全 200）。旧实现一遇 429
  // 就把整个 IP 判死 10 分钟，等于让其它还能用的模型陪葬，也让轮换反复
  // 把候选挑回"对这个模型已烧空"的出口。键 = `${归一化IP}|${模型}`。
  modelCooldown: new Map(),
};
const ROTATION_BLOCK_MS = parseInt(process.env.NEWOFM_ROTATION_BLOCK_MS || "300000", 10);
const DEAD_EGRESS_FILE = join(CACHE_DIR, "dead_egress.json");
/** 模型级冷却表的默认/上限（retry-after 缺失时取默认；存在时按它，封顶 24h）。 */
const MODEL_COOLDOWN_DEFAULT_MS = parseInt(process.env.NEWOFM_MODEL_COOLDOWN_MS || "300000", 10);
const MODEL_COOLDOWN_MAX_MS = 24 * 3600 * 1000;
/** retry-after 超过这个值就判定为"额度桶已空"（而非短时冷却）。
 *  实测分布：冷却 30s~几分钟；额度耗尽 48410s 这种级别。10 分钟作分界很宽。 */
const QUOTA_RETRY_AFTER_MS = parseInt(process.env.NEWOFM_QUOTA_RETRY_AFTER_MS || "600000", 10);
const MODEL_COOLDOWN_FILE = join(CACHE_DIR, "model_cooldown.json");

/** 解析 Retry-After：秒数或 HTTP-date；无法解析返回 0。 */
function parseRetryAfterMs(value, now = Date.now()) {
  const v = String(value ?? "").trim();
  if (!v) return 0;
  if (/^\d+$/.test(v)) return Math.max(0, parseInt(v, 10) * 1000);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - now) : 0;
}

/** 记一条 (出口 IP, 模型) 冷却。until = now + clamp(retryAfter)。 */
function markModelCooldown(ip, model, retryAfterMs = 0, now = Date.now()) {
  const nip = normalizeEgress(ip);
  if (!nip || !model) return 0;
  const wait = Math.min(
    MODEL_COOLDOWN_MAX_MS,
    Math.max(retryAfterMs || MODEL_COOLDOWN_DEFAULT_MS, 30_000),
  );
  const until = now + wait;
  egressState.modelCooldown.set(`${nip}|${model}`, until);
  saveModelCooldown();
  return until;
}

/** 成功一次即清除该 (IP, 模型) 的冷却（上游状态已变）。 */
function clearModelCooldown(ip, model) {
  const nip = normalizeEgress(ip);
  if (!nip || !model) return false;
  const key = `${nip}|${model}`;
  if (!egressState.modelCooldown.has(key)) return false;
  egressState.modelCooldown.delete(key);
  saveModelCooldown();
  return true;
}

function saveModelCooldown() {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const now = Date.now();
    const arr = [...egressState.modelCooldown.entries()].filter(([, t]) => t > now);
    writeFileSync(MODEL_COOLDOWN_FILE, JSON.stringify(arr));
  } catch {
    /* 写失败不影响主流程 */
  }
}
function loadModelCooldown() {
  try {
    const arr = JSON.parse(readFileSync(MODEL_COOLDOWN_FILE, "utf8"));
    const now = Date.now();
    for (const [k, t] of arr) if (t > now) egressState.modelCooldown.set(k, t);
  } catch {
    /* 无缓存/损坏 → 从空表开始 */
  }
}

/** 死池表持久化：重启不丢（滚动窗口以 24h 计，比进程寿命长） */
function loadDeadEgress() {
  try {
    const arr = JSON.parse(readFileSync(DEAD_EGRESS_FILE, "utf8"));
    const now = Date.now();
    for (const [ip, t] of arr) if (t > now) egressState.dead.set(ip, t);
  } catch {
    /* 无缓存/损坏 → 从空表开始 */
  }
}
const NODE_IP_FILE = join(CACHE_DIR, "node_ip_map.json");
function loadNodeIpMap() {
  try {
    const arr = JSON.parse(readFileSync(NODE_IP_FILE, "utf8"));
    for (const [n, ip] of arr) egressState.ipByNode.set(n, ip);
  } catch {
    /* 无缓存 → 从空表开始 */
  }
}
function saveNodeIpMap() {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(NODE_IP_FILE, JSON.stringify([...egressState.ipByNode.entries()]));
  } catch {
    /* 写失败不影响主流程 */
  }
}
function saveDeadEgress() {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(DEAD_EGRESS_FILE, JSON.stringify([...egressState.dead.entries()]));
  } catch {
    /* 写失败不影响主流程 */
  }
}

/** 候选筛选（纯函数，便于回归测试）：去掉信息条目、当前节点、节点冷却。
 *  全冷却时退回"不排除冷却"的兜底池 —— 宁可变差，也别一动不动。
 *  cap>0 时截断，配合 ROTATE_BUDGET_MS 防"扫全部 40 个节点"的静默长跑。
 *  ⭐ 模型维度——传了 model 时，把"(该 IP, 该模型)
 *  已额度冷却"的候选排到最后（同分再按恢复时刻早的优先），避免轮换反复
 *  挑回对这个模型已烧空的出口（18:33 四个港区 IP 全 429 的直接教训）。 */
function pickCandidates({ all = [], current = "", nodeDead = new Map(), now = Date.now(), cap = 0, ipByNode = new Map(), originIp = "", deadEgress = new Map(), modelCooldown = new Map(), model = "" } = {}) {
  const base = all.filter((n) => !isInfoNode(n) && n !== current);
  const alive = base.filter((n) => (nodeDead.get(n) || 0) <= now);
  const pool = alive.length ? alive : base;
  // 排序（稳定）：① 未知 IP（映射会过期——机场随时换池 IP，实测 trace 才是真知）
  // ② 已知出口 IP 且 ≠ 起点、非死池 ③ 已知同起点池 / 死池（大概率白切，垫底）
  // 统一走 normalizeEgress（幂等），避免 v6 键二次归一化（v6:v6:…）
  const normIp = (ip) => normalizeEgress(ip);
  const rank = (n) => {
    const ip = ipByNode.get(n);
    if (!ip) return 0;
    const nip = normIp(ip);
    if ((deadEgress.get(nip) || 0) > now) return 2;
    if (originIp && nip === originIp) return 2;
    return 1;
  };
  // 该节点对该模型是否处于额度冷却：冷却中 → 排到最后一档
  const modelRank = (n) => {
    if (!model) return 0;
    const nip = normIp(ipByNode.get(n));
    if (!nip) return 0;
    const until = modelCooldown.get(`${nip}|${model}`) || 0;
    return until > now ? 1 : 0;
  };
  const recovery = (n) => {
    if (!model) return 0;
    const nip = normIp(ipByNode.get(n));
    return (nip && modelCooldown.get(`${nip}|${model}`)) || 0;
  };
  pool.sort(
    (a, b) =>
      modelRank(a) - modelRank(b) ||
      rank(a) - rank(b) ||
      recovery(a) - recovery(b),
  );
  return cap > 0 ? pool.slice(0, cap) : pool;
}

/** 单飞句柄：并发 429 共用同一次轮换。
 *  不串行的话会互相踩踏：两个请求各挑节点、又互相把对方的出口改掉，
 *  再各自 trace 到别人刚切过去的那台，于是把好节点判成死池。 */
let rotationInflight = null;

/** 轮换出口：挑未冷却候选 → 测速 → 切过去 → 校验选择生效 → trace 验证 IP 没见过 → 成才收工。
 *  ⭐ 多个节点可能共享同一个 egress IP（同一机房的不同入口），互为死池。
 *  不做 IP 去重的轮换会在死池间打转，全部失败。
 *  另外三条约束（mihomo REST 文档明写的两条规矩）：
 *  ① PUT 成功后要回读组状态确认 now==cand，PUT 的回执不代表已生效；
 *  ② 候选全败要回滚到原节点，不能把组停在最后试过的死池上，否则之后
 *     每个请求都从死池出发。 */
async function rotateExit(why = "", model = "") {
  if (!CLASH_SOCK || !CLASH_GROUP) return { ok: false, reason: "clash not configured" };
  if (rotationInflight) return rotationInflight; // 单飞：别人在换就等它的结果
  rotationInflight = doRotateExit(why, model).finally(() => {
    rotationInflight = null;
  });
  return rotationInflight;
}

async function doRotateExit(why = "", model = "") {
  const t0 = Date.now();
  const deadline = t0 + ROTATE_BUDGET_MS;
  // 起点 IP：本次轮换必须落到**不同**的出口 IP 才有意义（同 IP = 同额度池，
  // 定时轮换在同一 IP 的两个节点之间反复打转的教训）。
  let originIp = normalizeEgress(exitState.currentEgress || "");
  if (!originIp) {
    originIp = normalizeEgress(await egressIpOf());
    if (originIp) exitState.currentEgress = originIp;
  }
  const info = await groupInfo();
  if (!info) return { ok: false, reason: "clash group query failed" };
  const now = info.now || "";
  const pool = pickCandidates({
    all: info.all || [],
    current: now,
    nodeDead: exitState.dead,
    now: t0,
    cap: ROTATE_SCAN_MAX,
    ipByNode: egressState.ipByNode,
    originIp,
    deadEgress: egressState.dead,
    modelCooldown: egressState.modelCooldown,
    model,
  });
  let probed = 0;
  let probeFailed = 0;
  let deadSkipped = 0;
  let sameSkipped = 0;
  const deadNow = () => Date.now();
  for (const cand of pool) {
    if (Date.now() >= deadline) {
      return finishFail("budget", { t0, now, probed, probeFailed, deadSkipped, sameSkipped, why });
    }
    // 已知映射的候选：IP 等于起点或已判死 → 不用切过去就能排除，省一次 PUT+trace
    const known = normalizeEgress(egressState.ipByNode.get(cand) || "");
    if (known && (egressState.dead.get(known) || 0) > deadNow()) {
      deadSkipped += 1;
      continue;
    }
    if (known && originIp && known === originIp) {
      sameSkipped += 1;
      continue;
    }
    let delay = null;
    if (EXIT_PROBE) {
      delay = await probeNode(cand);
      probed += 1;
      if (delay === null) {
        exitState.unreachable.set(cand, Date.now() + UNREACH_COOLDOWN_MS);
        probeFailed += 1;
        continue;
      }
    }
    const put = await clashApi("PUT", "/proxies/" + encodeURIComponent(CLASH_GROUP), { name: cand });
    if (put.status !== 200 && put.status !== 204) continue;
    // 校验选择真的生效（PUT 回执 ≠ 已切换）；未生效就换下一个，别读别人的 IP
    const after = await groupInfo();
    if (!after || (after.now || "") !== cand) {
      probeFailed += 1;
      continue;
    }
    if (ROTATE_SETTLE_MS > 0) await new Promise((r) => setTimeout(r, ROTATE_SETTLE_MS));
    // 切过去后验真实出口 IP：死池（429 过的）或与起点同池的直接跳下一个
    const ip = normalizeEgress(await egressIpOf());
    if (ip && egressState.ipByNode.get(cand) !== ip) {
      egressState.ipByNode.set(cand, ip);
      saveNodeIpMap();
    }
    if (ip && (egressState.dead.get(ip) || 0) > deadNow()) {
      deadSkipped += 1;
      console.log(`[newofm] skip ${cand}: egress ${ip} is a dead pool`);
      continue;
    }
    if (ip && originIp && ip === originIp) {
      sameSkipped += 1;
      console.log(`[newofm] skip ${cand}: egress ${ip} same pool as origin (${now})`);
      continue;
    }
    exitState.dead.set(now, Date.now() + EXIT_COOLDOWN_MS);
    exitState.current = cand;
    exitState.rotations += 1;
    exitState.lastRotateAt = Date.now();
    exitState.lastReason = why;
    if (ip) {
      exitState.currentEgress = ip;
      saveNodeIpMap();
    }
    console.log(
      `[newofm] exit rotated: ${now} -> ${cand}${delay ? ` (${delay}ms)` : ""}` +
        `${ip ? ` egress=${ip}` : ""} (${why})`,
    );
    return { ok: true, from: now, to: cand, delay, egress: ip };
  }
  return finishFail("no reachable candidate", { t0, now, probed, probeFailed, deadSkipped, sameSkipped, why });

  /** 失败收尾：回滚到原节点 + 打一行带数字的总结。
   *  原来失败路径一言不发，巡检时只能看到"没有 rotated"，分不清是探测全挂
   *  还是候选全被死池表挡掉。 */
  async function finishFail(reason, s) {
    let rolledBack = false;
    try {
      const cur = await groupInfo();
      if (cur && s.now && (cur.now || "") !== s.now) {
        const rb = await clashApi("PUT", "/proxies/" + encodeURIComponent(CLASH_GROUP), { name: s.now });
        rolledBack = rb.status === 200 || rb.status === 204;
      }
    } catch {
      /* 回滚失败不阻塞返回 */
    }
    const ms = Date.now() - s.t0;
    console.log(
      `[newofm] rotation failed: ${reason} why=${s.why || "-"} candidates=${pool.length} ` +
        `probed=${s.probed} probe_failed=${s.probeFailed} dead_skip=${s.deadSkipped} same_skip=${s.sameSkipped} ` +
        `${ms}ms rollback=${rolledBack ? "yes" : "no"}`,
    );
    return { ok: false, reason, probed: s.probed, probeFailed: s.probeFailed, deadSkipped: s.deadSkipped, sameSkipped: s.sameSkipped, ms };
  }
}

function exitPoolStatus() {
  const now = Date.now();
  return {
    sock: CLASH_SOCK ? "configured" : "absent",
    group: CLASH_GROUP,
    current: exitState.current,
    currentEgress: exitState.currentEgress || "",
    rotations: exitState.rotations,
    lastRotateAt: exitState.lastRotateAt,
    lastReason: exitState.lastReason,
    inFlight: exitState.inFlight,
    probe: EXIT_PROBE ? EXIT_PROBE_URL : "off",
    rotateOn429: ROTATE_ON_429,
    laneB: LANE_B_URL || "off",
    timedRotateMin: TIMED_ROTATE_MIN,
    rotationBudgetMs: ROTATE_BUDGET_MS,
    rotationScanMax: ROTATE_SCAN_MAX,
    rotationInflight: Boolean(rotationInflight),
    rotationBlockedUntil: egressState.blockedUntil,
    rotationBlockedForS: egressState.blockedUntil > now ? Math.round((egressState.blockedUntil - now) / 1000) : 0,
    deadEgressPools: [...egressState.dead.entries()].filter(([, t]) => t > now).length,
    // (出口IP, 模型) 额度冷却：条数 + 最近一条的恢复倒计时，够运维判断"是不是桶空了"
    modelCooldownEntries: [...egressState.modelCooldown.entries()].filter(([, t]) => t > now).length,
    modelCooldownNearestS: (() => {
      const live = [...egressState.modelCooldown.values()].filter((t) => t > now);
      return live.length ? Math.round((Math.min(...live) - now) / 1000) : 0;
    })(),
    modelCooldown: [...egressState.modelCooldown.entries()]
      .filter(([, t]) => t > now)
      .slice(0, 8)
      .map(([k, t]) => ({ key: k, recoversInS: Math.round((t - now) / 1000) })),
    samePoolSkipped: egressState.samePoolSkipped,
    knownNodes: egressState.ipByNode.size,
    unreachable: [...exitState.unreachable.entries()]
      .filter(([, t]) => t > now)
      .map(([n, t]) => ({ node: n, cooldown_s: Math.round((t - now) / 1000) })),
  };
}

// ────────────────────────────────────────────────────────────────
// 3. 上游调用（门禁重试 + 流式管道）
// ────────────────────────────────────────────────────────────────

const stats = { requests: 0, ok: 0, err: 0, retries: 0, started: Date.now() };
let lastGateRejectAt = 0; // 403 冷却，避免给 IP 刑期加码（参考项目同款）

/** 是不是"IP 级滥用"终局拒绝 —— 这种等上游解封，重试/改形状都没用。 */
function isAbuseRejection(status, bodyText) {
  if (status !== 403) return false;
  return /abusive traffic|abuse of traffic|detected abuse/i.test(String(bodyText || ""));
}

/** 车道 B 兜底：把同一个 OpenAI 请求原样转给官方身份车道，响应体直接透传。
 *  只在伪造车道 429 且轮换救不回时调用——官方身份有自己的额度桶，可立即恢复可用。 */
async function forwardToLaneB(body, stream) {
  if (!LANE_B_URL) return null;
  const t0 = Date.now();
  try {
    const res = await fetch(LANE_B_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS * 2),
    });
    if (!res.ok) return null;
    console.log(`[newofm] lane-b fallback ok ${res.status} ${Date.now() - t0}ms`);
    return res;
  } catch (err) {
    console.log(`[newofm] lane-b fallback failed: ${err && err.message ? err.message : err}`);
    return null;
  }
}

async function callUpstream(body, sessionId) {
  const headers = buildHeaders(sessionId);
  // ⭐ 超时必须分层。
  // 旧实现把 AbortSignal.timeout(120s) 挂在 fetch 上，**响应头到手后信号仍然计时**，
  // 于是任何「总时长 > 120 秒」的回答（长思考/长输出）都会在流中途被 abort →
  // 客户端看到没有 finish_reason 的断流 → 报"用户已取消"（日志里是
  // TimeoutError + 无 FAIL 行）。现在只给「等响应头」设超时，流阶段交给
  // ssePipe 的空闲超时（UPSTREAM_IDLE_TIMEOUT_MS）与客户端取消。
  const ctrl = new AbortController();
  const headerTimer = setTimeout(() => {
    try {
      ctrl.abort(new Error("upstream_headers_timeout"));
    } catch {
      /* 已结束则忽略 */
    }
  }, UPSTREAM_HEADERS_TIMEOUT_MS);
  const init = {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: ctrl.signal,
  };
  if (UPSTREAM_PROXY) init.proxy = UPSTREAM_PROXY;
  // 运维 Debug：NEWOFM_DUMP_REQ=/path 时落盘上游请求原文（排 429 歧义用）
  if (process.env.NEWOFM_DUMP_REQ) {
    try {
      appendFileSync(
        process.env.NEWOFM_DUMP_REQ,
        JSON.stringify({ t: Date.now(), url: UPSTREAM_CHAT_URL, headers: init.headers, body: init.body }) + "\n",
      );
    } catch {
      /* dump 失败不影响请求 */
    }
  }
  // 传输类异常（ECONNRESET 等）换新 session 原地重试一次（对连接抖动有效）
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const t0 = Date.now();
        const res = await fetch(UPSTREAM_CHAT_URL, init);
        clearTimeout(headerTimer); // 响应头已到 → 不再有"整体超时"，流阶段另算
        // 日志只有总耗时，无法按"ttfb 近总耗时＝上游慢 /
        // ttfb 远小于总耗时＝生成慢 / 两者都小但总耗时长＝重试链吃时间"分流。
        // fetch 返回＝响应头已到，把这段挂在响应对象上供日志取用（不改协议）。
        try {
          res.__ttfbMs = Date.now() - t0;
          res.__abort = ctrl; // 供流阶段空闲超时 / 客户端取消时掐上游
        } catch {
          /* 不可写则忽略 */
        }
        return res;
      } catch (err) {
        if (attempt === 0 && /ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket connection/i.test(String(err))) {
          init.headers = { ...buildHeaders(createSessionId()), "content-type": "application/json" };
          continue;
        }
        throw err;
      }
    }
  } finally {
    clearTimeout(headerTimer);
  }
}

/**
 * 发一次对话补全。403 且非 IP 滥用 → 换新 session 重试一次（门禁形状
 * 拒绝的典型恢复动作；参考项目同款，带 30s 冷却防止加码 IP 刑期）。
 * 429 → 出口兜底轮换：额度按出口 IP 分池，换节点 + 换新 session 同模型
 * 重试（最多 MAX_ROTATE 次；实测一次轮换通常即可恢复）。
 * IP 滥用 / 5xx 原样吐回，不重试。
 */
async function postChatWithRetry(body, sessionId) {
  const modelId = String(body && body.model ? body.model : "");
  let res = await callUpstream(body, sessionId);
  if (res.status === 403) {
    const text = await res.text().catch(() => "");
    if (isAbuseRejection(403, text)) {
      return { res: null, abuse: true, detail: text.slice(0, 500), sessionId };
    }
    const now = Date.now();
    if (now - lastGateRejectAt >= GATE_RETRY_COOLDOWN_MS) {
      lastGateRejectAt = now;
      stats.retries += 1;
      const retrySession = createSessionId();
      res = await callUpstream(body, retrySession);
      return { res, abuse: false, sessionId: retrySession, retried: true };
    }
    return { res: null, gate: true, detail: text.slice(0, 500), sessionId };
  }
  if (res.status === 429 && ROTATE_ON_429 && CLASH_SOCK) {
    let retryAfter = res.headers.get("retry-after") || "";
    let text429 = await res.text().catch(() => "");
    // 风暴熔断：上一轮 3 次轮换都没救回来 → 冷却期内不再轮换，直接吐回
    // （教训：连续轮换在死池间打转，会把大量节点全标冷却、
    //   用户请求拖 1 分钟才报错、还加速烧掉各出口的新 session 名额）
    if (Date.now() < egressState.blockedUntil) {
      return {
        res: new Response(text429, { status: 429, headers: { "content-type": "application/json" } }),
        abuse: false,
        sessionId,
        blocked: true,
        retryAfter,
      };
    }
    // 429 归因（按证据分流，不再一刀切把整 IP 判死）：
    //   retry-after ≥10min → 该出口对该**模型**的额度桶已空（实测 48410s 级别），
    //     只记 (IP, 模型) 冷却，别的模型照常用这个 IP；
    //   retry-after 短或无 → 短时冷却/未知，按出口级短冷却处理。
    // 旧行为是 egressState.dead.set(curIp, now+10min)，会让同 IP 其它模型陪葬。
    const curIp = normalizeEgress(await egressIpOf());
    const raMs = parseRetryAfterMs(retryAfter);
    if (curIp) {
      if (raMs >= QUOTA_RETRY_AFTER_MS && modelId) {
        markModelCooldown(curIp, modelId, raMs);
        egressState.dead.set(curIp, Date.now() + 60_000); // 只挡 60s，防本请求立刻原地打转
        saveDeadEgress();
      } else {
        egressState.dead.set(curIp, Date.now() + Math.max(UNREACH_COOLDOWN_MS, raMs));
        saveDeadEgress();
      }
    }
    // 单请求的总预算：轮换本身已有 ROTATE_BUDGET_MS 上限，MAX_ROTATE 次叠加后
    // 仍可能 45s+（客户端全程零字节）。实测一次请求被拖 60s 以上，
    // 用户只看到"卡住"。超预算就立刻把最后一次 429 吐回，让客户端自己退避。
    const rotateDeadline = Date.now() + ROTATE_BUDGET_MS;
    for (let i = 0; i < MAX_ROTATE; i++) {
      if (Date.now() >= rotateDeadline) break;
      const r = await rotateExit(`429-retry#${i + 1}`, modelId);
      if (!r.ok) break;
      stats.retries += 1;
      const retrySession = createSessionId();
      res = await callUpstream(body, retrySession);
      if (res.status !== 429) {
        egressState.blockedUntil = 0;
        // 换到这个出口后成功了 → 清掉该 (IP, 模型) 的历史冷却（上游状态已变）
        const okIp = normalizeEgress(r.egress || exitState.currentEgress || "");
        if (okIp && modelId) clearModelCooldown(okIp, modelId);
        return { res, abuse: false, sessionId: retrySession, retried: true, rotated: true };
      }
      const ra2 = res.headers.get("retry-after") || "";
      const t2 = await res.text().catch(() => "");
      if (ra2) retryAfter = ra2;
      if (t2) text429 = t2;
      const ip2 = normalizeEgress(r.egress || (await egressIpOf()));
      const ra2Ms = parseRetryAfterMs(ra2);
      if (ip2) {
        if (ra2Ms >= QUOTA_RETRY_AFTER_MS && modelId) {
          markModelCooldown(ip2, modelId, ra2Ms);
          egressState.dead.set(ip2, Date.now() + 60_000);
        } else {
          egressState.dead.set(ip2, Date.now() + Math.max(UNREACH_COOLDOWN_MS, ra2Ms));
        }
        saveDeadEgress();
      }
    }
    // 轮换救不回来 → 熔断 + 把最后一次 429（带 Retry-After）原样吐回
    egressState.blockedUntil = Date.now() + ROTATION_BLOCK_MS;
    return {
      res: new Response(text429, {
        status: 429,
        headers: {
          "content-type": "application/json",
          ...(retryAfter ? { "retry-after": retryAfter } : {}),
        },
      }),
      abuse: false,
      sessionId,
      rotated: true,
      retryAfter,
    };
  }
  return { res, abuse: false, sessionId };
}

/** 上游 SSE → OpenAI SSE：透传 + 保证终止帧 + tool_call 名回映射。
 *  ⚠ 注意：原实现只在缺 [DONE] 时补 [DONE]，但不补
 *  `finish_reason`。上游干净 EOF（TCP 正常关、不给 finish_reason）时客户端
 *  拿到的是一条没有终结原因的消息 —— OpenAI 协议里这就是"永远生成中"。
 *  终帧形状照 openai-python 的 chunk 定义：delta 空、finish_reason 非空。
 *
 *  ⭐ 重写（修"对话突然断、提示用户已取消"）：
 *  ① transform 里默认没有空闲超时，上游半死（TCP 挂着不出字节）时会永久挂住；
 *     现在每次 read 都有 idle 超时（UPSTREAM_IDLE_TIMEOUT_MS，默认 300s）。
 *  ② 上游中途 ECONNRESET/abort 时，pipeThrough 会把 error 传给客户端，客户端
 *     表现为流异常终止 → 只能报"用户已取消/网络错误"。现在改成**优雅收尾**：
 *     补 finish_reason + [DONE] 后正常 close，客户端看到完整结束。
 *  ③ 客户端主动取消（cancel）时立刻上游 abort，不再继续读白烧额度。
 *  ④ 中途失败会回调 onStreamError 供入口记结构化日志（原来是未捕获异常）。 */
function ssePipe(upstreamBody, alias, opts = {}) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let sawDone = false;
  let sawFinish = false;
  let sawToolCall = false;
  const chunkId = "chatcmpl-" + randomId(24);
  const created = Math.floor(Date.now() / 1000);
  const idleMs = opts.idleTimeoutMs ?? UPSTREAM_IDLE_TIMEOUT_MS;
  const onStreamError = typeof opts.onStreamError === "function" ? opts.onStreamError : null;
  const reader = upstreamBody.getReader();
  let clientCancelled = false;

  const flushTail = (controller) => {
    const tail = decoder.decode();
    if (tail) {
      try {
        controller.enqueue(encoder.encode(mapToolCallNames(tail, alias)));
      } catch {
        /* 已关闭则忽略 */
      }
    }
    try {
      if (!sawFinish && !sawDone) {
        const frame = {
          id: chunkId,
          object: "chat.completion.chunk",
          created,
          model: alias || "unknown",
          choices: [
            { index: 0, delta: {}, finish_reason: sawToolCall ? "tool_calls" : "stop" },
          ],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      }
      if (!sawDone) controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    } catch {
      /* 已关闭则忽略 */
    }
  };

  return new ReadableStream({
    async start(controller) {
      let idleTimer = null;
      const readOnce = () =>
        new Promise((resolve, reject) => {
          if (!(idleMs > 0)) {
            reader.read().then(resolve, reject);
            return;
          }
          idleTimer = setTimeout(() => {
            const err = new Error(`upstream idle timeout ${idleMs}ms`);
            err.name = "IdleTimeoutError";
            reject(err);
          }, idleMs);
          reader.read().then(
            (r) => {
              if (idleTimer) clearTimeout(idleTimer);
              resolve(r);
            },
            (e) => {
              if (idleTimer) clearTimeout(idleTimer);
              reject(e);
            },
          );
        });

      try {
        for (;;) {
          const { done, value } = await readOnce();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          if (text.includes("data: [DONE]") || text.includes("data:[DONE]")) sawDone = true;
          if (/"finish_reason"\s*:\s*"[^"]+"/.test(text)) sawFinish = true;
          if (text.includes('"tool_calls"')) sawToolCall = true;
          controller.enqueue(encoder.encode(mapToolCallNames(text, alias)));
        }
        flushTail(controller); // 干净 EOF：补齐终帧（保持旧行为，测试 D4 覆盖）
        controller.close();
      } catch (err) {
        // 上游中途断/空闲超时：已吐出的内容照常保留，补终帧后正常结束，
        // 不让客户端看到 error（那会被上层显示成"用户已取消/网络错误"）。
        // 客户端主动取消时 controller 已关闭，此时不该记成上游故障。
        if (!clientCancelled && onStreamError) {
          try {
            onStreamError(err);
          } catch {
            /* 日志回调自身异常不影响流 */
          }
        }
        if (!clientCancelled) {
          flushTail(controller);
          try {
            controller.close();
          } catch {
            /* 已关闭则忽略 */
          }
        }
        try {
          reader.cancel(err).catch(() => {});
        } catch {
          /* ignore */
        }
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
      }
    },
    cancel(reason) {
      // 客户端断开：立刻停上游，省额度（旧实现会继续读到超时）
      clientCancelled = true;
      try {
        reader.cancel(reason).catch(() => {});
      } catch {
        /* ignore */
      }
      const ctrl = opts.abortController;
      if (ctrl && !ctrl.signal.aborted) {
        try {
          ctrl.abort(new Error("client_cancelled"));
        } catch {
          /* ignore */
        }
      }
    },
  });
}

/** 非流式：把上游 SSE 聚合回一条 chat.completion JSON。 */
async function aggregateSSE(upstreamBody, opts = {}) {
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  const idleMs = opts.idleTimeoutMs ?? UPSTREAM_IDLE_TIMEOUT_MS;
  let buffer = "";
  let content = "";
  let reasoning = "";
  const toolCalls = [];
  let finish = null;
  let usage = null;
  let id = null;
  let model = null;
  let partial = false;
  for (;;) {
    // 与 ssePipe 一致：读流阶段加空闲超时，避免上游半死时永久挂住
    let idleTimer = null;
    let chunk;
    try {
      chunk = await new Promise((resolve, reject) => {
        if (!(idleMs > 0)) {
          reader.read().then(resolve, reject);
          return;
        }
        idleTimer = setTimeout(() => {
          const err = new Error(`upstream idle timeout ${idleMs}ms`);
          err.name = "IdleTimeoutError";
          reject(err);
        }, idleMs);
        reader.read().then(
          (r) => {
            if (idleTimer) clearTimeout(idleTimer);
            resolve(r);
          },
          (e) => {
            if (idleTimer) clearTimeout(idleTimer);
            reject(e);
          },
        );
      });
    } catch (err) {
      // 已经聚到内容就别丢：标记 partial，把已生成部分当正常完成返回
      if (!content && !reasoning && !toolCalls.length) throw err;
      partial = true;
      if (typeof opts.onStreamError === "function") {
        try {
          opts.onStreamError(err);
        } catch {
          /* 日志回调自身异常不影响聚合 */
        }
      }
      break;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
    }
    const { done, value } = chunk;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const obj = JSON.parse(payload);
        id = id || obj.id;
        model = model || obj.model;
        if (obj.usage) usage = obj.usage;
        for (const choice of obj.choices || []) {
          const d = choice.delta || {};
          if (typeof d.content === "string") content += d.content;
          if (typeof d.reasoning_content === "string") reasoning += d.reasoning_content;
          for (const tc of d.tool_calls || []) {
            const i = tc.index ?? toolCalls.length;
            if (!toolCalls[i]) {
              toolCalls[i] = { index: i, id: tc.id, type: "function", function: { name: "", arguments: "" } };
            }
            if (tc.id) toolCalls[i].id = tc.id;
            // name 只在首个 delta 上落名；个别上游每片都重复 name，
            // 相同则跳过、不同才追加，避免 "BashBash"。
            if (tc.function?.name) {
              const cur = toolCalls[i].function.name;
              if (!cur) toolCalls[i].function.name = tc.function.name;
              else if (tc.function.name !== cur) toolCalls[i].function.name += tc.function.name;
            }
            if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
          }
          if (choice.finish_reason) finish = choice.finish_reason;
        }
      } catch {
        /* 半行 JSON 等下一块 */
      }
    }
  }
  const message = { role: "assistant", content };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;
  const out = {
    id: id || `chatcmpl-newofm-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || "unknown",
    choices: [{ index: 0, message, finish_reason: finish || (toolCalls.length ? "tool_calls" : "stop") }],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
  if (partial) out.__partial = true; // 上游中途断，返回的是已聚合部分（入口据此记日志）
  return out;
}

// ────────────────────────────────────────────────────────────────
// 4. HTTP 服务（/health · /v1/models · /v1/chat/completions）
// ────────────────────────────────────────────────────────────────

function jsonResp(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

function openaiError(message, type, status) {
  return jsonResp({ error: { message, type } }, status);
}

/** 失败也要留一行日志。
 *  原代码只在成功分支 console.log，失败分支只 stats.err += 1 —— 于是
 *  零字节超时在 journal 里**一行都没有**，事后无从定位；只按日志数数会
 *  得出"全部 200、零故障"的结论，而 /health 的 err 计数已经在涨。 */
function logRequestFail(model, t0, kind, status, detail) {
  const ms = Date.now() - t0;
  const flat = String(detail || "").replace(/\s+/g, " ").slice(0, 220);
  console.log(`[newofm] FAIL ${model || "?"} ${kind} ${status} ${ms}ms ${flat}`);
}

async function handleChatCompletions(req) {
  stats.requests += 1;
  const t0 = Date.now();
  let body;
  try {
    body = await req.json();
  } catch {
    stats.err += 1;
    logRequestFail("?", t0, "bad_json", 400, "request body is not valid JSON");
    return openaiError("request body is not valid JSON", "invalid_request_error", 400);
  }
  if (!body || typeof body !== "object") {
    stats.err += 1;
    logRequestFail("?", t0, "bad_body", 400, "body is not an object");
    return openaiError("request body must be an object", "invalid_request_error", 400);
  }

  const facts = resolveModel(body.model);
  if (!facts) {
    stats.err += 1;
    logRequestFail(String(body.model || ""), t0, "unknown_model", 404, "not an available free model");
    return openaiError(
      `model '${body.model}' is not an available free model; GET /v1/models for the list`,
      "invalid_request_error",
      404,
    );
  }

  // 组上游 body。字段名与顺序对齐官方 CLI 的请求形状：
  // max_completion_tokens、tools 在 stream 前、**不发 store**。**上游恒发 stream:true** ——
  // 一是门禁消融要求 body 必须流式（dsh 项目 Gate 2），二是非流式
  // 客户端由下面的 aggregateSSE 聚合，行为完全一致。
  let messages = applyEnvBlock(body.messages, facts);
  const { body: anchored, alias, appended } = ensureReadAnchor({ ...body, messages });
  // 注入过门禁 stub → 系统提示开头加占位说明（模型别调它们）
  const note = buildPlaceholderNote(appended);
  if (note) {
    messages = messages.map((m, i) =>
      i === 0 && m && (m.role === "system" || m.role === "developer")
        ? { ...m, content: `${note}\n\n${typeof m.content === "string" ? m.content : ""}` }
        : m,
    );
  }
  const upstreamBody = {
    model: facts.id,
    messages,
    tools: anchored.tools,
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: adjustMaxTokens(facts, body.max_tokens ?? body.max_completion_tokens),
  };
  if (typeof body.temperature === "number") upstreamBody.temperature = body.temperature;
  if (typeof body.top_p === "number") upstreamBody.top_p = body.top_p;
  if (body.stop !== undefined) upstreamBody.stop = body.stop;
  if (body.response_format !== undefined) upstreamBody.response_format = body.response_format;
  if (body.reasoning_effort !== undefined) upstreamBody.reasoning_effort = body.reasoning_effort;
  if (anchored.tool_choice !== undefined) upstreamBody.tool_choice = anchored.tool_choice;

  const sessionId = sessionFromConversation(firstUserText(messages));
  // in_flight 窗口 = 整个上游往返：定时换池只在 0 时切节点（不掐生成中请求）
  exitState.inFlight += 1;
  let retryResult;
  try {
    retryResult = await postChatWithRetry(upstreamBody, sessionId);
  } catch (err) {
    // ⭐ 原来这里只有 finally，传输异常（TimeoutError /
    // ECONNRESET 重试后仍失败）会冒泡出 handler → Bun 直接断连接，客户端只能
    // 报"用户已取消"，日志里连 FAIL 行都没有。现在转成结构化 502。
    stats.err += 1;
    const msg = err && err.message ? err.message : String(err);
    logRequestFail(facts.id, t0, "upstream_transport", 502, msg.slice(0, 300));
    return openaiError(`upstream transport error: ${msg.slice(0, 300)}`, "upstream_error", 502);
  } finally {
    exitState.inFlight = Math.max(0, exitState.inFlight - 1);
  }
  const { res, abuse, gate, detail, sessionId: usedSession, retried, rotated } = retryResult;

  if (abuse) {
    stats.err += 1;
    logRequestFail(facts.id, t0, "ip_abuse", 403, detail);
    return openaiError(
      `upstream flagged this egress IP as abusive traffic (terminal, will not retry): ${detail}`,
      "ip_abuse",
      403,
    );
  }
  if (gate) {
    stats.err += 1;
    logRequestFail(facts.id, t0, "gate_rejected", 403, detail);
    return openaiError(
      `upstream gate rejected the request shape and retry is cooling down: ${detail}`,
      "gate_rejected",
      403,
    );
  }
  if (!res || !res.ok) {
    // 伪造车道救不回（429/5xx）→ 车道 B 兜底（官方身份额度桶独立）
    if (LANE_B_URL && (!res || res.status === 429 || res.status >= 500)) {
      const laneBody = {
        model: facts.id,
        messages: Array.isArray(body.messages) ? body.messages : messages,
        stream: body.stream === true,
      };
      for (const k of ["temperature", "top_p", "stop", "max_tokens", "max_completion_tokens", "response_format", "tools", "tool_choice"]) {
        if (body[k] !== undefined) laneBody[k] = body[k];
      }
      const laneB = await forwardToLaneB(laneBody, body.stream);
      if (laneB) {
        stats.ok += 1;
        console.log(`[newofm] ${facts.id} ${body.stream ? "stream" : "batch"} 200 via lane-b ${Date.now() - t0}ms`);
        return laneB;
      }
    }
    stats.err += 1;
    const status = res && res.status ? res.status : 502;
    const text = res ? await res.text().catch(() => "") : "no response";
    const ra = res && res.headers ? res.headers.get("retry-after") : "";
    const raNote = ra
      ? `；出口窗口额度已耗尽，约 ${Math.round(Number(ra) / 360) / 10} 小时后随最早一批请求滚出 24h 窗口而恢复，轮换熔断中不再自动换出口`
      : "";
    logRequestFail(facts.id, t0, `upstream_${status}`, status, `${text.slice(0, 200)}${ra ? ` retry-after=${ra}` : ""}`);
    return openaiError(
      `upstream HTTP ${res ? res.status : "?"}: ${text.slice(0, 400)}${raNote}`,
      "upstream_error",
      res && res.status >= 400 && res.status < 600 ? res.status : 502,
    );
  }

  stats.ok += 1;
  const ms = Date.now() - t0;
  console.log(
    `[newofm] ${facts.id} ses=${usedSession.slice(4, 10)} ${retried ? "retried " : ""}` +
      `${rotated ? "rotated " : ""}` +
      // ttfb＝上游响应头到达时刻；缺值时打 "-"（重试链里最后一次调用的响应才有）
      `ttfb=${typeof res.__ttfbMs === "number" ? res.__ttfbMs + "ms" : "-"} ` +
      `${body.stream ? "stream" : "batch"} ${res.status} ${ms}ms`,
  );

  if (body.stream) {
    return new Response(
      ssePipe(res.body, alias, {
        abortController: res.__abort,
        onStreamError: (err) => {
          // 已吐内容照常保留并补终帧；这里只负责留下结构化痕迹
          logRequestFail(
            facts.id,
            t0,
            "stream_interrupted",
            200,
            String(err && err.message ? err.message : err).slice(0, 200),
          );
        },
      }),
      {
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      },
    );
  }
  try {
    const agg = await aggregateSSE(res.body, {
      abortController: res.__abort,
      onStreamError: (err) => {
        logRequestFail(
          facts.id,
          t0,
          "batch_interrupted",
          200,
          String(err && err.message ? err.message : err).slice(0, 200),
        );
      },
    });
    return jsonResp(agg);
  } catch (err) {
    stats.err += 1;
    logRequestFail(facts.id, t0, "aggregate_failed", 502, String(err));
    return openaiError(`stream aggregation failed: ${err}`, "upstream_error", 502);
  }
}

function handleModels() {
  return jsonResp({
    object: "list",
    data: catalog.models.map((m) => ({
      id: m.id,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "opencode-zen-free",
    })),
  });
}

function handleHealth() {
  return jsonResp({
    ok: true,
    engine: "lane-a-forged",
    version: VERSION,
    identity: {
      userAgent: buildHeaders("ses_00000000000000000000000000")["user-agent"],
      sessionPrefix: SESSION_PREFIX,
      gateAnchors: GATE_ANCHORS,
      toolProfile: TOOL_PROFILE,
      requiredTools: REQUIRED_TOOL_NAMES,
    },
    catalog: {
      source: catalog.source,
      count: catalog.models.length,
      fetchedAt: catalog.fetchedAt,
      lastError: catalogLastError,
    },
    egress: { proxy: UPSTREAM_PROXY, mode: UPSTREAM_PROXY ? "proxy" : "direct" },
    exit_pool: exitPoolStatus(),
    upstream: { chatUrl: UPSTREAM_CHAT_URL, catalogUrl: CATALOG_URL },
    stats: { ...stats, uptime_s: Math.floor((Date.now() - stats.started) / 1000) },
  });
}

/** 请求路由（导出供测试直接调用，不起端口）。 */
async function handleFetch(req) {
  const url = new URL(req.url);
  // /healthz 是常见的探活路径同义名：不少监控与进程守护默认探它，
  // 只提供 /health 会让"活着"被判成"挂了"。两个路径完全等价。
  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/healthz")) {
    return handleHealth();
  }
  if (req.method === "GET" && url.pathname === "/v1/models") return handleModels();
  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    return handleChatCompletions(req);
  }
  return openaiError(`no route for ${req.method} ${url.pathname}`, "not_found", 404);
}

// ────────────────────────────────────────────────────────────────
// 5. 入口（仅直接运行时监听；被 import 时不启动，供测试）
// ────────────────────────────────────────────────────────────────

loadDeadEgress();
loadNodeIpMap();
loadConversationSessions(); // 会话亲和 + prompt cache 跨重启保留
loadModelCooldown(); // (出口IP, 模型) 额度冷却跨重启保留

if (import.meta.main) {
  loadCatalogCache();
  refreshCatalog(); // 异步补 live 目录，不阻塞启动
  Bun.serve({
    port: PORT,
    hostname: HOST,
    fetch: handleFetch,
    maxRequestBodySize: MAX_BODY_BYTES,
    // 默认 10s 会掐断长思考的流式响应（实测警告）；
    // 255 是 Bun 允许的最大秒数
    idleTimeout: 255,
  });
  console.log(
    `[newofm] v${VERSION} lane-a-forged listening on http://${HOST}:${PORT} ` +
      `(catalog=${catalog.source}/${catalog.models.length}, egress=${UPSTREAM_PROXY || "direct"}, ` +
      `rotate=${ROTATE_ON_429 ? "on" : "off"}/${MAX_ROTATE}, timed=${TIMED_ROTATE_MIN}min, ` +
      `sock=${CLASH_SOCK ? "ok" : "absent"})`,
  );
  // 定时换池（默认 60 分钟）：到期后等 in_flight==0 再切（忙则下个周期再看）。
  // 依据实测：额度按请求数/出口分池，重负载 47~70 分钟
  // 打空一个池；定时换池把用量切成小份分摊 41 节点，原池归来时早已重置。
  if (TIMED_ROTATE_MIN > 0 && CLASH_SOCK) {
    let lastTimedRotateAt = Date.now();
    let timedDue = false;
    setInterval(() => {
      if (!timedDue && Date.now() - lastTimedRotateAt >= TIMED_ROTATE_MIN * 60000) {
        timedDue = true;
      }
      if (timedDue && exitState.inFlight === 0) {
        timedDue = false;
        lastTimedRotateAt = Date.now();
        rotateExit("timed").catch(() => {});
      }
    }, 60_000);
  }
  // 启动即读当前出口（/health 的 exit_pool.current 不再是空串）
  if (CLASH_SOCK) {
    groupInfo()
      .then((info) => {
        if (info) exitState.current = info.now || "";
      })
      .catch(() => {});
  }
}

export {
  // 身份推导
  createSessionId,
  sessionFromConversation,
  buildHeaders,
  projectHash,
  ensureReadAnchor,
  withHarnessEnvBlock,
  buildHarnessEnvBlock,
  harnessSystemText,
  HARNESS_MARKER,
  applyEnvBlock,
  firstUserText,
  mapToolCallNames,
  SESSION_SHAPE,
  GATE_ANCHORS,
  READ_TOOL_STUB,
  SHELL_TOOL_STUB,
  GATE_TOOL_STUBS,
  randomId,
  randomHex,
  buildPlaceholderNote,
  MAX_OUTPUT_TOKENS,
  // 目录
  parseUpstreamCatalog,
  isFreeEntry,
  resolveModel,
  adjustMaxTokens,
  refreshCatalog,
  // 上游
  callUpstream,
  postChatWithRetry,
  isAbuseRejection,
  aggregateSSE,
  // 服务
  handleFetch,
  handleChatCompletions,
  handleModels,
  handleHealth,
  // 状态（测试用）
  catalog,
  stats,
  // 出口轮换
  rotateExit,
  pickCandidates,
  ssePipe,
  logRequestFail,
  ROTATE_BUDGET_MS,
  ROTATE_SCAN_MAX,
  exitPoolStatus,
  exitState,
  egressState,
  normalizeEgress,
  loadNodeIpMap,
  egressIpOf,
  // 模型级冷却
  parseRetryAfterMs,
  markModelCooldown,
  clearModelCooldown,
  loadModelCooldown,
  QUOTA_RETRY_AFTER_MS,
  MODEL_COOLDOWN_MAX_MS,
};
