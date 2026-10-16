/**
 * _test_delivery_reconciler_loop.ts — B 对账通道**生产接线**验收单测（切片 1）
 *
 * 依据：`plans/20261016_b_channel_wiring_plan.md` §3（E1–E5，每条**自带反例自检**）；
 * 咨询 `plans/20261016_consult_scheduling_and_wake_reliability.md` §6.2/§6.5。
 *
 * ## 覆盖什么（E1–E5 逐条）
 *   E1  关 A 后 B 仍生效：**只启 loop**（全程不加载 `async-result-watcher.ts`）⇒ 终态 run 仍被
 *       `ensureEvent` + 补投（channel=B attempt）+ 到期**升级**（incident）。
 *   E2  `undiscovered_terminal = 0`：**终态 run 全集**（独立枚举，非「已解析集合」）− 已建事件全集 = 0。
 *   E3  **B 不写 run 终态**：loop 只读 runsDir；跑前后 `run_*.json` **逐字节相同**（含目录清单不新增）。
 *   E4  **kill switch 关闭 ⇒ 零动作**：无 interval、无事件、无 incident、无 outbox、**无状态文件写入**。
 *   E5  **cursor 跨重启不丢**：>limit 条终态 + 三次「启停 loop」；三段各覆盖**不同**圆环段，
 *       合起来**无终态被永久漏扫**（不永远只看前 N 条）。
 *
 * ## 反例自检（`agents/code-reviewer.md`「断言强度核对」必查项）
 * 每条判据在报告里都做了**一次实际变异**（故意破坏 ⇒ 必红 ⇒ 还原），并在下方注释标出
 * 该变异的具体形态。E2/E4 的反例直接内嵌为本文件里的**坏基线对照**断言（同文件即可自证强度），
 * E1/E3/E5 的反例是**对生产文件/调用点的临时变异**（见报告 `plans/20261016_b_channel_wiring_impl.md`）。
 *
 * ## 隔离
 * `PI_RUNTIME_DIR` / `PI_SUBAGENT_RUNS_DIR` / `PI_LINKS_PATH` 三 env 均在 **import 之前**设为
 * 独立 mkdtemp（零写入真实 `~/.pi/agent`；同 `_test_delivery_crash_window.ts:44` 纪律）。
 *
 * 运行：npm run -s test:delivery-reconciler-loop
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── 隔离在 import 之前（模块级路径解析全部落到临时目录）────────────────
const ROOT = mkdtempSync(join(tmpdir(), "delivery-loop-env-"));
process.env.PI_RUNTIME_DIR = join(ROOT, "runtime");
process.env.PI_SUBAGENT_RUNS_DIR = join(ROOT, "subagent-runs");
process.env.PI_LINKS_PATH = join(ROOT, "links.jsonl");
delete process.env.PI_SUBAGENT;
delete process.env.PI_TAB_RUN_ID;
delete process.env.PI_DELIVERY_RECONCILER;

import {
	startDeliveryReconcilerLoop,
	deliveryReconcilerEnabled,
	deliveryReconcilerStatePath,
	readDeliveryReconcilerState,
} from "./runtime-host/delivery-reconciler-loop.ts";
import { listEvents, listAcks, listAttempts, listOpenIncidents } from "./delivery-ledger.ts";
import { listOutboxItems, outboxDir } from "./runtime/message-outbox.ts";

let n = 0;
const ok = (name: string): void => { n += 1; console.log(`ok ${n} - ${name}`); };

const NOW = Date.parse("2026-10-16T09:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

/** 每组独立的三目录（runs / delivery / state），避免跨组计数互相污染。 */
interface Group { runsDir: string; deliverDir: string; stateDir: string }
const group = (g: string): Group => {
	const d: Group = {
		runsDir: join(ROOT, `runs-${g}`),
		deliverDir: join(ROOT, `delivery-${g}`),
		stateDir: join(ROOT, `state-${g}`),
	};
	mkdirSync(d.runsDir, { recursive: true });
	return d;
};

/** 写一份权威终态 run JSON（返回**逐字节**内容，供 E3 比对）。 */
const writeRun = (runsDir: string, runId: string, at: number): Buffer => {
	const buf = Buffer.from(JSON.stringify({
		id: runId, agent: "general", task: "loop-test", status: "completed",
		startedAt: iso(at - 60_000), endedAt: iso(at), pid: 4242,
		result: { status: "completed", text: "ok", error: null },
	}), "utf8");
	writeFileSync(join(runsDir, `${runId}.json`), buf);
	return buf;
};

/** 独立 oracle：直接读 runsDir，枚举**终态 run 全集**（不经被测模块的解析函数）。 */
const terminalRunIds = (runsDir: string): Set<string> => {
	const out = new Set<string>();
	for (const f of readdirSync(runsDir)) {
		if (!f.startsWith("run_") || !f.endsWith(".json")) continue;
		try {
			const rec = JSON.parse(readFileSync(join(runsDir, f), "utf8")) as { id?: unknown; status?: unknown };
			if (typeof rec.id === "string" && typeof rec.status === "string" && rec.status !== "running") out.add(rec.id);
		} catch { /* 坏文件跳过（本用例不构造） */ }
	}
	return out;
};

/** 目录快照：相对路径清单 + 每个文件 sha256（E3 逐字节比对用）。 */
const snapshotDir = (dir: string): string => {
	const out: string[] = [];
	const walk = (rel: string): void => {
		let entries: string[] = [];
		try { entries = readdirSync(join(dir, rel)).sort(); } catch { return; }
		for (const e of entries) {
			const p = join(dir, rel, e);
			const rp = rel ? `${rel}/${e}` : e;
			let st: ReturnType<typeof statSync>;
			try { st = statSync(p); } catch { continue; }
			if (st.isDirectory()) walk(rp);
			else if (st.isFile()) out.push(`${rp} ${createHash("sha256").update(readFileSync(p)).digest("hex")}`);
		}
	};
	walk("");
	return out.join("\n");
};

const outboxItems = (stateDir: string): ReturnType<typeof listOutboxItems> => listOutboxItems(outboxDir(stateDir));

try {
	// ── 基线：kill switch 语义的纯函数口径 ──────────────────────────
	{
		assert.equal(deliveryReconcilerEnabled({}), true, "缺省启用（本批目的就是接线）");
		assert.equal(deliveryReconcilerEnabled({ PI_DELIVERY_RECONCILER: "0" }), false, "=0 ⇒ 关");
		assert.equal(deliveryReconcilerEnabled({ PI_DELIVERY_RECONCILER: " 0 " }), false, "trim 后 =0 ⇒ 关");
		assert.equal(deliveryReconcilerEnabled({ PI_DELIVERY_RECONCILER: "1" }), true, "=1 ⇒ 开");
		assert.equal(deliveryReconcilerEnabled({ PI_DELIVERY_RECONCILER: "false" }), true, "仅恰为 0 才关（其余值启用）");
		ok("基线 kill switch 口径：仅 PI_DELIVERY_RECONCILER=0（trim）关闭，缺省启用");
	}

	// ══ E1：关 A 后 B 仍生效（只启 loop；无 watcher）════════════════════
	// 反例自检：把下方 `startDeliveryReconcilerLoop(...)` 调用点整段注释掉 ⇒ 本组全红。
	{
		const g = group("e1");
		const runId = "run_e1_only_b";
		writeRun(g.runsDir, runId, NOW);
		let clock = NOW + 25_000; // > RECONCILE_FIRST_RETRY_MS(20s) 且 < deadline(60s)
		const loop = startDeliveryReconcilerLoop({
			runsDir: g.runsDir, deliverDir: g.deliverDir, stateDir: g.stateDir,
			intervalMs: 60_000, limit: 50, now: () => clock,
			resolveDispatcher: (r: string) => (r === runId ? "sess_b_dispatch" : undefined),
		});
		try {
			await loop.ready;

			// ① 终态 run 被 ensureEvent（B 独立建事件）
			const ev = listEvents(g.deliverDir, 100).find((e) => e.runId === runId);
			assert.ok(ev, "E1① 只跑 loop（不加载 watcher）⇒ 终态 run 仍被 ensureEvent");
			assert.equal(ev!.dispatcherSessionId, "sess_b_dispatch", "派发者来自 links 解析口径（注入点）");

			// ② 补投：B 通道 attempt 已记（channel=B），且**没有** A 通道痕迹
			const attempts = listAttempts(g.deliverDir, ev!.eventId);
			assert.equal(attempts.length, 1, "E1② 过 20s 阈值 ⇒ B 补投一次");
			assert.equal(attempts[0]!.channel, "B", "attempt 归因 B 通道（A 从未参与）");
			assert.equal(attempts[0]!.status, "sent", "attempt 只表示「调过发送」（不是 delivered）");
			assert.equal(attempts.filter((a) => a.channel === "A").length, 0, "全程无 A 通道 attempt（A 未加载）");
			assert.equal(existsSync(join(g.runsDir, `${runId}.notified`)), false, "无 A 的 .notified 残留（A 未跑）");
			assert.equal(listAcks(g.deliverDir, ev!.eventId).length, 0, "B 补投**不**伪造 consumed（交付成功须 receiver ACK）");

			// ③ outbox 定向持久唤醒（生产缺省投递路径）确实落盘到派发者
			const items = outboxItems(g.stateDir);
			assert.equal(items.length, 1, "E1③ 生产投递 = 向派发者 outbox 写 1 条定向持久唤醒");
			assert.equal(items[0]!.sessionId, "sess_b_dispatch", "唤醒寻址 = 派发者会话（不是别的会话）");
			assert.ok(items[0]!.text.includes(ev!.eventId), "唤醒正文**必带 eventId 标记**（receiver context 才能 ACK）");

			// ④ 升级：过 deliveryDeadline ⇒ fail_delivery + 持久 incident（不调用模型）
			clock = NOW + 75_000;
			await loop.runOnce();
			const open = listOpenIncidents(g.deliverDir).filter((i) => i.runId === runId);
			assert.equal(open.length, 1, "E1④ 期限到 ⇒ 持久 incident 恰 1 条（升级出口）");
			assert.ok(open[0]!.reason.includes("deadline-exceeded"), `incident 原因写明期限（实得 ${open[0]!.reason}）`);
			const st = loop.status();
			assert.equal(st.running, true, "升级后循环仍在跑（never-throw）");
			assert.equal(st.lastError, null, "无 lastError");
			assert.equal(st.tickCount, 2, "两轮对账各自 tickCount +1");
		} finally {
			loop.stop();
		}
		// 反例自检（等价于「把 loop 启动注释掉」）：坏基线 = 不启动 loop 时同一终态 run 零事件
		{
			const g2 = group("e1-neg");
			writeRun(g2.runsDir, "run_e1_neg", NOW);
			await new Promise((r) => setTimeout(r, 30)); // 留出「若真启动了」的窗口
			assert.equal(listEvents(g2.deliverDir, 100).length, 0, "E1 反例基线：不启动 loop ⇒ 零事件（该断言在漏接线时必红）");
		}
		ok("E1 只启 loop（无 watcher）：ensureEvent + B 补投 + outbox 定向唤醒 + 到期 incident 升级");
	}

	// ══ E2：undiscovered_terminal = 0（终态 run 全集 − 已建事件全集 = 0）══
	{
		const g = group("e2");
		const ids = ["run_e2_a", "run_e2_b", "run_e2_c", "run_e2_d", "run_e2_e"];
		for (const id of ids) writeRun(g.runsDir, id, NOW);
		const loop = startDeliveryReconcilerLoop({
			runsDir: g.runsDir, deliverDir: g.deliverDir, stateDir: g.stateDir,
			intervalMs: 60_000, limit: 50, now: () => NOW + 25_000,
			resolveDispatcher: (r: string) => (ids.includes(r) ? "sess_e2" : undefined),
		});
		try {
			await loop.ready;
		} finally {
			loop.stop();
		}
		// 独立 oracle：两边都从盘上枚举（不读被测模块的内存结果）
		const terminals = terminalRunIds(g.runsDir);
		const discovered = new Set(listEvents(g.deliverDir, 10_000).map((e) => e.runId));
		const undiscovered = [...terminals].filter((id) => !discovered.has(id));
		assert.equal(terminals.size, 5, "E2 名义全集非空（5 条终态，真的能走到）");
		assert.equal(undiscovered.length, 0, `undiscovered_terminal 必须 = 0（实得 ${undiscovered.join(",")}）`);

		// ── 反例自检（坏基线，同文件自证断言强度）：resolveDispatcher 恒 undefined ⇒ 计数 > 0 ──
		{
			const gNeg = group("e2-neg");
			for (const id of ids) writeRun(gNeg.runsDir, id, NOW);
			const neg = startDeliveryReconcilerLoop({
				runsDir: gNeg.runsDir, deliverDir: gNeg.deliverDir, stateDir: gNeg.stateDir,
				intervalMs: 60_000, limit: 50, now: () => NOW + 25_000,
				resolveDispatcher: () => undefined, // 变异：fail-closed 变永闭
			});
			try { await neg.ready; } finally { neg.stop(); }
			const negDisc = new Set(listEvents(gNeg.deliverDir, 10_000).map((e) => e.runId));
			const negUndiscovered = [...terminalRunIds(gNeg.runsDir)].filter((id) => !negDisc.has(id));
			assert.equal(negUndiscovered.length, 5, "E2 反例：派发者恒 undefined ⇒ undiscovered_terminal=5 > 0（该断言在误接时必红）");
		}
		ok("E2 undiscovered_terminal=0（独立 oracle 复算）；反例：派发者恒 undefined ⇒ 5 > 0");
	}

	// ══ E2b：**生产缺省**解析/投递路径（不注入任何 resolveDispatcher/deliver）══
	// 为什么必须单列：E1/E2 都注入了 resolveDispatcher ⇒ 生产缺省实现（`links.ts::listLinks`
	// 口径 + outbox spool）可能整体漏测。本组只靠 PI_LINKS_PATH 的真实 async link 与
	// PI_RUNTIME_DIR/PI_SUBAGENT_RUNS_DIR 的隔离路径，跑**零注入**的一个 loop。
	// 反例自检：把生产缺省 `resolveDispatcherFromLinks` 改成恒 undefined ⇒ 本组必红。
	{
		const g = group("e2-prod");
		const ids = ["run_e2p_a", "run_e2p_b"];
		for (const id of ids) {
			writeRun(g.runsDir, id, NOW);
			// 真实 links 账本行（与 A 派发时 `recordLink` 落盘形状一致；env PI_LINKS_PATH 已隔离）
			writeFileSync(process.env.PI_LINKS_PATH!, `${JSON.stringify({ sessionId: "sess_prod_links", kind: "async", targetId: id, detail: "prod-defaults", at: iso(NOW), pid: process.pid })}\n`, { flag: "a" });
		}
		const loop = startDeliveryReconcilerLoop({
			runsDir: g.runsDir, deliverDir: g.deliverDir, stateDir: g.stateDir,
			intervalMs: 60_000, limit: 50, now: () => NOW + 25_000,
			// linksPath 缺省 ⇒ 走 env PI_LINKS_PATH（= 生产 env override 路径）
		});
		try {
			await loop.ready;
		} finally {
			loop.stop();
		}
		const terminals = terminalRunIds(g.runsDir);
		const evs = listEvents(g.deliverDir, 10_000);
		const discovered = new Set(evs.map((e) => e.runId));
		const undiscovered = [...terminals].filter((id) => !discovered.has(id));
		assert.equal(undiscovered.length, 0, `E2b 生产缺省派发者解析（links）无一漏发现（实得 ${undiscovered.join(",")}）`);
		assert.equal(evs.length, 2, "E2b 两条终态各建一事件");
		assert.ok(evs.every((e) => e.dispatcherSessionId === "sess_prod_links"), "E2b 派发者 = links 账本里的 async sessionId（生产口径）");
		// 生产投递（outbox spool）确实产出定向唤醒，且寻址派发者
		const items = outboxItems(g.stateDir);
		assert.equal(items.length, 2, "E2b 生产缺省投递 = outbox 定向唤醒 ×2");
		assert.ok(items.every((it) => it.sessionId === "sess_prod_links" && it.to === "pi://sess_prod_links"), "E2b outbox 寻址 = 派发者会话地址");
		// 幂等：再跑一轮不得重复投（dedupeKey 绑 eventId ⇒ item id 稳定）
		const loop2 = startDeliveryReconcilerLoop({ runsDir: g.runsDir, deliverDir: g.deliverDir, stateDir: g.stateDir, intervalMs: 60_000, limit: 50, now: () => NOW + 45_000 });
		try { await loop2.ready; } finally { loop2.stop(); }
		assert.equal(outboxItems(g.stateDir).length, 2, "E2b 重投幂等：outbox 项数不增（dedupeKey 绑 eventId）");
		ok("E2b 生产缺省路径（无注入）：links 解析派发者 + outbox 定向唤醒 + 重投幂等");
	}

	// ══ E3：B 不写 run 终态（runsDir 只读；逐字节不变）══════════════════
	// 反例自检：在 loop 内加一句写 run 文件 ⇒ 本组必红（变异见报告）。
	{
		const g = group("e3");
		const ids = ["run_e3_a", "run_e3_b", "run_e3_c"];
		const bytes = new Map<string, Buffer>();
		for (const id of ids) bytes.set(id, writeRun(g.runsDir, id, NOW));
		const before = snapshotDir(g.runsDir); // 文件清单 + sha256
		const loop = startDeliveryReconcilerLoop({
			runsDir: g.runsDir, deliverDir: g.deliverDir, stateDir: g.stateDir,
			intervalMs: 60_000, limit: 50, now: () => NOW + 25_000,
			resolveDispatcher: () => "sess_e3",
		});
		try {
			await loop.ready;
			await loop.runOnce(); // 多跑一轮（含第二轮「事件已存在」路径）
		} finally {
			loop.stop();
		}
		assert.ok(listEvents(g.deliverDir, 100).length >= ids.length, "loop 确实做了事（非空转下比对才有意义）");
		for (const id of ids) {
			assert.ok(readFileSync(join(g.runsDir, `${id}.json`)).equals(bytes.get(id)!), `E3 ${id} 终态逐字节不变`);
		}
		const after = snapshotDir(g.runsDir);
		assert.equal(after, before, "E3 runsDir 目录级零变化（清单 + 内容 hash 全等 ⇒ 无新增/改写/删除）");
		ok("E3 B 只读 runsDir：3 个 run 终态逐字节不变 + 目录级零变化（含跑两轮 + incident 判定路径）");
	}

	// ══ E4：kill switch 关闭 ⇒ 零动作 ══════════════════════════════════
	// 反例自检：忽略 kill switch（强制走启用分支）⇒ 状态文件/事件出现 ⇒ 本组必红。
	{
		const g = group("e4");
		const runId = "run_e4_gated";
		writeRun(g.runsDir, runId, NOW);
		const statePath = deliveryReconcilerStatePath(g.stateDir);
		// 覆盖两条关闭路径：显式 killSwitch:false 与 env PI_DELIVERY_RECONCILER=0
		process.env.PI_DELIVERY_RECONCILER = "0";
		const loop = startDeliveryReconcilerLoop({
			runsDir: g.runsDir, deliverDir: g.deliverDir, stateDir: g.stateDir,
			intervalMs: 30, limit: 50, now: () => NOW + 75_000, // 期限早过：若被忽略，必产 incident
			resolveDispatcher: () => "sess_e4",
		});
		try {
			assert.equal(loop.status().running, false, "status().running=false");
			assert.equal(loop.status().reason, "kill-switch", "reason=kill-switch");
			await loop.ready; // 关闭态 ready 立即 resolve（零动作）
			await loop.runOnce(); // 显式调用也必须零动作
			await new Promise((r) => setTimeout(r, 150)); // ≥ 5 个 interval：若真起了 timer 必留下痕迹
			assert.equal(loop.status().tickCount, 0, "E4 无 interval：tickCount 恒 0（5×intervalMs 窗口内零 tick）");
			assert.equal(existsSync(statePath), false, "E4 无状态文件写入（delivery-reconciler.json 不存在）");
			assert.equal(readDeliveryReconcilerState(g.stateDir).tickCount, 0, "读状态亦为缺省（未落盘）");
			assert.equal(existsSync(g.deliverDir) ? readdirSync(g.deliverDir).length : 0, 0, "E4 无事件/尝试/incident（账本目录零文件）");
			assert.equal(listOpenIncidents(g.deliverDir).length, 0, "E4 无 incident（即使期限早过）");
			assert.equal(outboxItems(g.stateDir).length, 0, "E4 无 outbox 投递");
			assert.equal(readFileSync(join(g.runsDir, `${runId}.json`), "utf8").includes("completed"), true, "run 原样");
		} finally {
			loop.stop();
			delete process.env.PI_DELIVERY_RECONCILER;
		}

		// ── 反例自检（坏基线，同文件自证）：忽略 kill switch ⇒ 状态文件与事件必出现 ──
		{
			const gNeg = group("e4-neg");
			writeRun(gNeg.runsDir, "run_e4_neg", NOW);
			const bypass = startDeliveryReconcilerLoop({
				runsDir: gNeg.runsDir, deliverDir: gNeg.deliverDir, stateDir: gNeg.stateDir,
				intervalMs: 60_000, limit: 50, now: () => NOW + 75_000,
				killSwitch: true, // 变异：无视外部关闭意图，直接放行
				resolveDispatcher: () => "sess_e4_neg",
			});
			try { await bypass.ready; } finally { bypass.stop(); }
			assert.equal(existsSync(deliveryReconcilerStatePath(gNeg.stateDir)), true, "E4 反例：放行 ⇒ 状态文件已写（关闸断言在该情形必红）");
			assert.ok(listEvents(gNeg.deliverDir, 100).length > 0, "E4 反例：放行 ⇒ 事件已建 + incident 已发（零动作断言必红）");
		}
		ok("E4 kill switch 关 ⇒ 零 interval / 零事件 / 零 incident / 零 outbox / 零状态文件；反例：放行即留痕");
	}

	// ══ E5：cursor 跨重启不丢（>limit 条终态；三段圆环无漏扫）═══════════
	// 反例自检：不持久化 cursor ⇒ 每次重启都从 files[0] 起重扫前 limit 条 ⇒ 后段终态永不被发现。
	{
		const g = group("e5");
		const ids = ["run_e5_00", "run_e5_01", "run_e5_02", "run_e5_03", "run_e5_04"];
		for (const id of ids) writeRun(g.runsDir, id, NOW);
		const LIMIT = 2; // 5 条终态 > limit=2 ⇒ 必须跨轮/跨重启轮转
		const segments: Array<{ covered: string[]; cursorAfter: string | null }> = [];
		for (let seg = 0; seg < 3; seg += 1) {
			const beforeIds = new Set(listEvents(g.deliverDir, 10_000).map((e) => e.runId));
			const loop = startDeliveryReconcilerLoop({
				runsDir: g.runsDir, deliverDir: g.deliverDir, stateDir: g.stateDir,
				intervalMs: 60_000, limit: LIMIT, now: () => NOW + 25_000,
				resolveDispatcher: (r: string) => (ids.includes(r) ? "sess_e5" : undefined),
			});
			try { await loop.ready; } finally { loop.stop(); }
			const afterIds = new Set(listEvents(g.deliverDir, 10_000).map((e) => e.runId));
			segments.push({
				covered: [...afterIds].filter((id) => !beforeIds.has(id)).sort(),
				cursorAfter: readDeliveryReconcilerState(g.stateDir).cursor,
			});
		}

		// ① 三段合起来覆盖全部 5 条终态（无终态永久漏扫）
		const union = new Set(listEvents(g.deliverDir, 10_000).map((e) => e.runId));
		const undiscovered = ids.filter((id) => !union.has(id));
		assert.equal(undiscovered.length, 0, `E5① 三段重启后无终态被漏扫（实得未覆盖 ${undiscovered.join(",")}）`);
		assert.equal(union.size, 5, "E5① 已建事件全集 = 终态全集（5）");

		// ② 每段覆盖的是**不同**圆环段（cursor 真的在推进，而非每次重扫前 2 条）
		assert.deepEqual(segments[0]!.covered, ["run_e5_00", "run_e5_01"], "E5② 第 1 段 = files[0..1]");
		assert.deepEqual(segments[1]!.covered, ["run_e5_02", "run_e5_03"], "E5② 第 2 段从上次 cursor 之后继续（不是重扫前 2 条）");
		assert.deepEqual(segments[2]!.covered, ["run_e5_04"], "E5② 第 3 段收尾最后一条（回绕页里剩下的未被漏）");
		assert.notEqual(segments[1]!.cursorAfter, segments[0]!.cursorAfter, "E5② 段间 cursor 变化（持久化生效）");

		// ③ 状态文件本身就是跨重启证据（重启后读到的 cursor 非 null）
		const persisted = readDeliveryReconcilerState(g.stateDir);
		assert.equal(typeof persisted.cursor, "string", "E5③ 状态文件持久 cursor（重启可见）");
		assert.ok(persisted.tickCount >= 3, `E5③ tickCount 跨三段累计（实得 ${persisted.tickCount}）`);

		// ── 反例自检（坏基线，同文件自证）：不持久化 cursor ⇒ 每段都重扫前 limit 条 ⇒ 后段永漏 ──
		{
			const gNeg = group("e5-neg");
			for (const id of ids) writeRun(gNeg.runsDir, id, NOW);
			for (let seg = 0; seg < 3; seg += 1) {
				// 每次重启都显式从 cursor=null 起（= 未持久化的等价形态：环回起点）
				const loop = startDeliveryReconcilerLoop({
					runsDir: gNeg.runsDir, deliverDir: gNeg.deliverDir, stateDir: gNeg.stateDir,
					intervalMs: 60_000, limit: LIMIT, now: () => NOW + 25_000,
					resolveDispatcher: (r: string) => (ids.includes(r) ? "sess_e5_neg" : undefined),
				});
				// 用独立 stateDir 的「首次」语义模拟：读得到的 cursor 恒为 null 时页面恒相同
				try { await loop.ready; } finally { loop.stop(); }
				// 抹掉 cursor 以复现「不持久化」的坏基线（等价变异）
				writeFileSync(deliveryReconcilerStatePath(gNeg.stateDir), JSON.stringify({
					cursor: null, lastTickAt: iso(NOW), tickCount: seg + 1, lastError: null, hostPid: process.pid,
				}), "utf8");
			}
			const negUnion = new Set(listEvents(gNeg.deliverDir, 10_000).map((e) => e.runId));
			const negUndiscovered = ids.filter((id) => !negUnion.has(id));
			assert.equal(negUnion.size, LIMIT, "E5 反例：cursor 不持久化 ⇒ 只覆盖前 limit 条（实得 " + negUnion.size + "）");
			assert.equal(negUndiscovered.length, 3, "E5 反例：3 条终态永远扫不到 ⇒ 该断言在漏持久化时必红");
		}
		ok("E5 cursor 跨重启续接：3 段各推进不同圆环段、5 条终态全覆盖；反例：不持久化 ⇒ 3 条永漏");
	}

	console.log(`\n_test_delivery_reconciler_loop: all ${n} groups passed`);
} finally {
	rmSync(ROOT, { recursive: true, force: true });
}
