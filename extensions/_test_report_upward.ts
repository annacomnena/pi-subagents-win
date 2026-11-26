/**
 * _test_report_upward.ts — Item 66 第 2 层：`agent://master_*` 回报路由
 *
 * 为什么需要这组测试：
 *   实测分母（2026-11-25，~/.pi/agent/reports/）：14 份 report 里 13 份有 `.notified`，
 *   **13 份成功的 `from` 全是 `tab_*`（100%）**；唯一失败的那份
 *   `report_mwucgcad_r1a0`（from=`agent://master_local_GreenCAD`）落 `.unroutable` 永不消费。
 *   ⇒ 不是概率问题，是 `recipientSessionIdFor` 结构上不认 `agent://`。
 *
 * 覆盖目标：
 *   ① 显式 `to = agent://master_*` ⇒ 读 attachment 拿 sessionId（横向汇报唯一正确入口）
 *   ② **fail closed**：attachment 缺失/坏/sessionId 非法 ⇒ undefined（不猜、不回落 from）
 *   ③ **不自环**：`from = agent://X` 且无 `to` ⇒ undefined（不要解析成 X 自己）
 *   ④ 向后兼容：无 `to` 时旧逻辑逐字节不变（tab_* 走 links / UUID 直接用 / 其他 undefined）
 *   ⑤ `to` 支持 tab_* 与 UUID
 *
 * 跑法：npm run test:report-upward
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let checks = 0;
function ok(cond: unknown, msg: string) {
	assert.ok(cond, msg);
	checks++;
}
function eq(actual: unknown, expected: unknown, msg: string) {
	assert.equal(actual, expected, msg);
	checks++;
}

const tmp = mkdtempSync(join(tmpdir(), "report-upward-"));
const prevRuntimeDir = process.env.PI_RUNTIME_DIR;
process.env.PI_RUNTIME_DIR = join(tmp, "runtime");

const { recipientSessionIdFor, sendReportToMain, readReportFile } = await import("./report.ts");
const { attachmentPathFor } = await import("./runtime/registry.ts");

/** 写一份 attachment（测试夹具必须贴近真实形状 —— 见 AGENTS.md §5） */
function writeAttachment(addr: string, sessionId: string | null, extra: Record<string, unknown> = {}) {
	const p = attachmentPathFor(addr);
	mkdirSync(join(p, ".."), { recursive: true });
	if (sessionId === null) {
		writeFileSync(p, JSON.stringify({ agentAddress: addr, generation: 1 }), "utf8"); // 缺 sessionId
		return;
	}
	writeFileSync(
		p,
		JSON.stringify({ agentAddress: addr, sessionId, generation: 1, attachedAt: new Date().toISOString(), ...extra }),
		"utf8",
	);
}

const GLOBAL_SID = "01a2070a-fbf2-7045-a398-909c365b0630";
const LOCAL_SID = "01a1a56a-4f9b-7485-9978-b789a9004df2";
const LINKS = join(tmp, "links.jsonl");
mkdirSync(join(tmp, "runtime"), { recursive: true });
writeFileSync(
	LINKS,
	[
		JSON.stringify({ kind: "tab", targetId: "tab_abc123", sessionId: "0f0e0d0c-0b0a-4090-8070-605040302010" }),
		JSON.stringify({ kind: "tab", targetId: "tab_unknown", sessionId: "unknown" }),
	].join("\n") + "\n",
	"utf8",
);

try {
	// ── ① 显式 to = agent://master_* ⇒ 读 attachment ──────────────────────
	{
		writeAttachment("agent://master_default", GLOBAL_SID);
		eq(
			recipientSessionIdFor({ from: "agent://master_local_subagent-win", to: "agent://master_default" }, LINKS),
			GLOBAL_SID,
			"① to=agent://master_default ⇒ 解析到 global 的 sessionId（横向汇报打通）",
		);
		// 换个 local master 也一样
		writeAttachment("agent://master_local_GreenCAD", LOCAL_SID);
		eq(
			recipientSessionIdFor({ from: "agent://master_local_subagent-win", to: "agent://master_local_GreenCAD" }, LINKS),
			LOCAL_SID,
			"① to=agent://master_local_* ⇒ 解析到对应 local 的 sessionId",
		);
	}

	// ── ② fail closed：无 attachment / 坏 / 非法 sessionId ────────────────
	{
		eq(
			recipientSessionIdFor({ from: "agent://master_local_x", to: "agent://master_nonexistent" }, LINKS),
			undefined,
			"② attachment 不存在 ⇒ undefined（不猜、不回落 from）",
		);
		writeAttachment("agent://master_no_sid", null);
		eq(
			recipientSessionIdFor({ from: "agent://master_local_x", to: "agent://master_no_sid" }, LINKS),
			undefined,
			"② attachment 缺 sessionId ⇒ undefined",
		);
		writeAttachment("agent://master_bad_sid", "not-a-uuid-at-all");
		eq(
			recipientSessionIdFor({ from: "agent://master_local_x", to: "agent://master_bad_sid" }, LINKS),
			undefined,
			"② sessionId 形态非法 ⇒ undefined（不把垃圾当会话 id）",
		);
		// 坏 JSON
		const badPath = attachmentPathFor("agent://master_broken");
		mkdirSync(join(badPath, ".."), { recursive: true });
		writeFileSync(badPath, "{ not json", "utf8");
		eq(
			recipientSessionIdFor({ from: "agent://master_local_x", to: "agent://master_broken" }, LINKS),
			undefined,
			"② attachment 文件损坏 ⇒ undefined（never-throw）",
		);
	}

	// ── ③ 不自环：from = agent://X 且无 to ⇒ undefined ──────────────────
	{
		eq(
			recipientSessionIdFor({ from: "agent://master_local_GreenCAD" }, LINKS),
			undefined,
			"③ from=agent:// 且无 to ⇒ undefined（**关键**：不得解析成它自己，否则 report 注入回发送方）",
		);
		// 即使那个地址有 attachment，也不得自环
		writeAttachment("agent://master_self_loop", "0a0b0c0d-0e0f-4010-8010-90100a0b0c0d");
		eq(
			recipientSessionIdFor({ from: "agent://master_self_loop" }, LINKS),
			undefined,
			"③ 有 attachment 也不得从 from 推导（避免自环）",
		);
	}

	// ── ④ 向后兼容：无 to 时旧逻辑逐字节不变 ─────────────────────────────
	{
		eq(
			recipientSessionIdFor({ from: "tab_abc123" }, LINKS),
			"0f0e0d0c-0b0a-4090-8070-605040302010",
			"④ 旧行为：from=tab_* ⇒ 查 links 拿派发方",
		);
		eq(
			recipientSessionIdFor({ from: "tab_unknown" }, LINKS),
			undefined,
			"④ 旧行为：links 里 sessionId=unknown ⇒ undefined（不消费未知身份）",
		);
		eq(
			recipientSessionIdFor({ from: "tab_notfound" }, LINKS),
			undefined,
			"④ 旧行为：links 里没有 ⇒ undefined",
		);
		eq(
			recipientSessionIdFor({ from: "01a1a56a-4f9b-7485-9978-b789a9004df2" }, LINKS),
			"01a1a56a-4f9b-7485-9978-b789a9004df2",
			"④ 旧行为：from=UUID ⇒ 直接视为接收方",
		);
		eq(recipientSessionIdFor({ from: "" }, LINKS), undefined, "④ 旧行为：空 from ⇒ undefined");
		eq(recipientSessionIdFor({ from: "随便什么中文" }, LINKS), undefined, "④ 旧行为：非 UUID 非 tab ⇒ undefined");
	}

	// ── ⑤ to 也接受 tab_* 与 UUID ────────────────────────────────────────
	{
		eq(
			recipientSessionIdFor({ from: "agent://master_local_x", to: "tab_abc123" }, LINKS),
			"0f0e0d0c-0b0a-4090-8070-605040302010",
			"⑤ to=tab_* ⇒ 走 links",
		);
		eq(
			recipientSessionIdFor({ from: "agent://master_local_x", to: "0123456789abcdef-0123-4567" }, LINKS),
			"0123456789abcdef-0123-4567",
			"⑤ to=UUID ⇒ 直接用",
		);
		eq(
			recipientSessionIdFor({ from: "agent://master_local_x", to: "garbage" }, LINKS),
			undefined,
			"⑤ to 非法 ⇒ undefined",
		);
	}

	// ── ⑥ sendReportToMain 真的把 to 落盘（走真实入口，不只手算函数）──
	{
		const reportsDir = join(tmp, "reports");
		const id = sendReportToMain(
			{ from: "agent://master_local_subagent-win", to: "agent://master_default", message: "hello global" },
			reportsDir,
		);
		const rec = readReportFile(reportsDir, id);
		ok(rec !== null, "⑥ sendReportToMain 落盘可读");
		eq(rec?.to, "agent://master_default", "⑥ to 字段真的写进 record");
		eq(rec?.from, "agent://master_local_subagent-win", "⑥ from 原样保留");
		// 不传 to ⇒ 字段不出现（向后兼容：旧读方不会看到新键）
		const id2 = sendReportToMain({ from: "tab_abc123", message: "legacy" }, reportsDir);
		const rec2 = readReportFile(reportsDir, id2);
		ok(rec2 !== null && !("to" in (rec2 as object)), "⑥ 不传 to ⇒ record 里无 to 键（旧格式零变化）");
	}
} finally {
	if (prevRuntimeDir === undefined) delete process.env.PI_RUNTIME_DIR;
	else process.env.PI_RUNTIME_DIR = prevRuntimeDir;
}

console.log(`_test_report_upward: ${checks} checks passed`);
