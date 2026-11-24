/**
 * _test_report_blackhole.ts — Item 66（2026-11-24）回归：回报通道的三个静默黑洞。
 *
 * 真实入口要求（AGENTS.md §4 / R-4）：断言必须经过 **pollNewReports / registerReportListener
 * 的 session_start → tick** 这两条真实链路，不能只调 `onNewReport` 内部函数。
 * （如实登记：C3/C6 走完整注册链路；C1/C2/C4/C5/C7/C8 走 tick 的**回调体** pollNewReports，
 *   未覆盖 fs.watch 分支与 ownerEligible/isSubagent 门——那是 registerReportListener 的事。）
 *
 * 覆盖：
 *  C1 `from=agent://master_local_*`（解析不到）⇒ 落 `.unroutable` 可见证据，**不写 `.notified`**
 *  C2 同上，**下一次 tick 仍会重试**（解析能力恢复后自动送达）—— 旧实现在 tick#1 后永久跳过
 *  C3 重启第二判决：`session_start` 的 snapshotExisting **只把已消费（有 .notified）的算已处理**
 *  C4 「解析成功但不是本会话」仍是正常分流：不写 `.notified`、不写 `.unroutable`、重复 tick 不重扫
 *  C5 `.unroutable` 不被当成回报文件枚举（listReportIds 只认 .json）
 *  C6 注入门的瞬时抑制（suppressed-not-owner）≠ 永久已处理：attach 晚到后同一份仍能送达
 *  C7 送达后清理 `.unroutable`（不留“未被消费”与“已消费”的矛盾证据）
 *  C8 退避指数增长并封顶（5s→…→5min），但**无次数上限**（不会永久放弃）
 *  C9 夹具清理 PI_SUBAGENT / PI_TAB_RUN_ID（agent shell 下也能绿）
 *  C10 already-injected ⇒ 收工（即使 .notified 缺失也不得无限重扫）
 *  C11 send 失败不删 .unroutable（不制造反向矛盾证据）
 *
 * 运行：npm run test:report-blackhole
 */
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "report-blackhole-runtime-"));
// 夹具纪律（对齐 _test_report.ts:16-17，L4 阻断项 1）：
// 本仓最常见的执行环境是 **agent 派生的 shell**（PI_SUBAGENT=1）。report.ts:297 的
// `if (isSubagent()) return;` 在那里恒真 ⇒ session_start 处理器直接返回 ⇒ C3 必红。
// 实测：不删这两个变量时本套件只在第 3 条就崩。
delete process.env.PI_SUBAGENT;
delete process.env.PI_TAB_RUN_ID;

const {
	_forceUnroutableRetryDue, _isReportSeen, _resetReportListener, _unroutableAttemptState, listReportIds, onNewReport, pollNewReports, registerReportListener, sendReportToMain,
} = await import("./report.ts");
const { setCurrentSessionId, getCurrentSessionId } = await import("./identity.ts");

let n = 0;
const ok = (msg: string): void => { n += 1; console.log(`ok ${n} - ${msg}`); };

const ROOT = mkdtempSync(join(tmpdir(), "report-blackhole-"));
let caseNo = 0;
const newCase = (): { reportsDir: string; linksPath: string } => {
	caseNo += 1;
	const d = join(ROOT, `case${caseNo}`);
	mkdirSync(join(d, "reports"), { recursive: true });
	const linksPath = join(d, "links.jsonl");
	writeFileSync(linksPath, "", "utf8");
	return { reportsDir: join(d, "reports"), linksPath };
};
/** 追加一条 links 派发记录（真实形状：kind=tab，targetId=from，sessionId=派发方会话）。 */
const addTabLink = (linksPath: string, from: string, sessionId: string): void => {
	appendFileSync(linksPath, JSON.stringify({
		sessionId, kind: "tab", targetId: from,
		detail: "fixture", at: new Date().toISOString(), pid: process.pid,
	}) + String.fromCharCode(10), "utf8");
};

// ── C1：master 地址形态 ⇒ 可见标记、不 claim ────────────────────────
{
	_resetReportListener();
	const { reportsDir, linksPath } = newCase();
	// 本进程扮演「主会话」，但那份回报的 from 解析不到接收方
	setCurrentSessionId("01a1a56a-0000-4000-8000-00000000c001");
	const injected: string[] = [];
	const opts = { reportsDir, linksPath, toast: false, sendUserMessage: (c: string) => { injected.push(c); } };

	const id = sendReportToMain({ from: "agent://master_local_GreenCAD", message: "离线解析成果" }, reportsDir);

	const fired = pollNewReports(reportsDir, opts);
	assert.equal(fired.length, 0, "解析不到接收方 ⇒ 不得消费");
	assert.equal(injected.length, 0, "不得注入");

	// 【核心断言】旧实现：既不写 .notified（正确）却已 markSeen（错误）⇒ 永久黑洞。
	// 修后：写 .unroutable 作为人可见证据，仍不写 .notified。
	assert.equal(
		existsSync(join(reportsDir, `${id}.unroutable`), true),
		true,
		"解析失败必须留下人可见的 .unroutable 标记（静默失效不可接受，AGENTS.md R-2）",
	);
	assert.equal(existsSync(join(reportsDir, `${id}.notified`)), false, "未送达就绝不能有 .notified");
	const marker = JSON.parse(readFileSync(join(reportsDir, `${id}.unroutable`), "utf8")) as { from?: string; reason?: string };
	assert.equal(marker.from, "agent://master_local_GreenCAD");
	assert.equal(marker.reason, "recipient-unresolved");
	ok("C1 解析不到接收方 ⇒ 落 .unroutable 标记、不写 .notified");
}

// ── C2：可重试 —— 解析能力恢复后，下一次 tick 必须送达 ──────────────
{
	_resetReportListener();
	const { reportsDir, linksPath } = newCase();
	setCurrentSessionId("01a1a56a-0000-4000-8000-00000000c002");
	const injected: string[] = [];
	const opts = { reportsDir, linksPath, toast: false, sendUserMessage: (c: string) => { injected.push(c); } };

	// from 用 tab 形态但 links 里还没有这条派发记录 ⇒ 解析不到（与 master 形态同一个分支）
	const id = sendReportToMain({ from: "tab_bh_recover", message: "先解析不到，后来能解析" }, reportsDir);

	const fired1 = pollNewReports(reportsDir, opts);
	assert.equal(fired1.length, 0);
	assert.equal(existsSync(join(reportsDir, `${id}.notified`)), false);

	// 关键：把派发记录补上（等价于「解析能力在后续版本修好」/「链路补齐」）
	addTabLink(linksPath, "tab_bh_recover", "01a1a56a-0000-4000-8000-00000000c002");
	// 退避窗口到期（生产由 nextAt 到期达成；这里显式推到过去，见 `_forceUnroutableRetryDue` 注释）
	_forceUnroutableRetryDue(id);

	const fired2 = pollNewReports(reportsDir, opts);
	assert.equal(fired2.length, 1, "【缺陷 3】tick#2 必须重试并送达；旧实现在 tick#1 后已 markSeen ⇒ 恒 0");
	assert.equal(injected.length, 1, "必须真的注入");
	assert.equal(existsSync(join(reportsDir, `${id}.notified`)), true, "送达后必须有 .notified");

	// 送达后幂等：第三次 tick 不再重复
	const fired3 = pollNewReports(reportsDir, opts);
	assert.equal(fired3.length, 0);
	assert.equal(injected.length, 1);
	ok("C2 解析失败后可重试：链路补齐后下一次 tick 送达（旧实现永久跳过）");
}

// ── C3：重启第二判决 —— snapshotExisting 只认「已消费」 ──────────────
//
// 必须走真实注册入口（pi.on("session_start") → snapshotExisting → interval → poll）。
// 旧实现把目录里**所有**文件都标 seen ⇒ 从未消费的回报重启后也永远不再尝试。
{
	_resetReportListener();
	const { reportsDir, linksPath } = newCase();
	const SID = "01a1a56a-0000-4000-8000-00000000c003";

	// ① 重启前就存在的「解析不到」回报（模拟 GreenCAD 那份在盘上等着）
	const idOld = sendReportToMain({ from: "tab_bh_old", message: "重启前就存在、从未被消费" }, reportsDir);
	assert.equal(existsSync(join(reportsDir, `${idOld}.notified`)), false, "夹具：它确实从未被消费");

	// ② 真注册入口：session_start → snapshotExisting
	const injected: string[] = [];
	const handlers: Array<(e: unknown, ctx?: unknown) => void> = [];
	const fakePi = {
		on(ev: string, cb: (e: unknown, ctx?: unknown) => void) { if (ev === "session_start") handlers.push(cb); },
		sendUserMessage: (c: string) => { injected.push(c); return true; },
	};
	const stop = registerReportListener(fakePi as never, {
		reportsDir, linksPath, toast: false, pollIntervalMs: 40,
	});
	for (const h of handlers) h({}, { sessionManager: { sessionId: SID } });
	assert.equal(getCurrentSessionId(), SID, "夹具自检：session_start 必须设好 currentSessionId");

	// ③ 解析链路补齐（session_start 之后才补，模拟「重启后路由能力已修好」）
	addTabLink(linksPath, "tab_bh_old", SID);

	// ④ 等真实 tick（不是直接调 pollNewReports）
	await new Promise((r) => setTimeout(r, 220));

	assert.ok(
		injected.length > 0,
		`【缺陷 3 · 第二判决】重启后仍必须消费这份从未送达的回报；旧实现 snapshotExisting 把它标成已处理 ⇒ 恒 0（实际 ${injected.length}）`,
	);
	assert.equal(existsSync(join(reportsDir, `${idOld}.notified`)), true, "送达后必须有 .notified");
	stop();
	ok("C3 重启不把「未消费」当已处理（真实 session_start → tick 链路）");
}

// ── C4：解析成功但不是本会话 ⇒ 正常分流（不 claim / 不标 unroutable / 不重扫）──
{
	_resetReportListener();
	const { reportsDir, linksPath } = newCase();
	setCurrentSessionId("01a1a56a-0000-4000-8000-00000000c004");
	addTabLink(linksPath, "tab_bh_other", "01a1a56a-0000-4000-8000-00000000c0ff"); // 派给另一个会话
	const injected: string[] = [];
	const opts = { reportsDir, linksPath, toast: false, sendUserMessage: (c: string) => { injected.push(c); } };

	const id = sendReportToMain({ from: "tab_bh_other", message: "别人的回报" }, reportsDir);

	const f1 = pollNewReports(reportsDir, opts);
	assert.equal(f1.length, 0, "不是本会话的回报不得消费");
	assert.equal(existsSync(join(reportsDir, `${id}.unroutable`)), false, "能解析到接收方 ⇒ 不该写 unroutable");
	assert.equal(existsSync(join(reportsDir, `${id}.notified`)), false, "没送达 ⇒ 不得 claim");

	// 本进程已 markSeen（正常分流，永不负责）⇒ 重复 tick 不重扫、也不误判成黑洞。
	// 判据必须用 `_isReportSeen`：`onNewReport(...)===false` 对「有没有 markSeen」**零判别力**
	// （分支② 不 markSeen 时也返回 false）—— 这是第一轮假绿的来源（L4 S7）。
	assert.equal(_isReportSeen(id), true, "分支②（非本会话）必须 markSeen 收工，否则每 tick 空转重扫");
	const f2 = pollNewReports(reportsDir, opts);
	assert.equal(f2.length, 0);
	assert.equal(injected.length, 0);
	assert.equal(onNewReport(reportsDir, id, opts), false);
	ok("C4 能解析但非本会话 ⇒ 正常分流，不 claim 不标黑洞，且不重复扫描");
}

// ── C5：.unroutable 不进回报枚举 ────────────────────────────────────
{
	const { reportsDir } = newCase();
	const id = sendReportToMain({ from: "agent://master_default", message: "x" }, reportsDir);
	pollNewReports(reportsDir, { reportsDir, linksPath: join(ROOT, "nope.jsonl"), toast: false, sendUserMessage: () => {} });
	const ids = listReportIds(reportsDir);
	assert.equal(ids.includes(id), true, "回报本体仍被枚举");
	assert.equal(ids.some((x) => x.endsWith(".unroutable")), false, "标记文件不得被当成回报");
	assert.equal(ids.length, 1, "目录里只应枚举出 1 份回报（标记文件不算）");
	ok("C5 .unroutable 不会被 listReportIds 当成回报文件");
}

// ── C6：gate 瞬时抑制 ≠ 永久已处理（L4 阻断项 2）──────────────────
//
// 真实场景 = R-21 实测过的「attach 晚 26 秒」：cutover 已开、attachment 还没到，
// 本会话此时不是 resolved owner ⇒ preInject 返回 suppressed-not-owner。
// 旧写法 markSeen 在 gate 之前 ⇒ 该回报被当成「永久已处理」，attach 到达后**永不复苏**。
// 这条用**同一个 id**：先抑制、后 attach，必须能送达。
{
	_resetReportListener();
	const { reportsDir, linksPath } = newCase();
	const SID = "01a1a56a-0000-4000-8000-00000000c006";
	const isoRuntime = mkdtempSync(join(tmpdir(), "report-bh-gate-"));
	const prevRuntime = process.env.PI_RUNTIME_DIR;
	process.env.PI_RUNTIME_DIR = isoRuntime;
	try {
		const { setCutover, attachMaster } = await import("./runtime/registry.ts");
		setCutover(true, "test");
		attachMaster({ sessionId: "sid-somebody-else" }); // 启动时 owner 是别人
		setCurrentSessionId(SID);

		addTabLink(linksPath, "tab_bh_gate", SID); // recipient 能解析到本会话
		const id = sendReportToMain({ from: "tab_bh_gate", message: "attach 前发的回报" }, reportsDir);

		const injected: string[] = [];
		const opts = { reportsDir, linksPath, toast: false, sendUserMessage: (c: string) => { injected.push(c); } };

		// ① attach 之前：非 owner ⇒ 被抑制（正确的行为）
		const f1 = pollNewReports(reportsDir, opts);
		assert.equal(f1.length, 0, "非 owner 不得注入");
		assert.equal(injected.length, 0);
		assert.equal(existsSync(join(reportsDir, `${id}.notified`)), false, "被抑制时不得 claim");

		// ② owner 切过来（模拟 attach 晚到）
		attachMaster({ sessionId: SID, forceStale: true, staleAfterMs: -1 });
		const att = (await import("./runtime/registry.ts")).readAttachment("agent://master_default" as never);
		assert.equal(att?.sessionId, SID, "夹具自检：owner 必须已切到本会话");

		// ③ 同一份回报、同一个 id，必须仍能送达。
		// 拆成两条断言（L4 S7）：或运算 `fired+injected>0` 无法排除「记了 fired 但没真注入」。
		const f2 = pollNewReports(reportsDir, opts);
		assert.equal(
			f2.includes(id), true,
			"【L4 阻断项 2】gate 的瞬时抑制不得 markSeen；attach 到达后同一份回报必须被处理（旧写法恒 0）",
		);
		assert.equal(injected.length, 1, "必须真的注入一条（不是只记 fired）");
		assert.equal(existsSync(join(reportsDir, `${id}.notified`)), true, "送达后必须有 .notified");
	} finally {
		if (prevRuntime === undefined) delete process.env.PI_RUNTIME_DIR;
		else process.env.PI_RUNTIME_DIR = prevRuntime;
		rmSync(isoRuntime, { recursive: true, force: true });
	}
	ok("C6 注入门的瞬时抑制不是永久已处理（attach 晚到后同一份仍能送达）");
}

// ── C7：送达后 `.unroutable` 必须收尾（L4 A3：矛盾证据）─────────────
//
// 场景：先解析不到（落 .unroutable）→ 链路补齐 → 送达（写 .notified）。
// 若不清 .unroutable，磁盘上会同时存在「未被任何会话消费」与「已消费」两份互相矛盾的证据。
{
	_resetReportListener();
	const { reportsDir, linksPath } = newCase();
	const SID = "01a1a56a-0000-4000-8000-00000000c007";
	setCurrentSessionId(SID);
	const injected: string[] = [];
	const opts = { reportsDir, linksPath, toast: false, sendUserMessage: (c: string) => { injected.push(c); } };

	const id = sendReportToMain({ from: "tab_bh_cleanup", message: "先解析不到后送达" }, reportsDir);
	const f1 = pollNewReports(reportsDir, opts);
	assert.equal(f1.length, 0);
	assert.equal(existsSync(join(reportsDir, `${id}.unroutable`)), true, "第一次失败应落标记");

	addTabLink(linksPath, "tab_bh_cleanup", SID);
	_forceUnroutableRetryDue(id);
	const f2 = pollNewReports(reportsDir, opts);
	assert.equal(f2.length, 1, "链路补齐后必须送达");
	assert.equal(existsSync(join(reportsDir, `${id}.notified`)), true);
	assert.equal(
		existsSync(join(reportsDir, `${id}.unroutable`)), false,
		"送达后必须清掉 .unroutable，否则与 .notified 构成矛盾证据",
	);
	ok("C7 送达后清理 .unroutable（不留下互相矛盾的证据）");
}

// ── C8：重试有指数退避 + 封顶，但**永不放弃**（L4 A2）──────────────
//
// 三条同时成立才算正解：① 退避确实生效 ② 指数增长且封顶 ③ 没有次数上限。
// 缺 ③ = 又造一个静默黑洞（该重试却放弃）；缺 ① = 「有界输入无界成本」
// （每份 tab_ 形态各付一次 listLinks，实测热 3.6ms / 冷 9.8ms，3740 行 934KB）。
{
	_resetReportListener();
	const { reportsDir, linksPath } = newCase();
	setCurrentSessionId("01a1a56a-0000-4000-8000-00000000c008");
	const id = sendReportToMain({ from: "agent://master_local_Throttle", message: "退避探针" }, reportsDir);
	const opts = { reportsDir, linksPath, toast: false, sendUserMessage: () => {} };

	// ① 首次失败 ⇒ 落标记 + 建退避状态（attempts=1, delay=5s）
	assert.equal(pollNewReports(reportsDir, opts).length, 0);
	assert.equal(existsSync(join(reportsDir, `${id}.unroutable`)), true);
	let st = _unroutableAttemptState(id);
	assert.equal(st?.attempts, 1, "首次失败应记 1 次");
	assert.equal(st?.delayMs, 5_000, "首档退避 = 5s（与 tick 周期同量级起步）");

	// ② 退避窗口内：不重复解析（attempts 不增，否则退避等于没生效）
	assert.equal(pollNewReports(reportsDir, opts).length, 0, "窗口内不重复处理");
	assert.equal(_unroutableAttemptState(id)?.attempts, 1, "窗口内不得递增");

	// ③ 窗口到期 ⇒ 必须再试，且延迟指数翻倍直到封顶
	for (let i = 0; i < 8; i++) {
		_forceUnroutableRetryDue(id);
		pollNewReports(reportsDir, opts);
	}
	st = _unroutableAttemptState(id);
	assert.equal(st?.attempts, 9, "退避到期后每次都要重试（9 = 1 + 8）");
	assert.equal(st?.delayMs, 5 * 60_000, `指数退避必须封顶 5min（实际 ${st?.delayMs}）`);

	// ④ **永不放弃**：第 10 次仍会重试（无次数上限）
	_forceUnroutableRetryDue(id);
	pollNewReports(reportsDir, opts);
	assert.equal(_unroutableAttemptState(id)?.attempts, 10, "无次数上限：第 10 次仍会重试");

	// ⑤ 链路可用时必须能送达（证明重试链未被退避或次数闸钉死）
	addTabLink(linksPath, "tab_bh_throttle", "01a1a56a-0000-4000-8000-00000000c008");
	const id2 = sendReportToMain({ from: "tab_bh_throttle", message: "退避后送达" }, reportsDir);
	assert.equal(pollNewReports(reportsDir, opts).length, 1, "链路可用时必须送达");
	assert.equal(existsSync(join(reportsDir, `${id2}.notified`)), true);
	ok("C8 退避指数增长并封顶，但无次数上限（不会永久放弃）");
}

// ── C9：agent shell 环境下必须仍是绿的（L4 阻断项 1）───────────────
//
// 本仓最常见的执行环境是 PI_SUBAGENT=1（agent 派生的 shell）。report.ts 的
// `if (isSubagent()) return;` 在那里恒真 ⇒ 若夹具不删该变量，C3（真实 session_start 链路）
// 必红。卡片顶部只删一次；这里再显式断言一次「环境确实是干净的」，防止将来有人提前恢复。
{
	assert.equal(process.env.PI_SUBAGENT, undefined, "夹具自检：PI_SUBAGENT 必须已删除（否则 session_start 门恒真）");
	assert.equal(process.env.PI_TAB_RUN_ID, undefined, "夹具自检：PI_TAB_RUN_ID 必须已删除");
	ok("C9 夹具清理 PI_SUBAGENT / PI_TAB_RUN_ID（agent shell 下也能绿）");
}


// ── C10：`injected-already` 不得每 tick 无限重扫（L4 R-2 硬问题 / S1）──────
//
// 形态：cutover 启用 + 别的实例已 confirmInjection（收据在盘），本进程 .notified 也在盘
// ⇒ preInject 恒返 `already-injected`。旧写法不 markSeen ⇒ 该 id 每 5s tick 再扫一遍，
// 无出口、零审计痕迹（L4 实测 C1/C4：5 次 poll 全 0，suppressions +0）。
// 判据：**第一次** poll 之后该 id 必须进 seenReports（可观测等价：后续 poll 不再产生任何
// gate 审计增量，也不再有输出；这里用「再 poll 3 次，fired 恒 0 且 .notified 恒在」+ 直接用
// onNewReport 复核「已被 seen 挡住」来判定收工）。
{
	_resetReportListener();
	const { reportsDir, linksPath } = newCase();
	const SID = "01a1a56a-0000-4000-8000-00000000c010";
	const isoRuntime = mkdtempSync(join(tmpdir(), "report-bh-already-"));
	const prevRuntime = process.env.PI_RUNTIME_DIR;
	process.env.PI_RUNTIME_DIR = isoRuntime;
	try {
		const registry = await import("./runtime/registry.ts");
		const receipts = await import("./runtime/receipts.ts");
		registry.setCutover(true, "test");
		registry.attachMaster({ sessionId: SID });
		setCurrentSessionId(SID);

		addTabLink(linksPath, "tab_bh_already", SID);
		const id = sendReportToMain({ from: "tab_bh_already", message: "别人已经注入过" }, reportsDir);
		// 造「另一实例已注入」的事实：**只写 delivered 收据，故意不写 .notified**
		// （L4 第三轮 B1：`.notified` 缺失时也必须收工，否则每 tick 无限重扫）。
		// 必须用 `recordNotificationReceipt`（直接写 delivered 收据）：`confirmInjection` 只允许
		// **claiming 持有者**确认（by 必须一致），拿它当夹具会静默返回 false ⇒ 收据根本没写
		// ⇒ preInject 走 claim 分支而不是 already-injected ⇒ 整条 C10 会「假绿」（实测踩过）。
		assert.equal(receipts.recordNotificationReceipt(`report-${id}`, "other-instance"), true, "夹具自检：delivered 收据必须写成功");
		assert.equal(receipts.hasNotificationReceipt(`report-${id}`), true, "夹具自检：收据必须可读（否则到不了 already-injected）");
		assert.equal(existsSync(join(reportsDir, `${id}.notified`)), false, "夹具：故意不写 .notified（覆盖 B1 的无限重扫形态）");

		const opts = { reportsDir, linksPath, toast: false, sendUserMessage: () => {} };
		assert.equal(pollNewReports(reportsDir, opts).length, 0, "已被消费 ⇒ 本进程不注入");

		// 夹具自检：确认本分支真的到了 `already-injected`（否则下半段断言没有判别力）。
		{
			const { preInject } = await import("./injection-gate.ts");
			const v = preInject({ key: `report-${id}`, sessionId: SID, path: "legacy-reports" });
			assert.equal(v.inject, false, "夹具自检：前置条件必须让 gate 拒绝注入");
			assert.equal(v.reason, "already-injected", `夹具自检：必须命中 already-injected（实际 ${v.reason}）`);
		}

		// 【核心】必须收工：否则下个 tick 又是一次 4.33ms 的 listLinks + 三次收据读，永不终止。
		// 判据用 `_isReportSeen`（**不能**用 `onNewReport(...)===false`：见 M5 — 那个断言
		// 对「有没有 markSeen」零判别力，删掉 markSeen 也仍返回 false ⇒ 假绿）。
		assert.equal(
			_isReportSeen(id), true,
			"【L4 S1/B1】already-injected ⇒ 必须进 seenReports 收工（旧写法每 tick 无限重扫且零痕迹）",
		);
		assert.equal(onNewReport(reportsDir, id, opts), false);

		// 再 poll 两次也必须是 0（且不再进入 gate）
		for (let i = 0; i < 2; i++) assert.equal(pollNewReports(reportsDir, opts).length, 0);
		ok("C10 already-injected ⇒ 收工（.notified 缺失时也不无限重扫）");
	} finally {
		if (prevRuntime === undefined) delete process.env.PI_RUNTIME_DIR;
		else process.env.PI_RUNTIME_DIR = prevRuntime;
		rmSync(isoRuntime, { recursive: true, force: true });
	}
}

// ── C11：send 失败时**不得**删除「未消费」反证据（L4 R-3a / S3）──────────
//
// 旧 v2 把 clearUnroutable 放在 sendUserMessage 之前 ⇒ send 抛时磁盘只剩 .notified
// （说「已送达」）而实际零注入 —— 反向矛盾证据。
// 判据：send 抛之后 `.unroutable` 必须**仍在**（它才是「没送达」的真话）。
{
	_resetReportListener();
	const { reportsDir, linksPath } = newCase();
	const SID = "01a1a56a-0000-4000-8000-00000000c011";
	setCurrentSessionId(SID);
	const id = sendReportToMain({ from: "tab_bh_sendfail", message: "先解析不到" }, reportsDir);

	// ① 先解析不到 ⇒ 落 .unroutable
	assert.equal(pollNewReports(reportsDir, { reportsDir, linksPath, toast: false, sendUserMessage: () => {} }).length, 0);
	assert.equal(existsSync(join(reportsDir, `${id}.unroutable`)), true);

	// ② 链路补齐 + 退避到期，但 send 抛
	addTabLink(linksPath, "tab_bh_sendfail", SID);
	_forceUnroutableRetryDue(id);
	const r = pollNewReports(reportsDir, {
		reportsDir, linksPath, toast: false,
		sendUserMessage: () => { throw new Error("busy: already processing"); },
	});
	// 如实登记：`onNewReport` 在 send 抛后仍然 `return true`（catch 里只置 selfDisabled），
	// 所以 `fired` 里会**有**这个 id —— fired 只表示「处理过」，不表示「送达了」（既存语义）。
	assert.equal(r.includes(id), true, "（既存语义）send 抛也计一次 fired —— 已登记，不在本项修");
	assert.equal(
		existsSync(join(reportsDir, `${id}.unroutable`)), true,
		"【L4 S3】send 失败时必须保留 .unroutable（删掉就等于只剩 .notified，说“已送达”而实际零注入）",
	);
	ok("C11 send 失败不删「未消费」反证据（不制造反向矛盾证据）");
}

setCurrentSessionId(undefined);
console.log(`\nreport-blackhole tests passed (${n} checks)`);
