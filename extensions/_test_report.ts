import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	onNewReport,
	listReportIds,
	pollNewReports,
	readReportFile,
	registerReportListener,
	sendReportToMain,
	_resetReportListener,
} from "./report.ts";
import { setCurrentSessionId } from "./identity.ts";

delete process.env.PI_SUBAGENT;
delete process.env.PI_TAB_RUN_ID;
// 隔离 shadow runtime：真实 ~/.pi/agent/runtime/registry 的 cutover 状态会让 preInject 判定 suppressed-not-owner（测试惯例同 _test_runtime_cutover）
process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "report-runtime-"));

const dir = mkdtempSync(join(tmpdir(), "report-test-"));
const reportsDir = join(dir, "reports");

/** 写一条 links 派发记录（tab → 派发会话），并返回 linksPath。 */
function makeLinks(...entries: Array<{ from: string; sessionId: string }>): string {
	const linksPath = join(dir, `links-${Math.random().toString(36).slice(2, 8)}.jsonl`);
	for (const e of entries) {
		appendFileSync(linksPath, JSON.stringify({ sessionId: e.sessionId, kind: "tab", targetId: e.from, detail: "", at: new Date().toISOString(), pid: 1 }) + "\n", "utf8");
	}
	return linksPath;
}

// ── 发送 + 读取 ───────────────────────────────────────────────────
{
	const id = sendReportToMain({ from: "tab_1", message: "批次完成，请回收", taskId: "1007", summary: "3 artifacts" }, reportsDir);
	assert.ok(id.startsWith("report_"), id);
	const rec = readReportFile(reportsDir, id);
	assert.equal(rec?.from, "tab_1");
	assert.equal(rec?.message, "批次完成，请回收");
	assert.equal(rec?.taskId, "1007");
	assert.equal(rec?.summary, "3 artifacts");
	assert.ok(rec?.at && rec.pid > 0);

	// 损坏文件 → null
	const { writeFileSync } = await import("node:fs");
	writeFileSync(join(reportsDir, "report_broken.json"), "{bad", "utf8");
	assert.equal(readReportFile(reportsDir, "report_broken"), null);
}

// ── 监听：会话定位 + 幂等注入 ─────────────────────────────────────
{
	_resetReportListener();
	setCurrentSessionId("session-main-1");
	const injected: string[] = [];
	const reportsDir2 = join(dir, "reports2");
	const linksPath = makeLinks({ from: "tab_2", sessionId: "session-main-1" });
	const opts = {
		reportsDir: reportsDir2,
		linksPath,
		toast: false,
		sendUserMessage: (content: string, _o?: unknown) => { injected.push(content); },
	};

	// 派发给本会话的回报 → 注入
	sendReportToMain({ from: "tab_2", message: "完成 X", taskId: "1008", summary: "done" }, reportsDir2);
	const fired = pollNewReports(reportsDir2, opts);
	assert.equal(fired.length, 1);
	assert.equal(injected.length, 1, "新回报应注入一条用户消息");
	assert.ok(injected[0].includes("tab_2"), injected[0]);
	assert.ok(injected[0].includes("完成 X"), "应含回报消息");
	assert.ok(injected[0].includes("1008"), "应含 taskId");
	assert.ok(injected[0].includes("busy-poll"), "回报注入应含禁轮询纪律");

	// 重复 poll → 幂等（已 seen 不再注入）
	const again = pollNewReports(reportsDir2, opts);
	assert.equal(again.length, 0);
	assert.equal(injected.length, 1);
}

// ── 会话定位：不是派发给本会话的回报 → 不注入（修复投错会话）─────
{
	_resetReportListener();
	setCurrentSessionId("session-main-1");
	const injected: string[] = [];
	const reportsDir4 = join(dir, "reports4");
	// 派发方是另一个会话（如 GreenCAD main），本会话（如 subagent-win）不得抢
	const linksPath = makeLinks({ from: "tab_238", sessionId: "session-green-cad-main" });
	const opts = {
		reportsDir: reportsDir4,
		linksPath,
		toast: false,
		sendUserMessage: (content: string, _o?: unknown) => { injected.push(content); },
	};

	sendReportToMain({ from: "tab_238", message: "进度核实完成", taskId: "238", summary: "done" }, reportsDir4);
	const fired = pollNewReports(reportsDir4, opts);
	assert.equal(fired.length, 0, "非本会话的回报不得消费");
	assert.equal(injected.length, 0, "不得注入无关回报");
	assert.equal(existsSync(join(reportsDir4, `${listReportIds(reportsDir4)[0]}.notified`)), false, "不得 claim 别人的回报");

	// 真正的编排会话（session-green-cad-main）应当能消费
	_resetReportListener();
	setCurrentSessionId("session-green-cad-main");
	const injected2: string[] = [];
	const opts2 = { ...opts, sendUserMessage: (c: string, _o?: unknown) => { injected2.push(c); } };
	const fired2 = pollNewReports(reportsDir4, opts2);
	assert.equal(fired2.length, 1, "派发会话应能消费自己的回报");
	assert.equal(injected2.length, 1);
	assert.ok(injected2[0].includes("tab_238"), injected2[0]);
}

// ── 会话定位：无派发记录（links 缺失）→ 不消费 ───────────────────
{
	_resetReportListener();
	setCurrentSessionId("session-main-1");
	const injected: string[] = [];
	const reportsDir5 = join(dir, "reports5");
	const opts = {
		reportsDir: reportsDir5,
		linksPath: join(dir, "links-empty.jsonl"),
		toast: false,
		sendUserMessage: (content: string, _o?: unknown) => { injected.push(content); },
	};
	sendReportToMain({ from: "tab_ghost", message: "幽灵回报", taskId: "999" }, reportsDir5);
	const fired = pollNewReports(reportsDir5, opts);
	assert.equal(fired.length, 0);
	assert.equal(injected.length, 0);
}

// ── registerReportListener：主会话才启动监听（惰性：session_start 时判定）──
{
	_resetReportListener();
	const makePi = () => ({
		on: (_evt: string, _h: unknown) => {},
		sendUserMessage: (_c: string, _o?: unknown) => {},
	});

	process.env.PI_SUBAGENT = "1";
	const cleanup1 = registerReportListener(makePi() as never, { reportsDir });
	assert.ok(typeof cleanup1 === "function");
	cleanup1();
	delete process.env.PI_SUBAGENT;

	const cleanup2 = registerReportListener(makePi() as never, { reportsDir });
	assert.ok(typeof cleanup2 === "function");
	cleanup2();
	_resetReportListener();
}

// ── 跨实例幂等：.notified 文件去重（根治双 watcher 双注入）───────
{
	_resetReportListener();
	setCurrentSessionId("session-main-2");
	const sent: string[] = [];
	const reportsDir3 = join(dir, "reports3");
	const linksPath = makeLinks({ from: "tab_9", sessionId: "session-main-2" });
	const opts = {
		reportsDir: reportsDir3,
		linksPath,
		toast: false,
		sendUserMessage: (content: string, _o?: unknown) => { sent.push(content); },
	};

	sendReportToMain({ from: "tab_9", message: "完成 X", taskId: "9", summary: "s" }, reportsDir3);
	const ids = listReportIds(reportsDir3);
	assert.equal(ids.length, 1);
	const id = ids[0];

	const first = onNewReport(reportsDir3, id, opts);
	assert.equal(first, true, "首实例应 claim 并注入");
	assert.equal(sent.length, 1);
	assert.equal(existsSync(join(reportsDir3, `${id}.notified`)), true, "应创建 .notified 标记");

	// 第二实例（seenReports 已重置）：.notified 存在 → 跳过
	_resetReportListener();
	setCurrentSessionId("session-main-2");
	const second = onNewReport(reportsDir3, id, opts);
	assert.equal(second, false, "第二实例看到 .notified 应跳过");
	assert.equal(sent.length, 1, "不得重复注入");
}

setCurrentSessionId(undefined);

// ── Phase 4d：cutover 启用 + 非 owner → 抑制（A5 F2）──────────────
{
	const isoDir = mkdtempSync(join(tmpdir(), "report-cutover-"));
	const prev = process.env.PI_RUNTIME_DIR;
	process.env.PI_RUNTIME_DIR = isoDir;
	try {
		const { setCutover, attachMaster } = await import("./runtime/registry.ts");
		setCutover(true, "test");
		attachMaster({ sessionId: "session-owner" });
		_resetReportListener();
		setCurrentSessionId("session-other"); // 非 owner，但 links 溯源通过
		const injected3: string[] = [];
		const reportsDir3 = join(dir, "reports3");
		const linksPath3 = makeLinks({ from: "tab_9", sessionId: "session-other" });
		sendReportToMain({ from: "tab_9", message: "求抑制", taskId: "1009" }, reportsDir3);
		const fired3 = pollNewReports(reportsDir3, {
			reportsDir: reportsDir3, linksPath: linksPath3, toast: false,
			sendUserMessage: (content: string) => { injected3.push(content); },
		});
		assert.equal(fired3.length, 0, "非 owner 不消费");
		assert.equal(injected3.length, 0, "非 owner 不注入");
		const { existsSync: ex } = await import("node:fs");
		assert.equal(ex(join(isoDir, "suppressions.jsonl")), true, "抑制记审计");
		setCurrentSessionId(undefined);
	} finally {
		if (prev === undefined) delete process.env.PI_RUNTIME_DIR;
		else process.env.PI_RUNTIME_DIR = prev;
		rmSync(isoDir, { recursive: true, force: true });
	}
}

// ── R-21 / L4 F5（2026-11-05）：`registerReportListener` 的 owner 门**不得阻塞注册** ──
//
// 事故同 mailbox：session_start 与 attach 是时序竞争（实测 gen14 晚 26s）⇒ 旧写法
// `if (!eligible) return` 让 watcher/interval 永不启动 ⇒ 晚到的 attach 永远没机会。
// 本条必须经过**真实注册入口**（pi.on 回调 → interval → poll），不能只调 pollNewReports。
{
	const isoDir = mkdtempSync(join(tmpdir(), "report-late-attach-"));
	const prev = process.env.PI_RUNTIME_DIR;
	process.env.PI_RUNTIME_DIR = isoDir;
	try {
		const { setCutover, attachMaster } = await import("./runtime/registry.ts");
		setCutover(true, "test");
		attachMaster({ sessionId: "sid-someone-else" }); // 启动时 owner 是别人

		_resetReportListener();
		const injected: string[] = [];
		const reportsDirX = join(dir, "reports-late");
		const linksX = makeLinks({ from: "tab_late", sessionId: "sid-late" });
		const handlers: Array<(e: unknown, ctx?: unknown) => void> = [];
		const fakePi = {
			on(ev: string, cb: (e: unknown, ctx?: unknown) => void) {
				if (ev === "session_start") handlers.push(cb);
			},
			sendUserMessage: (content: string) => { injected.push(content); return true; },
		};
		const stop = registerReportListener(fakePi as never, {
			reportsDir: reportsDirX, linksPath: linksX, toast: false,
			pollIntervalMs: 50, // 生产 5000；测试调到 50ms 才能验证「注册→tick→poll」真实接线
		});
		for (const h of handlers) h({}, { sessionManager: { sessionId: "sid-late" } });
		// ⚠ 夹具要点：`registerReportListener` 在 session_start 时调 `snapshotExisting()`，
		// 把目录里**已有**的报告全部标记为已见。所以所有发送必须在 session_start 之后。
		// 夹具自检：session_start 必须真的把 currentSessionId 设成 sid-late
		//（前一个用例末尾 setCurrentSessionId(undefined)，不显式断言就会在 preInject 那道
		//  独立 owner 门被 suppressed-not-owner 静默抑掉，表现为「注入 0」而非报错）
		assert.equal(
			(await import("./identity.ts")).getCurrentSessionId(),
			"sid-late",
			"夹具自检：currentSessionId 必须已设为 sid-late",
		);

		// attach 之前：非 owner，不应注入
		sendReportToMain({ from: "tab_late", message: "attach 前的回报", taskId: "1010" }, reportsDirX);
		await new Promise((r) => setTimeout(r, 120));
		assert.equal(injected.length, 0, "attach 之前不得注入（此时还归别人）");

		// ← 模拟」attach 在 session_start 之后才完成」（用 forceStale 真走交接路径：
		// attachMaster 不会无条件抢占已有 owner，这是它的不变量）
		attachMaster({ sessionId: "sid-late", forceStale: true, staleAfterMs: -1 });
		assert.equal(
			(await import("./runtime/registry.ts")).readAttachment("agent://master_default" as never)?.sessionId,
			"sid-late",
			"夹具自检：owner 必须已切到 sid-late",
		);
		sendReportToMain({ from: "tab_late", message: "attach 后的回报", taskId: "1011" }, reportsDirX);
		await new Promise((r) => setTimeout(r, 300));
		assert.ok(
			injected.length > 0,
			`【L4 F5】attach 晚到后 tick 必须开始消费；旧实现 interval 根本没起 ⇒ 恒 0（实际 ${injected.length}）`,
		);
		stop();
	} finally {
		if (prev === undefined) delete process.env.PI_RUNTIME_DIR;
		else process.env.PI_RUNTIME_DIR = prev;
		rmSync(isoDir, { recursive: true, force: true });
	}
}

rmSync(dir, { recursive: true, force: true });

console.log("report tests passed");
