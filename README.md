# newofm

把 opencode.ai 的**匿名免费模型**包装成一个标准的 OpenAI 兼容接口 —— 单文件、零依赖、
只监听本机回环地址。任何支持自定义 Base URL 的客户端都可以直接使用。

当前版本：**v1.0**

> 本项目基于对公开可观测行为的黑盒研究与工程实现，用于学习与个人研究。
> 仓库内不含任何账号、密钥或私有凭据；上游身份是官方客户端公开使用的匿名标识。

## 它解决什么问题

opencode.ai 的免费模型层对客户端有比较严格的形状要求：TLS 指纹、会话标识、
工具锚点、系统提示词，缺一条就被拒，而且**错误消息和"额度用尽"完全一样**。
普通 HTTP 客户端无论怎么重试都过不去。

newofm 把这些要求收敛到一个地方，对外只暴露三个朴素端点，让客户端不必关心细节。

```
你的客户端  ──OpenAI API──▶  newofm (127.0.0.1:8920)  ──▶  上游免费模型
```

## 特性

- **OpenAI 兼容**：`/v1/models` 与 `/v1/chat/completions`，流式与非流式都支持。
- **单文件**：一个 `.js` 文件跑起来，无 npm 依赖、无子进程。
- **模型目录实时同步**：启动时拉取上游目录，自动过滤付费与已废弃模型，
  并从目录读取真实接口地址（上游迁移端点时不需要改代码）。
- **429 归因分流**：区分"额度耗尽"和"请求形状不合规"——两者的错误消息一模一样，
  但处置完全相反。按 `(出口, 模型)` 维度冷却，避免把还能用的资源一起判死。
- **可选出口轮换**：本机有 mihomo / Clash 控制口时，可以按出口 IP 自动轮换并去重。
- **流式稳定**：超时分层（等响应头 vs 读流空闲），长回答不会被半途掐断；
  客户端取消会透传到上游。
- **57 个离线测试**：全部使用 mock，不需要网络，不消耗额度。

## 快速开始

前提：**Bun 1.4 或更高版本**。这不是偏好，而是硬要求——上游会校验 TLS 指纹，
只有 Bun 的 ClientHello 与官方 CLI 一致；Node、Python、curl 都会被直接拒绝。

```bash
# 1. 安装 Bun（如果还没有）
curl -fsSL https://bun.sh/install | bash

# 2. 启动
git clone https://github.com/yysoulhaha/newofm.git
cd newofm
bun newofm.js
```

看到下面这行就说明起来了：

```
[newofm] v1.0.0 lane-a-forged listening on http://127.0.0.1:8920
```

试一下：

```bash
curl -s http://127.0.0.1:8920/v1/models | head

curl -s http://127.0.0.1:8920/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "big-pickle",
    "messages": [{"role": "user", "content": "用一句话解释什么是递归"}],
    "stream": false
  }'
```

客户端接入：Base URL 填 `http://127.0.0.1:8920/v1`，API Key 随便填（不会用到），
模型名从 `/v1/models` 返回的列表里选。

### 关于网络

如果无法直连上游，通过本地代理走即可：

```bash
UPSTREAM_PROXY_URL=http://127.0.0.1:7897 bun newofm.js
```

直连环境把它设为空串：`UPSTREAM_PROXY_URL= bun newofm.js`。

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 运行状态：模型目录、出口、冷却表、统计 |
| GET | `/healthz` | 同上（兼容常见探活路径） |
| GET | `/v1/models` | 当前可用的免费模型 |
| POST | `/v1/chat/completions` | OpenAI 兼容，支持 `stream: true` |

## 配置

全部通过环境变量，都有合理默认值。

| 变量 | 默认 | 说明 |
|---|---|---|
| `NEWOFM_PORT` | `8920` | 监听端口 |
| `NEWOFM_HOST` | `127.0.0.1` | 监听地址。**默认只绑回环**，不建议对公网开放 |
| `NEWOFM_CACHE_DIR` | `~/.newofm` | 目录缓存与冷却状态 |
| `NEWOFM_CLI_VERSION` | `2.1.4` | 请求中声明的 CLI 版本 |
| `NEWOFM_TOOL_PROFILE` | `core` | 工具面：`core`（最小）/ `full`（官方 12 工具） |
| `UPSTREAM_PROXY_URL` | `http://127.0.0.1:7897` | 上游出口代理；直连设空串 |
| `NEWOFM_LANEB_URL` | 空 | 可选兜底端点：429 / 5xx 时转发到另一个 OpenAI 兼容服务 |
| `UPSTREAM_HEADERS_TIMEOUT_MS` | 见文件头 | 等待响应头的上限 |
| `UPSTREAM_IDLE_TIMEOUT_MS` | `300000` | 读流的空闲超时，出数据即续期 |
| `GATE_RETRY_COOLDOWN_MS` | `30000` | 被拒后的重试冷却，避免给出口加刑 |
| `NEWOFM_CLASH_SOCK` | 自动探测 | mihomo 控制口 unix socket；显式空串 = 关闭轮换 |
| `NEWOFM_CLASH_GROUP` | 空 | 代理组名，留空则不启用轮换 |
| `NEWOFM_ROTATE_ON_429` | `1` | 遇 429 是否自动换出口 |
| `NEWOFM_TIMED_ROTATE_MIN` | `60` | 定时换池间隔（分钟），仅在无进行中请求时执行 |

## 工作原理

一句话：**把请求形状对齐到官方 CLI 的真实请求**。

上游会校验四项：TLS 指纹、会话标识（位反转时间戳 + 同毫秒计数器）、
工具锚点（`read` 与 `shell`）、完整系统提示词。任一项不符都会被拒，
且错误消息伪装成"额度耗尽"——这是本项目所有设计取舍的来源。

细节（会话算法、工具面、429 归因、出口轮换、超时分层）见
**[docs/DESIGN.md](docs/DESIGN.md)**。

## 项目结构

```
newofm.js                主程序（单文件，零依赖）
harness_prompt.js        官方系统提示词模板
tools/
  gate_tools_full.json   full 档：官方 12 工具定义
  gate_tools_core.json   core 档：read + shell 最小面
  dump_request.js        打印一次完整上行请求，排障用
  make_harness_prompt.py 从抓包重新生成提示词模板
tests/
  newofm.test.js         57 个离线测试
docs/
  DESIGN.md              设计说明
```

## 测试

```bash
bun test tests/newofm.test.js
```

全部离线，不发起真实网络请求。测试会把缓存目录指向临时路径，
也不会触碰你正在使用的代理组。

## 已知限制

1. **上游规则会变。** 本项目是针对可观测行为的实现，不保证长期有效。
   规则调整时通常表现为"突然大面积 429"。
2. **占位工具。** 为满足工具锚点要求，请求里会带上一组占位工具定义。
   纯对话场景无影响；需要模型真正执行工具的 Agent 客户端应自行接管这一层。
3. **静态模型表。** 内置清单只在目录抓取失败时兜底，实际以实时目录为准。
4. **没有内置多上游调度。** 需要冗余时自行配置 `NEWOFM_LANEB_URL`。
5. **出口轮换依赖外部控制口。** 没有 mihomo / Clash 的环境下该功能自动关闭，
   不影响转发本身。

## 参考

设计参考了这几个开源项目（仅作研究参考，代码为独立实现）：

- [azrinaldi/opencode-free-bridge](https://github.com/azrinaldi/opencode-free-bridge) — 身份推导、目录模型、错误自愈
- [FishBottle7/opencode2dsh](https://github.com/FishBottle7/opencode2dsh) — 准入条件的消融数据
- [TiaraBasori/OpenCode2API](https://github.com/TiaraBasori/OpenCode2API) — 多协议网关形态

## 声明

仅供学习与个人研究。使用者需自行遵守上游服务的使用条款与所在地法律法规。
本项目不提供、也不承诺任何可用性保证。
