/**
 * _test_runtime_host_backpressure.ts — R-14：journal 重放必须分批，不能一次灌满 socket。
 *
 * ## 真机事故（2026-11-03）
 *
 * GUI「不能继续对话」，daemon 日志反复出现：
 * ```
 * [ws xxx] subscribe journal -> resume (replay to head 7587)
 * [ws xxx] close 1013 backpressure
 * [ws xxx] closed
 * ```
 * 每连必断。根因 `subscribeJournal` 用**同步 for 循环**逐条 `send()` 整个 backlog：
 * 一帧都不让出事件循环 ⇒ Node 写缓冲秒满 ⇒ `send()` 返 false ⇒ 立即
 * `close 1013 backpressure` ⇒ 客户端重连又从 base.seq 重发全量 ⇒ 死循环。
 *
 * ## 判据
 *
 * A. 大 backlog（> REPLAY_BATCH）必须收完，不得 1013 断线
 * B. seq 严格递增且无重复（异步分批不得与 live tail 交错）
 * C. 回放结束后 live 增量照常推送（tail 在回放之后才启动）
 * D. 对照：证明 backlog 真的大于单批（否则测不到分批路径）
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "bp-env-"));
process.env.PI_SESSIONS_DIR = mkdtempSync(join(tmpdir(), "bp-sessions-"));

import { createRuntimeHostServer, type RuntimeHostHandle } from "./runtime-host/server.ts";
import { wsHandshake } from "./_test_ws_client.ts";
import { newEventEnvelope } from "./runtime/envelope.ts";
import { masterAddress } from "./runtime/address.ts";
import { defaultJournalPath, appendRuntimeEnvelope } from "./runtime/journal.ts";

let passed = 0;
const check = (name: string, fn: () => void): void => {
	try {
		fn();
		passed += 1;
		console.log(`  ✓ ${name}`);
	} catch (e) {
		console.error(`  ✗ ${name}`);
		console.error(`    ${e instanceof Error ? e.message : String(e)}`);
		throw e;
	}
};

const N = 3000;

function seedJournal(n: number): void {
	const p = defaultJournalPath();
	mkdirSync(dirname(p), { recursive: true });
	const lines: string[] = [];
	for (let i = 0; i < n; i++) {
		const env = newEventEnvelope({
			kind: "event",
			type: "probe.tick",
			source: masterAddress(),
			payload: { i, pad: "x".repeat(200) },
		});
		lines.push(JSON.stringify(env));
	}
	writeFileSync(p, `${lines.join("\n")}\n`, "utf8");
}

async function main(): Promise<void> {
	seedJournal(N);
	const host: RuntimeHostHandle = await createRuntimeHostServer({
		port: 0,
		journalPath: defaultJournalPath(),
		sessionsDir: process.env.PI_SESSIONS_DIR as string,
		tailMs: 30,
		pingMs: 5000,
	});
	const token = host.info.token;
	const port = host.info.port;

	try {
		const hs = await wsHandshake(port, `/v1/events/stream?token=${encodeURIComponent(token)}`);
		assert.ok(hs.ok && hs.ws, `WS 握手失败: ${hs.statusLine}`);
		const ws = hs.ws;

		console.log("\nA. 大 backlog 分批重放");

		// 【判别力核心】用 setImmediate 自循环数「事件循环轮次」。
		// 同步 for 循环的 N 帧全部在同一轮内写完（轮次不变）；分批实现每 REPLAY_BATCH 条
		// 就隔一个 setImmediate（轮次递增）。真机事故的机制就是「一帧不让出」⇒ 缓冲灌满。
		let tick = 0;
		let stopCounter = false;
		const bump = (): void => {
			tick += 1;
			if (!stopCounter) setImmediate(bump);
		};
		setImmediate(bump);

		ws.sendText(JSON.stringify({ type: "subscribe", topic: "journal", base: { seq: 0, logEpoch: "" } }));

		const frames: Array<{ seq: number; tick: number }> = [];
		const deadline = Date.now() + 25_000;
		while (frames.length < N && Date.now() < deadline) {
			const j = (await ws.recvJson(500)) as { type?: string; seq?: number } | null;
			if (j === null) continue;
			if (j.type === "event" && typeof j.seq === "number") frames.push({ seq: j.seq, tick });
		}
		stopCounter = true;

		check(`A1 ${N} 条全部收到（未因 backpressure 断线）`, () => {
			assert.ok(!ws.closed, "连接不得被 1013 断开");
			assert.equal(frames.length, N, `期望 ${N} 条，实际 ${frames.length}`);
		});

		console.log("\nB. seq 严格递增、无重复");
		check("B1 seq 严格递增", () => {
			for (let i = 1; i < frames.length; i++) {
				assert.ok(
					frames[i].seq > frames[i - 1].seq,
					`第 ${i} 条 seq=${frames[i].seq} 不大于前一条 ${frames[i - 1].seq}（分批与 tail 交错）`,
				);
			}
		});
		check("B2 seq 无重复", () => {
			const seen = new Set<number>();
			for (const f of frames) {
				assert.ok(!seen.has(f.seq), `seq ${f.seq} 重复投递`);
				seen.add(f.seq);
			}
		});
		check("B3 首条 seq === 1（不漏头）", () => {
			assert.equal(frames[0].seq, 1, `首条 seq 应为 1，实际 ${frames[0].seq}`);
		});
		check(`B4 末条 seq === ${N}（不缺尾）`, () => {
			assert.equal(frames[frames.length - 1].seq, N, `末条 seq 应为 ${N}，实际 ${frames[frames.length - 1].seq}`);
		});

		console.log("\nC. 回放结束后 live 增量照常推送");
		appendRuntimeEnvelope(
			newEventEnvelope({ kind: "event", type: "probe.live", source: masterAddress(), payload: { live: true } }),
		);
		let liveSeq: number | null = null;
		const liveDeadline = Date.now() + 10_000;
		while (liveSeq === null && Date.now() < liveDeadline) {
			const j = (await ws.recvJson(500)) as { type?: string; seq?: number } | null;
			if (j && j.type === "event" && typeof j.seq === "number" && j.seq > N) liveSeq = j.seq;
		}
		check("C1 live 追加能收到（tail 在回放后才启动）", () => {
			assert.equal(liveSeq, N + 1, `live seq 应为 ${N + 1}，实际 ${liveSeq}`);
		});

		ws.destroy();

		console.log("\nD. 【判别力】分批实现必须让出事件循环");
		const firstTick = frames[0].tick;
		const lastTick = frames[frames.length - 1].tick;
		const span = lastTick - firstTick;
		// 分批：N/64 批 ≈ 47 次让出（N=3000）。同步：同一轮内跑完 ⇒ span 约 0。
		// 放宽到 N/256（≈11）避开调度抖动，仍远大于同步实现的 ~0。
		const minSpan = Math.floor(N / 256);

		check(`D1 帧到达跨越 >= ${minSpan} 个事件循环轮次（真的分批了）`, () => {
			assert.ok(
				span >= minSpan,
				`跨度只有 ${span} 轮（首 ${firstTick} → 末 ${lastTick}）。` +
					`同步 for 循环会在同一轮发完（跨度≈0），这正是修复前的行为。` +
					`要求 >= ${minSpan} 才算分批。`,
			);
		});

		check("D2 对照：backlog 与实收都远大于单批(64)", () => {
			assert.ok(N > 64 * 10, `backlog ${N} 必须 >> 64`);
			assert.ok(frames.length > 64 * 10, `实收 ${frames.length} 必须 >> 64`);
		});

		console.log(`\n_test_runtime_host_backpressure: ${passed} checks passed`);
	} finally {
		await host.close();
		rmSync(process.env.PI_RUNTIME_DIR as string, { recursive: true, force: true });
		rmSync(process.env.PI_SESSIONS_DIR as string, { recursive: true, force: true });
	}
}

await main();
