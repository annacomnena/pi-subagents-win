/**
 * _test_gui_daemon_lifecycle.ts — Runtime Daemon 第一切片测试
 * （plans/0923_runtime_daemon_final_plan.md §9/§10 第一批门禁）
 *
 * 覆盖：
 *   L1 OFF 零侵入：隔离 runtimeDir fixture 建档（文件清单+sha256）→ OFF tick →
 *      清单/hash 完全一致，且无 host.json/host.lock 新文件（未显式启用零动作）。
 *   L2 静态托管：真 server + fixture dist → GET / 回 HTML；/assets/* 回文件；
 *      `/v1/*` 未知路径 JSON 404（无 HTML，永不 SPA fallback）；匿名 health 无 token、
 *      含 runtimeId/releaseId。
 *   L3 路径穿越拒绝：`..`/绝对路径/大小写编码/双重编码 → 400/403/404，且响应不含
 *      dist 外文件内容。
 *   L4 身份挑战：POST /v1/challenge 正常 nonce → 200，本地 HMAC 可验；坏 nonce → 400；
 *      verifyChallengeResponse 篡改字段 → false（fail-closed）。
 *   L5 双 start：ensureRuntimeDaemon 两次 → 同 pid/instanceId，第二次 already:true
 *     （一个写手）。
 *   L6 接管不误杀：活锁占用 / stale 无锁 → uncertain fail-closed，且 holder 进程事后
 *      仍存活（未被 kill），handoff 锁已释放。
 *
 * 运行：npm run test:gui-daemon-lifecycle
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// 隔离（env 先于 import；同既有测试纪律）
const ROOT = mkdtempSync(join(tmpdir(), "daemon-lifecycle-env-"));
process.env.PI_RUNTIME_DIR = ROOT;
delete process.env.PI_SUBAGENT;
delete process.env.PI_TAB_RUN_ID;

import { readHostInfo, PROTOCOL_VERSION } from "./runtime-host/discovery.ts";
import { createRuntimeHostServer } from "./runtime-host/server.ts";
import {
	acquireRuntimeLock,
	daemonUrlFor,
	ensureRuntimeDaemon,
	lockPathFor,
	readRuntimeLock,
	stopRuntimeDaemon,
} from "./runtime-host/daemon-lifecycle.ts";
import { isProcessAlive } from "./runtime/liveness.ts";
import {
	runtimeIdForDir,
	verifyChallengeResponse,
	RUNTIME_SCHEMA_VERSION,
} from "./runtime-host/identity.ts";
import { guiAutoStartTick, guiAutoStartState } from "./gui-autostart.ts";

const SERVER_TS = join(dirname(fileURLToPath(import.meta.url)), "runtime-host", "server.ts");
const DIRS: string[] = [ROOT];
const sleepers: Array<ReturnType<typeof spawn>> = [];

function mkd(prefix: string): string {
	const d = mkdtempSync(join(tmpdir(), prefix));
	DIRS.push(d);
	return d;
}

/** 目录快照：相对路径清单 + 每个文件 sha256（可复现 fixture 比对用）。 */
function snapshotDir(dir: string): string {
	const out: string[] = [];
	const walk = (base: string, rel: string): void => {
		let entries: string[] = [];
		try {
			entries = readdirSync(join(base, rel)).sort();
		} catch {
			return;
		}
		for (const e of entries) {
			const p = join(base, rel, e);
			const rp = rel ? `${rel}/${e}` : e;
			let st: ReturnType<typeof statSync>;
			try {
				st = statSync(p);
			} catch {
				continue;
			}
			if (st.isDirectory()) walk(base, rp);
			else if (st.isFile()) {
				const h = createHash("sha256").update(readFileSync(p)).digest("hex");
				out.push(`${rp} ${h}`);
			}
		}
	};
	walk(dir, "");
	return out.join("\n");
}

async function getRaw(base: string, path: string): Promise<{ status: number; text: string; ctype: string }> {
	const res = await fetch(`${base}${path}`);
	return { status: res.status, text: await res.text(), ctype: res.headers.get("content-type") ?? "" };
}

async function postJson(base: string, path: string, body: unknown): Promise<{ status: number; body: any }> {
	const res = await fetch(`${base}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: res.status, body: await res.json() };
}

function spawnSleeper(): ReturnType<typeof spawn> {
	const c = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
	c.unref();
	sleepers.push(c);
	return c;
}

try {
	// ── L1 OFF 零侵入 ─────────────────────────────────────────────
	{
		const D = mkd("daemon-l1-");
		mkdirSync(join(D, "state"), { recursive: true });
		writeFileSync(join(D, "state", "keep.json"), JSON.stringify({ a: 1 }));
		const before = snapshotDir(D);
		guiAutoStartState.lastAt = 0;
		guiAutoStartTick({ readAutoStart: () => false, configPath: join(D, "cfg.json"), now: () => 1_000_000 });
		await new Promise((r) => setTimeout(r, 50));
		guiAutoStartTick({ readAutoStart: () => false, configPath: join(D, "cfg.json"), now: () => 1_000_001 });
		await new Promise((r) => setTimeout(r, 50));
		const after = snapshotDir(D);
		assert.equal(after, before, "L1 OFF tick 前后文件清单+hash 逐字节一致");
		assert.ok(!readdirSync(D).some((f) => f === "host.json" || f.endsWith(".lock")), "L1 未显式启用 → 无 host.json/锁文件");
		guiAutoStartState.lastAt = 0;
	}

	// ── L2/L3/L4：真 server + fixture dist ─────────────────────────
	{
		const D = mkd("daemon-l2-");
		const dist = join(D, "dist");
		mkdirSync(join(dist, "assets"), { recursive: true });
		writeFileSync(join(dist, "index.html"), "<!doctype html><html><body>daemon-gui</body></html>");
		writeFileSync(join(dist, "assets", "app.js"), "console.log('asset-ok');");
		const SECRET_OUTSIDE = "outside-secret-should-never-leak";
		writeFileSync(join(D, "outside.txt"), SECRET_OUTSIDE);

		const h = await createRuntimeHostServer({
			hostPath: join(D, "host.json"),
			timersDir: join(D, "timers"),
			stateDir: join(D, "state"),
			mailboxDir: join(D, "mailbox"),
			journalPath: join(D, "events.jsonl"),
			distDir: dist,
		});
		try {
			const base = `http://127.0.0.1:${h.info.port}`;
			// L2 静态
			const page = await getRaw(base, "/");
			assert.equal(page.status, 200, "L2 GET / 200");
			assert.ok(page.ctype.includes("text/html") && page.text.includes("daemon-gui"), "L2 / 回 dist 首页");
			const asset = await getRaw(base, "/assets/app.js");
			assert.equal(asset.status, 200, "L2 /assets/* 200");
			assert.ok(asset.text.includes("asset-ok"), "L2 asset 内容正确");
			// L2 /v1/* 永不 fallback
			const nope = await getRaw(base, "/v1/does-not-exist-l2");
			assert.equal(nope.status, 404, "L2 未知 /v1/* 404");
			assert.ok(nope.ctype.includes("application/json"), "L2 404 为 JSON（非 HTML）");
			assert.ok(!nope.text.includes("<html"), "L2 无 SPA fallback 泄漏");
			// L2 匿名 health：无 token，有身份非敏感字段
			const health = await getRaw(base, "/v1/health");
			assert.equal(health.status, 200);
			const hb = JSON.parse(health.text) as Record<string, any>;
			assert.equal(hb.host.token, undefined, "L2 health 不含 token");
			assert.equal(hb.host.instanceId, h.info.instanceId, "L2 health instanceId");
			assert.equal(hb.host.runtimeId, h.info.runtimeId, "L2 health runtimeId");
			assert.equal(hb.host.releaseId, h.info.releaseId, "L2 health releaseId");
			assert.ok(typeof h.info.token === "string" && h.info.token.length > 0, "L2 host.json 侧有 token（文件级）");

			// L3 穿越拒绝
			const evil = [
				"/assets/../outside.txt",
				"/assets/%2e%2e/outside.txt",
				"/assets/%2E%2E/outside.txt",
				"/assets/%252e%252e/outside.txt",
				"/assets/..%2foutside.txt",
			];
			for (const p of evil) {
				const r = await getRaw(base, p);
				assert.ok([400, 403, 404].includes(r.status), `L3 ${p} → ${r.status}（拒绝）`);
				assert.ok(!r.text.includes(SECRET_OUTSIDE), `L3 ${p} 无越界内容泄漏`);
			}

			// L4 挑战
			const file = readHostInfo(join(D, "host.json"))!;
			assert.ok(file.token, "L4 前置：host.json 有 token");
			const good = await postJson(base, "/v1/challenge", { nonce: "abcdef1234567890" });
			assert.equal(good.status, 200, "L4 正常 nonce 200");
			const meta = {
				instanceId: file.instanceId,
				runtimeId: file.runtimeId!,
				protocolVersion: PROTOCOL_VERSION,
				releaseId: file.releaseId!,
				schemaVersion: RUNTIME_SCHEMA_VERSION,
				processStartIdentity: file.processStartIdentity!,
			};
			assert.equal(
				verifyChallengeResponse(file.token, "abcdef1234567890", good.body, meta),
				true,
				"L4 本地 HMAC 可验",
			);
			const tampered = { ...good.body, instanceId: "host_forged" };
			assert.equal(verifyChallengeResponse(file.token, "abcdef1234567890", tampered, meta), false, "L4 篡改 instanceId → false");
			const bad = await postJson(base, "/v1/challenge", { nonce: "short" });
			assert.equal(bad.status, 400, "L4 短 nonce 400");
			const bad2 = await postJson(base, "/v1/challenge", {});
			assert.equal(bad2.status, 400, "L4 缺 nonce 400");
		} finally {
			await h.close();
		}
	}

	// ── L5 双 start（真 spawn）：一个写手 ───────────────────────────
	{
		const D = mkd("daemon-l5-");
		const r1 = await ensureRuntimeDaemon({ hostPath: join(D, "host.json"), serverPath: SERVER_TS, waitMs: 25000 });
		assert.equal(r1.error ?? null, null, `L5 首次 ensure 无错：${r1.error ?? ""}`);
		assert.equal(r1.ok, true, "L5 首次 ensure ok");
		assert.ok(r1.info && isProcessAlive(r1.info.pid), "L5 新 daemon 存活");
		assert.ok((r1.url ?? "").startsWith("http://127.0.0.1:"), "L5 同源 URL");
		assert.equal(r1.url, daemonUrlFor(r1.info!.port), "L5 daemonUrlFor 一致");
		// 静态页随 daemon 可达（默认 repo gui/dist）
		const page = await fetch(r1.url!);
		assert.equal(page.status, 200, "L5 daemon 静态首页可达");
		const r2 = await ensureRuntimeDaemon({ hostPath: join(D, "host.json"), serverPath: SERVER_TS, waitMs: 25000 });
		assert.equal(r2.ok, true, "L5 二次 ensure ok");
		assert.equal(r2.already, true, "L5 二次 already（未重 spawn）");
		assert.equal(r2.info?.pid, r1.info?.pid, "L5 同 pid（一个写手）");
		assert.equal(r2.info?.instanceId, r1.info?.instanceId, "L5 同 instanceId");
		// 锁由 daemon 持有
		const lock = readRuntimeLock(lockPathFor(join(D, "host.json")));
		assert.ok(lock && lock.kind === "daemon" && lock.pid === r1.info?.pid, "L5 daemon 自持单实例锁");
		// 回收真 daemon（alive → kill + 条件删，不留孤儿进程）
		const st = await stopRuntimeDaemon({ hostPath: join(D, "host.json") });
		assert.equal(st.stopped, true, "L5 stop 回收");
	}

	// ── L6 接管不误杀 ──────────────────────────────────────────────
	{
		// L6a：活锁占用（daemon kind，holder 存活）→ uncertain，holder 未被 kill
		const D = mkd("daemon-l6a-");
		const holder = spawnSleeper();
		await new Promise((r) => setTimeout(r, 200));
		const hp = join(D, "host.json");
		const staleFile = {
			instanceId: "host_stale_a",
			pid: holder.pid!,
			port: 1,
			startedAt: new Date(Date.now() - 120000).toISOString(),
			protocolVersion: PROTOCOL_VERSION,
		};
		writeFileSync(hp, JSON.stringify(staleFile));
		const lockAc = acquireRuntimeLock(lockPathFor(hp), {
			kind: "daemon",
			pid: holder.pid!,
			instanceId: "host_stale_a",
			runtimeId: runtimeIdForDir(D),
			acquiredAt: new Date().toISOString(),
		});
		assert.equal(lockAc.acquired, true, "L6a 前置：holder 持锁");
		const r = await ensureRuntimeDaemon({ hostPath: hp, serverPath: SERVER_TS, waitMs: 3000 });
		assert.equal(r.ok, false, "L6a 活锁占用 → 不 ok");
		assert.equal(r.uncertain, true, "L6a uncertain fail-closed");
		assert.ok(isProcessAlive(holder.pid!), "L6a holder 未被 kill（不误杀）");
		assert.equal(readHostInfo(hp)?.instanceId, "host_stale_a", "L6a host.json 未被覆盖");

		// L6b：stale 无锁（pid 活但探活失败）→ uncertain，holder 未被 kill，handoff 已释放
		const D2 = mkd("daemon-l6b-");
		const holder2 = spawnSleeper();
		await new Promise((r) => setTimeout(r, 200));
		const hp2 = join(D2, "host.json");
		writeFileSync(hp2, JSON.stringify({ ...staleFile, instanceId: "host_stale_b", pid: holder2.pid }));
		const rB = await ensureRuntimeDaemon({ hostPath: hp2, serverPath: SERVER_TS, waitMs: 3000 });
		assert.equal(rB.ok, false, "L6b stale → 不 ok");
		assert.equal(rB.uncertain, true, "L6b uncertain fail-closed（禁止覆盖活锁）");
		assert.ok(isProcessAlive(holder2.pid!), "L6b holder 未被 kill");
		assert.equal(readRuntimeLock(lockPathFor(hp2)), null, "L6b handoff 锁已释放");
		assert.equal(readHostInfo(hp2)?.instanceId, "host_stale_b", "L6b host.json 未被覆盖");
	}

	console.log("_test_gui_daemon_lifecycle: all assertions passed");
	for (const c of sleepers) {
		try {
			c.kill();
		} catch {
			/* ignore */
		}
	}
} catch (e) {
	for (const c of sleepers) {
		try {
			c.kill();
		} catch {
			/* ignore */
		}
	}
	for (const d of DIRS) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
	console.error("_test_gui_daemon_lifecycle FAILED:", e);
	process.exit(1);
}
for (const d of DIRS) {
	try {
		rmSync(d, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}
