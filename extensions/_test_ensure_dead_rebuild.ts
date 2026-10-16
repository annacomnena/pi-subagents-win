/**
 * _test_ensure_dead_rebuild.ts — ensureRuntimeDaemon「dead 僵尸 host.json 接管重建」门禁
 * （L3 修复 plans/0923_daemon_dead_rebuild_fix.md；对齐 daemon-lifecycle.ts 文件头契约：
 *   「接管 fail-closed：dead pid/坏文件才在确已持锁后重建；pid 活但超时（stale）/
 *     身份不符/锁被活持有人占用 → uncertain」）
 *
 * 覆盖：
 *   ①   dead host.json（pid 已死，无锁）→ 持锁重建：回执含「僵尸/接管」，spawn 被调用，非 uncertain。
 *   ①b  dead host.json + 孤儿锁（锁持有人已死）→ 清僵尸锁后持锁重建（仍不得碰活锁）。
 *   ②   stale（pid 活但探活失败）→ 仍 uncertain fail-closed，spawn 未被调用，host.json 未被覆盖。
 *   ③   runtimeId 身份不符 → 仍 uncertain fail-closed，spawn 未被调用，host.json 未被覆盖。
 *   ④   dead host.json + 锁被**活**持有人占用 → 仍 fail-closed：不重建、不 kill、不删锁、不覆盖。
 *
 * 隔离：hostPath/锁/stateDir 全在 tmp（显式 hostPath → runtimeDir=其目录）；spawn/now 注入；
 * 假 spawn 只写 fixture host.json（pid=本测试进程）+ 指向本测试内联健康探针端口；
 * **不触碰真实 ~/.pi/agent/runtime**。
 *
 * 运行：npx tsx extensions/_test_ensure_dead_rebuild.ts
 *      （或 node --experimental-strip-types extensions/_test_ensure_dead_rebuild.ts）
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 隔离（env 先于 import；同既有测试纪律）
const ROOT = mkdtempSync(join(tmpdir(), "ensure-dead-env-"));
process.env.PI_RUNTIME_DIR = ROOT;
delete process.env.PI_SUBAGENT;
delete process.env.PI_TAB_RUN_ID;

import {
	acquireRuntimeLock,
	ensureRuntimeDaemon,
	lockPathFor,
	readRuntimeLock,
} from "./runtime-host/daemon-lifecycle.ts";
import { PROTOCOL_VERSION, readHostInfo } from "./runtime-host/discovery.ts";
import { runtimeIdForDir } from "./runtime-host/identity.ts";
import { isProcessAlive, probePidState } from "./runtime/liveness.ts";

const DIRS: string[] = [ROOT];
const sleepers: Array<ReturnType<typeof spawn>> = [];

function mkd(prefix: string): string {
	const d = mkdtempSync(join(tmpdir(), prefix));
	DIRS.push(d);
	return d;
}

function cleanup(): void {
	for (const c of sleepers) {
		try {
			c.kill();
		} catch {
			/* ignore */
		}
	}
	for (const d of DIRS) {
		try {
			rmrf(d);
		} catch {
			/* ignore */
		}
	}
}

import { rmSync as rmrf } from "node:fs";

/** host.json 夹具（pid 默认 = 已死的 999999；runtimeId 默认 = 该 tmp 目录的正确值）。 */
function hostFixture(dir: string, over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		instanceId: "host_fixture_dead",
		pid: 999999,
		port: 0,
		startedAt: new Date(Date.now() - 120_000).toISOString(),
		protocolVersion: PROTOCOL_VERSION,
		runtimeId: runtimeIdForDir(dir),
		...over,
	};
}

function writeHost(dir: string, data: Record<string, unknown>): void {
	writeFileSync(join(dir, "host.json"), JSON.stringify(data));
}

interface SpawnLog {
	calls: Array<{ serverPath: string; runtimeDir: string }>;
}

/** 注入假 spawn：记录调用 + 写一份「新实例」host.json（pid=本进程、端口=健康探针）供确权复用。 */
function fakeSpawnFor(dir: string, log: SpawnLog, healthPort: number) {
	return (o: { serverPath: string; runtimeDir: string }): { pid: number; kill: () => void } => {
		log.calls.push(o);
		writeHost(
			dir,
			hostFixture(dir, {
				instanceId: "host_rebuilt",
				pid: process.pid,
				port: healthPort,
				startedAt: new Date().toISOString(),
			}),
		);
		return { pid: process.pid, kill: () => {} };
	};
}

try {
	// ── 前置：夹具 pid 判死可信 ─────────────────────────────────────
	assert.equal(isProcessAlive(999999), false, "前置：pid=999999 应判 dead");
	assert.equal(isProcessAlive(999998), false, "前置：孤儿锁 pid=999998 应判 dead");

	// 内联健康探针（/v1/health 200 JSON）——供重建后的新 host.json 通过 classify
	const healthSrv = createServer((req, res) => {
		if (req.url === "/v1/health") {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ ok: true }));
		} else {
			res.statusCode = 404;
			res.end("{}");
		}
	});
	await new Promise<void>((r) => healthSrv.listen(0, "127.0.0.1", r));
	const healthyPort = (healthSrv.address() as AddressInfo).port;

	// 已关闭端口（探活必失败）——供 stale 夹具
	const closedSrv = createServer();
	await new Promise<void>((r) => closedSrv.listen(0, "127.0.0.1", r));
	const closedPort = (closedSrv.address() as AddressInfo).port;
	await new Promise<void>((r) => closedSrv.close(() => r()));

	try {
		// ── ① dead host.json（无锁）→ 持锁重建 ─────────────────────
		{
			const D = mkd("ensure-dead-1-");
			writeHost(D, hostFixture(D, { port: healthyPort }));
			const log: SpawnLog = { calls: [] };
			const r = await ensureRuntimeDaemon({
				hostPath: join(D, "host.json"),
				serverPath: join(D, "server.ts"),
				waitMs: 3000,
				spawn: fakeSpawnFor(D, log, healthyPort),
			});
			console.log(`① dead 无锁 → ok=${r.ok} uncertain=${r.uncertain ?? false} spawn=${log.calls.length} note=${r.note ?? "-"}`);
			assert.equal(r.ok, true, `① dead 应进入重建并成功：${r.error ?? ""}`);
			assert.notEqual(r.uncertain, true, "① 不再是 uncertain fail-closed");
			assert.equal(log.calls.length, 1, "① 注入 spawn 被调用一次");
			assert.ok(r.note && r.note.includes("僵尸") && r.note.includes("接管"), `① 回执含僵尸/接管：${r.note ?? ""}`);
			assert.ok(r.note!.includes("999999"), "① 回执标注原 dead pid");
			assert.equal(r.already, false, "① 重建非复用");
			assert.equal(readRuntimeLock(lockPathFor(join(D, "host.json"))), null, "① handoff 锁已释放");
		}

		// ── ①b dead host.json + 孤儿锁（持有人已死）→ 清僵尸锁后重建 ──
		{
			const D = mkd("ensure-dead-1b-");
			const hp = join(D, "host.json");
			writeHost(D, hostFixture(D, { port: healthyPort }));
			const ac = acquireRuntimeLock(lockPathFor(hp), {
				kind: "daemon",
				pid: 999998,
				instanceId: "host_fixture_dead",
				runtimeId: runtimeIdForDir(D),
				acquiredAt: new Date().toISOString(),
			});
			assert.equal(ac.acquired, true, "①b 前置：孤儿锁写入成功");
			const log: SpawnLog = { calls: [] };
			const r = await ensureRuntimeDaemon({
				hostPath: hp,
				serverPath: join(D, "server.ts"),
				waitMs: 3000,
				spawn: fakeSpawnFor(D, log, healthyPort),
			});
			console.log(`①b dead+孤儿锁 → ok=${r.ok} uncertain=${r.uncertain ?? false} spawn=${log.calls.length} error=${r.error ?? "-"} note=${r.note ?? "-"}`);
			assert.equal(r.ok, true, `①b 孤儿锁（持有人已死）应清锁后重建：${r.error ?? ""}`);
			assert.notEqual(r.uncertain, true, "①b 不再是 uncertain fail-closed");
			assert.equal(log.calls.length, 1, "①b 注入 spawn 被调用一次");
			assert.ok(r.note && r.note.includes("僵尸") && r.note.includes("接管"), `①b 回执含僵尸/接管：${r.note ?? ""}`);
		}

		// ── ② stale（pid 活但探活失败）→ 仍 uncertain，spawn 未被调用 ──
		{
			const D = mkd("ensure-dead-2-");
			const hp = join(D, "host.json");
			writeHost(D, hostFixture(D, { pid: process.pid, port: closedPort }));
			const log: SpawnLog = { calls: [] };
			const r = await ensureRuntimeDaemon({
				hostPath: hp,
				serverPath: join(D, "server.ts"),
				waitMs: 3000,
				spawn: fakeSpawnFor(D, log, healthyPort),
			});
			console.log(`② stale → ok=${r.ok} uncertain=${r.uncertain ?? false} spawn=${log.calls.length} error=${r.error ?? "-"}`);
			assert.equal(r.ok, false, "② stale 不 ok");
			assert.equal(r.uncertain, true, "② stale 仍 uncertain fail-closed");
			assert.equal(log.calls.length, 0, "② spawn 未被调用（不覆盖活 pid）");
			assert.ok((r.error ?? "").includes("host 超时"), `② 错误含 host 超时：${r.error ?? ""}`);
			assert.equal(readHostInfo(hp)?.instanceId, "host_fixture_dead", "② host.json 未被覆盖");
		}

		// ── ③ runtimeId 身份不符 → 仍 uncertain，spawn 未被调用 ──────
		{
			const D = mkd("ensure-dead-3-");
			const hp = join(D, "host.json");
			writeHost(D, hostFixture(D, { pid: process.pid, port: healthyPort, runtimeId: "rt_forged_otherdir" }));
			const log: SpawnLog = { calls: [] };
			const r = await ensureRuntimeDaemon({
				hostPath: hp,
				serverPath: join(D, "server.ts"),
				waitMs: 3000,
				spawn: fakeSpawnFor(D, log, healthyPort),
			});
			console.log(`③ runtimeId 不符 → ok=${r.ok} uncertain=${r.uncertain ?? false} spawn=${log.calls.length} error=${r.error ?? "-"}`);
			assert.equal(r.ok, false, "③ 身份不符不 ok");
			assert.equal(r.uncertain, true, "③ 身份不符仍 uncertain fail-closed");
			assert.equal(log.calls.length, 0, "③ spawn 未被调用");
			assert.ok((r.error ?? "").includes("身份不符"), `③ 错误含身份不符：${r.error ?? ""}`);
			assert.equal(readHostInfo(hp)?.instanceId, "host_fixture_dead", "③ host.json 未被覆盖");
		}

		// ── ④ dead host.json + 锁被活持有人占用 → fail-closed 不重建 ──
		{
			const D = mkd("ensure-dead-4-");
			const hp = join(D, "host.json");
			writeHost(D, hostFixture(D, { port: healthyPort }));
			const holder = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
			holder.unref();
			sleepers.push(holder);
			await new Promise((r) => setTimeout(r, 200));
			assert.ok(holder.pid && isProcessAlive(holder.pid), "④ 前置：活持有人存活");
			const ac = acquireRuntimeLock(lockPathFor(hp), {
				kind: "daemon",
				pid: holder.pid!,
				instanceId: "host_fixture_dead",
				runtimeId: runtimeIdForDir(D),
				acquiredAt: new Date().toISOString(),
			});
			assert.equal(ac.acquired, true, "④ 前置：活锁写入成功");
			const log: SpawnLog = { calls: [] };
			const r = await ensureRuntimeDaemon({
				hostPath: hp,
				serverPath: join(D, "server.ts"),
				waitMs: 3000,
				spawn: fakeSpawnFor(D, log, healthyPort),
			});
			console.log(`④ dead+活锁占用 → ok=${r.ok} uncertain=${r.uncertain ?? false} spawn=${log.calls.length} error=${r.error ?? "-"}`);
			assert.equal(r.ok, false, "④ 活锁占用不 ok");
			assert.equal(r.uncertain, true, "④ 仍 uncertain fail-closed");
			assert.equal(log.calls.length, 0, "④ spawn 未被调用（不因 host.json dead 重建）");
			assert.ok((r.error ?? "").includes("活锁占用"), `④ 错误含活锁占用：${r.error ?? ""}`);
			assert.ok(holder.pid && isProcessAlive(holder.pid), "④ 活持有人未被 kill");
			assert.equal(readHostInfo(hp)?.instanceId, "host_fixture_dead", "④ host.json 未被覆盖");
			const lock = readRuntimeLock(lockPathFor(hp));
			assert.ok(lock && lock.pid === holder.pid, "④ 活锁未被删/抢");
		}

		// ── ⑤–⑦ EPERM 家族（Windows：已终止但仍有句柄引用的 pid 也返回 EPERM）──
		// 根因：旧 isProcessAlive 把 EPERM 判成「活」⇒ classifyHost=stale ⇒ 永久 fail-closed
		//（实测 pid 6744：不在进程表、端口无监听，kill 仍 EPERM）⇒ 地基卡死。
		{
			// ⑤ EPERM + 进程表无此 pid + 端口无人应答 ⇒ dead ⇒ 必须能持锁重建（不再永久卡死）
			const D = mkd("ensure-eperm-5-");
			writeHost(D, hostFixture(D, { port: 1 })); // 1 号端口确定无人应答
			const log: SpawnLog = { calls: [] };
			const r = await ensureRuntimeDaemon({
				hostPath: join(D, "host.json"),
				serverPath: join(D, "server.ts"),
				waitMs: 3000,
				spawn: fakeSpawnFor(D, log, healthyPort),
				probePid: (pid) => (pid === process.pid ? { state: "alive", basis: "kill" } : { state: "dead", basis: "enumerate" }),
			});
			console.log(`⑤ EPERM+表无+端口空 → ok=${r.ok} uncertain=${r.uncertain ?? false} spawn=${log.calls.length} note=${r.note ?? "-"}`);
			assert.equal(r.ok, true, `⑤ 枚举确证 dead 应进入重建（EPERM 不再永久 fail-closed）：${r.error ?? ""}`);
			assert.equal(log.calls.length, 1, "⑤ 注入 spawn 被调用一次");
			assert.ok((r.note ?? "").includes("僵尸"), `⑤ 回执标注僵尸接管：${r.note ?? ""}`);
		}
		{
			// ⑥ 反例守卫：EPERM + 表无此 pid **但端口有人应答** ⇒ 不得认死、不得重建（防覆盖看不见的活 daemon）
			const D = mkd("ensure-eperm-6-");
			writeHost(D, hostFixture(D, { port: healthyPort }));
			const log: SpawnLog = { calls: [] };
			const r = await ensureRuntimeDaemon({
				hostPath: join(D, "host.json"),
				serverPath: join(D, "server.ts"),
				waitMs: 3000,
				spawn: fakeSpawnFor(D, log, healthyPort),
				probePid: (pid) => (pid === process.pid ? { state: "alive", basis: "kill" } : { state: "dead", basis: "enumerate" }),
			});
			console.log(`⑥ EPERM+表无+端口应答 → ok=${r.ok} uncertain=${r.uncertain ?? false} spawn=${log.calls.length} error=${r.error ?? "-"}`);
			assert.equal(r.ok, false, "⑥ 端口应答时不得重建");
			assert.equal(r.uncertain, true, "⑥ 仍 uncertain fail-closed");
			assert.equal(log.calls.length, 0, "⑥ spawn 未被调用");
			assert.equal(readHostInfo(join(D, "host.json"))?.instanceId, "host_fixture_dead", "⑥ host.json 未被覆盖");
		}
		{
			// ⑦ 无确证（unknown：枚举不可用/非 win32）⇒ 保持既有 fail-closed，不判死也不判活
			const D = mkd("ensure-eperm-7-");
			writeHost(D, hostFixture(D, { port: healthyPort }));
			const log: SpawnLog = { calls: [] };
			const r = await ensureRuntimeDaemon({
				hostPath: join(D, "host.json"),
				serverPath: join(D, "server.ts"),
				waitMs: 3000,
				spawn: fakeSpawnFor(D, log, healthyPort),
				probePid: () => ({ state: "unknown", basis: "unknown" }),
			});
			console.log(`⑦ unknown → ok=${r.ok} uncertain=${r.uncertain ?? false} spawn=${log.calls.length}`);
			assert.equal(r.ok, false, "⑦ unknown 不得重建");
			assert.equal(r.uncertain, true, "⑦ unknown 仍 uncertain");
			assert.equal(log.calls.length, 0, "⑦ spawn 未被调用");
		}
		{
			// ⑧ probePidState 单元矩阵（注入 kill/enumerate ⇒ 不依赖本机 pid 状况）
			const eperm = (): never => {
				const e = new Error("kill EPERM") as NodeJS.ErrnoException;
				e.code = "EPERM";
				throw e;
			};
			const esrch = (): never => {
				const e = new Error("kill ESRCH") as NodeJS.ErrnoException;
				e.code = "ESRCH";
				throw e;
			};
			assert.deepEqual(probePidState(123, { kill: () => {} }), { state: "alive", basis: "kill" }, "⑧ kill 成功 ⇒ alive/kill");
			assert.deepEqual(probePidState(123, { kill: esrch }), { state: "dead", basis: "kill" }, "⑧ ESRCH ⇒ dead/kill（不查表）");
			if (process.platform === "win32") {
				assert.deepEqual(probePidState(123, { kill: eperm, enumerate: () => false }), { state: "dead", basis: "enumerate" }, "⑧ EPERM+表无 ⇒ dead/enumerate");
				assert.deepEqual(probePidState(123, { kill: eperm, enumerate: () => true }), { state: "alive", basis: "enumerate" }, "⑧ EPERM+表有 ⇒ alive/enumerate");
				assert.deepEqual(probePidState(123, { kill: eperm, enumerate: () => undefined }), { state: "unknown", basis: "unknown" }, "⑧ EPERM+枚举不可用 ⇒ unknown");
			} else {
				assert.deepEqual(probePidState(123, { kill: eperm }), { state: "unknown", basis: "unknown" }, "⑧ 非 win32 EPERM ⇒ unknown（Unix 语义不变）");
			}
			assert.deepEqual(probePidState(0, { kill: () => {} }), { state: "dead", basis: "kill" }, "⑧ 非法 pid ⇒ dead");
			console.log("⑧ probePidState 矩阵全绿");
		}
		{
			// ⑨ 真实枚举（非注入）：钉住 tasklist 无匹配时退出码 1 的坑
			//（execFileSync 会抛 ⇒ 只能得 unknown；必须 spawnSync 读 stdout）
			if (process.platform === "win32") {
				const eperm = (): never => {
					const e = new Error("kill EPERM") as NodeJS.ErrnoException;
					e.code = "EPERM";
					throw e;
				};
				assert.deepEqual(probePidState(process.pid, { kill: eperm }), { state: "alive", basis: "enumerate" }, "⑨ 真实枚举：本进程在表中");
				assert.equal(probePidState(999999, { kill: eperm }).state, "dead", "⑨ 真实枚举：999999 不在表中 ⇒ dead（无匹配退出码 1 不影响）");
				console.log("⑨ 真实 tasklist 枚举双向全绿");
			}
		}

		{
			// ⑩ EPERM 僵尸锁：锁持有人 pid 被判「死」（严格探针）⇒ 必须进入「清僵尸锁后重建」
			//（真实事故形态：host.json.lock 仍记 pid 6744，旧 lockHolderAlive 判活 ⇒ 永久「活锁占用」）
			const D = mkd("ensure-eperm-10-");
			const hp = join(D, "host.json");
			writeHost(D, hostFixture(D, { port: 1 }));
			const ac = acquireRuntimeLock(lockPathFor(hp), {
				kind: "daemon",
				pid: 6744,
				instanceId: "host_eperm_zombie",
				runtimeId: runtimeIdForDir(D),
				acquiredAt: new Date().toISOString(),
			});
			assert.equal(ac.acquired, true, "⑩ 前置：僵尸锁写入成功");
			const log: SpawnLog = { calls: [] };
			const r = await ensureRuntimeDaemon({
				hostPath: hp,
				serverPath: join(D, "server.ts"),
				waitMs: 3000,
				spawn: fakeSpawnFor(D, log, healthyPort),
				// 6744 = EPERM 僵尸锁持有人、999999 = 僵尸 host.json（严格探针均判死）；新实例（pid=本进程）= 活
				probePid: (pid) =>
					pid === 6744 || pid === 999999 ? { state: "dead", basis: "enumerate" } : { state: "alive", basis: "kill" },
			});
			console.log(`⑩ EPERM 僵尸锁 → ok=${r.ok} uncertain=${r.uncertain ?? false} spawn=${log.calls.length} note=${r.note ?? "-"} error=${r.error ?? "-"}`);
			assert.equal(r.ok, true, `⑩ 僵尸锁应被清后重建（不再「活锁占用」卡死）：${r.error ?? ""}`);
			assert.equal(log.calls.length, 1, "⑩ 注入 spawn 被调用一次");
			assert.ok((r.note ?? "").includes("僵尸"), `⑩ 回执标注僵尸接管：${r.note ?? ""}`);
			assert.equal(readRuntimeLock(lockPathFor(hp)), null, "⑩ handoff 锁最终已释放");
		}

		console.log("_test_ensure_dead_rebuild: all assertions passed");
	} finally {
		await new Promise<void>((r) => healthSrv.close(() => r()));
	}
	cleanup();
} catch (e) {
	cleanup();
	console.error("_test_ensure_dead_rebuild FAILED:", e);
	process.exit(1);
}
