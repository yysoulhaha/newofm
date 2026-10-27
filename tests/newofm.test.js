/**
 * newofm 测试（bun test）。
 *
 * A 段纯函数离线确定性测试，B 段 mock fetch 集成测试
 * （不发真实网络请求、不消耗额度），边界情形逐条枚举。
 *
 * 运行：bun test tests/newofm.test.js
 */
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";

// ── 环境必须在 import 前设好（模块在 import 时读配置）──────────
const TMP = mkdtempSync(join(tmpdir(), "newofm_test_"));
process.env.NEWOFM_CACHE_DIR = TMP;
process.env.UPSTREAM_PROXY_URL = "http://127.0.0.1:7897";
process.env.NEWOFM_CLI_VERSION = "9.9.9"; // 便于断言 UA 形状
process.env.GATE_RETRY_COOLDOWN_MS = "0"; // 测试里不冷却
// 显式空串＝关掉出口轮换。否则测试会自动探测本机的 mihomo unix socket，
// 可能把你正在使用的代理组切走。
process.env.NEWOFM_CLASH_SOCK = "";

const SRC = new URL("../newofm.js", import.meta.url);
const nw = await import(SRC.href);

// ── mock fetch ────────────────────────────────────────────────
let fetchCalls = [];
let fetchImpl = async () => new Response("{}", { status: 200 });
const realFetch = globalThis.fetch;

beforeEach(() => {
  fetchCalls = [];
  fetchImpl = async () => new Response("{}", { status: 200 });
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    return fetchImpl(url, init);
  };
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

// ── 小工具 ────────────────────────────────────────────────────
function sseChunk(content, extra = {}) {
  return (
    "data: " +
    JSON.stringify({
      id: "chatcmpl-x",
      object: "chat.completion",
      created: 1,
      model: "big-pickle",
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
      ...extra,
    }) +
    "\n\n"
  );
}

function sseToolChunk(name, args = "") {
  return (
    "data: " +
    JSON.stringify({
      id: "chatcmpl-x",
      object: "chat.completion",
      created: 1,
      model: "big-pickle",
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name, arguments: args } }] },
          finish_reason: null,
        },
      ],
    }) +
    "\n\n"
  );
}

function sseUsageChunk() {
  return (
    "data: " +
    JSON.stringify({
      id: "chatcmpl-x",
      object: "chat.completion",
      created: 1,
      model: "big-pickle",
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }) +
    "\n\n"
  );
}

function sseResponse(parts, { usage = true } = {}) {
  // 真实上游在 stream_options.include_usage 下会在末尾补一个 usage chunk
  const all = usage ? parts.concat([sseUsageChunk()]) : parts;
  return new Response(all.join("") + "data: [DONE]\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function chatReq(body) {
  return new Request("http://127.0.0.1:8920/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ════════════════════════════════════════════════════════════════
// A 段：身份推导纯函数（offline，确定性）
// ════════════════════════════════════════════════════════════════

describe("A 段 · 身份推导", () => {
  test("A1 createSessionId 形状合规 ses_[0-9a-f]{12}[0-9A-Za-z]{14}", () => {
    for (let i = 0; i < 200; i++) {
      const id = nw.createSessionId();
      expect(id).toMatch(nw.SESSION_SHAPE);
      expect(id.length).toBe(4 + 26);
    }
  });

  test("A2 createSessionId 同毫秒递增 k（官方计数器语义），尾部随机确定", () => {
    let seq = 0;
    const rng = () => {
      seq += 1;
      return (seq % 100) / 100;
    };
    // ⭐ 官方算法含同毫秒计数器（k 从 1 起），同 ms 两次调用 k 不同是特性
    // （官方用它保证同 ms 多 session 严格递增）；确定性体现在：固定 timestamp
    // 时 12 hex 只随 k 单调变化，14 位尾部由 rng 完全决定。
    const a = nw.createSessionId({ timestamp: 1792933289000, rng });
    seq = 0;
    const b = nw.createSessionId({ timestamp: 1792933289000, rng });
    expect(a.slice(16)).toBe(b.slice(16)); // 尾部 14 位由 rng 决定 → 确定
    expect(a.slice(4, 12)).toBe(b.slice(4, 12)); // 高 8 hex（时间戳主体）相同
    const ka = ~BigInt("0x" + a.slice(4, 16)) & 0xfffn;
    const kb = ~BigInt("0x" + b.slice(4, 16)) & 0xfffn;
    expect(Number(kb)).toBe(Number(ka) + 1); // k 严格递增（同 ms）
    expect(Number(ka)).toBeGreaterThanOrEqual(1);
    expect(a).toMatch(/^ses_[0-9a-f]{12}/);
  });

  test("A3 同一毫秒多次生成不重复（尾部随机兜底）", () => {
    const ids = new Set();
    let seq = 0;
    const rng = () => ((seq = (seq + 7) % 97) / 97);
    for (let i = 0; i < 50; i++) ids.add(nw.createSessionId({ timestamp: 1792933289000, rng }));
    expect(ids.size).toBe(50);
  });

  test("A3b 同毫秒 200 连发，反转计数器恒落在门禁接受的 [0xfc0,0xfff]", () => {
    // 定案（2dsh issue #62 实测互证）：门禁把 12 hex 反转回
    // 原始计数器并只接受 [0,63]，即反转后低 12 位必须 ≥ 0xfc0。超限必须
    // 进位到下一毫秒，而不是让 k 涨到 64+（那会被伪装成 429）。
    let seq = 0;
    const rng = () => ((seq = (seq + 11) % 101) / 101);
    const ts = 1792933289000;
    for (let i = 0; i < 200; i++) {
      const id = nw.createSessionId({ timestamp: ts, rng });
      const hex = id.slice(4, 16);
      const inv = BigInt("0x" + hex);
      const low12 = inv & 0xfffn;
      expect(Number(low12)).toBeGreaterThanOrEqual(0xfc0);
      expect(Number(low12)).toBeLessThanOrEqual(0xfff);
      // 反解出的原始计数器必须 ≤ 63（含进位后的等价表述）
      expect(Number(0xfffn - low12)).toBeLessThanOrEqual(63);
    }
  });

  test("A4 sessionFromConversation 同对话同 id、异对话异 id、形状合规", () => {
    const a1 = nw.sessionFromConversation("帮我算 1+1");
    const a2 = nw.sessionFromConversation("帮我算 1+1");
    const b = nw.sessionFromConversation("帮我算 2+2");
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(a1).toMatch(nw.SESSION_SHAPE);
    expect(nw.sessionFromConversation("")).toMatch(nw.SESSION_SHAPE);
  });

  test("A4b session 前缀走官方时间戳算法（k≥1；低 12 位恒 ≠ 0xfff）", () => {
    const store = new Map();
    const ts = 1792933289000;
    const id = nw.sessionFromConversation("前缀测试", { store, timestamp: ts, rng: () => 0.5 });
    expect(id).toMatch(/^ses_e[0-9a-f]{11}/); // 当前时段官方前缀的邻域形态
    // ⭐ 实测定案：官方算法 = ~(ts×0x1000 + k)，k∈[1,100]
    // （同毫秒计数器从 1 起）。低 12 位 = 0xfff-k，恒 ≠ 0xfff —— k=0 的值在
    // 真实空间不存在，门禁以 FreeUsageLimitError 伪装拒绝（CLI 抓包 4ffe、
    // 参考桥 effe/5ffe/1ffe/0ffe 均印证）。旧实现 ~(ts×0x1000) 低 12 位恒
    // 0xfff → 全天 429 的真因。
    const v = BigInt("0x" + id.slice(4, 16));
    const x = ~v & ((1n << 48n) - 1n);
    const k = x & 0xfffn; // x 的低 12 位 = k（extraMs 只影响高位），与计数器状态无关
    expect(k >= 1n && k <= 100n).toBe(true);
    // ts×0x1000 是 60 位，掩码后只剩低 48 位——须对低 48 位基值比较
    const base = (BigInt(ts) * 0x1000n) & ((1n << 48n) - 1n);
    expect(x).toBeGreaterThanOrEqual(base + 1n);
    expect(id.slice(13, 16)).not.toBe("fff"); // 低 12 位（末 3 hex）
    // 注入 store 复用：同对话再取还是同一个（会话亲和）
    expect(nw.sessionFromConversation("前缀测试", { store })).toBe(id);
  });

  test("A5 buildHeaders 七头齐全、UA 形状、session 三头同值、匿名钥匙", () => {
    const sid = nw.createSessionId({ timestamp: 1792933289000, rng: () => 0.5 });
    const h = nw.buildHeaders(sid);
    expect(h["user-agent"]).toBe("opencode/latest/9.9.9/cli"); // 第四段是 cli（抓包实证）
    expect(h["x-opencode-session"]).toBe(sid);
    expect(h["x-opencode-session-id"]).toBe(sid);
    expect(h["x-session-affinity"]).toBe(sid);
    expect(h["x-session-id"]).toBe(sid); // 小写！大写被网关 429（线上字节实证）
    expect(h["x-opencode-client"]).toBe("cli");
    expect(h["x-opencode-project"]).toMatch(/^[0-9a-f]{40}$/); // 40 位十六进制（抓包实证）
    // 官方明文捕获定案：官方 CLI 不发 x-opencode-request，对齐删除
    expect(h["x-opencode-request"]).toBeUndefined();
    // b3 / traceparent 追踪对（Zipkin B3 + W3C，抓包实证）
    expect(h["b3"]).toMatch(/^[0-9a-f]{32}-[0-9a-f]{16}-1-[0-9a-f]{16}$/);
    expect(h["traceparent"]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(h["b3"].split("-")[0]).toBe(h["traceparent"].split("-")[1]); // 同一 trace
    // 官方捕获：traceId 同会话稳定（spanId 每请求新造）
    const h2 = nw.buildHeaders(sid);
    expect(h2["b3"].split("-")[0]).toBe(h["b3"].split("-")[0]);
    expect(h2["b3"].split("-")[1]).not.toBe(h["b3"].split("-")[1]);
    expect(h["authorization"]).toBe("Bearer public");
    // 三个门禁锚点头必须在场
    for (const name of nw.GATE_ANCHORS.headers) expect(h[name]).toBeTruthy();
    // 两个门禁锚点工具
    expect(nw.GATE_ANCHORS.tools).toEqual(["read", "shell"]);
  });

  test("A6a ensureReadAnchor 无 tools → 注入 read+shell 双锚点", () => {
    const { body, alias } = nw.ensureReadAnchor({ messages: [] });
    expect(body.tools.map((t) => t.function.name).sort()).toEqual(["read", "shell"]);
    expect(alias.size).toBe(0);
    // stub 定义与抓包一致（关键字段）
    const read = body.tools.find((t) => t.function.name === "read");
    const shell = body.tools.find((t) => t.function.name === "shell");
    expect(read.function.parameters.required).toEqual(["path"]);
    expect(shell.function.parameters.required).toEqual(["command"]);
  });

  test("A6b ensureReadAnchor 有 tools 无锚点 → 追加两个", () => {
    const { body } = nw.ensureReadAnchor({
      tools: [{ type: "function", function: { name: "Bash", parameters: {} } }],
    });
    expect(body.tools.map((t) => t.function.name).sort()).toEqual(["Bash", "read", "shell"]);
  });

  test("A6c ensureReadAnchor 客户端 read → 改名 read_client 且补锚点、可回映射", () => {
    const { body, alias } = nw.ensureReadAnchor({
      tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
    });
    // 客户端的 read 改名 read_client；门禁锚点 read + shell 由 stub 补上
    expect(body.tools.map((t) => t.function.name).sort()).toEqual(["read", "read_client", "shell"]);
    expect(alias.get("read_client")).toBe("read");
  });

  test("A6d ensureReadAnchor tool_choice none 被丢弃（上游 403）", () => {
    const { body } = nw.ensureReadAnchor({ tool_choice: "none" });
    expect(body.tool_choice).toBeUndefined();
  });

  test("A6e ensureReadAnchor tool_choice 对象指向 read → 映射为 read_client", () => {
    const { body } = nw.ensureReadAnchor({
      tools: [{ type: "function", function: { name: "read" } }],
      tool_choice: { type: "function", function: { name: "read" } },
    });
    expect(body.tool_choice.function.name).toBe("read_client");
  });

  test("A6f ensureReadAnchor tool_choice auto 原样保留", () => {
    const { body } = nw.ensureReadAnchor({ tool_choice: "auto" });
    expect(body.tool_choice).toBe("auto");
  });

  test("A7 mapToolCallNames 回映射 read_client→read，其余行原样", () => {
    const alias = new Map([["read_client", "read"]]);
    const out = nw.mapToolCallNames(sseToolChunk("read_client", '{"path":"a"}'), alias);
    expect(out).toContain('"name":"read"');
    expect(out).not.toContain("read_client");
    // 非 JSON 行 / [DONE] 不动
    expect(nw.mapToolCallNames("data: [DONE]\n\n", alias)).toBe("data: [DONE]\n\n");
    expect(nw.mapToolCallNames(": keep-alive\n\n", alias)).toBe(": keep-alive\n\n");
    // 空 alias 时零开销原样返回
    const raw = sseToolChunk("read_client");
    expect(nw.mapToolCallNames(raw, null)).toBe(raw);
  });

  const FACTS = { id: "big-pickle", name: "Big Pickle", reasoning: true, maxOutput: 32000 };

  test("A8a withHarnessEnvBlock 空提示 → 生成完整 harness 提示词", () => {
    const out = nw.withHarnessEnvBlock("", FACTS);
    // 门禁要的是 CLI 原文，不只是 env 块（冒烟实证）
    expect(out).toContain(nw.HARNESS_MARKER);
    expect(out).toContain("<env>");
    expect(out).toContain("Working directory:");
    expect(out).toContain("</env>");
    expect(out).toContain("- Name: Big Pickle");
    expect(out).toContain("- Model ID: big-pickle");
    expect(out).toContain("Today's date:");
  });

  test("A8b withHarnessEnvBlock 已含 harness 标记 → 原文不动（幂等）", () => {
    const src = `你是助手\n${nw.HARNESS_MARKER} blah\n<env>\n  Working directory: /tmp\n</env>`;
    expect(nw.withHarnessEnvBlock(src, FACTS)).toBe(src);
  });

  test("A8b2 只有 env 块没有 harness 标记 → 仍补完整提示词（env 块不足过门禁）", () => {
    const src = "你是助手\n<env>\n  Working directory: /tmp\n</env>";
    const out = nw.withHarnessEnvBlock(src, FACTS);
    expect(out.startsWith("你是助手")).toBe(true);
    expect(out).toContain(nw.HARNESS_MARKER);
    expect(out.match(/<env>/g)).toHaveLength(2); // 客户端自带一个 + harness 自带一个
  });

  test("A8c withHarnessEnvBlock 普通提示 → 原文 + 完整提示词（只加一次）", () => {
    const out = nw.withHarnessEnvBlock("你是助手", FACTS);
    expect(out.startsWith("你是助手")).toBe(true);
    expect(out.split(nw.HARNESS_MARKER).length - 1).toBe(1);
    // 非字符串输入也能造完整提示
    expect(nw.withHarnessEnvBlock(undefined, FACTS)).toContain("Working directory:");
  });

  test("A8d harnessSystemText 按模型填 # Your Model 段落", () => {
    const glm = nw.harnessSystemText({ id: "glm-5.3-flash-free", name: "GLM-5.3-Flash Free" });
    expect(glm).toContain("- Name: GLM-5.3-Flash Free");
    expect(glm).toContain("- Model ID: glm-5.3-flash-free");
    expect(glm).not.toContain("Big Pickle");
    // 缺 name 时退回 id
    const noName = nw.harnessSystemText({ id: "beam-free" });
    expect(noName).toContain("- Name: beam-free");
  });

  test("A9 applyEnvBlock 无 system 插一条 / 有 system 追加 / developer 也认", () => {
    const a = nw.applyEnvBlock([{ role: "user", content: "hi" }], FACTS);
    expect(a[0].role).toBe("system");
    expect(a[0].content).toContain(nw.HARNESS_MARKER);
    expect(a[0].content).toContain("<env>");
    expect(a).toHaveLength(2);
    const b = nw.applyEnvBlock([{ role: "system", content: "sys" }, { role: "user", content: "hi" }], FACTS);
    expect(b).toHaveLength(2);
    expect(b[0].content).toContain("sys");
    expect(b[0].content).toContain(nw.HARNESS_MARKER);
    expect(b[0].content).toContain("<env>");
    const c = nw.applyEnvBlock([{ role: "developer", content: "dev" }], FACTS);
    expect(c[0].content).toContain(nw.HARNESS_MARKER);
    // 不改原数组
    const orig = [{ role: "user", content: "hi" }];
    nw.applyEnvBlock(orig, FACTS);
    expect(orig).toHaveLength(1);
  });

  test("A10 firstUserText 字符串 / 多段数组 / 无 user", () => {
    expect(nw.firstUserText([{ role: "system", content: "s" }, { role: "user", content: "u" }])).toBe("u");
    expect(
      nw.firstUserText([{ role: "user", content: [{ type: "text", text: "a" }, { type: "image_url" }, { type: "text", text: "b" }] }]),
    ).toBe("a\nb");
    expect(nw.firstUserText([{ role: "system", content: "s" }])).toBe("");
    expect(nw.firstUserText(null)).toBe("");
  });
});

// ════════════════════════════════════════════════════════════════
// B 段：目录（offline）
// ════════════════════════════════════════════════════════════════

describe("B 段 · 目录", () => {
  test("B1 isFreeEntry 零价且未废弃才算免费", () => {
    expect(nw.isFreeEntry({ cost: { input: 0 } })).toBe(true);
    expect(nw.isFreeEntry({ cost: { input: 0 }, status: "deprecated" })).toBe(false);
    expect(nw.isFreeEntry({ cost: { input: 0.5 } })).toBe(false);
    expect(nw.isFreeEntry({})).toBe(false);
    expect(nw.isFreeEntry(null)).toBe(false);
  });

  test("B2 parseUpstreamCatalog 只取 opencode provider + 事实表 + api 字段", () => {
    const { models, api } = nw.parseUpstreamCatalog({
      providers: {
        opencode: {
          api: "https://opencode.ai/inference/openai/v1",
          models: {
            "big-pickle": { cost: { input: 0 }, limit: { output: 8192 } },
            "paid-x": { cost: { input: 1 } },
            "dead-free": { cost: { input: 0 }, status: "deprecated" },
            "glm-5.3-flash-free": { cost: { input: 0 }, reasoning: true, limit: { output: 16384 } },
          },
        },
        openrouter: {
          models: { "or-free": { cost: { input: 0 } } }, // 别家零价模型不收
        },
      },
    });
    expect(models.map((m) => m.id).sort()).toEqual(["big-pickle", "glm-5.3-flash-free"]);
    const glm = models.find((m) => m.id === "glm-5.3-flash-free");
    expect(glm.reasoning).toBe(true);
    expect(glm.maxOutput).toBe(16384);
    expect(models.find((m) => m.id === "big-pickle").reasoning).toBe(false);
    expect(api).toBe("https://opencode.ai/inference/openai/v1");
  });

  test("B2b parseUpstreamCatalog 扁平结构（真实目录形态，无 providers 包裹）", () => {
    const { models, api } = nw.parseUpstreamCatalog({
      opencode: {
        api: "https://opencode.ai/inference/openai/v1/",
        models: {
          "big-pickle": { cost: { input: 0, output: 0 }, reasoning: true, limit: { output: 32000 } },
          "longcat-2.5-preview-free": { cost: { input: 0 }, status: "deprecated" },
        },
      },
      google: { models: { "gemini-x": { cost: { input: 0 } } } }, // 非 opencode provider 忽略
    });
    expect(models.map((m) => m.id)).toEqual(["big-pickle"]);
    expect(models[0].maxOutput).toBe(32000);
    expect(api).toBe("https://opencode.ai/inference/openai/v1"); // 尾斜线剥掉
  });

  test("B3 resolveModel 精确 / 前缀 / 家族简写 / 未知 / 歧义", () => {
    expect(nw.resolveModel("big-pickle").id).toBe("big-pickle");
    expect(nw.resolveModel("opencode/big-pickle").id).toBe("big-pickle");
    expect(nw.resolveModel("mimo").id).toBe("mimo-v2.6-flash-free"); // 唯一前缀命中
    expect(nw.resolveModel("no-such-model")).toBeNull();
    expect(nw.resolveModel("nemotron")).toBeNull(); // 三个 nemotron 前缀 → 歧义不猜
    expect(nw.resolveModel("")).toBeNull();
  });

  test("B4 adjustMaxTokens 无显式请求→模型上限；思考下限/封顶；普通下限", () => {
    // 无显式请求：要 131072 再封顶到模型 limit.output（参考桥实测行为）
    expect(nw.adjustMaxTokens({ reasoning: true, maxOutput: 32000 }, null)).toBe(32000);
    expect(nw.adjustMaxTokens({ reasoning: true, maxOutput: 32000 }, undefined)).toBe(32000);
    expect(nw.adjustMaxTokens({ reasoning: true }, null)).toBe(135168); // 无封顶时 131072+4096
    expect(nw.adjustMaxTokens({ reasoning: false, maxOutput: 32000 }, null)).toBe(32000);
    expect(nw.adjustMaxTokens(null, null)).toBe(nw.MAX_OUTPUT_TOKENS);
    // 显式小请求：加法下限（思考）/ 普通下限
    expect(nw.adjustMaxTokens({ reasoning: true }, 100)).toBe(5120); // max(100,1024)+4096
    expect(nw.adjustMaxTokens({ reasoning: true, maxOutput: 4000 }, 100)).toBe(4000); // 封顶
    expect(nw.adjustMaxTokens({ reasoning: true, maxOutput: 6000 }, 100)).toBe(5120); // 未触顶
    expect(nw.adjustMaxTokens({ reasoning: false }, 100)).toBe(512);
    expect(nw.adjustMaxTokens({ reasoning: false }, 4096)).toBe(4096);
  });

  test("B5 buildPlaceholderNote 复数/单数/空", () => {
    // 改为逗号列表句式（full profile 12 个工具时更自然）
    expect(nw.buildPlaceholderNote(["read", "shell"])).toBe(
      "The following tools are placeholders that do nothing; do not call them: `read`, `shell`. Use the other tools you have been given instead.",
    );
    expect(nw.buildPlaceholderNote(["read"])).toBe(
      "The following tools are placeholders that do nothing; do not call them: `read`. Use the other tools you have been given instead.",
    );
    expect(nw.buildPlaceholderNote([])).toBe("");
    expect(nw.buildPlaceholderNote(null)).toBe("");
  });
});

// ════════════════════════════════════════════════════════════════
// C 段：服务端集成（mock fetch，不发真实请求）
// ════════════════════════════════════════════════════════════════

describe("C 段 · 服务端集成", () => {
  test("C1 /v1/models 返回静态种子全量（9 个活着的免费模型）", async () => {
    const res = await nw.handleFetch(new Request("http://127.0.0.1:8920/v1/models"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe("list");
    expect(body.data).toHaveLength(9);
    expect(body.data.map((m) => m.id)).toContain("big-pickle");
    expect(body.data.map((m) => m.id)).toContain("flint-40b-free");
    // 已废弃的不出现
    expect(body.data.map((m) => m.id)).not.toContain("longcat-2.5-preview-free");
    expect(body.data.map((m) => m.id)).not.toContain("space-bunny-free");
  });

  test("C2 /health 结构完整", async () => {
    const res = await nw.handleFetch(new Request("http://127.0.0.1:8920/health"));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.engine).toBe("lane-a-forged");
    expect(body.identity.userAgent).toBe("opencode/latest/9.9.9/cli");
    expect(body.identity.sessionPrefix).toBe("ses_");
    expect(body.catalog.source).toBe("static");
    expect(body.egress.proxy).toBe("http://127.0.0.1:7897");
  });

  test("C3 未知路由 404", async () => {
    const res = await nw.handleFetch(new Request("http://127.0.0.1:8920/nope"));
    expect(res.status).toBe(404);
  });

  test("C4 非流式：聚合 SSE 为完整 JSON，且上游请求过齐四道门禁", async () => {
    fetchImpl = async () => sseResponse([sseChunk("你"), sseChunk("好")]);
    const res = await nw.handleFetch(
      chatReq({ model: "big-pickle", messages: [{ role: "user", content: "在吗" }] }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choices[0].message.content).toBe("你好");
    expect(body.usage.total_tokens).toBe(3);

    // 断言上游请求形状
    expect(fetchCalls).toHaveLength(1);
    const call = fetchCalls[0];
    expect(call.url).toBe("https://opencode.ai/inference/openai/v1/chat/completions");
    expect(call.init.method).toBe("POST");
    expect(call.init.proxy).toBe("http://127.0.0.1:7897"); // 走 Clash 出口
    const h = call.init.headers;
    expect(h["authorization"]).toBe("Bearer public");
    expect(h["user-agent"]).toBe("opencode/latest/9.9.9/cli");
    expect(h["x-opencode-session"]).toMatch(nw.SESSION_SHAPE);
    expect(h["x-session-affinity"]).toBe(h["x-opencode-session"]);
    const up = JSON.parse(call.init.body);
    expect(up.stream).toBe(true); // 上游恒流式（门禁 + 聚合需要）
    expect(up.store).toBeUndefined(); // 2.1.4 抓包无 store 字段，不发
    expect(up.max_completion_tokens).toBe(32000); // 无显式请求 → 封顶到模型上限（参考桥实证）
    expect(up.tools.some((t) => t.function.name === "read")).toBe(true); // 门禁 3a
    expect(up.tools.some((t) => t.function.name === "shell")).toBe(true); // 门禁 3b
    expect(up.messages[0].role).toBe("system");
    expect(up.messages[0].content).toContain(nw.HARNESS_MARKER); // 门禁 4：完整 harness 原文
    expect(up.messages[0].content).toContain("<env>");
    expect(up.messages[0].content).toContain("Working directory:");
    // 占位工具提示（注入 stub 时系统提示开头；现为逗号列表句式）
    expect(up.messages[0].content.startsWith("The following tools are placeholders")).toBe(true);
    // 追踪对也得上链路
    expect(call.init.headers["b3"]).toMatch(/^[0-9a-f]{32}-/);
    expect(up.messages[0].role).toBe("system");
    expect(up.messages[0].content).toContain("<env>"); // 门禁 4
    expect(up.messages[0].content).toContain("Working directory:");
  });

  test("C5 流式：透传 SSE + [DONE]，content-type 正确", async () => {
    fetchImpl = async () => sseResponse([sseChunk("甲"), sseChunk("乙")]);
    const res = await nw.handleFetch(
      chatReq({ model: "big-pickle", stream: true, messages: [{ role: "user", content: "hi" }] }),
    );
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("甲");
    expect(text).toContain("乙");
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  test("C6 流式 + 客户端 read 工具 → 回程 tool_call 名映射", async () => {
    fetchImpl = async () =>
      sseResponse([sseToolChunk("read_client", '{"path":'), sseToolChunk("read_client", '"/a"}')]);
    const res = await nw.handleFetch(
      chatReq({
        model: "big-pickle",
        stream: true,
        tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
        messages: [{ role: "user", content: "读文件" }],
      }),
    );
    const text = await res.text();
    expect(text).toContain('"name":"read"');
    expect(text).not.toContain("read_client");
  });

  test("C7 上游不带 [DONE] 时网官补发", async () => {
    fetchImpl = async () =>
      new Response(sseChunk("x"), { status: 200, headers: { "content-type": "text/event-stream" } });
    const res = await nw.handleFetch(
      chatReq({ model: "big-pickle", stream: true, messages: [{ role: "user", content: "hi" }] }),
    );
    const text = await res.text();
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  test("C8 403 门禁拒绝 → 换新 session 重试一次并成功", async () => {
    let n = 0;
    fetchImpl = async () => {
      n += 1;
      if (n === 1) {
        return new Response(
          JSON.stringify({ error: { message: "FreeTierError: free tier can only be used from within OpenCode" } }),
          { status: 403 },
        );
      }
      return sseResponse([sseChunk("好")]);
    };
    const res = await nw.handleFetch(
      chatReq({ model: "big-pickle", messages: [{ role: "user", content: "在吗" }] }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).choices[0].message.content).toBe("好");
    expect(fetchCalls).toHaveLength(2);
    const s1 = fetchCalls[0].init.headers["x-opencode-session"];
    const s2 = fetchCalls[1].init.headers["x-opencode-session"];
    expect(s1).not.toBe(s2); // 重试必须换 session
    expect(s2).toMatch(nw.SESSION_SHAPE);
  });

  test("C9 IP 滥用终局 → 不重试、单次请求、403 带回", async () => {
    fetchImpl = async () =>
      new Response(
        JSON.stringify({ error: { message: "Detected abusive traffic from this IP address" } }),
        { status: 403 },
      );
    const res = await nw.handleFetch(
      chatReq({ model: "big-pickle", messages: [{ role: "user", content: "在吗" }] }),
    );
    expect(res.status).toBe(403);
    expect(fetchCalls).toHaveLength(1); // 绝不重试
    const body = await res.json();
    expect(body.error.type).toBe("ip_abuse");
  });

  test("C10 429 限额 → 不重试，原样透出", async () => {
    fetchImpl = async () =>
      new Response(JSON.stringify({ error: { message: "FreeUsageLimitError: quota spent" } }), {
        status: 429,
      });
    const res = await nw.handleFetch(
      chatReq({ model: "big-pickle", messages: [{ role: "user", content: "在吗" }] }),
    );
    expect(res.status).toBe(429);
    expect(fetchCalls).toHaveLength(1);
  });

  test("C11 付费/未知模型 → 本地 404，不碰上游", async () => {
    const res = await nw.handleFetch(
      chatReq({ model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }] }),
    );
    expect(res.status).toBe(404);
    expect(fetchCalls).toHaveLength(0);
  });

  test("C12 坏 JSON body → 400", async () => {
    const req = new Request("http://127.0.0.1:8920/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const res = await nw.handleFetch(req);
    expect(res.status).toBe(400);
  });

  test("C13 思考模型 token 下限生效（deepseek → 5120）", async () => {
    fetchImpl = async () => sseResponse([sseChunk("好")]);
    await nw.handleFetch(
      chatReq({ model: "deepseek-v4.1-flash-free", max_tokens: 100, messages: [{ role: "user", content: "hi" }] }),
    );
    const up = JSON.parse(fetchCalls[0].init.body);
    expect(up.max_completion_tokens).toBe(5120);
  });

  test("C14 客户端自带 system 提示 → env 块追加而非替换", async () => {
    fetchImpl = async () => sseResponse([sseChunk("好")]);
    await nw.handleFetch(
      chatReq({
        model: "big-pickle",
        messages: [
          { role: "system", content: "你是数学老师" },
          { role: "user", content: "hi" },
        ],
      }),
    );
    const up = JSON.parse(fetchCalls[0].init.body);
    expect(up.messages[0].content).toContain("你是数学老师");
    expect(up.messages[0].content).toContain("Working directory:");
  });

  test("C15 aggregateSSE 直接单测：tool_calls 增量拼接 + reasoning", async () => {
    const parts = [
      sseChunk("", { choices: [{ index: 0, delta: { reasoning_content: "想" }, finish_reason: null }] }),
      sseToolChunk("Bash", '{"cmd":'),
      sseToolChunk("Bash", '"ls"}'), // 部分上游每片重复 name，不能拼成 BashBash
      sseUsageChunk(),
      "data: [DONE]\n\n",
    ];
    const res = sseResponse(parts, { usage: false });
    const out = await nw.aggregateSSE(res.body);
    expect(out.choices[0].message.tool_calls).toHaveLength(1);
    expect(out.choices[0].message.tool_calls[0].function.name).toBe("Bash");
    expect(out.choices[0].message.tool_calls[0].function.arguments).toBe('{"cmd":"ls"}');
    expect(out.choices[0].message.reasoning_content).toBe("想");
    expect(out.choices[0].finish_reason).toBe("tool_calls");
  });
});

// ════════════════════════════════════════════════════════════════
// D 段 · 巡检回归项（防"下次优化又踩回去"）
// 背景：当天 210 条成功日志零失败，但 health 的 err 在涨 —— 失败请求
// 原本不留日志；出口轮换无单飞、无预算、失败不回滚，会在死池间反复轮换，
// 或在一次静默扫描里拖掉几十秒。
// ════════════════════════════════════════════════════════════════
describe("D 段 · 巡检回归", () => {
  test("D1 候选筛选：排除信息条目/当前节点/冷却节点", () => {
    const now = 1_000_000;
    const pool = nw.pickCandidates({
      all: ["Node-A", "Node-B", "Node-C", "剩余流量：10GB", "DIRECT", "官网"],
      current: "Node-A",
      nodeDead: new Map([["Node-C", now + 60_000]]),
      now,
    });
    expect(pool).toEqual(["Node-B"]);
  });

  test("D2 候选全冷却 → 回落到兜底池（不许一动不动）", () => {
    const now = 1_000_000;
    const pool = nw.pickCandidates({
      all: ["A", "B"],
      current: "A",
      nodeDead: new Map([
        ["B", now + 60_000],
      ]),
      now,
    });
    expect(pool).toEqual(["B"]);
  });

  test("D2b 扫描上限生效：cap=3 时最多 3 个候选（防扫全部 40 个节点）", () => {
    const all = Array.from({ length: 40 }, (_, i) => `N${i}`);
    expect(nw.pickCandidates({ all, current: "N0", cap: 3, now: 1 }).length).toBe(3);
    // 上限必须是有限正数，防止有人把旋钮关掉换回"扫全表"
    expect(nw.ROTATE_SCAN_MAX).toBeGreaterThan(0);
    expect(nw.ROTATE_SCAN_MAX).toBeLessThanOrEqual(40);
  });

  test("D3 轮换总预算有上限（客户端不许再被静默拖 60s+）", () => {
    // ROTATE_BUDGET_MS 默认 45s（ROTATE_SCAN_MAX=20 配套），
    // 上限口径同步放宽到 60s：预算必须在 0~60s 之间。
    expect(nw.ROTATE_BUDGET_MS).toBeGreaterThan(0);
    expect(nw.ROTATE_BUDGET_MS).toBeLessThanOrEqual(60_000);
  });

  test("D4 上游干净 EOF 无 finish_reason → 补终帧且在 [DONE] 之前", async () => {
    const up = new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(sseChunk("甲")));
          c.close();
        },
      }),
    );
    const text = await new Response(nw.ssePipe(up.body, "big-pickle")).text();
    expect(text).toContain('"finish_reason":"stop"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(text.indexOf('"finish_reason":"stop"')).toBeLessThan(text.indexOf("data: [DONE]"));
  });

  test("D5 上游已给 [DONE] → 不得在 [DONE] 之后追加终帧（C5 的回归）", async () => {
    const up = new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(sseChunk("甲") + "data: [DONE]\n\n"));
          c.close();
        },
      }),
    );
    const text = await new Response(nw.ssePipe(up.body, "big-pickle")).text();
    expect(text.indexOf('"finish_reason":"stop"')).toBe(-1);
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  test("D6 失败请求必须留日志行（否则巡检会把故障数成 0）", async () => {
    fetchImpl = async () =>
      new Response(JSON.stringify({ error: { message: "FreeUsageLimitError: quota spent" } }), {
        status: 429,
      });
    const lines = [];
    const realLog = console.log;
    console.log = (...a) => lines.push(a.join(" "));
    try {
      const res = await nw.handleFetch(
        chatReq({ model: "big-pickle", messages: [{ role: "user", content: "在吗" }] }),
      );
      expect(res.status).toBe(429);
    } finally {
      console.log = realLog;
    }
    const fail = lines.filter((l) => l.includes("FAIL") && l.includes("429"));
    expect(fail).toHaveLength(1);
  });
  test("D7 (出口IP,模型) 冷却：retry-after 解析与额度/冷却分流", () => {
    // 429 按证据分流，长 retry-after = 额度桶空
    expect(nw.parseRetryAfterMs("48410")).toBe(48410000);
    expect(nw.parseRetryAfterMs("30")).toBe(30000);
    expect(nw.parseRetryAfterMs("")).toBe(0);
    expect(nw.parseRetryAfterMs("not-a-date")).toBe(0);
    const future = new Date(Date.now() + 120000).toUTCString();
    const d = nw.parseRetryAfterMs(future);
    expect(d).toBeGreaterThan(100000);
    expect(d).toBeLessThan(130000);
    // 分界线：10 分钟以上算额度耗尽
    expect(nw.QUOTA_RETRY_AFTER_MS).toBe(600000);
    expect(nw.MODEL_COOLDOWN_MAX_MS).toBe(86400000);
  });

  test("D8 模型冷却只影响该模型，且能把该 IP 排到候选末位", () => {
    const now = Date.now();
    const modelCooldown = new Map();
    const ipByNode = new Map([
      ["节点A", "1.1.1.1"],
      ["节点B", "2.2.2.2"],
      ["节点C", "3.3.3.3"],
    ]);
    // A 对 glm 冷却中，B 干净
    modelCooldown.set("1.1.1.1|glm-5.3-flash-free", now + 3_600_000);
    const all = ["节点A", "节点B", "节点C"];
    // 对 glm：A 必须排在干净节点之后
    const forGlm = nw.pickCandidates({
      all, current: "", ipByNode, modelCooldown, model: "glm-5.3-flash-free", now,
    });
    expect(forGlm[forGlm.length - 1]).toBe("节点A");
    // 对别的模型：A 不受影响（不再陪葬）
    const forOther = nw.pickCandidates({
      all, current: "", ipByNode, modelCooldown, model: "big-pickle", now,
    });
    expect(forOther.indexOf("节点A")).toBeLessThan(forOther.length - 1);
  });

  test("D9 markModelCooldown 有上限、clear 可清、过期不生效", () => {
    const ip = "9.9.9.9";
    const until = nw.markModelCooldown(ip, "big-pickle", 48 * 3600 * 1000);
    const wait = until - Date.now();
    expect(wait).toBeLessThanOrEqual(nw.MODEL_COOLDOWN_MAX_MS + 1000); // 封顶 24h
    expect(nw.egressState.modelCooldown.has("9.9.9.9|big-pickle")).toBe(true);
    expect(nw.clearModelCooldown(ip, "big-pickle")).toBe(true);
    expect(nw.egressState.modelCooldown.has("9.9.9.9|big-pickle")).toBe(false);
    // 缺省时长：retry-after 为 0 时用默认值，但至少 30s
    const u2 = nw.markModelCooldown("8.8.8.8", "x", 0);
    expect(u2 - Date.now()).toBeGreaterThanOrEqual(29_000);
    nw.clearModelCooldown("8.8.8.8", "x");
  });
  test("D10 normalizeEgress 幂等（v6 二次归一化会毁掉 (IP,模型) 冷却键）", () => {
    const v6 = "2408:8207:1234:5678:aaaa:bbbb:cccc:dddd";
    const once = nw.normalizeEgress(v6);
    expect(once).toBe(nw.normalizeEgress(once)); // 幂等
    expect(once.startsWith("v6:v6:")).toBe(false);
    expect(nw.normalizeEgress("1.2.3.4")).toBe("1.2.3.4");
    expect(nw.normalizeEgress("")).toBe("");
    // 归一化后的 v6 值作为冷却键，可被 clear 命中
    nw.markModelCooldown(v6, "m", 60000);
    const key = [...nw.egressState.modelCooldown.keys()].find((k) => k.endsWith("|m"));
    expect(key).toBe(once + "|m");
    expect(nw.clearModelCooldown(v6, "m")).toBe(true);
  });
  test("D11 上游中途断流：补终帧后正常结束（不再让客户端看到 error）", async () => {
    const enc = new TextEncoder();
    const up = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode('data: {"id":"x","choices":[{"index":0,"delta":{"content":"前半段"}}]}\n\n'));
        setTimeout(() => c.error(new Error("ECONNRESET: socket closed")), 10);
      },
    });
    const errs = [];
    const text = await new Response(
      nw.ssePipe(up, "big-pickle", { onStreamError: (e) => errs.push(String(e)) }),
    ).text();
    expect(text).toContain("前半段");
    expect(text).toContain('"finish_reason":"stop"'); // 补齐终帧
    expect(text.trim().endsWith("data: [DONE]".trim())).toBe(true); // 以 [DONE] 收尾
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("ECONNRESET");
  });

  test("D12 空闲超时：无字节时按 idle 超时优雅收尾", async () => {
    const enc = new TextEncoder();
    const up = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode('data: {"id":"y","choices":[{"index":0,"delta":{"content":"A"}}]}\n\n'));
        // 之后故意不再吐字节（模拟上游半死挂住）
      },
    });
    const errs = [];
    const t0 = Date.now();
    const text = await new Response(
      nw.ssePipe(up, "big-pickle", { idleTimeoutMs: 80, onStreamError: (e) => errs.push(String(e)) }),
    ).text();
    expect(Date.now() - t0).toBeLessThan(3000); // 不会永久挂住
    expect(text).toContain("A");
    expect(text).toContain('"finish_reason":"stop"');
    expect(errs.join(" ")).toContain("idle timeout");
  });

  test("D13 非流式聚合中途断：返回已聚合部分并标 __partial", async () => {
    const enc = new TextEncoder();
    const up = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode('data: {"id":"z","model":"big-pickle","choices":[{"index":0,"delta":{"content":"部分内容"}}]}\n\n'));
        setTimeout(() => c.error(new Error("socket closed")), 10);
      },
    });
    const agg = await nw.aggregateSSE(up, { idleTimeoutMs: 100 });
    expect(agg.choices[0].message.content).toBe("部分内容");
    expect(agg.__partial).toBe(true);
    expect(agg.choices[0].finish_reason).toBe("stop");
  });

  test("D14 客户端取消：cancel 会把上游 abort 掉（不再空烧额度）", async () => {
    const enc = new TextEncoder();
    let upstreamCancelled = false;
    const up = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode('data: {"id":"q","choices":[{"index":0,"delta":{"content":"x"}}]}\n\n'));
      },
      cancel() {
        upstreamCancelled = true;
      },
    });
    const ctrl = new AbortController();
    const piped = nw.ssePipe(up, "big-pickle", { abortController: ctrl });
    const reader = piped.getReader();
    await reader.read(); // 读一帧，制造"客户端正在消费"的状态
    await reader.cancel(new Error("client gone"));
    await new Promise((r) => setTimeout(r, 30));
    expect(upstreamCancelled).toBe(true);
    expect(ctrl.signal.aborted).toBe(true);
  });
});
