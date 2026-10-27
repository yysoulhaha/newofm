// 零成本请求审查：把冒烟请求的完整上行 body + headers 打出来，不打上游。
// 跑法：bun tools/dump_request.js
import {
  applyEnvBlock,
  ensureReadAnchor,
  buildHeaders,
  sessionFromConversation,
  firstUserText,
  resolveModel,
  adjustMaxTokens,
} from "../newofm.js";

const body = {
  model: "big-pickle",
  messages: [{ role: "user", content: "只回复四个字：冒烟通过" }],
  stream: false,
};

const facts = resolveModel(body.model);
console.log("== facts ==", JSON.stringify(facts, null, 1));

const messages = applyEnvBlock(body.messages);
console.log("\n== messages after applyEnvBlock ==");
for (const m of messages) {
  console.log(`[${m.role}] ${JSON.stringify(m.content).slice(0, 400)}`);
}

const { body: anchored, alias } = ensureReadAnchor({ ...body, messages });
const upstreamBody = {
  model: facts.id,
  messages: anchored.messages,
  tools: anchored.tools,
  stream: true,
  stream_options: { include_usage: true },
  max_completion_tokens: adjustMaxTokens(facts, body.max_tokens ?? body.max_completion_tokens),
  store: false,
};
console.log("\n== upstreamBody ==");
console.log(JSON.stringify(upstreamBody, null, 1));

const sessionId = sessionFromConversation(firstUserText(messages));
console.log("\n== sessionId ==", sessionId, "len:", sessionId.length);

const headers = buildHeaders(sessionId);
console.log("\n== headers ==");
for (const [k, v] of Object.entries(headers)) console.log(`${k}: ${v}`);

// 门禁自检
console.log("\n== gate self-check ==");
const sysText = upstreamBody.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
console.log("has <env> block:", /<env>/.test(sysText));
console.log("has Working directory:", /Working directory:/.test(sysText));
console.log("tools has read:", (upstreamBody.tools || []).some((t) => t.function && t.function.name === "read"));
console.log("stream:", upstreamBody.stream);
console.log("session format ok:", /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(sessionId));
console.log("UA:", headers["user-agent"]);
