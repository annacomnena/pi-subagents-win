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
 *   T14 G6-P2 L4：非默认 sessionsDir 可列表可 POST（executor 存在性校验同源）；
 *      /v1/sessions 服务端权威 masterProtected（列表 flag + POST 真 403 同源）；
 *      host 启动扫 pending outbox：超 24h TTL → expired + journal message.expired 回执
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
import { attachMaster, attachmentPathFor, readAttachment } from "./runtime/registry.ts";
import { newEventEnvelope } from "./runtime/envelope.ts";
import { newEnvelopeId } from "./runtime/ids.ts";
import { masterAddress } from "./runtime/address.ts";
import { appendRuntimeEnvelope } from "./runtime/journal.ts";
import { listRuntimeEnvelopes } from "./runtime/journal.ts";
import { RUNTIME_SCHEMA_VERSION, verifyChallengeResponse } from "./runtime-host/identity.ts";
import { listOutboxItems, newOutboxItem, outboxDir, writeOutboxItem } from "./runtime/message-outbox.ts";
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

	// ── T13 stale 不覆盖（第一切片 fail-closed 回归，替代旧 L4 覆盖语义）：
	// pid 活但探活失败（PID 重用/陌生进程形状）→ uncertain，不复用、不重建、不 kill ───

	{
		const D = mkdtempDir("runtime-host-t13-");
		DIRS.push(D);
		const hp = join(D, "host.json");

		// 伪造 stale 形状：存活 pid（本进程，即 PID 重用形状）+ 探活必失败的端口 1 + 过期 startedAt
		const stale = mkHostInfo({ pid: process.pid, port: 1, startedAt: new Date(Date.now() - 120000).toISOString() });
		writeHostInfo(stale, hp);
		assert.equal(await classifyHost(stale, { timeoutMs: 500 }), "stale", "前置：pid 活、探活失败 → stale");

		// start 必须 fail-closed（不能回显“已在跑”，也不能覆盖活锁）
		const r = await startRuntimeHost({ hostPath: hp, waitMs: 5000 });
		assert.equal(r.started, false, "stale host → 不启动");
		assert.equal(r.already, undefined, "不得判 already");
		assert.equal(r.uncertain, true, "stale host → uncertain fail-closed");
		assert.ok(r.error && r.error.includes("fail-closed"), `回显 fail-closed 原因：${r.error ?? "无"}`);
		assert.equal(readHostInfo(hp)?.instanceId, stale.instanceId, "host.json 未被覆盖（活锁保护）");
		assert.ok(isProcessAlive(process.pid), "stale pid 未被 kill（不误杀）");

		// dead 僵尸仍可持锁重建（与 T12 同语义）：覆盖 stale 文件为 dead pid 后 start → 接管
		const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
		await new Promise<void>((r2) => {
			child.on("exit", () => r2());
			setTimeout(() => r2(), 5000);
		});
		writeHostInfo(mkHostInfo({ pid: child.pid, port: 1 }), hp);
		const r3 = await startRuntimeHost({ hostPath: hp, waitMs: 15000 });
		try {
			assert.equal(r3.started, true, "dead host → 持锁重建");
			assert.ok(r3.note && r3.note.includes("检测到僵尸，已接管"), `回显接管提示：${r3.note ?? "无"}`);
			assert.notEqual(r3.info?.instanceId, stale.instanceId, "新 instanceId（覆盖语义）");
			// 重建后重复 start → 回显现有（fresh 不重起）
			const r4 = await startRuntimeHost({ hostPath: hp });
			assert.equal(r4.started, false);
			assert.equal(r4.already, true, "fresh host 重复 start → 回显现有（不重起）");
			assert.equal(r4.info?.pid, r3.info!.pid, "同 pid（未重新 spawn）");
		} finally {
			if (r3.info && isProcessAlive(r3.info.pid)) {
				await stopRuntimeHost({ hostPath: hp }).catch(() => undefined);
			}
		}
	}

	// ── T14 G6-P2 L4 必修 3/4/2：非默认 sessionsDir 可列表可 POST；/v1/sessions 服务端权威
	// masterProtected；启动扫 pending outbox（TTL → expired + journal 回执）───────

	{
		const D = mkdtempDir("runtime-host-t14-");
		DIRS.push(D);
		// 前序 T1 已 attach sess-S（同 env 注册表）→ 物理清除 attachment，保证无 attachment 基线
		const prevAtt = readAttachment(masterAddress());
		if (prevAtt) rmSync(attachmentPathFor(masterAddress()), { force: true });
		const sessionsDirCustom = join(D, "sessions-custom"); // 有意 ≠ env PI_SESSIONS_DIR/缺省目录
		mkdirSync(sessionsDirCustom, { recursive: true });
		const sidCustom = "c1111111-2222-3333-4444-555555555555";
		writeFileSync(join(sessionsDirCustom, `2026-09-22T14-00-00-000Z_${sidCustom}.jsonl`),
			`{"type":"session","version":3,"id":"${sidCustom}","timestamp":"2026-09-22T14:00:00.000Z","cwd":"C:\\ws\\t14"}\n`, "utf8");
		const stateDir = join(D, "state");
		const journalPath = join(D, "events.jsonl");

		const h = await createRuntimeHostServer({
			hostPath: join(D, "host.json"),
			stateDir,
			journalPath,
			timersDir: join(D, "timers"),
			mailboxDir: join(D, "mailbox"),
			sessionsDir: sessionsDirCustom, // 非默认：executor 存在性校验必须同源（L4 必修 3）
		});
		try {
			const base = `http://127.0.0.1:${h.info.port}`;
			const post = async (body: unknown, tok: string): Promise<{ status: number; body: any }> => {
				const res = await fetch(`${base}/v1/commands`, {
					method: "POST",
					headers: { "content-type": "application/json", "x-command-token": tok },
					body: JSON.stringify(body),
				});
				return { status: res.status, body: await res.json() };
			};
			const sm = (commandKey: string, to: string) => ({
				frame: "command", type: "session.message", to, commandKey,
				issuedAt: new Date().toISOString(), payload: { text: "t14" },
			});

			// 可列表：非默认 sessionsDir 的会话出现在 /v1/sessions（修复前：读投影用自定义目录、
			// executor 用缺省目录 → 可见但 POST no-session，E2E 因 env 恰同而掩盖）
			const lst = await getJson(base, "/v1/sessions");
			assert.equal(lst.status, 200);
			const entry = (lst.body.sessions as any[]).find((s) => s.sessionId === sidCustom);
			assert.ok(entry, "非默认 sessionsDir 会话可列表");
			assert.equal(entry.masterProtected, undefined, "无 attachment → 非受保护");
			assert.equal(lst.body.masterProtectedSessionId, null);

			// 可 POST：session.message → accepted（修复前误判 no-session 404）
			const post1 = await post(sm("t14-post-1", `pi://${sidCustom}`), h.info.token);
			assert.equal(post1.status, 200, `非默认 sessionsDir POST accepted（实际 ${post1.status} ${JSON.stringify(post1.body)}）`);
			assert.equal(post1.body.status, "accepted");

			// 服务端权威 masterProtected：attach 后列表条目带 flag + 顶层 id；POST 该会话 → 真 403
			attachMaster({ sessionId: sidCustom, generation: 1 });
			const lst2 = await getJson(base, "/v1/sessions");
			const entry2 = (lst2.body.sessions as any[]).find((s) => s.sessionId === sidCustom);
			assert.equal(entry2.masterProtected, true, "服务端权威 masterProtected flag（executor 护栏同源）");
			assert.equal(lst2.body.masterProtectedSessionId, sidCustom);
			const post403 = await post(sm("t14-post-403", `pi://${sidCustom}`), h.info.token);
			assert.equal(post403.status, 403);
			assert.equal(post403.body.reason, "master-session-protected", "POST 真 403（与列表 flag 同源，非前端猜测）");
			// 还原注册表（T14 结束后不留 sidCustom attachment）
			rmSync(attachmentPathFor(masterAddress()), { force: true });

			// 启动扫（必修 2）：预置超龄 pending → 新 server 启动即转 expired + journal 回执
			const obDir = join(stateDir, "message-outbox");
			mkdirSync(obDir, { recursive: true });
			const old = newOutboxItem({
				dedupeKey: "session.message:t14-expired",
				commandKey: "t14-expired",
				to: `pi://${sidCustom}` as any,
				sessionId: sidCustom,
				text: "orphan",
				now: new Date(Date.now() - 25 * 60 * 60 * 1000), // 25h 前 → 超 24h TTL
			});
			writeOutboxItem(obDir, old);
			const h2 = await createRuntimeHostServer({
				hostPath: join(D, "host2.json"),
				stateDir,
				journalPath,
				timersDir: join(D, "timers"),
				mailboxDir: join(D, "mailbox"),
				sessionsDir: sessionsDirCustom,
			});
			try {
				const swept = JSON.parse(readFileSync(join(obDir, `${old.id}.json`), "utf8")) as { status: string; expiredBy?: string };
				assert.equal(swept.status, "expired", "host 启动扫：超龄 pending → expired（不留永久孤儿）");
				assert.equal(swept.expiredBy, "runtime-host");
				const evs = listRuntimeEnvelopes({ path: journalPath }).envelopes.filter((e) => e.type === "message.expired");
				assert.equal(evs.length, 1, "journal message.expired 回执一条");
				assert.equal((evs[0]!.payload as any).outboxId, old.id);
			} finally {
				await h2.close().catch(() => undefined);
			}
		} finally {
			await h.close().catch(() => undefined);
		}
	}
	// ── T15 第一切片：身份发布 + 挑战 + 静态托管 + 穿越拒绝 + 单实例锁 ───

	{
		const D = mkdtempDir("runtime-host-t15-");
		DIRS.push(D);
		const dist = join(D, "dist");
		mkdirSync(join(dist, "assets"), { recursive: true });
		writeFileSync(join(dist, "index.html"), "<!doctype html><html><body>t15-home</body></html>");
		writeFileSync(join(dist, "assets", "a.js"), "t15-asset-ok");
		writeFileSync(join(D, "secret.txt"), "t15-outside-secret");
		const hp = join(D, "host.json");
		const h = await createRuntimeHostServer({
			hostPath: hp,
			timersDir: join(D, "t"),
			mailboxDir: join(D, "m"),
			stateDir: join(D, "s"),
			journalPath: join(D, "e.jsonl"),
			distDir: dist,
		});
		try {
			const base = `http://127.0.0.1:${h.info.port}`;
			// 身份三件套随 host.json 原子发布
			assert.ok(h.info.runtimeId && h.info.releaseId && h.info.processStartIdentity, "T15① 身份字段发布");
			assert.equal(h.info.schemaVersion, RUNTIME_SCHEMA_VERSION, "T15② schemaVersion=1");
			assert.ok(h.info.token && h.info.token.length > 0, "T15③ token 落盘（同用户可读）");
			// 静态托管同源可用
			const pageRes = await fetch(`${base}/`);
			assert.equal(pageRes.status, 200, "T15④ GET / 200");
			assert.ok((await pageRes.text()).includes("t15-home"), "T15⑤ 首页为 dist 内容");
			const aRes = await fetch(`${base}/assets/a.js`);
			assert.equal(aRes.status, 200, "T15⑥ /assets/* 200");
			assert.ok((await aRes.text()).includes("t15-asset-ok"), "T15⑦ asset 内容正确");
			// /v1/* 永不 SPA fallback
			const nRes = await fetch(`${base}/v1/nope-t15`);
			assert.equal(nRes.status, 404, "T15⑧ 未知 /v1/* 404");
			assert.ok((nRes.headers.get("content-type") ?? "").includes("application/json"), "T15⑨ 404 为 JSON");
			assert.ok(!(await nRes.text()).includes("<html"), "T15⑩ 无 HTML 泄漏");
			// 匿名 health 无 token
			const hh = await getJson(base, "/v1/health");
			assert.equal((hh.body.host as any).token, undefined, "T15⑪ health 无 token");
			assert.equal(hh.body.host.runtimeId, h.info.runtimeId, "T15⑫ health runtimeId");
			// 穿越拒绝且无越界泄漏
			for (const p of ["/assets/%2e%2e/secret.txt", "/assets/%252e%252e/x"]) {
				const er = await fetch(`${base}${p}`);
				assert.ok([400, 403, 404].includes(er.status), `T15⑬ ${p} → ${er.status}`);
				assert.ok(!(await er.text()).includes("t15-outside-secret"), `T15⑭ ${p} 无泄漏`);
			}
			// 身份挑战往返
			const nonce = "t15-nonce-0123456789abcdef";
			const chRes = await fetch(`${base}/v1/challenge`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ nonce }),
			});
			assert.equal(chRes.status, 200, "T15⑮ challenge 200");
			const chBody = (await chRes.json()) as Record<string, unknown>;
			const meta = {
				instanceId: h.info.instanceId,
				runtimeId: h.info.runtimeId!,
				protocolVersion: PROTOCOL_VERSION,
				releaseId: h.info.releaseId!,
				schemaVersion: RUNTIME_SCHEMA_VERSION,
				processStartIdentity: h.info.processStartIdentity!,
			};
			assert.equal(verifyChallengeResponse(h.info.token, nonce, chBody, meta), true, "T15⑯ HMAC 本地可验");
			assert.equal((chBody as any).token, undefined, "T15⑰ 挑战回显不含 token");
			const badRes = await fetch(`${base}/v1/challenge`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ nonce: "x" }),
			});
			assert.equal(badRes.status, 400, "T15⑱ 坏 nonce 400");
			// 单实例锁：同 hostPath 再起 → 拒绝（不双跑）
			await assert.rejects(
				createRuntimeHostServer({ hostPath: hp, timersDir: join(D, "t2") }),
				/单实例锁/,
				"T15⑲ 同 hostPath 双跑被拒绝",
			);
		} finally {
			await h.close();
		}
	}

	// ── T16 0924：HTTP 请求体严格解码（GBK 还原；双重非法 → 400 且 outbox 零新增，
	//    plans/0924_remote_input_encoding_fix.md §4）──────────────────────────────
	{
		const D = mkdtempDir("runtime-host-t16-");
		DIRS.push(D);
		const stateDir = join(D, "s");
		const sessionsDir = join(D, "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		const sid = "a1111111-2222-3333-4444-555555555555";
		writeFileSync(join(sessionsDir, `2026-09-24T09-00-00-000Z_${sid}.jsonl`),
			`{"type":"session","version":3,"id":"${sid}","timestamp":"2026-09-24T09:00:00.000Z","cwd":"C:\\ws\\t16"}\n`, "utf8");
		const obDir = outboxDir(stateDir);
		const h = await createRuntimeHostServer({
			hostPath: join(D, "host.json"),
			stateDir,
			journalPath: join(D, "e.jsonl"),
			timersDir: join(D, "t"),
			mailboxDir: join(D, "m"),
			sessionsDir,
		});
		try {
			const base = `http://127.0.0.1:${h.info.port}`;
			// raw 字节 POST（无 charset 声明；GBK 体 = Windows curl -d 本 bug 复现形状）
			const postRaw = async (buf: Buffer, contentType: string): Promise<{ status: number; body: any }> => {
				const res = await fetch(`${base}/v1/commands`, {
					method: "POST",
					headers: { "content-type": contentType, "x-command-token": h.info.token },
					body: new Uint8Array(buf),
				});
				return { status: res.status, body: await res.json() };
			};
			const frameBytes = (commandKey: string, textBytes: Buffer): Buffer =>
				Buffer.concat([
					Buffer.from(`{"frame":"command","type":"session.message","to":"pi://${sid}","commandKey":"${commandKey}","issuedAt":"${new Date().toISOString()}","payload":{"text":"`, "utf8"),
					textBytes,
					Buffer.from(`"}}`, "utf8"),
				]);

			// (a) GBK 字节（本 bug 复现字节）POST → 200 + outbox text 为正确中文（无 U+FFFD）
			const gbkText = Buffer.from("28d6f7bbe1bbb0c1b4c2b7d7d4bceca3babfc9baf6c2d429", "hex");
			const rGbk = await postRaw(frameBytes("t16-gbk", gbkText), "application/json");
			assert.equal(rGbk.status, 200, `GBK 体 POST 200（实际 ${rGbk.status} ${JSON.stringify(rGbk.body)}）`);
			assert.equal(rGbk.body.status, "accepted");
			const item = listOutboxItems(obDir).find((it) => it.commandKey === "t16-gbk");
			assert.ok(item, "GBK 体正确解码落盘（修复前会烧 U+FFFD 落盘）");
			assert.equal(item.text, "(主会话链路自检：可忽略)", "outbox text 为正确中文");
			assert.ok(!item.text.includes("\uFFFD"), "无 U+FFFD");

			// (b) 双重非法字节（28 ff 29：既非合法 UTF-8 也非合法 GB18030）POST →
			//     400 invalid-encoding 且 outbox 目录零新增（fail-closed 不写盘）
			const before = readdirSync(obDir).sort();
			const commandsDir = join(stateDir, "commands");
			const commandsBefore = existsSync(commandsDir) ? readdirSync(commandsDir).sort() : [];
			const rBad = await postRaw(frameBytes("t16-bad", Buffer.from([0x28, 0xff, 0x29])), "application/json");
			assert.equal(rBad.status, 400, `双重非法体 400（实际 ${rBad.status} ${JSON.stringify(rBad.body)}）`);
			assert.equal(rBad.body.error, "invalid-encoding", "400 error=invalid-encoding");
			assert.deepEqual(readdirSync(obDir).sort(), before, "outbox 目录零新增（拒收不落盘）");
			assert.deepEqual(existsSync(commandsDir) ? readdirSync(commandsDir).sort() : [], commandsBefore, "commands 状态目录零新增（拒收不落盘）");
		} finally {
			await h.close();
		}
	}
} finally {
	for (const d of DIRS) {
		rmSync(d, { recursive: true, force: true });
	}
}

console.log("_test_runtime_host_server: all assertions passed");
