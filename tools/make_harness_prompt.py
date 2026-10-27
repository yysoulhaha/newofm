#!/usr/bin/env python3
"""从一次官方 CLI 请求的抓包中提取完整系统提示词模板，
生成 harness_prompt.js 模块。

用法：
  python3 tools/make_harness_prompt.py <capture.json> [out.js]

capture.json 需包含 {"body_text": "<请求体 JSON 字符串>"} 或直接是请求体。

占位符：
  {{MODEL_NAME}}  模型显示名（# Your Model 段落）
  {{MODEL_ID}}    模型 id（# Your Model 段落）
  {{ENV_BLOCK}}   运行时动态生成的 <env> 块（含 Working directory 行）

依据：消融实验显示，system 换成通用助手提示、或只发尾部 <env> 块，
都会被拒绝；env 块只是原文的尾部组成部分，不等价于原文。
"""
import json
import sys

if len(sys.argv) < 2:
    sys.exit("用法: python3 tools/make_harness_prompt.py <capture.json> [out.js]")
CAPTURE = sys.argv[1]
OUT = sys.argv[2] if len(sys.argv) > 2 else "harness_prompt.js"

with open(CAPTURE) as f:
    d = json.load(f)
body = json.loads(d["body_text"]) if "body_text" in d else d
prompt = body["messages"][0]["content"]

ENV_HEAD = "Here is some useful information about the environment you are running in:"
i = prompt.index(ENV_HEAD)
j = prompt.index("</env>", i) + len("</env>")
head = prompt[:i]           # env 块之前的部分（含模型名段落）
tail = prompt[j:]           # env 块之后的部分（worktree 说明）

tpl = head + "{{ENV_BLOCK}}" + tail
tpl = tpl.replace("Big Pickle", "{{MODEL_NAME}}").replace("big-pickle", "{{MODEL_ID}}")
tpl = tpl.replace("Today's date: Sun Oct 25 2026", "Today's date: {{TODAY}}")
assert "{{MODEL_NAME}}" in tpl and "{{MODEL_ID}}" in tpl and "{{ENV_BLOCK}}" in tpl
assert "{{TODAY}}" in tpl
assert "Big Pickle" not in tpl and "big-pickle" not in tpl
assert "Working directory:" not in tpl  # cwd 相关内容全在 ENV_BLOCK 里，运行时生成
assert "Today's date: Sun" not in tpl
print(f"captured system prompt: {len(prompt)} chars")

js = (
    "// 官方 opencode CLI 的完整系统提示词模板（抓包原文，未改动内容）。\n"
    "// 这是免费车道门禁的硬条件之一：system prompt 必须是 CLI 原文，只发\n"
    "// <env> 块或换成通用助手提示都会被上游以 429 FreeUsageLimitError 拒绝\n"
    "// （与额度用尽的消息一字不差，曾致误诊）。\n"
    "//\n"
    "// 占位符（harnessSystemText 运行时替换）：\n"
    "//   {{MODEL_NAME}} 模型显示名；{{MODEL_ID}} 模型 id；\n"
    "//   {{TODAY}}      new Date().toDateString()（CLI 每请求注入当天日期）；\n"
    "//   {{ENV_BLOCK}}  buildHarnessEnvBlock(cwd) 动态生成的 <env> 块。\n"
    "//\n"
    "// 生成方式：把官方 CLI 的 baseURL 指向本地捕获服务得到明文请求，\n"
    "// 再由 tools/make_harness_prompt.py 提取。勿手改模板内容。\n"
    "export const HARNESS_SYSTEM_TEMPLATE = "
    + json.dumps(tpl, ensure_ascii=False)
    + ";\n\n"
    "/** 模板里出现即说明「已是 harness 提示」的标记串（幂等判断用）。 */\n"
    "export const HARNESS_MARKER = \"You are an AI agent running in OpenCode\";\n"
)

with open(OUT, "w") as f:
    f.write(js)

print(f"written {OUT} ({len(js)} bytes)")
print(f"template length: {len(tpl)} chars")
print(f"head: {len(head)} chars, tail: {len(tail)} chars")
print("head ends with:", repr(head[-80:]))
print("tail starts with:", repr(tail[:80]))
