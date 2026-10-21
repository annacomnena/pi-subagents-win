/**
 * _probe_runs_endpoint_real.ts — 对**真实** `~/.pi/agent/subagent-runs/`（154 份）的端点实测探针。
 *
 * 为什么单独一个探针而不塞进 `_test_runs_endpoint.ts`：那里必须用夹具（测试不得读真实目录），
 * 这里的意义恰好相反——要的是真实数据的体积与延迟读数。脚本不入产品路径、不写任何盘。
 *
 * 读法（每项打印原始值，便于直接贴进报告）：
 *   P1 `?limit=154` 响应体字节数（min-card 判据 ≤120 KB）
 *   P2 `?limit=154&includeRecentCalls=1` 响应体字节数（判据 ≤420 KB）
 *   P3 各跑 ≥5 次取 min/median/P95/max（判据 P95 <50 ms）
 *   P4 If-None-Match → 304（贴状态码）
 *   P5 三态分布（alive/dead/unknown，分母 154）
 *
 * 运行：node --experimental-strip-types --import ./extensions/runtime-host/pi-deps-loader.mjs \
 *        ./extensions/_probe_runs_endpoint_real.ts
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 隔离 runtime 侧（delivery/mailbox/journal），**不动**真实 subagent-runs（这才是被测对象）
process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "runs-probe-"));
delete process.env.PI_SUBAGENT_RUNS_DIR; // 明确：读真实缺省目录

const { createRuntimeHostServer } = await import("./runtime-host/server.ts");
const { DEFAULT_RUNS_DIR } = await import("./subagent-kill.ts");

const ROOT = process.env.PI_RUNTIME_DIR!;
const h = await createRuntimeHostServer({
	hostPath: join(ROOT, "host.json"),
	stateDir: join(ROOT, "state"),
	mailboxDir: join(ROOT, "mailbox"),
	journalPath: join(ROOT, "journal.jsonl"),
	sessionsDir: join(ROOT, "sessions"),
	lockWaitMs: 1000,
});
const base = `http://127.0.0.1:${h.info.port}`;
console.log(`DEFAULT_RUNS_DIR = ${DEFAULT_RUNS_DIR}`);
console.log(`server = ${base}`);

const pct = (arr: number[], p: number): number => {
	const s = [...arr].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
};

async function measure(path: string, n = 7): Promise<{ bytes: number; ms: number[] }> {
	let bytes = 0;
	const ms: number[] = [];
	for (let i = 0; i < n; i += 1) {
		const t0 = performance.now();
		const r = await fetch(`${base}${path}`);
		const text = await r.text();
		ms.push(performance.now() - t0);
		bytes = Buffer.byteLength(text, "utf8");
	}
	return { bytes, ms };
}

try {
	// ── P1 min-card（无 recentCalls）────────────────────────────────
	const p1 = await measure("/v1/runs?limit=154");
	console.log(`P1 limit=154  bytes=${p1.bytes} (${(p1.bytes / 1024).toFixed(1)} KB, 判据 ≤120 KB)  ms=${p1.ms.map((x) => x.toFixed(1)).join(",")}`);
	console.log(`P1 stats     min=${Math.min(...p1.ms).toFixed(2)} median=${pct(p1.ms, 50).toFixed(2)} P95=${pct(p1.ms, 95).toFixed(2)} max=${Math.max(...p1.ms).toFixed(2)}`);

	// ── P2 带 recentCalls ──────────────────────────────────────────
	const p2 = await measure("/v1/runs?limit=154&includeRecentCalls=1");
	console.log(`P2 +recent   bytes=${p2.bytes} (${(p2.bytes / 1024).toFixed(1)} KB, 判据 ≤420 KB)  ms=${p2.ms.map((x) => x.toFixed(1)).join(",")}`);
	console.log(`P2 stats     min=${Math.min(...p2.ms).toFixed(2)} median=${pct(p2.ms, 50).toFixed(2)} P95=${pct(p2.ms, 95).toFixed(2)} max=${Math.max(...p2.ms).toFixed(2)}`);

	// ── P5 三态分布 ────────────────────────────────────────────────
	const body = (await (await fetch(`${base}/v1/runs?limit=154&includeRecentCalls=1`)).json()) as {
		version: number;
		count: number;
		total: number;
		runs: { id: string; status: string; liveness: string; pid: number | null; usage: unknown; recentCalls?: unknown[] }[];
	};
	const tally: Record<string, number> = {};
	for (const r of body.runs) tally[r.liveness] = (tally[r.liveness] ?? 0) + 1;
	const statusTally: Record<string, number> = {};
	for (const r of body.runs) statusTally[r.status] = (statusTally[r.status] ?? 0) + 1;
	const withPid = body.runs.filter((r) => r.pid !== null).length;
	const withUsage = body.runs.filter((r) => r.usage !== null).length;
	const withCalls = body.runs.filter((r) => Array.isArray(r.recentCalls) && r.recentCalls.length > 0).length;
	console.log(`P5 version=${body.version} count=${body.count} total=${body.total}`);
	console.log(`P5 liveness  ${JSON.stringify(tally)}  (分母 ${body.runs.length})`);
	console.log(`P5 status    ${JSON.stringify(statusTally)}`);
	console.log(`P5 带 pid=${withPid}/${body.runs.length}  有 usage=${withUsage}  有 recentCalls=${withCalls}`);
	for (const r of body.runs.filter((x) => x.pid !== null)) console.log(`P5 pid sample ${r.id} status=${r.status} liveness=${r.liveness} pid=${r.pid}`);

	// ── P4 ETag / 304 ─────────────────────────────────────────────
	const first = await fetch(`${base}/v1/runs?limit=154`);
	const etag = first.headers.get("etag");
	console.log(`P4 200 etag=${etag} bytes=${Buffer.byteLength(await first.text(), "utf8")}`);
	const second = await fetch(`${base}/v1/runs?limit=154`, { headers: { "if-none-match": etag ?? "" } });
	const secondBody = await second.text();
	console.log(`P4 If-None-Match → status=${second.status} bodyBytes=${Buffer.byteLength(secondBody, "utf8")} (期望 304 / 0)`);
	// includeRecentCalls 的 ETag 与 min-card 不同（不同查询不同响应体）
	const rq = await fetch(`${base}/v1/runs?limit=154&includeRecentCalls=1`);
	console.log(`P4 includeRecentCalls etag=${rq.headers.get("etag")} (应与 min-card 不同)`);
} finally {
	await h.close();
}
