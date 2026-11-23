/**
 * _test_tool_call_summary.ts — 工具卡「折叠行人话摘要」回归门（2026-11-17）。
 *
 * 用户诉求：自动折叠不能撤，但折叠后满屏只剩 `bash 完成`，看不出 agent 在干什么。
 * 本测试守两件事：
 *   ① 摘要解析**算得对**（真实参数形状 / 去敏 / 截断 / 畸形输入 never-throw）；
 *   ② 摘要**真接在折叠行上**，且没有碰自动折叠/展开的既有逻辑（源码级接线断言）。
 *
 * 运行：npm run test:tool-summary
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describeToolCall, TOOL_SUMMARY_MAX_CHARS } from "./toolCallSummary.ts";

let n = 0;
const ok = (name: string): void => {
	n += 1;
	console.log(`ok ${n} - ${name}`);
};

// ── 1. bash：高频命令给「动词 + 目标」─────────────────────────────
const rgSummary = describeToolCall("bash", { command: 'rg -n "fusion-dispatch" extensions/ | head -5' });
assert.ok(rgSummary !== null && rgSummary.includes("搜索") && rgSummary.includes("fusion-dispatch"), `rg → 搜索词：${rgSummary}`);
const grepSummary = describeToolCall("bash", { command: "grep -rn 'TODO' gui/src 2>/dev/null" });
assert.ok(grepSummary !== null && grepSummary.includes("搜索") && grepSummary.includes("TODO"), `grep → 搜索词：${grepSummary}`);
const gitSummary = describeToolCall("bash", { command: "git status --short && git log --oneline -3" });
assert.equal(gitSummary, "git status", "串联命令只看第一段主命令");
const catSummary = describeToolCall("bash", { command: "cat ~/.pi/agent/runtime/host.json" });
assert.ok(catSummary !== null && catSummary.includes("查看") && catSummary.includes("host.json"), `cat → 查看路径：${catSummary}`);
const lsSummary = describeToolCall("bash", { command: "ls -dt state/trace-fusion/*" });
assert.ok(lsSummary !== null && lsSummary.includes("列出"), `ls → 列出：${lsSummary}`);
const npmSummary = describeToolCall("bash", { command: "npm run build" });
assert.ok(npmSummary !== null && npmSummary.startsWith("运行 "), `npm → 运行：${npmSummary}`);
const genericBash = describeToolCall("bash", { command: "python scripts/supv-greencad.py --tick" });
assert.ok(genericBash !== null && genericBash.startsWith("运行 "), `python → 运行：${genericBash}`);
ok("1 bash：rg/grep=搜索、git=子命令、cat=查看、ls=列出、npm/python=运行");

// ── 2. 读改查：路径/查询词要看得见 ─────────────────────────────────
const readSummary = describeToolCall("read", { path: "C:\\Users\\Annacomnena\\pi-packages\\subagent-win\\gui\\src\\ChatPage.tsx" });
assert.ok(readSummary !== null && readSummary.startsWith("读取 ") && readSummary.includes("ChatPage.tsx"), `read → 读取末段路径：${readSummary}`);
assert.ok(!readSummary.includes("C:\\"), "绝对路径不整条塞进摘要");
const editSummary = describeToolCall("edit", {
	path: "extensions/trace-fusion/fusion-dispatch.ts",
	edits: [{ oldText: "a", newText: "b" }, { oldText: "c", newText: "d" }],
});
assert.ok(editSummary !== null && editSummary.startsWith("编辑 ") && editSummary.includes("2 处"), `edit → 编辑 + 处数：${editSummary}`);
const codegraphSummary = describeToolCall("codegraph", { action: "query", query: "fusion-dispatch" });
assert.equal(codegraphSummary, "查询「fusion-dispatch」", "codegraph → 查询词");
const writeSummary = describeToolCall("write", { path: "a.ts", content: "hello" });
assert.equal(writeSummary, null, "write 卡自带路径+行数摘要，不重复输出");
ok("2 read/edit/codegraph 出人话；write 不重复专属摘要");

// ── 3. 自定义工具：从最有信息量的字段取后缀 ────────────────────────
assert.ok(describeToolCall("subagent-win", { agent: "impl", async: true, task: "诊断 frontier.json 覆盖写" })?.includes("诊断 frontier.json"), "subagent-win.task");
assert.ok(describeToolCall("tab-status", { runId: "tab_mw1u4th9_l2oz" })?.includes("tab_mw1u4th9_l2oz"), "tab-status.runId");
assert.ok(describeToolCall("set-timer", { delayMs: 1000, label: "巡检", message: "检查 run 状态" })?.includes("检查 run 状态"), "set-timer.message");
ok("3 自定义工具取 task/runId/message 等文本字段");

// ── 4. 安全与健壮性：去敏 / 截断 / never-throw ──────────────────────
// 真机 master-attach 带 token 键 → 键名过滤直接拦掉（L4 I1：此前这条断言是空过，
// 因为 token 根本不在 GENERIC_TEXT_KEYS；现在下面额外断言「值里的凭据」也走内容级 scrub）
const attach = describeToolCall("master-attach", { token: "ho_SUPER_SECRET_123", local: true });
assert.equal(attach, null, "敏感键 token 不进摘要");
// L4 B1 全部复现输入：凭据藏在**值**里（header / 驼峰赋值 / URL userinfo / 搜索词 / 普通文本字段）
for (const [tool, args] of [
	["bash", { command: 'curl -H "Authorization: Bearer sk-1234567890" https://x.com' }],
	["bash", { command: "export apiKey=sk-1234567890 && curl https://x.com" }],
	["bash", { command: "rg sk-1234567890 src/" }],
	["bash", { command: "curl https://user:sk-1234567890@host/db" }],
	["x", { url: "https://user:sk-1234567890@host/db" }],
	["x", { message: "token=sk-1234567890" }],
	["bash", { command: "AUTHORIZATION=sk-1234567890 curl https://x.com" }],
] as const) {
	const summary = describeToolCall(tool, args);
	assert.ok(summary !== null && !summary.includes("sk-1234567890"), `${tool} 值里的凭据不得进摘要：${summary}`);
	assert.ok(summary !== undefined && !/sk-[A-Za-z0-9]{8,}/.test(summary), `${tool} 摘要不得残留 sk-* token：${summary}`);
}
const credentialBash = describeToolCall("bash", { command: "export API_KEY=sk-1234567890 && curl https://example.com" });
assert.ok(credentialBash !== null && !credentialBash.includes("sk-1234567890"), "bash 命令里的凭据赋值要抹掉");
// L4 N1：双向控制符不得随摘要进可见文本 / title
assert.ok(!/[\u202A-\u202E\u2066-\u2069]/.test(describeToolCall("bash", { command: "echo safe\u202Egnp.exe.txt" }) ?? ""), "bidi 控制符被剥离");
for (const args of [null, undefined, 42, "plain text", [], { command: 42 }, "{broken json"]) {
	const result = describeToolCall("bash", args);
	assert.ok(result === null || typeof result === "string", `bash 畸形输入不抛：${JSON.stringify(args)}`);
	assert.equal(describeToolCall("read", args), null, `read 畸形输入回落 null：${JSON.stringify(args)}`);
}
const long = describeToolCall("bash", { command: `grep -rn "${"x".repeat(500)}" .` }, 40);
assert.ok(long !== null && long.length <= 40 && long.includes("…"), `长文本按 max 截断：${long}`);
assert.ok(describeToolCall("bash", { command: "ls" }, -1)?.length !== undefined, "非法 max 回落到默认上限");
assert.ok(TOOL_SUMMARY_MAX_CHARS >= 40, "默认上限常量可用");
const jsonStringArgs = describeToolCall("read", '{"path":"src/A.ts"}');
assert.ok(jsonStringArgs?.includes("A.ts"), "arguments 为 JSON 字符串时也能解析");
ok("4 去敏 / 畸形输入 never-throw / 截断 / JSON 字符串参数");

// ── 5. 接线断言：摘要确实落在折叠行，且没动自动折叠 ─────────────────
const chatPage = readFileSync(new URL("./pages/ChatPage.tsx", import.meta.url), "utf8");
assert.ok(chatPage.includes('import { describeToolCall } from "../toolCallSummary"'), "ChatPage 引入摘要解析");
assert.ok(/const toolSummary = describeToolCall\(row\.name, row\.arguments\);/.test(chatPage), "工具卡调用 describeToolCall");
assert.ok(chatPage.includes('attrs={{ "data-tool-summary": toolSummary ?? "" }}'), "折叠行带诊断属性");
assert.ok(chatPage.includes("title={toolSummary}"), "摘要 title 保留全文");
const triggerBlock = chatPage.slice(
	chatPage.indexOf("<CollapsibleTrigger", chatPage.indexOf("function ToolCallRowView")),
	chatPage.indexOf("</CollapsibleTrigger>", chatPage.indexOf("function ToolCallRowView")),
);
assert.ok(triggerBlock.includes("{toolSummary !== null"), "摘要渲染在工具卡 CollapsibleTrigger（折叠行）内");
const summarySpan = triggerBlock.slice(triggerBlock.indexOf("{toolSummary !== null"), triggerBlock.indexOf("{toolSummary !== null") + 260);
assert.ok(!/\bhidden\b|sr-only|aria-hidden/.test(summarySpan), "摘要 span 不得被 hidden/sr-only 藏掉（L4 I1）");
assert.ok(
	["autoExpandTarget({", "wasRunningRef.current", "holdOpen", "settling", "userLockedRef.current"].every((s) => chatPage.includes(s)),
	"自动展开/合上 + 用户锁定 + 收笔逻辑原样保留",
);
ok("5 接线：摘要在折叠行内渲染 + 自动折叠逻辑未被替换");

console.log(`\n${n} checks passed.`);
