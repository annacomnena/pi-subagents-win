/**
 * _test_runtime_host_server.ts — G2 测试（runtime-host 事件流 + 健康发现，
 * plans/0920_G2_eventstream_plan.md §5 + 主会话拍板①-④：动态端口 / 仅 slash 命令 /
 * 无 SSE / health 含 mailbox 只读计数）
 *
 * 覆盖：
 *   T1 /v1/health 契约：无 attachment → masterOwnerAlive=null；attachment+14s 心跳 → true；
 *      16s → false；sessionHeartbeats 与 sessions/ 目录一致；journalTail/mailboxPending/
 *      generatedAt/host.protocolVersion 字段齐全
 *   T2 心跳新鲜度边界：14999ms → alive；15000ms → stale（对齐 SESSION_HEARTBEAT_GRACE_MS）
 *   T3 /v1/snapshot 契约：= G1 RuntimeSnapshot 且 runtime.host 非 null（pid/startedAt 注入，
 *      snapshot.ts 零 diff）
 *   T4 /v1/events 分页：排他下界（after=<idN> 只含其后）、after=0/缺省从头、type/limit 透传
 *   T5 /v1/events 409：after=<不存在 id> → {reason:"cursor-invalid",resync:true}；
 *      journal 文件缺失 → 同 409 路径
 *   T6 增量语义：journal 追加新行后下一 poll 含新行、不含旧行（cursor 前进）
 *   T7 dedupe 消费端：同 cursor 重取结果一致，消费端可按 id 幂等去重（服务端不存位点）
 *   T8 discovery 三态：alive（真 server）/ stale（pid 活、探活失败）/ dead（僵尸 host.json）
 *   T9 host.json 原子写完整可解析 + 独立进程 SIGINT 优雅退出删除 host.json
 *   T10 never-throw：journal 坏行 / sessions 目录缺失 / mailbox 缺失 → /v1/* 全 200 降级；
 *      未知路径 404 JSON
 *   T11 start/stop 往返：start 派生进程 + host.json 就绪 + health OK；重复 start 回显现有；
 *      stop 杀进程 + 清 host.json（僵尸可清）；stop 未启动 → reason
 *   T12 僵尸覆盖：dead-pid 的 host.json 被新实例 start 后原子覆盖（新 startedAt/instanceId）
 *   T13 stale 接管（L4 必修回归）：pid 活但探活失败（PID 重用形状，含过期 startedAt）的
 *      host.json，start → 覆盖成功（非回显）+ note「检测到僵尸，已接管」+ health 可达；
 *      另：fresh host 重复 start → 回显现有不重起（T11 r2 断言保留）
 *
 * 运行：npm run test:runtime-host-server
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync, mkdirSync, rmSync, readFileSync, readdirSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

process.env.PI_RUNTIME_DIR = mkdtempDir("runtime-host-test-main-");
const ROOT = process.env.PI_RUNTIME_DIR!;

import {
	PROTOCOL_VERSION,
	classifyHost,
	hostInfoPath,
	isProcessAlive,
	readHostInfo,
	writeHostInfo,
	type HostInfo,
} from "./runtime-host/discovery.ts";
import {
	buildHealthView,
	buildSnapshotView,
	createRuntimeHostServer,
	readEventsAfter,
	runtimeHostStatus,
	startRuntimeHost,
	stopRuntimeHost,
	type RuntimeHostHandle,
} from "./runtime-host/server.ts";
import { attachMaster } from "./runtime/registry.ts";
import { newEventEnvelope } from "./runtime/envelope.ts";
import { newEnvelopeId } from "./runtime/ids.ts";
import { masterAddress } from "./runtime/address.ts";
import { appendRuntimeEnvelope } from "./runtime/journal.ts";
import { deliverLetter } from "./runtime/mailbox.ts";
import { newMessageFrame } from "./runtime/protocol.ts";
import { SESSION_HEARTBEAT_GRACE_MS, touchSessionHeartbeat } from "./timers.ts";

const SERVER_TS = join(dirname(fileURLToPath(import.meta.url)), "runtime-host", "server.ts");

// ── helpers ─────────────────────────────────────────────────────────

function mkdtempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

function mkHostInfo(over: Partial<HostInfo> = {}): HostInfo {
	const now = new Date();
	return {
		instanceId: over.instanceId ?? `host_${now.getTime().toString(36)}_test`,
		pid: over.pid ?? process.pid,
		port: over.port ?? 1,
		startedAt: over.startedAt ?? now.toISOString(),
		protocolVersion: PROTOCOL_VERSION,
	};
}

async function getJson(base: string, path: string): Promise<{ status: number; body: any }> {
	const res = await fetch(`${base}${path}`);
	const text = await res.text();
	let body: unknown = null;
	try {
		body = text.length > 0 ? JSON.parse(text) : null;
	} catch {
		body = { __raw: text };
	}
	return { status: res.status, body };
}

function writeEnv(dir: string, type: string, subject: string, at: string): ReturnType<typeof newEventEnvelope> {
	const env = newEventEnvelope({ type, source: masterAddress(), subject, at });
	appendRuntimeEnvelope(env, join(dir, "events.jsonl"));
	return env;
}

async function waitExit(pid: number, timeoutMs: number): Promise<boolean> {
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		if (!isProcessAlive(pid)) return true;
		await new Promise((r) => setTimeout(r, 100));
	}
	return !isProcessAlive(pid);
}

const DIRS: string[] = [ROOT];

try {
	// ── T1-T3/T4-T7/T10：主 server（路径全注入 temp 目录）────────────────

	const D = mkdtempDir("runtime-host-t1-");
	DIRS.push(D);
	const hostPath = join(D, "host.json");
	const timersDir = join(D, "timers");
	const mailboxDir = join(D, "mailbox");
	const journalPath = join(D, "events.jsonl");
	mkdirSync(join(timersDir, "sessions"), { recursive: true });

	const h = await createRuntimeHostServer({
		hostPath,
		timersDir,
		stateDir: join(D, "state"),
		mailboxDir,
		journalPath,
	});
	const base = `http://127.0.0.1:${h.info.port}`;
	try {
		// T1 无 attachment：master 段全空态
		{
			const r = await getJson(base, "/v1/health");
			assert.equal(r.status, 200, "health 200");
			assert.equal(r.body.version, 1);
			// G6-P1：host.json 含本机 token，但 token 绝不进 HTTP 响应（剥密后比对）
			const { token: _wsToken, ...hostInfoPublic } = h.info;
			assert.equal(_wsToken === undefined || typeof _wsToken === "string", true);
			assert.deepEqual(r.body.host, { ...hostInfoPublic, protocolVersion: PROTOCOL_VERSION }, "host 自信息 + protocolVersion（无 token）");
			assert.equal((r.body.host as any).token, undefined, "token 绝不泄漏进 /v1/* 响应");
			assert.equal(r.body.master.attachment, null);
			assert.equal(r.body.master.cutover, false);
			assert.equal(r.body.masterOwnerAlive, null, "无 attachment → null（未 attach = legacy）");
			assert.deepEqual(r.body.sessionHeartbeats, []);
			assert.deepEqual(r.body.journalTail, { lastEnvelopeAt: null, lastRecordedAt: null, totalEvents: 0 });
			assert.equal(r.body.mailboxPending, 0);
			assert.ok(!Number.isNaN(Date.parse(r.body.generatedAt)), "generatedAt 合法 ISO");
		}
		// T1 有 attachment + 新鲜心跳（14s）→ alive=true；mailbox 计数（拍板④）
		{
			const t = new Date();
			attachMaster({ sessionId: "sess-S", now: t });
			touchSessionHeartbeat(timersDir, "sess-S", new Date(t.getTime() - 14000));
			const e1 = writeEnv(D, "run.dispatched", "run://tab/tab_s1", "2026-09-20T10:00:00.000Z");
			const e2 = writeEnv(D, "run.completed", "run://tab/tab_s1", "2026-09-20T10:05:00.000Z");
			const e3 = writeEnv(D, "run.dispatched", "run://tab/tab_s2", "2026-09-20T10:10:00.000Z");
			deliverLetter(
				newMessageFrame({
					id: newEnvelopeId("msg"), kind: "REPORT", from: "agent://a", to: masterAddress(),
					subject: "run://tab/tab_s1", sentAt: "2026-09-20T10:06:00.000Z", summary: "pend",
				}),
				{ mailboxDir },
			);

			const r = await getJson(base, "/v1/health");
			assert.equal(r.status, 200);
			assert.equal(r.body.master.attachment.sessionId, "sess-S", "owner sessionId 透传");
			assert.ok(r.body.master.attachment.generation >= 1, "代际透传");
			assert.equal(r.body.masterOwnerAlive, true, "14s 心跳 → alive（活性来自 sessions/ 心跳，非 lastHeartbeatAt）");
			assert.equal(r.body.sessionHeartbeats.length, 1);
			assert.equal(r.body.sessionHeartbeats[0].sessionId, "sess-S");
			assert.equal(r.body.sessionHeartbeats[0].alive, true);
			assert.equal(r.body.journalTail.totalEvents, 3);
			assert.equal(r.body.journalTail.lastEnvelopeAt, e3.at);
			assert.equal(r.body.mailboxPending, 1, "mailbox 只读 pending 计数（拍板④）");
			// 目录一致性：sessions/ 下 .json 文件数 == 返回条数
			const files = readdirSync(join(timersDir, "sessions")).filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"));
			assert.equal(files.length, r.body.sessionHeartbeats.length, "sessionHeartbeats 与 sessions/ 目录一致");
		}
		// T1 心跳 16s → stale（false，非崩溃：tab/subagent 不写此心跳）
		{
			const t = new Date();
			touchSessionHeartbeat(timersDir, "sess-S", new Date(t.getTime() - 16000));
			const r = await getJson(base, "/v1/health");
			assert.equal(r.body.masterOwnerAlive, false, "16s → stale（false）");
			assert.equal(r.body.sessionHeartbeats[0].alive, false);
		}

		// T2 新鲜度边界：14999ms → alive；15000ms → stale
		{
			const now = new Date();
			touchSessionHeartbeat(timersDir, "sess-S", new Date(now.getTime() - 14999));
			const a = buildHealthView({ host: h.info, timersDir, journalPath, mailboxDir, now });
			assert.equal(a.masterOwnerAlive, true, `14999ms < ${SESSION_HEARTBEAT_GRACE_MS} → alive`);
			touchSessionHeartbeat(timersDir, "sess-S", new Date(now.getTime() - 15000));
			const b = buildHealthView({ host: h.info, timersDir, journalPath, mailboxDir, now });
			assert.equal(b.masterOwnerAlive, false, `15000ms = grace → stale（< 判定排他）`);
			// 复原新鲜心跳（后续 T3 快照断言不依赖它，仅保持目录一致）
			touchSessionHeartbeat(timersDir, "sess-S", now);
		}

		// T3 /v1/snapshot：G1 契约 + host 注入
		{
			const r = await getJson(base, "/v1/snapshot");
			assert.equal(r.status, 200);
			assert.equal(r.body.version, 1);
			assert.deepEqual(Object.keys(r.body).sort(),
				["attention", "generatedAt", "master", "runs", "runtime", "sectionErrors", "tasks", "timeline", "version", "workstreams"].sort(),
				"= G1 RuntimeSnapshot 字段集（契约零改动）");
			assert.notEqual(r.body.runtime.host, null, "runtime.host 非 null（G1 预留位注入）");
			assert.equal(r.body.runtime.host.pid, process.pid, "pid = server 进程 pid");
			assert.equal(r.body.runtime.host.startedAt, h.info.startedAt);
			assert.equal(r.body.runtime.counts.pendingMailbox, 1, "G1 段（mailbox 计数复用）");
			assert.equal(r.body.master.attachment.sessionId, "sess-S");
			assert.ok(Array.isArray(r.body.sectionErrors));
			// 纯函数直调（不经 HTTP）同契约
			const s = buildSnapshotView({ ...h.info, stateDir: join(D, "state"), mailboxDir, journalPath, now: new Date("2026-09-20T11:00:00.000Z") });
			assert.equal(s.runtime.host.pid, process.pid);
			assert.equal(s.generatedAt, "2026-09-20T11:00:00.000Z", "now 注入确定性");
		}

		// T4 /v1/events 分页 + 排他下界 + type/limit 透传
		{
			const all = await getJson(base, "/v1/events");
			assert.equal(all.status, 200);
			assert.equal(all.body.count, 3);
			const ids = all.body.envelopes.map((e: any) => e.id);
			assert.equal(ids.length, 3);
			assert.equal(all.body.nextCursor, ids[2], "nextCursor = 最后一条 id");

			const after2 = await getJson(base, `/v1/events?after=${ids[1]}`);
			assert.deepEqual(after2.body.envelopes.map((e: any) => e.id), [ids[2]], "排他下界：after=<id2> 只含其后");
			assert.equal(after2.body.after, ids[1]);

			const from0 = await getJson(base, "/v1/events?after=0");
			assert.equal(from0.body.count, 3, "after=0 = 从头");
			const def = await getJson(base, "/v1/events");
			assert.equal(def.body.count, 3, "缺省 after = 从头");

			const onlyCompleted = await getJson(base, "/v1/events?type=run.completed");
			assert.equal(onlyCompleted.body.count, 1, "type 透传");
			assert.equal(onlyCompleted.body.envelopes[0].type, "run.completed");

			const lim1 = await getJson(base, "/v1/events?limit=1");
			assert.deepEqual(lim1.body.envelopes.map((e: any) => e.id), [ids[0]], "limit 从 cursor 后向前取");
			assert.equal(lim1.body.nextCursor, ids[0], "客户端据此前进");
			const lim1after = await getJson(base, `/v1/events?after=${ids[0]}&limit=1`);
			assert.deepEqual(lim1after.body.envelopes.map((e: any) => e.id), [ids[1]], "limit+after 组合");
		}

		// T5 409：cursor 不存在 / journal 缺失
		{
			const bad = await getJson(base, "/v1/events?after=evt_does_not_exist");
			assert.equal(bad.status, 409, "cursor 失效 → 409");
			assert.equal(bad.body.reason, "cursor-invalid");
			assert.equal(bad.body.resync, true, "重同步指引");
			assert.ok(typeof bad.body.hint === "string" && bad.body.hint.includes("/v1/snapshot"), "hint 指向 snapshot 重同步");

			const D2 = mkdtempDir("runtime-host-nj-");
			DIRS.push(D2);
			const h2 = await createRuntimeHostServer({ hostPath: join(D2, "host.json"), journalPath: join(D2, "nope.jsonl"), timersDir: join(D2, "timers"), mailboxDir: join(D2, "m"), stateDir: join(D2, "state") });
			try {
				const r = await getJson(`http://127.0.0.1:${h2.info.port}`, "/v1/events?after=evt_x");
				assert.equal(r.status, 409, "journal 文件缺失 → 同 409 路径");
				assert.equal(r.body.resync, true);
				// 同 server 的 after=0/缺省 → 200 空集（非 409）
				const ok = await getJson(`http://127.0.0.1:${h2.info.port}`, "/v1/events");
				assert.equal(ok.status, 200);
				assert.equal(ok.body.count, 0);
			} finally {
				await h2.close();
			}
		}

		// T6 增量语义：追加后下一 poll 含新行、不含旧行
		{
			const ids = (await getJson(base, "/v1/events")).body.envelopes.map((e: any) => e.id);
			const after3 = await getJson(base, `/v1/events?after=${ids[2]}`);
			assert.equal(after3.body.count, 0, "cursor 停在尾部 → 空");
			writeEnv(D, "run.completed", "run://tab/tab_s2", "2026-09-20T10:20:00.000Z");
			const again = await getJson(base, `/v1/events?after=${ids[2]}`);
			assert.equal(again.body.count, 1, "追加后 poll 到新行");
			assert.deepEqual(again.body.envelopes.map((e: any) => e.subject), ["run://tab/tab_s2"]);
			for (const old of ids) {
				assert.ok(!again.body.envelopes.some((e: any) => e.id === old), "不含旧行");
			}
			assert.equal(again.body.nextCursor, again.body.envelopes[0].id, "cursor 前进");
		}

		// T7 dedupe 消费端：同 cursor 重取一致，可按 id 幂等去重
		{
			const ids = (await getJson(base, "/v1/events")).body.envelopes.map((e: any) => e.id);
			const r1 = await getJson(base, `/v1/events?after=${ids[0]}`);
			const r2 = await getJson(base, `/v1/events?after=${ids[0]}`);
			assert.deepEqual(r2.body.envelopes.map((e: any) => e.id), r1.body.envelopes.map((e: any) => e.id), "服务端无状态：同 cursor 重取结果一致");
			// 消费端幂等去重：单次响应内 id 唯一；cursor 回退重放后，Set 去重后新增长度 = 0（同 id 同内容）
			const seen = new Set<string>();
			for (const e of r1.body.envelopes) {
				assert.ok(!seen.has(e.id), "单次响应内 envelope id 唯一");
				seen.add(e.id);
			}
			let added = 0;
			for (const e of r2.body.envelopes) {
				if (!seen.has(e.id)) added += 1;
				else assert.deepEqual(e, r1.body.envelopes.find((x: any) => x.id === e.id), "同 id 同内容（幂等去重语义成立）");
			}
			assert.equal(added, 0, "重放不产生新 envelope（消费端可按 id 幂等）");
		}

		// T10 never-throw：坏行/缺目录 → 200 降级；未知路径 404
		{
			const D3 = mkdtempDir("runtime-host-nt-");
			DIRS.push(D3);
			writeFileSync(join(D3, "events.jsonl"), "not-json\n{\"version\":9}\n", "utf8"); // 两行坏
			const h3 = await createRuntimeHostServer({ hostPath: join(D3, "host.json"), journalPath: join(D3, "events.jsonl"), timersDir: join(D3, "no-such-timers"), mailboxDir: join(D3, "no-such-mbox"), stateDir: join(D3, "no-such-state") });
			try {
				const hH = await getJson(`http://127.0.0.1:${h3.info.port}`, "/v1/health");
				assert.equal(hH.status, 200, "坏行 + 缺目录 → health 仍 200");
				assert.equal(hH.body.journalTail.totalEvents, 0, "坏行不计入（tolerant read）");
				assert.deepEqual(hH.body.sessionHeartbeats, []);
				assert.equal(hH.body.mailboxPending, 0, "mailbox 缺失 → 0（never-throw 包裹）");
				const hS = await getJson(`http://127.0.0.1:${h3.info.port}`, "/v1/snapshot");
				assert.equal(hS.status, 200);
				assert.equal(hS.body.runtime.journal.skippedBadLines, 2, "G1 tolerant 计数透传");
				const hE = await getJson(`http://127.0.0.1:${h3.info.port}`, "/v1/events");
				assert.equal(hE.status, 200);
				assert.equal(hE.body.count, 0);
				const nf = await getJson(`http://127.0.0.1:${h3.info.port}`, "/v1/nope");
				assert.equal(nf.status, 404);
				assert.equal(nf.body.error, "not-found");
			} finally {
				await h3.close();
			}
		}
	} finally {
		await h.close();
	}

	// ── T8 discovery 三态 ─────────────────────────────────────────────

	{
		const D = mkdtempDir("runtime-host-t8-");
		DIRS.push(D);
		const hp = join(D, "host.json");
		const h = await createRuntimeHostServer({ hostPath: hp, journalPath: join(D, "e.jsonl"), timersDir: join(D, "t"), mailboxDir: join(D, "m"), stateDir: join(D, "s") });
		try {
			// alive：真 server
			const info = readHostInfo(hp)!;
			assert.ok(info, "host.json 存在");
			assert.equal(await classifyHost(info), "alive");
			const st = await runtimeHostStatus({ hostPath: hp });
			assert.equal(st.state, "alive");
			assert.equal((st.health as any).version, 1, "status 回显 health 体");
		} finally {
			await h.close();
		}
		// stale：pid 活（本进程）+ 探活失败（端口 1 必 ECONNREFUSED）
		{
			const stale = mkHostInfo({ pid: process.pid, port: 1 });
			writeHostInfo(stale, hp);
			assert.equal(await classifyHost(stale, { timeoutMs: 500 }), "stale", "pid 在、探活失败 → stale");
		}
		// dead：僵尸 host.json（短命子进程退出后 pid 不再存活）
		{
			const child = spawn(process.execPath, ["-e", "setTimeout(()=>process.exit(0),100)"], { stdio: "ignore" });
			const exited = await new Promise<boolean>((r) => {
				child.on("exit", () => r(true));
				setTimeout(() => r(false), 5000);
			});
			assert.ok(exited, "子进程正常退出");
			const zombie = mkHostInfo({ pid: child.pid, port: 9 });
			writeHostInfo(zombie, hp);
			assert.equal(await classifyHost(zombie, { timeoutMs: 500 }), "dead", "僵尸文件 → dead（不盲信文件，risk4 验收锚点）");
			const st = await runtimeHostStatus({ hostPath: hp, timeoutMs: 500 });
			assert.equal(st.state, "dead");
			// 僵尸可被 stop 清理
			const stop = await stopRuntimeHost({ hostPath: hp });
			assert.equal(stop.stopped, true);
			assert.equal(readHostInfo(hp), null, "stop 清僵尸 host.json");
		}
	}

	// ── T9 host.json 原子写 + 独立进程 SIGINT 优雅删除 ─────────────────

	{
		const D = mkdtempDir("runtime-host-t9-");
		DIRS.push(D);
		const hp = join(D, "host.json");
		// 原子写：tmp+rename 后完整可解析
		const info = mkHostInfo({ port: 4141 });
		assert.equal(writeHostInfo(info, hp), true);
		const back = readHostInfo(hp);
		assert.deepEqual(back, info, "写后完整回读一致");
		assert.ok(!readdirSync(D).some((f) => f.endsWith(".tmp")), "无残留 tmp");

			// 独立进程 SIGINT → 优雅退出 + host.json 删除
	const child = spawn(process.execPath, ["--experimental-strip-types", SERVER_TS], { stdio: "ignore", env: { ...process.env } });
	const t0 = Date.now();
	while (Date.now() - t0 < 15000 && !existsSync(hp)) {
		if (child.pid !== undefined && !isProcessAlive(child.pid)) break; // 提前崩溃
		await new Promise((r) => setTimeout(r, 100));
	}
	assert.ok(existsSync(hp), "独立进程写盘 host.json（未提前崩溃）");
	const sig = process.platform === "win32" ? ("SIGINT" as NodeJS.Signals) : ("SIGTERM" as NodeJS.Signals);
	child.kill(sig);
	const exited = await waitExit(child.pid!, 10000);
	assert.ok(exited, `独立进程已退出（code=${child.exitCode}）`);
	// unix：SIGTERM 走 JS handler → 优雅删 host.json；Windows：kill 信号 = TerminateProcess（硬终止，
	// JS handler 不跑，文件残留属预期僵尸语义——由 /runtime-host stop 清理，T8/T11 已覆盖）。
	if (process.platform !== "win32") {
		assert.ok(!existsSync(hp), "SIGTERM 后 host.json 已删（优雅清理）");
	}
	}

	// ── T11/T12 start/stop 往返 + 僵尸覆盖 ───────────────────────────

	{
		const D = mkdtempDir("runtime-host-t11-");
		DIRS.push(D);
		const hp = join(D, "host.json");

		// T12 前置：写一个僵尸 host.json（dead pid）
		const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
		await new Promise<void>((r) => {
			child.on("exit", () => r());
			setTimeout(() => r(), 5000);
		});
		const zombie = mkHostInfo({ pid: child.pid, port: 1, startedAt: new Date(Date.now() - 60000).toISOString() });
		writeHostInfo(zombie, hp);

		// start 应覆盖僵尸并起真进程
		const r1 = await startRuntimeHost({ hostPath: hp, waitMs: 15000 });
		try {
			assert.equal(r1.error, undefined, `start 无错：${r1.error ?? ""}`);
			assert.equal(r1.started, true, "僵尸文件被新实例覆盖（非回显）");
			assert.equal(r1.already, undefined);
			assert.ok(r1.note && r1.note.includes("检测到僵尸，已接管"), `dead 僵尸覆盖也回显接管：${r1.note ?? "无"}`);
			const fresh = r1.info!;
			assert.notEqual(fresh.instanceId, zombie.instanceId, "新 instanceId（覆盖语义）");
			assert.ok(fresh.startedAt >= zombie.startedAt, "新 startedAt（poll 按时间戳区分新旧）");
			assert.ok(isProcessAlive(fresh.pid), "新进程存活");
			const health = await getJson(`http://127.0.0.1:${fresh.port}`, "/v1/health");
			assert.equal(health.status, 200, "新实例 health 可达");
			assert.equal(health.body.host.port, fresh.port, "端口动态（127.0.0.1:0 实际值写 host.json，拍板①）");

			// 重复 start → 回显现有（不重复 spawn）
			const r2 = await startRuntimeHost({ hostPath: hp });
			assert.equal(r2.started, false);
			assert.equal(r2.already, true, "已在跑 → 回显现有");
			assert.equal(r2.info?.pid, fresh.pid, "同 pid（未重新 spawn）");

			// T11 stop：杀进程 + 清 host.json
			const st = await runtimeHostStatus({ hostPath: hp, timeoutMs: 2000 });
			assert.equal(st.state, "alive", "stop 前 status=alive");
			const r3 = await stopRuntimeHost({ hostPath: hp });
			assert.equal(r3.stopped, true);
			assert.equal(r3.info?.pid, fresh.pid);
			assert.equal(readHostInfo(hp), null, "host.json 已清理");
			assert.ok(await waitExit(fresh.pid, 5000), "进程已退出");

			// stop 未启动 → reason
			const r4 = await stopRuntimeHost({ hostPath: hp });
			assert.equal(r4.stopped, false);
			assert.ok(r4.reason, "带 reason");
			// status 未启动 → missing
			const st2 = await runtimeHostStatus({ hostPath: hp });
			assert.equal(st2.state, "missing");
		} finally {
			if (r1.info && isProcessAlive(r1.info.pid)) {
				await stopRuntimeHost({ hostPath: hp }).catch(() => undefined);
			}
		}
	}

	// ── T13 stale 接管（L4 必修回归）：pid 活但探活失败 ≠ “已在跑” ────────────

	{
		const D = mkdtempDir("runtime-host-t13-");
		DIRS.push(D);
		const hp = join(D, "host.json");

		// 伪造 stale 形状：存活 pid（本进程，即 PID 重用形状）+ 探活必失败的端口 1 + 过期 startedAt
		const stale = mkHostInfo({ pid: process.pid, port: 1, startedAt: new Date(Date.now() - 120000).toISOString() });
		writeHostInfo(stale, hp);
		assert.equal(await classifyHost(stale, { timeoutMs: 500 }), "stale", "前置：pid 活、探活失败 → stale");

		// start 必须覆盖启动（不能回显“已在跑”）
		const r = await startRuntimeHost({ hostPath: hp, waitMs: 15000 });
		try {
			assert.equal(r.error, undefined, `start 无错：${r.error ?? ""}`);
			assert.equal(r.started, true, "stale host → 覆盖启动（非回显）");
			assert.equal(r.already, undefined, "不得判 already");
			assert.ok(r.note && r.note.includes("检测到僵尸，已接管"), `回显接管提示：${r.note ?? "无"}`);
			assert.notEqual(r.info?.instanceId, stale.instanceId, "新 instanceId（覆盖语义）");
			assert.notEqual(r.info?.pid, stale.pid, "新 pid（未被旧 pid 形状误导）");
			assert.ok(isProcessAlive(r.info!.pid), "新进程存活");
			const health = await getJson(`http://127.0.0.1:${r.info!.port}`, "/v1/health");
			assert.equal(health.status, 200, "新实例 health 可达");
			assert.equal((health.body.host as any).instanceId, r.info!.instanceId, "health 回显 = 新实例");

			// 覆盖后重复 start → 回显现有（fresh 不重起）
			const r2 = await startRuntimeHost({ hostPath: hp });
			assert.equal(r2.started, false);
			assert.equal(r2.already, true, "fresh host 重复 start → 回显现有（不重起）");
			assert.equal(r2.info?.pid, r.info!.pid, "同 pid（未重新 spawn）");
		} finally {
			if (r.info && isProcessAlive(r.info.pid)) {
				await stopRuntimeHost({ hostPath: hp }).catch(() => undefined);
			}
		}
	}
} finally {
	for (const d of DIRS) {
		rmSync(d, { recursive: true, force: true });
	}
}

console.log("_test_runtime_host_server: all assertions passed");
