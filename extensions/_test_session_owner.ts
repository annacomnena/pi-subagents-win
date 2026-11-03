/**
 * _test_session_owner.ts — 全生命周期 session↔pid 记录（项 1，2026-11-03）
 *
 * ## 为什么需要这个模块（真机事故）
 *
 * `state/scope-liveness/<scope>.json` 只有 local master owner 会写（`session-hooks.ts`
 * 的身份门 `if (!att || att.sessionId !== sid) return;`），普通 TUI 会话**零写**
 * ⇒ `probeTargetSessionLiveness` 对它们恒 `unknown` ⇒ B 通道（目标死 ⇒ 快速 failed）
 * 与 S2（目标死 ⇒ 拉起）同时失效。
 *
 * 而且 scope-liveness 只在 `agent_start`/`agent_end` 写 ⇒ 即使 owner，**空闲期心跳必然超龄**
 * ⇒ 真机发生「pid 76520 活着、会话文件仍在写，但被 B 判 dead 并标 failed」。
 *
 * ## 本模块的三条不变量（逐条对应一个失败模式）
 *
 * 1. **全生命周期**：`session_start` 写、`session_shutdown` 删 ⇒ 与忙闲无关，空闲也在。
 * 2. **pid 身份 = pid + 进程启动时间**：只看 pid 会被 PID 复用骗（2026-10-20 wechat worker
 *    事故：pid 7016 死后被 Windows 复用给 "Memory Compression"）。
 * 3. **never-throw + 僵尸懒删**：写失败只是丢一条 gauge；pid 已死的记录在**读**时删掉。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	deleteSessionOwner,
	probeSessionOwner,
	readSessionOwner,
	sessionOwnerDir,
	sessionOwnerPath,
	writeSessionOwner,
} from "./runtime/session-owner.ts";

const ROOT = mkdtempSync(join(tmpdir(), "session-owner-"));
const STATE = join(ROOT, "state");

let n = 0;
const ok = (name: string): void => {
	n += 1;
	console.log(`ok ${n} - ${name}`);
};

const T0 = new Date("2026-11-03T10:00:00.000Z");

try {
	// ── S1 写入 / 读取 round-trip ──
	{
		const wrote = writeSessionOwner({
			sessionId: "sess-s1",
			pid: 1234,
			startedAt: "2026-11-03T09:00:00.000Z",
			stateDir: STATE,
			now: T0,
		});
		assert.equal(wrote, true, "首次写入必须成功并返回 true");
		const rec = readSessionOwner("sess-s1", STATE);
		assert.ok(rec, "写后必须读得回");
		assert.equal(rec!.sessionId, "sess-s1");
		assert.equal(rec!.pid, 1234);
		assert.equal(rec!.startedAt, "2026-11-03T09:00:00.000Z");
		assert.equal(rec!.updatedAt, T0.toISOString());
		assert.ok(existsSync(sessionOwnerPath("sess-s1", STATE)), "文件名 = <sessionId>.json");
		assert.equal(sessionOwnerDir(STATE), join(STATE, "session-owner"), "目录名固定 session-owner");
		ok("S1 写入/读取 round-trip（sessionId/pid/startedAt/updatedAt 全保真）");
	}

	// ── S2 删除（session_shutdown 等价动作）──
	{
		writeSessionOwner({ sessionId: "sess-s2", pid: 1234, stateDir: STATE, now: T0 });
		assert.ok(readSessionOwner("sess-s2", STATE), "前置：记录存在");
		const removed = deleteSessionOwner("sess-s2", STATE);
		assert.equal(removed, true, "删除应返回 true");
		assert.equal(readSessionOwner("sess-s2", STATE), null, "删除后读不到");
		assert.equal(existsSync(sessionOwnerPath("sess-s2", STATE)), false, "文件应已消失");
		// 幂等：再删一次不抛、返回 false
		assert.equal(deleteSessionOwner("sess-s2", STATE), false, "重复删除返回 false（never-throw）");
		ok("S2 session_shutdown 等价删除（且幂等 never-throw）");
	}

	// ── S3 容忍读：坏 JSON / 坏版本 / 缺关键字段 → null ──
	{
		const dir = sessionOwnerDir(STATE);
		mkdirSync(dir, { recursive: true });
		const cases: Array<[string, string]> = [
			["sess-bad-json", "{ not json"],
			["sess-bad-version", JSON.stringify({ version: 99, sessionId: "sess-bad-version", pid: 1, updatedAt: T0.toISOString() })],
			["sess-no-pid", JSON.stringify({ version: 1, sessionId: "sess-no-pid", startedAt: T0.toISOString(), updatedAt: T0.toISOString() })],
			["sess-no-updated", JSON.stringify({ version: 1, sessionId: "sess-no-updated", pid: 1, startedAt: T0.toISOString() })],
		];
		for (const [sid, body] of cases) {
			writeFileSync(join(dir, `${sid}.json`), body, "utf8");
			assert.equal(readSessionOwner(sid, STATE), null, `${sid} 应容忍为 null（不抛）`);
		}
		assert.equal(readSessionOwner("sess-never-written", STATE), null, "缺失文件 → null");
		ok("S3 容忍读：坏 JSON / 坏版本 / 缺 pid / 缺 updatedAt / 缺失 全 → null");
	}

	// ── S4 pid 已死 ⇒ dead，且记录被**懒删** ──
	{
		writeSessionOwner({ sessionId: "sess-s4", pid: 999999, startedAt: "2026-11-03T09:00:00.000Z", stateDir: STATE, now: T0 });
		const p = probeSessionOwner("sess-s4", {
			stateDir: STATE,
			now: T0,
			probePid: () => ({ state: "dead", basis: "test" }),
		});
		assert.equal(p.state, "dead", `pid 死应判 dead，实际 ${p.state}（${p.basis}）`);
		assert.equal(p.record?.pid, 999999, "结论应带上原记录（诊断可读）");
		assert.equal(existsSync(sessionOwnerPath("sess-s4", STATE)), false, "僵尸记录应被懒删（否则目录无限增长）");
		ok("S4 pid 已死 ⇒ dead + 僵尸记录懒删");
	}

	// ── S5 pid 活 + 启动时间匹配 ⇒ alive ──
	{
		writeSessionOwner({ sessionId: "sess-s5", pid: 4242, startedAt: "2026-11-03T09:00:00.000Z", stateDir: STATE, now: T0 });
		const p = probeSessionOwner("sess-s5", {
			stateDir: STATE,
			now: T0,
			probePid: () => ({ state: "alive", basis: "test" }),
			probeProcessStartedAt: () => "2026-11-03T09:00:20.000Z", // 记录时刻 +20s（容差内）
		});
		assert.equal(p.state, "alive", `pid 活 + 启动时间匹配应 alive，实际 ${p.state}（${p.basis}）`);
		assert.ok(existsSync(sessionOwnerPath("sess-s5", STATE)), "活记录不得被删");
		ok("S5 pid 活 + 进程启动时间匹配（20s 容差内）⇒ alive");
	}

	// ── S6 pid 活但 OS 启动时间**晚于**记录 ⇒ PID 复用 ⇒ dead ──
	{
		writeSessionOwner({ sessionId: "sess-s6", pid: 5151, startedAt: "2026-11-03T09:00:00.000Z", stateDir: STATE, now: T0 });
		const p = probeSessionOwner("sess-s6", {
			stateDir: STATE,
			now: T0,
			probePid: () => ({ state: "alive", basis: "test" }),
			// 那个号现在是另一个进程（晚 2 小时才起）
			probeProcessStartedAt: () => "2026-11-03T11:00:00.000Z",
		});
		assert.equal(p.state, "dead", `PID 复用应判 dead，实际 ${p.state}（${p.basis}）`);
		assert.match(p.basis, /reused/, `basis 应指明 pid 复用，实际 ${p.basis}`);
		ok("S6 pid 活但 OS 启动时间晚于记录 ⇒ dead(pid-reused)");
	}

	// ── S6b OS 启动时间不可用 ⇒ **不猜**（alive，但 basis 标注）──
	{
		writeSessionOwner({ sessionId: "sess-s6b", pid: 5252, startedAt: "2026-11-03T09:00:00.000Z", stateDir: STATE, now: T0 });
		const p = probeSessionOwner("sess-s6b", {
			stateDir: STATE,
			now: T0,
			probePid: () => ({ state: "alive", basis: "test" }),
			probeProcessStartedAt: () => undefined, // 查询不可用
		});
		assert.equal(p.state, "alive", "启动时间查不到只能按 pid 活判 alive（探不到 ≠ 已死）");
		assert.match(p.basis, /start-time-unavailable/, `basis 应诚实标注，实际 ${p.basis}`);
		ok("S6b OS 启动时间查询不可用 ⇒ alive + basis 标注 start-time-unavailable（不猜）");
	}

	// ── S7 探针抛异常 ⇒ unknown（never-throw）──
	{
		writeSessionOwner({ sessionId: "sess-s7", pid: 6262, stateDir: STATE, now: T0 });
		const p = probeSessionOwner("sess-s7", {
			stateDir: STATE,
			now: T0,
			probePid: () => {
				throw new Error("boom");
			},
		});
		assert.equal(p.state, "unknown", `探针抛异常应 unknown，实际 ${p.state}`);
		assert.ok(existsSync(sessionOwnerPath("sess-s7", STATE)), "探针异常不得删记录");
		ok("S7 探针抛异常 ⇒ unknown（never-throw）");
	}

	// ── S8 无记录 ⇒ unknown（不猜，与"记录缺失"区分）──
	{
		const p = probeSessionOwner("sess-s8-none", { stateDir: STATE, now: T0 });
		assert.equal(p.state, "unknown", "无记录 ⇒ unknown");
		assert.match(p.basis, /no-record/, `basis 应指明无记录，实际 ${p.basis}`);
		assert.equal(p.record, undefined, "无记录时 record 为 undefined");
		ok("S8 无记录 ⇒ unknown(no-record)（不猜，不误判死）");
	}

	// ── S9 原子写：不留 .tmp 残留 ──
	{
		writeSessionOwner({ sessionId: "sess-s9", pid: 7272, stateDir: STATE, now: T0 });
		const left = readFileSync(sessionOwnerPath("sess-s9", STATE), "utf8");
		assert.equal(left.trim().startsWith("{"), true, "落盘内容必须是完整 JSON");
		const dir = sessionOwnerDir(STATE);
		const { readdirSync } = await import("node:fs");
		const tmps = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
		assert.equal(tmps.length, 0, `不得留 tmp 残留，实得 ${tmps.join(",")}`);
		ok("S9 写入原子（tmp+rename，零残留）");
	}

	// ── S11 生命周期接线自证（2026-11-03 L4 第 2 轮实测驱动）──────────
	// 背景：L4 实测 `writeSessionOwner` 的**生产调用点 = 0 个**⇒ 本文件头写的
	// 「session_start 写、session_shutdown 删」当时只是声明（AGENTS.md §4：判定必须走真实入口）。
	// 本检查走**真实注册线**：registerSessionHooks(fakePi) → 触发 session_start / session_shutdown。
	{
		process.env.PI_RUNTIME_DIR = join(ROOT, "runtime"); // 必须早于 import（本检查内动态 import ⇒ 隔离真的成立）
		// 生产侧推导是 `join(defaultRuntimeDir(), "state")` ⇒ 测试读同一个推导，不能自造目录
		const OWNER_STATE = join(process.env.PI_RUNTIME_DIR, "state");
		const { registerSessionHooks } = await import("./session-hooks.ts");
		const handlers: Record<string, Array<(e: unknown, c: unknown) => void>> = {};
		const fakePi = { on: (ev: string, cb: (e: unknown, c: unknown) => void) => { (handlers[ev] ??= []).push(cb); } };
		registerSessionHooks(fakePi as never, { cleanups: [], isNotifyEnabled: () => false, pkgDir: ROOT });
		const fire = (ev: string): void => { for (const cb of handlers[ev] ?? []) cb({}, { sessionManager: { sessionId: "sess-life-1" } }); };
		assert.ok((handlers["session_start"] ?? []).length > 0, "S11 前置：session_start handler 已注册");
		assert.equal(readSessionOwner("sess-life-1", OWNER_STATE), null, "S11 前置：本会话尚无 owner 记录");
		fire("session_start");
		assert.notEqual(readSessionOwner("sess-life-1", OWNER_STATE), null, "S11① 真实 session_start ⇒ owner 记录真的创建（接线在）");
		const probe = probeSessionOwner("sess-life-1", { stateDir: OWNER_STATE });
		assert.equal(probe.state, "alive", `S11② 本进程活着 ⇒ 探针应 alive（实得 ${probe.state}/${probe.basis}）`);
		fire("session_shutdown");
		assert.equal(deleteSessionOwner("sess-life-1", OWNER_STATE), false, "S11③ 真实 session_shutdown 已删（再删应 false）");
		assert.equal(readSessionOwner("sess-life-1", OWNER_STATE), null, "S11④ 生命周期成对：shutdown 后无残留");
		ok("S11 生命周期接线（registerSessionHooks ⇒ session_start 写 / session_shutdown 删）");
	}

	console.log(`\n_test_session_owner: ${n} checks passed`);
} finally {
	rmSync(ROOT, { recursive: true, force: true });
}
