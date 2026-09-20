import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTabResultFile, pollNewResults, _resetEventBus, registerEventBus } from "./event-bus.ts";
import { readTabResultFile } from "./tab-runs.ts";

delete process.env.PI_SUBAGENT;
delete process.env.PI_TAB_RUN_ID;

// 隔离 shadow journal：emit 路径不得写真实 ~/.pi/agent/runtime/（Phase 1H 修复）
process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "event-bus-journal-"));

const dir = mkdtempSync(join(tmpdir(), "event-bus-test-"));

function writeResult(runId: string, status = "completed") {
	writeFileSync(join(dir, `${runId}.result.json`), JSON.stringify({
		id: runId, taskId: "1007", status, finishedAt: new Date().toISOString(), summary: "批次完成",
	}), "utf8");
}

// ── 幂等：同一 result 只触发一次 ─────────────────────────────────
{
	const fired: string[] = [];
	writeResult("tab_a");
	const opts = { runsDir: dir, toast: false, autoReclaim: false, onTabFinished: (r: string) => fired.push(r) };

	const first = onTabResultFile(dir, "tab_a.result.json", opts);
	assert.equal(first, true, "首次应触发");
	assert.deepEqual(fired, ["tab_a"]);

	const second = onTabResultFile(dir, "tab_a.result.json", opts);
	assert.equal(second, false, "重复文件不应再触发");
	assert.deepEqual(fired, ["tab_a"], "幂等");
}

// ── pollNewResults：处理所有未见过的文件（snapshot 语义属于 registerEventBus）──
{
	_resetEventBus();
	const fired: string[] = [];
	const opts = { runsDir: dir, toast: false, autoReclaim: false, onTabFinished: (r: string) => fired.push(r) };

	// 用独立子目录隔离本块
	const dirPoll = join(dir, "poll");
	const mkdirSync = (await import("node:fs")).mkdirSync;
	mkdirSync(dirPoll, { recursive: true });
	const writePoll = (rid: string) => writeFileSync(join(dirPoll, `${rid}.result.json`), JSON.stringify({ id: rid, taskId: "1", status: "completed", finishedAt: new Date().toISOString(), summary: "s" }), "utf8");
	writePoll("tab_old");
	writePoll("tab_new");

	const firedFirst = pollNewResults(dirPoll, opts);
	assert.deepEqual(firedFirst.sort(), ["tab_new.result.json", "tab_old.result.json"].sort(), "poll 处理全部未见文件");

	// 再 poll → 已 seen，不再触发（幂等）
	const firedSecond = pollNewResults(dirPoll, opts);
	assert.deepEqual(firedSecond, [], "重复 poll 幂等");
}

// ── autoReclaim：注入用户消息（带完整结果回报）────────────────────
{
	_resetEventBus();
	const sent: string[] = [];
	// 带 artifacts/reportPath 的结果
	writeFileSync(join(dir, "tab_reclaim.result.json"), JSON.stringify({
		id: "tab_reclaim", taskId: "1007", status: "completed", finishedAt: new Date().toISOString(),
		summary: "批次完成",
		artifacts: ["plans/20260806.md", "Wiki/Modules/xxx.md"],
		reportPath: "plans/20260806_research.md",
		usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.0123, turns: 1 },
	}), "utf8");
	const opts = {
		runsDir: dir,
		toast: false,
		autoReclaim: true,
		sendUserMessage: (content: string, _o?: unknown) => { sent.push(content); },
	};
	onTabResultFile(dir, "tab_reclaim.result.json", opts);
	assert.equal(sent.length, 1, "autoReclaim 应注入消息");
	assert.ok(sent[0].includes("tab_reclaim"), sent[0]);
	assert.ok(sent[0].includes("reclaim-tabs"), "应指引模型去回收");
	assert.ok(sent[0].includes("批次完成"), "回报应带 summary");
	assert.ok(sent[0].includes("plans/20260806.md"), "回报应带 artifacts");
	assert.ok(sent[0].includes("plans/20260806_research.md"), "回报应带 reportPath");
	assert.ok(sent[0].includes("$0.0123"), "回报应带 cost");
	assert.ok(sent[0].includes("busy-poll"), "完成通知应含禁轮询纪律");

	const result = readTabResultFile(dir, "tab_reclaim");
	assert.equal(result?.status, "completed");
}

// ── registerEventBus：主会话才启动监听（惰性：session_start 时判定）──
{
	_resetEventBus();
	const makePi = () => ({
		on: (_evt: string, _h: unknown) => {},
		sendUserMessage: (_c: string, _o?: unknown) => {},
	});

	// 子 agent → cleanup 存在，session_start 处理器不启动 watcher（不报错即可）
	process.env.PI_SUBAGENT = "1";
	const cleanup1 = registerEventBus(makePi() as never, { runsDir: dir });
	assert.ok(typeof cleanup1 === "function");
	cleanup1();
	delete process.env.PI_SUBAGENT;

	// 主会话 → 注册成功且返回 cleanup
	const cleanup2 = registerEventBus(makePi() as never, { runsDir: dir });
	assert.ok(typeof cleanup2 === "function");
	cleanup2();
	_resetEventBus();
}

// ── 跨实例幂等：.notified 文件去重（根治双 watcher 双注入）───────
{
	_resetEventBus();
	const sent: string[] = [];
	const opts = {
		runsDir: dir,
		toast: false,
		sendUserMessage: (content: string, _o?: unknown) => { sent.push(content); },
	};

	// 第一个实例：claim 成功 → 注入
	writeFileSync(join(dir, "tab_dedup.result.json"), JSON.stringify({ id: "tab_dedup", taskId: "1", status: "completed", finishedAt: new Date().toISOString(), summary: "s" }), "utf8");
	const first = onTabResultFile(dir, "tab_dedup.result.json", opts);
	assert.equal(first, true, "首实例应 claim 并注入");
	assert.equal(sent.length, 1);
	assert.equal(existsSync(join(dir, "tab_dedup.notified")), true, "应创建 .notified 标记");

	// 第二个实例（模拟 reload 后新 watcher，seenResults 已重置）：.notified 存在 → 跳过不注入
	_resetEventBus();
	const second = onTabResultFile(dir, "tab_dedup.result.json", opts);
	assert.equal(second, false, "第二实例看到 .notified 应跳过");
	assert.equal(sent.length, 1, "不得重复注入");
}

// ── 会话定位：只注入给「派发该 tab 的会话」（2026-08-13，防 identityless 会话抢注入权）──
{
	_resetEventBus();
	const sent: string[] = [];
	const linksPath = join(dir, "links.jsonl");
	const opts = {
		runsDir: dir,
		linksPath,
		toast: false,
		sendUserMessage: (content: string, _o?: unknown) => { sent.push(content); },
	};

	// links 溯源：tab_route1 由 session-B 派发
	writeFileSync(linksPath, JSON.stringify({
		sessionId: "session-B", kind: "tab", targetId: "tab_route1",
		detail: "task=1", at: new Date().toISOString(), pid: 1,
	}) + "\n", "utf8");
	writeFileSync(join(dir, "tab_route1.result.json"), JSON.stringify({
		id: "tab_route1", taskId: "1", status: "completed", finishedAt: new Date().toISOString(), summary: "s",
	}), "utf8");

	// 我是 session-A：不是派发方 → 在任何副作用前跳过（不 journal/mailbox/claim/注入/toast）。
	// run 完成属于 links recipient；其他会话不能以 journal 完备性之名抢占其归属。
	const { setCurrentSessionId } = await import("./identity.ts");
	setCurrentSessionId("session-A");
	const skipped = onTabResultFile(dir, "tab_route1.result.json", opts);
	assert.equal(skipped, false, "非派发会话必须跳过");
	assert.equal(sent.length, 0, "不得注入");
	assert.equal(existsSync(join(dir, "tab_route1.notified")), false, "不得 claim（唤醒权留给真正派发会话）");
	{
		const { listRuntimeEnvelopes } = await import("./runtime/journal.ts");
		const mine = () => listRuntimeEnvelopes({}).envelopes.filter((e) => e.subject === "run://tab/tab_route1");
		assert.equal(mine().length, 0, "非派发会话不得写 journal");
		// 幂等：另一个实例（同样非派发方）重放同一文件仍无副作用。
		_resetEventBus();
		setCurrentSessionId("session-C");
		onTabResultFile(dir, "tab_route1.result.json", opts);
		assert.equal(mine().length, 0, "重放仍不 journal");
	}

	// 我是 session-B（派发方）：journal + 注入
	_resetEventBus();
	setCurrentSessionId("session-B");
	const injected = onTabResultFile(dir, "tab_route1.result.json", opts);
	assert.equal(injected, true, "派发会话应注入");
	assert.equal(sent.length, 1, "应注入完成消息");
	assert.ok(sent[0].includes("tab_route1"), sent[0]);

	// 无溯源（旧账本无 sessionId）→ 回退 claim 先到先得（不阻断既有行为）
	_resetEventBus();
	setCurrentSessionId("session-A");
	writeFileSync(join(dir, "tab_legacy.result.json"), JSON.stringify({
		id: "tab_legacy", taskId: "2", status: "completed", finishedAt: new Date().toISOString(), summary: "legacy",
	}), "utf8");
	const legacy = onTabResultFile(dir, "tab_legacy.result.json", { ...opts });
	assert.equal(legacy, true, "无溯源时回退注入");

	setCurrentSessionId(undefined); // 清理，不污染后续
}

// ── Phase 3c：mailbox 影子投递（§27-28）─────────────────────
{
	_resetEventBus();
	const { setCurrentSessionId } = await import("./identity.ts");
	const opts = { runsDir: dir, toast: false, autoReclaim: false, onTabFinished: () => {} };
	writeFileSync(join(dir, "tab_mbx.result.json"), JSON.stringify({
		id: "tab_mbx", taskId: "3", status: "completed", finishedAt: new Date().toISOString(), summary: "mailbox smoke",
	}), "utf8");
	setCurrentSessionId("session-B");
	onTabResultFile(dir, "tab_mbx.result.json", opts);

	// 信落入 logical recipient（agent://master_default）的 spool，不依赖 links.jsonl sessionId
	const { listLetters, defaultMailboxDir } = await import("./runtime/mailbox.ts");
	const { masterAddress } = await import("./runtime/address.ts");
	const mine = () => listLetters(masterAddress(), undefined, defaultMailboxDir())
		.filter((l) => l.frame.subject === "run://tab/tab_mbx");
	assert.equal(mine().length, 1, "tab 终态 → mailbox 恰好一封信");
	const letter = mine()[0]!;
	assert.equal(letter.status, "pending");
	assert.equal(letter.frame.frame === "message" ? letter.frame.kind : "", "REPORT");
	assert.equal(letter.frame.subject, "run://tab/tab_mbx");
	assert.equal(letter.frame.to, "agent://master_default");
	assert.equal(String((letter.frame.body.details as Record<string, unknown> | undefined)?.tabRunId), "tab_mbx");

	// 重复触发同一 result（模拟第二个 watcher 进程）：_resetEventBus 清 seenResults，
	// dedupeId 文件名屏障防重投（跨进程幂等）
	_resetEventBus();
	onTabResultFile(dir, "tab_mbx.result.json", opts);
	assert.equal(mine().length, 1, "双 watcher 不重投");
	setCurrentSessionId(undefined);
}

// ── Phase 5.6：ownership-gated 注册 + 注入前 fencing + journal 跟随 owner ──────────
// 修「tab 承载 logical master 时 result watcher 无人注册 → 完成唤醒链断裂」。
// 新导出（shouldRegisterWatcher / triggerOwnershipRecheck / isEventBusWatching）经动态 import 引入，
// 旧代码缺这些导出 → 本文件对旧代码红；④ 为纯行为断言（非 owner 不 journal），对旧代码也是干净的断言红。
{
	const { setCurrentSessionId } = await import("./identity.ts");
	const { attachMaster, detachMaster, readAttachment, attachmentPathFor, setCutover } = await import("./runtime/registry.ts");
	const { masterAddress } = await import("./runtime/address.ts");
	const { listRuntimeEnvelopes } = await import("./runtime/journal.ts");
	const { unlinkSync, mkdirSync } = await import("node:fs");
	const { shouldRegisterWatcher, triggerOwnershipRecheck, isEventBusWatching } = await import("./event-bus.ts");

	const ownerDir = join(dir, "owner-tests");
	mkdirSync(ownerDir, { recursive: true });
	// 重置 ownership 状态（cutover + attachment）到指定 cutover 开关；attachment 一律清空
	const resetOwnership = (cutover: boolean): void => {
		try { unlinkSync(attachmentPathFor(masterAddress())); } catch { /* ignore */ }
		setCutover(cutover, "test");
	};
	const writeOwnerResult = (runId: string, status = "completed"): void => {
		writeFileSync(join(ownerDir, `${runId}.result.json`), JSON.stringify({
			id: runId, taskId: "2001", status, finishedAt: new Date().toISOString(), summary: "owner 批次",
		}), "utf8");
	};
	// 捕获 session_start 处理器 + 注入 fake sendUserMessage（不依赖真实 pi / 全局状态）
	const capturePi = (sent: string[]) => {
		let start: ((e: unknown, ctx: unknown) => void) | null = null;
		const pi = {
			on: (evt: string, h: unknown) => { if (evt === "session_start") start = h as never; },
			sendUserMessage: (c: string) => { sent.push(c); },
		};
		return { pi, fire: (sid: string) => start!("evt", { sessionManager: { sessionId: sid } }) };
	};

	// ④ watch 期间易主（本会话不再是 owner）→ 不注入、不 journal（留给新 owner）
	{
		_resetEventBus();
		resetOwnership(true); // cutover ON
		attachMaster({ sessionId: "new-owner" }); // 当前 owner 是 new-owner
		setCurrentSessionId("old-owner"); // 我已非 owner（被 bump 掉）
		writeOwnerResult("tab_own4");
		const sent: string[] = [];
		const ok = onTabResultFile(ownerDir, "tab_own4.result.json", {
			runsDir: ownerDir, toast: false, autoReclaim: true, sendUserMessage: (c: string) => { sent.push(c); },
		});
		assert.equal(ok, false, "④ 易主后不注入");
		assert.equal(sent.length, 0, "④ 不注入任何消息");
		const mine = listRuntimeEnvelopes({}).envelopes.filter((e) => e.subject === "run://tab/tab_own4");
		assert.equal(mine.length, 0, "④ 不 journal（终态留给新 owner 的 watcher）");
		setCurrentSessionId(undefined);
	}

	// ③ cutover OFF + 无 attachment → isMainSession 回退（零行为变化）
	{
		_resetEventBus();
		resetOwnership(false); // cutover OFF，无 attachment
		delete process.env.PI_TAB_RUN_ID;
		assert.equal(shouldRegisterWatcher(), true, "③ cutover OFF + 主会话 → watch（legacy 回退）");
		process.env.PI_TAB_RUN_ID = "tab_leg3";
		assert.equal(shouldRegisterWatcher(), false, "③ cutover OFF + 标签页 → 不 watch（legacy 回退）");
		delete process.env.PI_TAB_RUN_ID;
	}

	// ⑤ 主会话恰为 owner（cutover ON）→ watch + 注入 + journal（现状兼容）
	{
		_resetEventBus();
		resetOwnership(true); // cutover ON
		attachMaster({ sessionId: "main-own" });
		delete process.env.PI_TAB_RUN_ID; // 主会话
		setCurrentSessionId("main-own");
		assert.equal(shouldRegisterWatcher(), true, "⑤ 主会话为 owner → watch（走 ownership 路，非 isMainSession 特判）");
		writeOwnerResult("tab_own5");
		const sent: string[] = [];
		const ok = onTabResultFile(ownerDir, "tab_own5.result.json", {
			runsDir: ownerDir, toast: false, autoReclaim: true, sendUserMessage: (c: string) => { sent.push(c); },
		});
		assert.equal(ok, true, "⑤ owner 主会话应注入");
		assert.equal(sent.length, 1, "⑤ 注入一次");
		const mine = listRuntimeEnvelopes({}).envelopes.filter((e) => e.subject === "run://tab/tab_own5");
		assert.equal(mine.length, 1, "⑤ journal 由 owner 记录");
		setCurrentSessionId(undefined);
	}

	// ① owner=tab（cutover ON，succession 产物）→ 注册 watcher + 发现 result → 注入 + journal
	{
		_resetEventBus();
		resetOwnership(true); // cutover ON
		// 持久侧不变量（DOG2 终修）：attach 写会话 UUID（durableSessionIdentity），即便本进程是标签页
		attachMaster({ sessionId: "uuid-mu6k-owner" }); // owner 身份 = 会话 UUID
		process.env.PI_TAB_RUN_ID = "tab_mu6k"; // 是标签页（isMainSession false，易失启动身份）
		setCurrentSessionId("uuid-mu6k-owner"); // 会话 UUID（持久身份，与 attachment 同域）
		assert.equal(shouldRegisterWatcher(), true, "① owner=tab → watch（ownership-gated，靠 owner 判定而非 isMainSession）");
		const sent: string[] = [];
		const { pi, fire } = capturePi(sent);
		registerEventBus(pi as never, { runsDir: ownerDir });
		fire("uuid-mu6k-owner"); // session_start 的 sessionManager.sessionId 即 attach 所用 UUID（生产同源）
		assert.equal(isEventBusWatching(), true, "① session_start 后 owner=tab 已注册 watcher");
		writeOwnerResult("tab_own1");
		const ok = onTabResultFile(ownerDir, "tab_own1.result.json", {
			runsDir: ownerDir, toast: false, autoReclaim: true, sendUserMessage: (c: string) => { sent.push(c); },
		});
		assert.equal(ok, true, "① owner=tab 应注入");
		assert.equal(sent.length, 1, "① 注入一次");
		const mine = listRuntimeEnvelopes({}).envelopes.filter((e) => e.subject === "run://tab/tab_own1");
		assert.equal(mine.length, 1, "① journal 由 owner（tab）记录");
		setCurrentSessionId(undefined);
	}

	// ①b attach 补注册：succession 后继 tab 在 session_start 之后才 attach 成 owner 的真实路径
	{
		_resetEventBus();
		resetOwnership(true); // cutover ON
		attachMaster({ sessionId: "pre-own" }); // 现 owner（旧主会话）
		process.env.PI_TAB_RUN_ID = "tab_succ"; // 后继 tab（此刻还不是 owner）
		setCurrentSessionId("succ-sess");
		assert.equal(shouldRegisterWatcher(), false, "①b 接班前（非 owner）不 watch");
		const sent: string[] = [];
		const { pi, fire } = capturePi(sent);
		registerEventBus(pi as never, { runsDir: ownerDir });
		fire("succ-sess");
		assert.equal(isEventBusWatching(), false, "①b session_start（非 owner）未注册 watcher（一次性判定）");
		// 后继凭 handoff token 接班成 owner → triggerOwnershipRecheck 补注册
		const d = detachMaster({ sessionId: "pre-own", generation: readAttachment(masterAddress())!.generation });
		assert.equal(d.ok, true, "①b 旧主 detach 发 token");
		attachMaster({ sessionId: "succ-sess", token: d.token }); // 后继 attach 写入其会话 UUID（"succ-sess" 即该测试宇宙中的 UUID）
		assert.equal(readAttachment(masterAddress())!.sessionId, "succ-sess", "①b 后继已接班（gen+1）");
		triggerOwnershipRecheck();
		assert.equal(isEventBusWatching(), true, "①b 接班后 triggerOwnershipRecheck 补注册 watcher");
		delete process.env.PI_TAB_RUN_ID;
		setCurrentSessionId(undefined);
	}

	// ② 非 owner（cutover ON）：标签页不 watch；主会话恒 watch（2026-09-20 修正：run 完成属于
	// 派发者——普通主会话必须 watch 自己的 tab，exactly-once 由三重屏障保证；外人 run 靠 fencing/路由挡）
	{
		_resetEventBus();
		resetOwnership(true); // cutover ON
		attachMaster({ sessionId: "owner-x" });
		process.env.PI_TAB_RUN_ID = "tab_nonowner"; // 标签页
		setCurrentSessionId("other-sess");
		assert.equal(shouldRegisterWatcher(), false, "② 标签页 + 非 owner → 不 watch");
		const sent: string[] = [];
		const { pi, fire } = capturePi(sent);
		registerEventBus(pi as never, { runsDir: ownerDir });
		fire("other-sess");
		assert.equal(isEventBusWatching(), false, "② session_start（标签页非 owner）未注册 watcher");
		delete process.env.PI_TAB_RUN_ID;
		setCurrentSessionId("other-main"); // 主会话但非 owner
		assert.equal(shouldRegisterWatcher(), true, "② 主会话 + 非 owner → 仍 watch（派发者唤醒不归 owner 管）");
		setCurrentSessionId(undefined);
	}

	// ⑥ 子 agent 硬门（review §1 Must fix）：PI_SUBAGENT=1 → 恒不 watch，docstring 承诺显式落地。
	// 覆盖两种 ownership 状态：cutover ON（owner 路）+ legacy（isMainSession 回退路）。
	{
		_resetEventBus();
		process.env.PI_SUBAGENT = "1";
		// (a) cutover ON + 有 attachment，且本 sessionId == 当前 owner——若无 isSubagent 硬门会被 owner 路放行
		resetOwnership(true);
		attachMaster({ sessionId: "subg-owner" });
		delete process.env.PI_TAB_RUN_ID;
		setCurrentSessionId("subg-owner"); // 捕获到等于 attachment 的 sessionId
		assert.equal(shouldRegisterWatcher(), false, "⑥ 子 agent + cutover ON + sessionId==owner → 硬门挡（不 watch）");
		// (b) legacy 回退（cutover OFF + 无 attachment）：子 agent 恒不 watch
		resetOwnership(false);
		setCurrentSessionId("subg-legacy");
		assert.equal(shouldRegisterWatcher(), false, "⑥ 子 agent + legacy → 不 watch（isMainSession 内部亦非子 agent，硬门已前置）");
		delete process.env.PI_SUBAGENT;
		setCurrentSessionId(undefined);
	}

	// ⑦ 两条 legacy 回退分支各测一次（review §1：此前只测了 cutover OFF + 无 attachment 的合取）
	{
		_resetEventBus();
		delete process.env.PI_TAB_RUN_ID; // 主会话
		setCurrentSessionId("x");
		// 分支 A：cutover ON + 无 attachment（registry 未激活）→ 回退 isMainSession（主会话 watch）
		resetOwnership(true); // cutover ON，attachment 已清空
		assert.equal(shouldRegisterWatcher(), true, "⑦ cutover ON + 无 attachment + 主会话 → legacy 回退 watch（不看 attachment）");
		// 分支 B：cutover OFF + 有 attachment（关开关后 attachment 仍在，正常场景）→ 回退 isMainSession
		resetOwnership(false);
		attachMaster({ sessionId: "retained-att" }); // cutover OFF 但保留 attachment
		assert.equal(shouldRegisterWatcher(), true, "⑦ cutover OFF + 有 attachment + 主会话 → legacy 回退 watch（不看 attachment）");
		process.env.PI_TAB_RUN_ID = "tab_77"; // 标签页 → legacy 不 watch
		assert.equal(shouldRegisterWatcher(), false, "⑦ cutover OFF + 有 attachment + 标签页 → legacy 不 watch");
		delete process.env.PI_TAB_RUN_ID;
		setCurrentSessionId(undefined);
	}

	// ⑧ transfer 窗口端到端（review §3 必修）：旧 owner watcher 观察到 result 并 fencing 放弃
	// （不 journal、不 mailbox、无 .notified）→ 易主 → 新 owner 补注册（triggerOwnershipRecheck）时
	// 由 recoverUnnotifiedResults 补投且**恰好一次**；已投递（.notified）后重放不再投递。
	{
		_resetEventBus();
		const tDir = join(dir, "transfer");
		mkdirSync(tDir, { recursive: true });
		const writeTrResult = (runId: string): void => {
			writeFileSync(join(tDir, `${runId}.result.json`), JSON.stringify({
				id: runId, taskId: "9001", status: "completed", finishedAt: new Date().toISOString(), summary: "tr 批次",
			}), "utf8");
		};
		resetOwnership(true);
		attachMaster({ sessionId: "uuid-old-888" }); // 旧 owner（tab 进程，attach 写会话 UUID——持久域）
		process.env.PI_TAB_RUN_ID = "tab_tr"; // 旧 owner 进程是标签页（易失启动身份）
		setCurrentSessionId("uuid-old-888");
		// 旧 owner 注册 watcher（session_start 首次 begin，非 recovery 路径）
		const sentOld: string[] = [];
		const { pi: piOld, fire: fireOld } = capturePi(sentOld);
		registerEventBus(piOld as never, { runsDir: tDir });
		fireOld("uuid-old-888"); // session_start id 即 attach 所用 UUID（生产同源）
		assert.equal(isEventBusWatching(), true, "⑧ 旧 owner 已注册 watcher（tDir 此刻空，snapshot 无历史）");
		writeTrResult("tab_tr"); // 易主窗口内 result 落盘（新出现，不在 seen）
		// 易主：旧主 detach 发 token → 新主凭 token 接手（gen+1）
		const d = detachMaster({ sessionId: "uuid-old-888", generation: readAttachment(masterAddress())!.generation });
		assert.equal(d.ok, true, "⑧ 旧主 detach 发 token");
		attachMaster({ sessionId: "new-own", token: d.token }); // 新 owner：主会话（换进程，无 tab 身份）
		assert.equal(readAttachment(masterAddress())!.sessionId, "new-own", "⑧ 新主已接手");
		delete process.env.PI_TAB_RUN_ID; // 新 owner 是另一进程（主会话，无标签页身份）
		// 旧 owner 的 watcher 此时观察到 tab_tr → fencing 发现已非 owner → 静默放弃（无 .notified、无 journal）
		const fenced = onTabResultFile(tDir, "tab_tr.result.json", {
			runsDir: tDir, toast: false, autoReclaim: true, sendUserMessage: (c: string) => { sentOld.push(c); },
		});
		assert.equal(fenced, false, "⑧ 旧 owner 易主后 fencing 放弃");
		assert.equal(sentOld.length, 0, "⑧ 旧 owner 不注入");
		assert.equal(existsSync(join(tDir, "tab_tr.notified")), false, "⑧ 旧 owner 未 claim（无 .notified）");
		assert.equal(listRuntimeEnvelopes({}).envelopes.filter((e) => e.subject === "run://tab/tab_tr").length, 0, "⑧ 旧 owner 未 journal");

		// 新 owner 进程独立启动：先 session_start（此刻已 owner）→ 首次 begin 只做 legacy snapshot（无 recovery）
		setCurrentSessionId("new-own");
		const newSent: string[] = [];
		const { pi: piNew, fire: fireNew } = capturePi(newSent);
		registerEventBus(piNew as never, { runsDir: tDir }); // _resetEventBus 清 seen，旧 watcher stale
		fireNew("new-own"); // 首次 begin：snapshot 把 tab_tr 标 seen（§3 陷阱：被当启动历史）
		assert.equal(isEventBusWatching(), true, "⑧ 新 owner 已注册 watcher");
		assert.equal(newSent.length, 0, "⑧ 首次 begin 不投递（无 recovery）");
		// 新 owner 经 master-attach 路径补注册（triggerOwnershipRecheck）→ begin(true) 触发 transfer 窗口补偿
		triggerOwnershipRecheck();
		assert.equal(newSent.length, 1, "⑧ 新 owner 补注册时补投 tab_tr（恰好一次）");
		assert.ok(newSent[0].includes("tab_tr"), "⑧ 补投带 runId");
		assert.equal(existsSync(join(tDir, "tab_tr.notified")), true, "⑧ 补投后已 claim（.notified 持久屏障）");
		assert.equal(listRuntimeEnvelopes({}).envelopes.filter((e) => e.subject === "run://tab/tab_tr").length, 1, "⑧ journal 由新 owner 恰好写一次");
		// 幂等：再次 triggerOwnershipRecheck / 直接重放同一文件 → .notified 屏障 → 不再投递（不双写不双注入）
		triggerOwnershipRecheck();
		assert.equal(newSent.length, 1, "⑧ 二次 recheck 不重复投递");
		const replay = onTabResultFile(tDir, "tab_tr.result.json", {
			runsDir: tDir, toast: false, autoReclaim: true, sendUserMessage: (c: string) => { newSent.push(c); },
		});
		assert.equal(newSent.length, 1, "⑧ 重放同一文件不重复注入");
		void replay;
		delete process.env.PI_TAB_RUN_ID;
		setCurrentSessionId(undefined);
	}

	// ── ⑨ DOG2 重启场景回归（身份易失→持久，2026-09-20）──────────────────────
	// 生产形状：attach 时本进程是标签页（flag 在）；TUI 重启后 pane 裸 pi 重开丢 flag——
	// 身份只剩会话 UUID。owner 绑定持久 UUID 域：重启前后都能被识别（watch + fencing + 注入）。
	{
		_resetEventBus();
		resetOwnership(true); // cutover ON
		// 第一代：tab 进程 attach（toolSession→durableSessionIdentity→UUID），flag 在
		attachMaster({ sessionId: "01a0b320-3724-701b-8d88-1ead0ea50aa7" }); // 会话 UUID
		process.env.PI_TAB_RUN_ID = "tab_mu6k3drx_fn9d"; // 启动身份（易失）
		setCurrentSessionId("01a0b320-3724-701b-8d88-1ead0ea50aa7"); // 持久身份
		assert.equal(shouldRegisterWatcher(), true, "⑨ 重启前（flag 在）：owner=UUID → watch");
		// 重启：flag 丢失（裸 pi 重开），resume 同一会话 → UUID 不变
		delete process.env.PI_TAB_RUN_ID;
		assert.equal(shouldRegisterWatcher(), true, "⑨ 重启后（flag 丢，UUID 存留）：仍是 owner → watch");
		writeOwnerResult("tab_own9");
		const sent9: string[] = [];
		const ok9 = onTabResultFile(ownerDir, "tab_own9.result.json", {
			runsDir: ownerDir, toast: false, autoReclaim: true, sendUserMessage: (c: string) => { sent9.push(c); },
		});
		assert.equal(ok9, true, "⑨ 重启后 fencing（UUID 域）不误伤");
		assert.equal(sent9.length, 1, "⑨ 注入一次");
		assert.equal(listRuntimeEnvelopes({}).envelopes.filter((e) => e.subject === "run://tab/tab_own9").length, 1, "⑨ journal 由 owner 记录");
		// ⑨b（M3）：真实重启形状——新进程实例重新走注册（session_start）+ tick 兑底投递新 result
		const sent9b: string[] = [];
		const { pi: pi9b, fire: fire9b } = capturePi(sent9b);
		registerEventBus(pi9b as never, { runsDir: ownerDir });
		fire9b("01a0b320-3724-701b-8d88-1ead0ea50aa7"); // resume 同一会话 → 同 UUID
		assert.equal(isEventBusWatching(), true, "⑨b 重启后新实例注册 watcher");
		writeOwnerResult("tab_own9b");
		const fired9b = pollNewResults(ownerDir, { runsDir: ownerDir, toast: false, autoReclaim: true, sendUserMessage: (c: string) => { sent9b.push(c); } });
		assert.equal(fired9b.length, 1, "⑨b tick 兑底发现新 result");
		assert.equal(sent9b.length, 1, "⑨b 新实例投递一次");
		setCurrentSessionId(undefined);
		delete process.env.PI_TAB_RUN_ID;
		console.log("ok - ⑨ DOG2 重启场景：flag 丢、UUID 存留 → 新实例注册+tick 投递");
	}

	// ── ⑭ 空结果守卫（T7 幻影完成，2026-09-20）──────────────────────────────
	// fs.watch 的 rename 含删除事件 + 未写完/坏 JSON 时 result 为 null：此前照走全链，
	// 产生 "(no summary)" 幻影完成并消耗 .notified。现在静默返回且不标 seen（可重试）。
	{
		resetOwnership(true); // cutover ON
		attachMaster({ sessionId: "uuid-null-guard" });
		delete process.env.PI_TAB_RUN_ID; // 主会话 owner
		setCurrentSessionId("uuid-null-guard");
		const sent14: string[] = [];
		const opts14 = {
			runsDir: ownerDir, toast: false, autoReclaim: true,
			sendUserMessage: (c: string) => { sent14.push(c); },
		};
		// 不存在的文件（watch delete 事件形状）→ 三无
		assert.equal(onTabResultFile(ownerDir, "tab_ghost.result.json", opts14), false, "⑭ 不存在文件不处理");
		assert.equal(sent14.length, 0, "⑭ 零注入");
		assert.equal(existsSync(join(ownerDir, "tab_ghost.notified")), false, "⑭ 不消耗认领");
		assert.equal(listRuntimeEnvelopes({}).envelopes.filter((e) => e.subject === "run://tab/tab_ghost").length, 0, "⑭ 不 journal");
		// torn 写（坏 JSON）→ false 且不污染 seen；补好后正常处理
		writeFileSync(join(ownerDir, "tab_torn.result.json"), "{broken", "utf8");
		assert.equal(onTabResultFile(ownerDir, "tab_torn.result.json", opts14), false, "⑭ 坏 JSON 不处理");
		assert.equal(existsSync(join(ownerDir, "tab_torn.notified")), false, "⑭ 坏文件不消耗认领");
		writeOwnerResult("tab_torn"); // 补好（覆盖）
		assert.equal(onTabResultFile(ownerDir, "tab_torn.result.json", opts14), true, "⑭ 补好后可重试处理");
		assert.equal(sent14.length, 1, "⑭ 恰好注入一次");
		setCurrentSessionId(undefined);
		console.log("ok - ⑭ 空结果守卫：删/坏文件零副作用，未写完可重试");
	}

	// ── ⑩ M1 回归：无身份哨兵 "unknown" 拒写 attachment（注册表层硬不变量）──────────
	{
		resetOwnership(true);
		const r = attachMaster({ sessionId: "unknown" }); // sessionIdentity 无身份时的哨兵
		assert.equal(r.ok, false, "⑩ unknown 哨兵拒写（bad-session）");
		if (!r.ok) assert.equal(r.reason, "bad-session", "⑩ 拒因是 bad-session");
		assert.equal(readAttachment(masterAddress()), null, "⑩ attachment 未被写入（无永不可读 owner）");
		console.log("ok - ⑩ unknown 哨兵拒写 attachment（M1）");
	}

	// ── ⑪⑫ 普通派发者唤醒（2026-09-20：cutover 下非 owner 派发者不断醒）────────────────
	// 背景：ownership-gated 修法把非 owner 主会话三重锁死（不注册+fencing+门压制），导致
	// 普通仓库主会话派的 tab 完成无人唤醒。不变量修正：run 完成属于派发者（links recipient）。
	{
		const { recordLink } = await import("./links.ts");
		const linksPath = join(dir, "ord-links.jsonl");
		resetOwnership(true); // cutover ON
		attachMaster({ sessionId: "uuid-global-owner" }); // 全局 master 是别人（本 gen-4 会话之外）
		delete process.env.PI_TAB_RUN_ID; // 主会话（普通仓库裸 pi）
		// ⑪ 本会话派发的 run：links recipient=main-A
		recordLink({ sessionId: "main-A", kind: "tab", targetId: "tab_ord11", detail: "ordinary dispatch" }, { linksPath });
		setCurrentSessionId("main-A");
		assert.equal(shouldRegisterWatcher(), true, "⑪ 普通主会话恒 watch（legacy 延续）");
		writeOwnerResult("tab_ord11");
		const sent11: string[] = [];
		const ok11 = onTabResultFile(ownerDir, "tab_ord11.result.json", {
			runsDir: ownerDir, toast: false, autoReclaim: true, linksPath,
			sendUserMessage: (c: string) => { sent11.push(c); },
		});
		assert.equal(ok11, true, "⑪ 派发者豁免 fencing + dispatcherWake 过门");
		assert.equal(sent11.length, 1, "⑪ 注入一次");
		assert.equal(listRuntimeEnvelopes({}).envelopes.filter((e) => e.subject === "run://tab/tab_ord11").length, 1, "⑪ journal 由派发者记录");
		// ⑫ owner 也不能抢普通派发者的 run：明确 links 归属必须在 journal/mailbox 前路由早退。
		recordLink({ sessionId: "main-A", kind: "tab", targetId: "tab_ord12", detail: "other dispatch" }, { linksPath });
		setCurrentSessionId("uuid-global-owner");
		writeOwnerResult("tab_ord12");
		const sent12: string[] = [];
		const ok12 = onTabResultFile(ownerDir, "tab_ord12.result.json", {
			runsDir: ownerDir, toast: false, autoReclaim: true, linksPath,
			sendUserMessage: (c: string) => { sent12.push(c); },
		});
		assert.equal(ok12, false, "⑫ owner 非派发者不注入（links 路由在 fencing 前挡住）");
		assert.equal(sent12.length, 0, "⑫ owner 零注入");
		assert.equal(listRuntimeEnvelopes({}).envelopes.filter((e) => e.subject === "run://tab/tab_ord12").length, 0, "⑫ owner 不 journal");
		// ⑫b 矩阵 Row D：第三方 watcher（非 owner 非派发者）看普通 run → 零动作
		setCurrentSessionId("main-B");
		writeOwnerResult("tab_ord12b");
		recordLink({ sessionId: "main-A", kind: "tab", targetId: "tab_ord12b", detail: "other dispatch b" }, { linksPath });
		const sent12b: string[] = [];
		const ok12b = onTabResultFile(ownerDir, "tab_ord12b.result.json", {
			runsDir: ownerDir, toast: false, autoReclaim: true, linksPath,
			sendUserMessage: (c: string) => { sent12b.push(c); },
		});
		assert.equal(ok12b, false, "⑫b 第三方不注入");
		assert.equal(sent12b.length, 0, "⑫b 零注入");
		assert.equal(listRuntimeEnvelopes({}).envelopes.filter((e) => e.subject === "run://tab/tab_ord12b").length, 0, "⑫b 第三方不 journal");
		// ⑬ mailbox 跨通道竞争回归：派发者处理后 owner 再消费 → owner 无信可吃、无注入
		// （已知归属非 owner 的 run 不再发 master 影子信，owner 的 mailbox 消费者抢不到 claim）
		const { consumeMailboxOnce } = await import("./mailbox-consumer.ts");
		const { listLetters, defaultMailboxDir } = await import("./runtime/mailbox.ts");
		const pending11 = listLetters(masterAddress(), "pending", defaultMailboxDir());
		assert.equal(pending11.filter((l) => JSON.stringify(l).includes("tab_ord11")).length, 0, "⑬ 普通 run 无 master 影子信");
		const ownerSent13: string[] = [];
		const rep13 = consumeMailboxOnce({
			sessionId: "uuid-global-owner", mailboxDir: defaultMailboxDir(), runsDir: ownerDir,
			sendUserMessage: (c: string) => { ownerSent13.push(c); },
		});
		assert.equal(ownerSent13.length, 0, "⑬ owner 的 mailbox 消费者不注入派发者的完成");
		assert.ok(!rep13.consumed.some((c) => JSON.stringify(c).includes("tab_ord11")), "⑬ 消费清单无 tab_ord11");
		assert.equal(sent11.length, 1, "⑬ 派发者仍是唯一注入方（恰好一次）");
		setCurrentSessionId(undefined);
		console.log("ok - ⑪⑫⑬ 分区矩阵：派发者唯一注入+journal；owner/第三方零动作；mailbox 抢不到");
	}
}

// teardown：关最后一个 watcher（进程退出保障——L4 复核指出新用例路径的 watcher 若不关，
// 测试打印 passed 后进程仍挂活，npm 脚本层表现为 exit 124 挂起）
import { closeWatcherForTests } from "./event-bus.ts";
closeWatcherForTests();

rmSync(dir, { recursive: true, force: true });

console.log("event-bus tests passed");
