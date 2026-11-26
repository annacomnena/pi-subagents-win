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

const { recipientSessionIdFor, sendReportToMain, readReportFile, onNewReport, _resetReportListener, healContradictoryMarkers, pollNewReports, _resetHealThrottle, detectFromMismatch, detectSuspicion, detectStaleContext } = await import("./report.ts");
const { attachmentPathFor } = await import("./runtime/registry.ts");
const { workReportLogic, registerWorkReportTool } = await import("./work-report.ts");
const { setCurrentSessionId } = await import("./identity.ts");

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

		const FUT = "2099-01-01T00:00:00.000Z"; // 晚于 attachment 的 attachedAt ⇒ 时间锚放行这一侧
		const mm = detectFromMismatch({ from: GC, envSessionId: MY_SID, at: FUT });
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
				JSON.stringify({ id: bid, from: GC, to: MY_SID, envSessionId: MY_SID, message: "冒充", at: "2099-01-01T00:00:00.000Z", pid: 1 }),
				"utf8",
			);
			_resetReportListener();
			const injected = [];
			setCurrentSessionId(MY_SID);
			try {
				onNewReport(dir, bid, { sendUserMessage: (b) => injected.push(b), linksPath: LINKS });
			} finally {
				setCurrentSessionId(undefined);
			}
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
		// ⚠ 必须传 to（L4 P2-3，2026-11-26）：不传时 recipient 恒 undefined
		// ⇒ `ok = Boolean(recipient)` 恒 false ⇒ 断言恒真（删掉空正文检查也绿）。传了才能区分两者。
		const r4 = workReportLogic({ message: "   ", to: "agent://master_default", sessionId: SID, reportsDir: dir });
		eq(r4.ok, false, "⑨d 空正文 ⇒ 拒绝");
		eq(r4.details.reason, "empty-message", "⑨d 拒绝理由必须是 empty-message（不是「路不通」）");

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

	// ── ⑩ 独立可疑信号（global master 的三步判据，只标记不拒收）──
	//
	// 为什么需要：`detectFromMismatch` 对自家脚本恒 null（`from` 由 envSessionId 反查 ⇒ 构造上必然一致）。
	// 真正独立的两条：① envSessionId 不在白名单 ② from 的 local scope 不在 cwd 里。
	{
		const dir = join(tmp, "reports-sus");
		mkdirSync(dir, { recursive: true });
		const GSID = "01a2070a-fbf2-7045-a398-909c365b0630";
		writeAttachment("agent://master_default", GSID);

		// ⑩a 构造性再说一遍：from 由 envSessionId 反查 ⇒ detectFromMismatch 恒 null（不是遗漏，是 tautology）
		eq(
			detectFromMismatch({ from: "agent://master_local_subagent-win", envSessionId: "01a1a56a-4f9b-7485-9978-b789a9004df2" }),
			null,
			"⑩a 自家脚本路径下 detectFromMismatch 恒 null（判别力登记）",
		);

		// ⑩b envSessionId 不在任何 attachment ⇒ unknown-session
		const s1 = detectSuspicion({ from: "agent://master_local_x", cwd: "C:\\tmp", envSessionId: "deadbeef-0000-4000-8000-000000000000" });
		ok(s1 !== null, "⑩b 未登记会话 ⇒ 报可疑");
		ok(s1?.reasons.includes("unknown-session"), "⑩b 理由是 unknown-session");

		// ⑩c cwd 不含它自报的 scope ⇒ cwd-scope-mismatch（这正是 global 自己那份探针的形状）
		const s2 = detectSuspicion({ from: "agent://master_local_GreenCAD", cwd: "C:\\tmp", envSessionId: GSID });
		ok(s2 !== null, "⑩c 在 C:/tmp 里替 GreenCAD 发 ⇒ 报可疑");
		ok(s2?.reasons.includes("cwd-scope-mismatch"), "⑩c 理由是 cwd-scope-mismatch");
		eq(s2?.detail.declaredScope, "GreenCAD", "⑩c 报出它声称的 scope");

		// ⑩d 一致（cwd 含 scope）⇒ 不报
		eq(
			detectSuspicion({ from: "agent://master_local_GreenCAD", cwd: "G:\\code\\GreenCAD\\sub", envSessionId: GSID }),
			null,
			"⑩d cwd 含 scope（含子目录）⇒ 不报",
		);

		// ⑩e global 没有 local scope ⇒ 跳过 ②（不得误报）
		eq(
			detectSuspicion({ from: "agent://master_default", cwd: "C:\\tmp", envSessionId: GSID }),
			null,
			"⑩e agent://master_default 无 scope ⇒ 不做 cwd 比对（不误报）",
		);

		// ⑩f 存量报（无 cwd / 无 envSessionId）⇒ 不报
		eq(detectSuspicion({ from: "agent://master_local_GreenCAD" }), null, "⑩f 无 cwd/envSessionId ⇒ 不报（向后兼容）");

		// ⑩g **接线 + 只标不拒**：可疑的报**仍会被正常投递**（不 return）
		{
			const d2 = join(tmp, "reports-sus-wire");
			mkdirSync(d2, { recursive: true });
			const sid = "report_sus_wire_1";
			writeFileSync(
				join(d2, sid + ".json"),
				JSON.stringify({
					id: sid,
					from: "agent://master_local_GreenCAD",
					to: "agent://master_default",
					cwd: "C:\\tmp",
					envSessionId: GSID,
					message: "替 GreenCAD 发但 cwd 不对",
					at: new Date().toISOString(),
					pid: 1,
				}),
				"utf8",
			);
			writeAttachment("agent://master_local_GreenCAD", GSID); // 让它可路由
			_resetReportListener();
			// 本进程不是接收方（接收方是 GSID 的 default），所以走分流分支；关键看标记
			onNewReport(d2, sid, { sendUserMessage: () => {}, linksPath: LINKS });
			eq(existsSync(join(d2, sid + ".suspicious")), true, "⑩g 接线：可疑 ⇒ 落 .suspicious 标记");
			eq(existsSync(join(d2, sid + ".from-mismatch")), false, "⑩g 可疑**不是** from-mismatch（语义不同：辅助信号 vs 自相矛盾）");
		}
	}

	// ⑪ 记录正文必须含自己的 id（global master 2026-11-26 指出）
	//
	// 旧行为：id 只存于**文件名** ⇒ 正文无法标识自己；而 `.unroutable` 侧车**有** `id`
	// ⇒ 两个文件字段集不一致，且缺的正是主文件那个。
	{
		const dir = join(tmp, "reports-id");
		const rid = sendReportToMain({ from: "tab_abc123", message: "with id" }, dir);
		const rec = readReportFile(dir, rid);
		eq(rec?.id, rid, "⑪a 正文里的 id 必须等于文件名");
		// →反向：只靠文件名的记录，一旦复制出去就丢身份
		writeFileSync(join(dir, "report_legacy_noid.json"), JSON.stringify({ from: "tab_x", message: "old", at: new Date().toISOString(), pid: 1 }), "utf8");
		const legacy = readReportFile(dir, "report_legacy_noid");
		eq(legacy?.id, undefined, "⑪b 存量无 id 仍可读（向后兼容，不报错）");
		ok(legacy?.message === "old", "⑪b 存量记录正文不受影响");
	}

	// ── ⑫ L4 阻断项回归（2026-11-26，独立审查 B1/B3/L4-M5/L4-M6）──
	{
		const dir = join(tmp, "reports-l4");
		mkdirSync(dir, { recursive: true });
		const HO = "agent://master_local_HandedOver";
		const OLD_SID = "01a1aaaa-0000-4000-8000-000000000001";
		const NEW_SID = "01a1bbbb-0000-4000-8000-000000000002";

		// 交接：attachment 现在属于 NEW_SID，且 attachedAt 晚于旧报
		const hoPath = attachmentPathFor(HO);
		mkdirSync(join(hoPath, ".."), { recursive: true });
		writeFileSync(
			hoPath,
			JSON.stringify({ agentAddress: HO, sessionId: NEW_SID, generation: 2, attachedAt: "2026-11-26T10:00:00.000Z", lastHeartbeatAt: "2026-11-26T10:00:00.000Z", attemptId: "t" }),
			"utf8",
		);

		// ⑫a **B1 核心**：交接前发出的合法报 ⇒ 不得判冒充（否则永久不投递 + 错误归因）
		eq(
			detectFromMismatch({ from: HO, envSessionId: OLD_SID, at: "2026-11-26T09:00:00.000Z" }),
			null,
			"⑫a 交接**前**发出的报（envSessionId=旧 owner）⇒ 不判冒充（时间锚）",
		);

		// ⑫b 交接后旧 owner 继续发 ⇒ 才是冒充
		ok(
			detectFromMismatch({ from: HO, envSessionId: OLD_SID, at: "2026-11-26T11:00:00.000Z" }) !== null,
			"⑫b 交接**后**旧 owner 仍发 ⇒ 判冒充（时间锚不放行这一侧）",
		);

		// ⑫c 时间不可解析 ⇒ fail open（不因坏时间戳入罪）
		eq(
			detectFromMismatch({ from: HO, envSessionId: OLD_SID, at: "not-a-date" }),
			null,
			"⑫c 坏时间戳 ⇒ 不判冒充（fail open，宁可放过）",
		);

		// ⑫d L4-N3：已送达的报不得被补写永久「拒收」标记
		{
			const d2 = join(tmp, "reports-l4-n3");
			mkdirSync(d2, { recursive: true });
			const nid = "report_n3_delivered";
			writeFileSync(join(d2, nid + ".json"), JSON.stringify({ id: nid, from: HO, envSessionId: OLD_SID, at: "2026-11-26T11:00:00.000Z", message: "x", pid: 1 }), "utf8");
			writeFileSync(join(d2, nid + ".notified"), "", "utf8"); // 已送达
			_resetReportListener();
			onNewReport(d2, nid, { sendUserMessage: () => {}, linksPath: LINKS });
			eq(existsSync(join(d2, nid + ".from-mismatch")), false, "⑫d 已送达（有 .notified）⇒ 不写 .from-mismatch");
		}

		// ⑫e L4-M5：`index.ts` 真的注册了 work-report（删掉真实注册调用必须红）
		{
			const idxPath = join(process.cwd(), "extensions", "index.ts");
			const idxSrc = readFileSync(idxPath, "utf8");
			ok(idxSrc.includes("registerWorkReportTool(pi)"), "⑫e 接线：extensions/index.ts 必须真的调用 registerWorkReportTool(pi)");
			ok(idxSrc.includes('from "./work-report.ts"'), "⑫e 接线：index.ts 必须 import work-report");
		}

		// ⑫f L4-M6：**只标不拒** —— 可疑但收件人就是本会话 ⇒ 仍然注入
		{
			const d3 = join(tmp, "reports-l4-m6");
			mkdirSync(d3, { recursive: true });
			const MY = "01a1a56a-4f9b-7485-9978-b789a9004df2";
			const sid3 = "report_m6_suspicious_delivered";
			writeFileSync(
				join(d3, sid3 + ".json"),
				JSON.stringify({
					id: sid3,
					from: HO,
					to: MY,
					envSessionId: NEW_SID, // 与 attachment 一致 ⇒ 不是 mismatch
					cwd: "C:\\tmp", // 但 scope=HandedOver 不在 cwd 里 ⇒ 可疑
					message: "可疑但要照常投递",
					at: "2026-11-26T11:00:00.000Z",
					pid: 1,
				}),
				"utf8",
			);
			setCurrentSessionId(MY);
			_resetReportListener();
			const injected: string[] = [];
			try {
				const fired = onNewReport(d3, sid3, { sendUserMessage: (b: string) => injected.push(b), linksPath: LINKS });
				eq(fired, true, "⑫f 可疑的报仍必须投递（fired=true）");
				ok(injected.length > 0, "⑫f **只标不拒**：可疑仍注入正文（变异成拒收必须红）");
				eq(existsSync(join(d3, sid3 + ".suspicious")), true, "⑫f 同时落了 .suspicious 标记");
			} finally {
				setCurrentSessionId(undefined);
			}
		}
	}

	// ── ⑬ 内容陈旧检测（否定式判据的自动化）──
	//
	// global master 2026-11-26 的判据：**不一致 ⇒ 报 STALE；一致 ⇒ 什么都不说。**
	// 「一致也打一行 OK」会制造假证据 —— 因为「一致」只证明有人读过这个仓，不证明是谁发的。
	{
		const { execFileSync } = await import("node:child_process");
		const REPO = process.cwd();
		const nowHead = execFileSync("git", ["-C", REPO, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();

		const mk = (head) => ({ message: `[auto] at=2026-11-26T01:00:00Z cwd=x repo=${REPO} head=${head} branch=b modified=0 staged=0 untracked=0` + String.fromCharCode(10) + String.fromCharCode(10) + "body" });

		// ⑬a **一致 ⇒ null**（不得输出任何"已验证"）
		eq(detectStaleContext(mk(nowHead)), null, "⑬a 一致 ⇒ 什么都不说（禁止制造假证据）");

		// ⑬b 陈旧 ⇒ 同时报出两个值（只报不一致这一侧）
		const st = detectStaleContext(mk("deadbeef"));
		ok(st !== null, "⑬b 不一致 ⇒ 报 STALE");
		eq(st?.reportedHead, "deadbeef", "⑬b 报出「它说的」");
		eq(st?.actualHead, nowHead, "⑬b 报出「现在的」");

		// ⑬c 无 auto 行 ⇒ 不检查（tab 报 / 手工 JSON / 旧脚本）
		eq(detectStaleContext({ message: "普通正文" }), null, "⑬c 无 auto 行 ⇒ 不检查");

		// ⑬d repo 读不到 ⇒ 不知道（不制造假信号）
		eq(detectStaleContext({ message: "[auto] repo=C:/no/such/repo head=deadbeef" }), null, "⑬d 读不到仓 ⇒ 不知道，不造假信号");

		// ⑬e **接线 + 只标不拒**：陈旧报仍投递，但落 .stale
		{
			const dir = join(tmp, "reports-stale");
			mkdirSync(dir, { recursive: true });
			const sid = "report_stale_1";
			writeFileSync(
				join(dir, sid + ".json"),
				JSON.stringify({
					id: sid, from: "tab_stale", to: "01a1a56a-4f9b-7485-9978-b789a9004df2",
					message: `[auto] at=2026-11-26T01:00:00Z cwd=x repo=${REPO} head=deadbeef branch=b modified=0 staged=0 untracked=0` + String.fromCharCode(10) + String.fromCharCode(10) + "过时正文",
					at: new Date().toISOString(), pid: 1,
				}),
				"utf8",
			);
			setCurrentSessionId("01a1a56a-4f9b-7485-9978-b789a9004df2");
			_resetReportListener();
			const inj = [];
			try {
				const fired = onNewReport(dir, sid, { sendUserMessage: (b) => inj.push(b), linksPath: LINKS });
				eq(fired, true, "⑬e 陈旧的报仍必须投递（只标不拒）");
				ok(inj.length > 0, "⑬e 正文确实注入");
				eq(existsSync(join(dir, sid + ".stale")), true, "⑬e 同时落 .stale 标记");
			} finally {
				setCurrentSessionId(undefined);
			}
		}

		// ⑬f **一致 ⇒ 不得落 .stale**（否则等于「验证通过」的假证据）
		{
			const dir = join(tmp, "reports-fresh");
			mkdirSync(dir, { recursive: true });
			const sid = "report_fresh_1";
			writeFileSync(
				join(dir, sid + ".json"),
				JSON.stringify({
					id: sid, from: "tab_fresh", to: "01a1a56a-4f9b-7485-9978-b789a9004df2",
					message: `[auto] at=2026-11-26T01:00:00Z cwd=x repo=${REPO} head=${nowHead} branch=b modified=0 staged=0 untracked=0` + String.fromCharCode(10) + String.fromCharCode(10) + "新鲜正文",
					at: new Date().toISOString(), pid: 1,
				}),
				"utf8",
			);
			setCurrentSessionId("01a1a56a-4f9b-7485-9978-b789a9004df2");
			_resetReportListener();
			try {
				onNewReport(dir, sid, { sendUserMessage: () => {}, linksPath: LINKS });
				eq(existsSync(join(dir, sid + ".stale")), false, "⑬f 一致 ⇒ **不得**写任何标记（不制造假证据）");
			} finally {
				setCurrentSessionId(undefined);
			}
		}
	}

	// ── ⑭ tool 协议：`execute` 必须返回 `content`（L4 P0-2）──
	//
	// 事故：`work-report` 的 execute 只返回 `details` ⇒ pi 靠 `content` 把结果交给模型，
	// ⇒ **工具能跑、有 ok，但模型看不到任何返回** = 新功能对模型静默失效。
	// 这是「实现了但没接线」的典型：测试可以直接调 `workReportLogic` 而绕过协议。
	// ⇒ 本组断言必须经过**真实 execute 签名**，不能只调 logic。
	{
		const dir = join(tmp, "reports-exec");
		mkdirSync(dir, { recursive: true });
		const MY_SID2 = "01a1a56a-4f9b-7485-9978-b789a9004df2";
		writeAttachment("agent://master_local_subagent-win", MY_SID2);

		let captured = null;
		const fakePi = { registerTool(t) { captured = t; } };
		registerWorkReportTool(fakePi, { reportsDir: dir });
		ok(captured !== null, "⑭ 前置：registerWorkReportTool 捕获到工具定义");
		eq(captured?.name, "work-report", "⑭ 工具名正确");
		ok(typeof captured?.execute === "function", "⑭ 有 execute");

		setCurrentSessionId(MY_SID2);
		let res;
		try {
			res = await captured.execute("tc1", { message: "hello via tool", to: "agent://master_default" });
		} finally {
			setCurrentSessionId(undefined);
		}
		ok(Array.isArray(res?.content), "⑭ **execute 必须返回 content 数组**（否则模型收到空结果）");
		eq(res?.content?.[0]?.type, "text", "⑭ content[0].type === 'text'");
		ok(typeof res?.content?.[0]?.text === "string" && res.content[0].text.length > 0, "⑭ content[0].text 非空");
		ok(String(res.content[0].text).includes("work-report"), "⑭ 正文包含可读信息（不是空串）");
		ok(res?.details && typeof res.details === "object", "⑭ details 仍然保留（渲染层用）");
	}

	// ⑮ 反向断言：`work-report` 落盘**不得**带 `envSessionId`（global master 2026-11-26 警告）
	//
	// 为什么要「反向」守：我曾为了修 P1-1 而把 `envSessionId` 设成会话 id，
	// 而那是 **tautology**（`from` 也是用同一个 sessionId 反查的）。
	// 恒真的检查比恒假的更危险（恒假红了有人查，恒真绿了没人查）。
	// ⇒ 宁可让它**缺失**（`detectFromMismatch` 显式跳过），也不留一份看起来能比对的假材料。
	{
		const dir = join(tmp, "reports-noenv");
		const RID = "01a1a56a-4f9b-7485-9978-b789a9004df2";
		writeAttachment("agent://master_local_subagent-win", RID);
		// ⚠ 必须先清掉 `PI_SESSION_ID`：否则 `sendReportToMain` 会回退读它（测试进程继承自 bash），
		// 而**生产的会话进程没有这个 env**（`dist/core/tools/bash.js:159` 先 delete，只给 shell 子进程设）。
		// ⇒ 不清的话，这条断言在测试里永远不成立，而它反映的又不是生产行为。
		const prevEnvSid = process.env.PI_SESSION_ID;
		delete process.env.PI_SESSION_ID;
		let outcome;
		try {
			outcome = workReportLogic({
				message: "no-env-session",
				to: "agent://master_default",
				sessionId: RID,
				reportsDir: dir,
			});
		} finally {
			if (prevEnvSid !== undefined) process.env.PI_SESSION_ID = prevEnvSid;
		}
		ok(outcome.ok, "⑮ 前置：work-report 成功落盘");
		const written = readReportFile(dir, String(outcome.details.reportId));
		ok(written !== null, "⑮ 前置：能读回刚写的报");
		ok(!("envSessionId" in (written as object)), "⑮ **work-report 落盘不得带 envSessionId**（否则是 tautology 假材料）");
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
