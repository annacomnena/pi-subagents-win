/**
 * _test_steer_takeover_worker.ts — N-2 并发接管回归的 worker 线程（非独立测试入口）
 *
 * 由 `_test_steer_consumer.ts` 以 `node:worker_threads.Worker` 启动：N 个 worker 在同一个
 * 陈旧 `.claimed` 上**真正并行**调用 `claimSteerAtomicDetailed`，统计每次 trial 里返回
 * `"claimed"` 的线程数、到达接管临界区的线程数（`arrived`）与实际发送次数（`sends`）。
 *
 * 确定性交错（使「修复前必红、修复后必绿」）：
 *   所有 worker 在临界点用共享内存对齐——等到「到达临界点 + 已完整返回」之和 = worker 数。
 *   - 修复后（令牌 CAS）：只有抢到 `<id>.claimed.takeover` 的 1 个线程能进入临界区，
 *     其余在令牌处 `held` 返回 → `arrived = 1`，恰好 1 个 claimed/1 次 send。
 *   - 修复前（裸 unlink）：无令牌，所有线程都进入临界区 → `arrived = N`，再按 `rank`
 *     错峰（rank 越大越晚动）→ 后者删掉前者刚建的新鲜 sidecar 再认领 → 多个 claimed。
 *
 * 防挂死：本 worker 不注册任何 `setInterval`；父测试持有硬超时并在 finally 里
 * `worker.terminate()`。共享内存布局（均 Int32Array）：
 *   go[0]       当前放行的 trial 号（父递增；worker 等到 >= t+1 才行动）
 *   done[0]     已完成 trial 计数（父等到 (t+1)*N）
 *   arrived[t]  trial t 到达接管临界区的线程数（修复后应恒为 1）
 *   finished[t] trial t 已完整返回的线程数（配合 arrived 做对齐，避免修复后死锁）
 *   claimed[t]  trial t 返回 "claimed" 的线程数
 *   sends[t]    trial t 真实发送分类调用的次数（claimed ⇒ 恰好 1）
 */

import { parentPort, workerData } from "node:worker_threads";
import { claimSteerAtomicDetailed, sendSteerDetailed } from "./steer.ts";

interface RaceWorkerData {
	dir: string;
	tabRunId: string;
	id: string;
	leaseMs: number;
	trials: number;
	go: SharedArrayBuffer;
	done: SharedArrayBuffer;
	arrived: SharedArrayBuffer;
	finished: SharedArrayBuffer;
	claimed: SharedArrayBuffer;
	sends: SharedArrayBuffer;
	rank: number;
	workerCount: number;
	staggerMs: number;
}

const data = workerData as RaceWorkerData;
const go = new Int32Array(data.go);
const done = new Int32Array(data.done);
const arrived = new Int32Array(data.arrived);
const finished = new Int32Array(data.finished);
const claimed = new Int32Array(data.claimed);
const sends = new Int32Array(data.sends);

/** 忙等（不引入定时器；临界区内用，微秒级）。 */
const spinUntil = (deadlineMs: number): void => {
	while (Date.now() < deadlineMs) { /* spin */ }
};

parentPort?.postMessage("ready");

for (let t = 0; t < data.trials; t++) {
	const target = t + 1;
	while (Atomics.load(go, 0) < target) { /* spin：等父放行本 trial */ }

	const outcome = claimSteerAtomicDetailed(data.dir, data.tabRunId, data.id, {
		staleMs: data.leaseMs,
		onTakeoverCritical: () => {
			Atomics.add(arrived, t, 1);
			// 对齐：等到所有 worker 都被计入（到达临界区 或 已完整返回）。
			// 修复后：输家在令牌处 held 返回 → 计入 finished，赢家可放行（不死锁）。
			// 修复前：所有线程都到临界区 → arrived=N，直接放行。
			const alignDeadline = Date.now() + 15_000;
			while (
				Atomics.load(arrived, t) + Atomics.load(finished, t) < data.workerCount
				&& Date.now() < alignDeadline
			) { /* spin */ }
			// 确定性错峰：rank 越大越晚动。修复前 → 后者会删掉前者刚建的新鲜 sidecar。
			if (data.rank > 0 && data.staggerMs > 0) spinUntil(Date.now() + data.staggerMs * data.rank);
		},
	});

	if (outcome === "claimed") {
		Atomics.add(claimed, t, 1);
		// 走真实发送分类（fake send 同步计数）：claimed ⇒ 消费链恰好一次 send。
		await sendSteerDetailed(() => { Atomics.add(sends, t, 1); }, "takeover-race-body");
	}
	Atomics.add(finished, t, 1);
	Atomics.add(done, 0, 1);
	Atomics.notify(done, 0);
}

parentPort?.postMessage("done");
