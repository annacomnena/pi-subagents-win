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

const { recipientSessionIdFor, sendReportToMain, readReportFile, onNewReport, _resetReportListener, healContradictoryMarkers, pollNewReports, _resetHealThrottle, detectFromMismatch } = await import("./report.ts");
const { attachmentPathFor } = await import("./runtime/registry.ts");
const { workReportLogic, registerWorkReportTool } = await import("./work-report.ts");

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
	// ── ⑦ 互斥：`.notified` 与 `.unroutable` **不得并存**（2026-11-26 多 master 事故）──
	//
	// 现场（report_mwwtqazm_jo06）：08:38:18 新码进程消费成功 → 领 `.notified` + 清标记；
	// 08:38:26 一个**仍跑旧码**的 master 进程 tick 又写回 `.unroutable`（旧码不认 to）。
	// ⇒ 「已送达」与「待重试」两个互斥状态被同时写进磁盘，而人工排查只看得到失败那个。
	{
		const reportsDir = join(tmp, "reports-mutex");
		mkdirSync(reportsDir, { recursive: true });

		// ⑦a 源头守卫：已有 `.notified` 时 **禁止**写 `.unroutable`
		writeAttachment("agent://master_default", GLOBAL_SID); // 已在上文建立，幂等
		const rec7 = {
			id: "report_mutex_a",
			from: "agent://master_local_x",
			message: "已送达但被旧码进程误判的回投",
			at: new Date().toISOString(),
		};
		writeFileSync(join(reportsDir, "report_mutex_a.json"), JSON.stringify(rec7), "utf8");
		writeFileSync(join(reportsDir, "report_mutex_a.notified"), "", "utf8"); // 已被领
		_resetReportListener();
		// from=agent:// 且无 to ⇒ 解析不出 ⇒ 旧行为会写 unroutable
		onNewReport(reportsDir, "report_mutex_a", {
			sendUserMessage: () => {},
			linksPath: LINKS,
		});
		eq(
			existsSync(join(reportsDir, "report_mutex_a.unroutable")),
			false,
			"⑦a 已有 .notified ⇒ **不得**写 .unroutable（源头阻止互斥状态并存）",
		);

		// ⑦b 存量自愈：已经并存的文件 ⇒ healContradictoryMarkers 删掉 unroutable
		writeFileSync(join(reportsDir, "report_mutex_b.json"), JSON.stringify({ ...rec7, id: "report_mutex_b" }), "utf8");
		writeFileSync(join(reportsDir, "report_mutex_b.notified"), "", "utf8");
		writeFileSync(join(reportsDir, "report_mutex_b.unroutable"), JSON.stringify({ reason: "recipient-unresolved" }), "utf8");
		const healed = healContradictoryMarkers(reportsDir);
		ok(healed.includes("report_mutex_b"), "⑦b 自愈命中并发的 id");
		eq(existsSync(join(reportsDir, "report_mutex_b.unroutable")), false, "⑦b 自愈删掉了矛盾的 .unroutable");
		eq(existsSync(join(reportsDir, "report_mutex_b.notified")), true, "⑦b `.notified`（更强证据）保留");

		// ⑦c 自愈**不得**误删真的没送达的（只有 unroutable、无 notified）
		writeFileSync(join(reportsDir, "report_mutex_c.json"), JSON.stringify({ ...rec7, id: "report_mutex_c" }), "utf8");
		writeFileSync(join(reportsDir, "report_mutex_c.unroutable"), JSON.stringify({ reason: "recipient-unresolved" }), "utf8");
		healContradictoryMarkers(reportsDir);
		eq(
			existsSync(join(reportsDir, "report_mutex_c.unroutable")),
			true,
			"⑦c 只有 unroutable（真未送达）⇒ **必须保留**（自愈不能变成「抹掉失败证据」）",
		);

		// ⑦d 文案不得再自称「无任何读取方」（一旦有人写重投器就变谎话）
		const unroutableText = readFileSync(join(reportsDir, "report_mutex_c.unroutable"), "utf8");
		writeFileSync(join(reportsDir, "report_mutex_d.json"), JSON.stringify({ ...rec7, id: "report_mutex_d" }), "utf8");
		_resetReportListener();
		onNewReport(reportsDir, "report_mutex_d", { sendUserMessage: () => {}, linksPath: LINKS });
		// 前置断言：解析不出的报**必须**落 unroutable。少了这条，若将来某改动让它不落，
		// 下面的 readFileSync 会以 ENOENT **崩溃**而不是给出清晰断言（实测踩过：M11 崩在这里）。
		ok(
			existsSync(join(reportsDir, "report_mutex_d.unroutable")),
			"⑦d 前置：解析不出的报必须落 unroutable",
		);
		const newText = existsSync(join(reportsDir, "report_mutex_d.unroutable"))
			? readFileSync(join(reportsDir, "report_mutex_d.unroutable"), "utf8")
			: "";
		ok(newText.includes("必须先跳过已存在同名"), "⑦d 新写入的 .unroutable 必须警告将来的重投器先查 .notified");
		// ⑦d2（global master 2026-11-26 提）：文案必须说清「文件存在 ≠ 未送达」——
		// 因为旧码进程会把它写回已送达的报，而自愈有 60s 节流 ⇒ 重投器若只信文件存在就会重发。
		ok(newText.includes("本文件存在不代表未送达"), "⑦d2 文案必须写「文件存在不代表未送达」");
		ok(newText.includes("重投前必须自己再查一次同名"), "⑦d2 文案必须要求重投器自查 .notified（不只信文件存在）");
		ok(!newText.includes("本文件目前**无任何读取方**"), "⑦d 旧自述（会变谎话的那句）已移除");
		ok(unroutableText.length > 0, "⑦d 对照：旧文件仍可读（不追溯改写存量）");
	}

	// ── ⑧ from-mismatch：「谁发的」可核（global master 用 pid 揭穿我的探测后补）──
	//
	// 事故：我在 GreenCAD 的 cwd 里跑脚本、`from` 写 GreenCAD ⇒ 收到的报带 pid=我的脚本进程。
	// `from` 是自报；可核的是「attachment 的 sessionId」与「进程继承的 PI_SESSION_ID」。
	{
		const GC = "agent://master_local_GreenCAD";
		const GC_SID = "01a1d371-1a49-73df-8fe1-b5c774018815";
		const MY_SID = "01a1a56a-4f9b-7485-9978-b789a9004df2";
		writeAttachment(GC, GC_SID);

		const mm = detectFromMismatch({ from: GC, envSessionId: MY_SID });
		ok(mm !== null, "⑧a from≠envSessionId ⇒ 检出冒充");
		eq(mm?.attachmentSessionId, GC_SID, "⑧a 报出 attachment 的权威 sessionId");
		eq(mm?.envSessionId, MY_SID, "⑧a 报出进程实际继承的 sessionId");

		eq(detectFromMismatch({ from: GC, envSessionId: GC_SID }), null, "⑧b from 与 envSessionId 一致 ⇒ 通过");
		eq(detectFromMismatch({ from: GC }), null, "⑧c 无 envSessionId（存量报）⇒ 跳过检查（向后兼容）");
		eq(detectFromMismatch({ from: "tab_abc123", envSessionId: MY_SID }), null, "⑧d tab_* ⇒ 不做此检查");

		{
			const dir = join(tmp, "reports-mismatch");
			mkdirSync(dir, { recursive: true });
			const bid = "report_mismatch_1";
			writeFileSync(
				join(dir, bid + ".json"),
				JSON.stringify({ id: bid, from: GC, to: "agent://master_default", envSessionId: MY_SID, message: "冒充", at: new Date().toISOString(), pid: 1 }),
				"utf8",
			);
			_resetReportListener();
			const injected = [];
			onNewReport(dir, bid, { sendUserMessage: (b) => injected.push(b), linksPath: LINKS });
			eq(existsSync(join(dir, bid + ".from-mismatch")), true, "⑧e 接线：冒充 ⇒ 落 .from-mismatch 标记");
			eq(injected.length, 0, "⑧e 冒充的报**不得**注入本会话（哪怕路由能解析）");
			eq(existsSync(join(dir, bid + ".unroutable")), false, "⑧e 冒充**不是** unroutable（拒收 vs 不知道怎么送）");
		}

		{
			const dir = join(tmp, "reports-ident");
			const prevSid = process.env.PI_SESSION_ID;
			process.env.PI_SESSION_ID = MY_SID;
			try {
				const iid = sendReportToMain({ from: "tab_abc123", message: "ident" }, dir);
				const r = readReportFile(dir, iid);
				eq(r?.envSessionId, MY_SID, "⑧f envSessionId 自动从 PI_SESSION_ID 写入");
				ok(typeof r?.cwd === "string" && r.cwd.length > 0, "⑧f cwd 自动写入（OS 事实，不是参数）");
			} finally {
				if (prevSid === undefined) delete process.env.PI_SESSION_ID;
				else process.env.PI_SESSION_ID = prevSid;
			}
		}
	}


	// ── ⑨ work-report 工具入口：pid 必须是**会话进程**（脚本入口永远做不到）──
	//
	// global master 的判据：「pid 必须是会话进程（如 GreenCAD 30212）」。
	// 实测脚本入口永远不满足：GreenCAD 那份报 pid=31244（子进程，已退出），会话是 30212。
	// 工具在会话进程内执行 ⇒ process.pid 天然就是会话 pid。
	{
		const dir = join(tmp, "reports-tool");
		const SID = "01a1a56a-4f9b-7485-9978-b789a9004df2";
		writeAttachment("agent://master_local_subagent-win", SID);

		// ⑨a 有 attachment ⇒ 发送成功，from = 自己的地址（不是参数）
		const r1 = workReportLogic({ message: "hello global", to: "agent://master_default", sessionId: SID, reportsDir: dir });
		eq(r1.ok, true, "⑨a 有 attachment ⇒ 发送成功");
		eq(r1.details.from, "agent://master_local_subagent-win", "⑨a from 由会话反查，不是调用方传的");
		eq(r1.details.pid, process.pid, "⑨a **pid === process.pid（会话进程）** —— 这是收方可核的关键");
		ok(typeof r1.details.reportId === "string", "⑨a 落盘返回 reportId");

		// ⑨b 无 attachment ⇒ 拒绝（不猜身份、不冒充）
		const r2 = workReportLogic({ message: "x", sessionId: "ffffffff-0000-4000-8000-000000000000", reportsDir: dir });
		eq(r2.ok, false, "⑨b 无 attachment ⇒ 拒绝发送");
		eq(r2.details.reason, "no-attachment", "⑨b 拒绝理由明确");

		// ⑨c 无 sessionId ⇒ 拒绝
		const r3 = workReportLogic({ message: "x", sessionId: "", reportsDir: dir });
		eq(r3.ok, false, "⑨c 拿不到会话 id ⇒ 拒绝发送");
		eq(r3.details.reason, "no-session-id", "⑨c 拒绝理由明确");

		// ⑨d 空正文 ⇒ 拒绝
		const r4 = workReportLogic({ message: "   ", sessionId: SID, reportsDir: dir });
		eq(r4.ok, false, "⑨d 空正文 ⇒ 拒绝");

		// ⑨e **接线**：注册函数真的把这个工具注册给 pi（否则工具永远不存在）
		{
			const names: string[] = [];
			const fakePi = {
				registerTool(t: { name: string }) {
					names.push(t.name);
				},
			};
			registerWorkReportTool(fakePi as never);
			eq(names.includes("work-report"), true, "⑨e 接线：registerWorkReportTool 真的注册了 work-report");
			eq(names.length, 1, "⑨e 只注册一个工具（不误注册其它）");
		}
	}

	// ── ⑦e **接线**：`pollNewReports` 真的调了自愈（否则删掉那行仍全绿 = 假绿）──
	// AGENTS.md §4：变异必须变异**真实接线**，不能只变异函数体。
	{
		const reportsDir = join(tmp, "reports-wiring");
		mkdirSync(reportsDir, { recursive: true });
		writeFileSync(
			join(reportsDir, "report_wire_1.json"),
			JSON.stringify({ id: "report_wire_1", from: "tab_notfound", message: "x", at: new Date().toISOString() }),
			"utf8",
		);
		writeFileSync(join(reportsDir, "report_wire_1.notified"), "", "utf8");
		writeFileSync(join(reportsDir, "report_wire_1.unroutable"), JSON.stringify({ reason: "recipient-unresolved" }), "utf8");
		_resetReportListener();
		_resetHealThrottle();
		pollNewReports(reportsDir, { sendUserMessage: () => {}, linksPath: LINKS });
		eq(
			existsSync(join(reportsDir, "report_wire_1.unroutable")),
			false,
			"⑦e 接线：pollNewReports（tick 入口）必须真的调自愈，否则并存会永久留在磁盘",
		);
	}
} finally {
	if (prevRuntimeDir === undefined) delete process.env.PI_RUNTIME_DIR;
	else process.env.PI_RUNTIME_DIR = prevRuntimeDir;
}

console.log(`_test_report_upward: ${checks} checks passed`);
