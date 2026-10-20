/**
 * runtime/session-busy.ts — 「会话正忙」标记（2026-10-20，停止按钮的可点性）。
 *
 * ## 为什么需要独立标记（用户实测报障）
 * 停止按钮的「可点」原来只靠两条信号，而**两条都在助手真正产出之后才成立**：
 *   1. 流式快照存在（`state/streaming/`）—— 要等第一个 `thinking_delta`/`text_delta`；
 *   2. 最后一行是 `status="running"` 的工具卡 —— 要等 tool_use 落盘。
 * ⇒ 用户点「发送」后到第一个 token 之间（含 provider 排队、长思考首字延迟）以及
 * 「工具跑完 → 下一段输出开始」之间，按钮都是灰的 —— 而这正是用户最想按停的时刻。
 *
 * 本标记由**会话进程自己**在 turn 开始/结束时写，是「agent 是否在跑」的权威信号：
 *   - `agent_start` / `turn_start` ⇒ 写 `{busy:true}`
 *   - `agent_settled` / `agent_end` / `session_shutdown` ⇒ 删除
 *
 * ## 为什么单独一个文件而不是塞进流式快照
 * 流式快照在 `message_end` 就被删除（好让正式 reasoning 行替换预览块），
 * 若复用它表示 busy，会在每次 message_end 后误报空闲。两者生命周期不同：
 *   - 流式快照 = 「当前这一段文字」（message 级）
 *   - busy 标记 = 「这个 turn 还在跑」（turn 级）
 *
 * ## 心跳（必须，否则长工具会「假死」）
 * 一次 turn 里可能有 30s 的 bash 而没有新事件 ⇒ 文件 `at` 不刷新 ⇒ 读端按陈旧丢弃 ⇒
 * 按钮又灰了。故 busy 期间每 15s 刷新一次 `at`（`unref()`，不阻进程退出）。
 *
 * ## 红线
 * - never-throw：写失败只是「这次按钮灰着」，不影响对话。
 * - 不写 journal、不发事件、不改任何既有状态机。
 */

import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultRuntimeDir } from "./journal.ts";

/** busy 心跳间隔（ms）：15s。读端陈旧阈值应显著大于它（daemon 侧 45s）。 */
export const BUSY_HEARTBEAT_MS = 15_000;

export function busyDir(runtimeDir: string = defaultRuntimeDir()): string {
	return join(runtimeDir, "state", "session-busy");
}

export function busySnapshotPath(sessionId: string, runtimeDir: string = defaultRuntimeDir()): string {
	return join(busyDir(runtimeDir), `${sessionId}.json`);
}

export interface BusySnapshot {
	version: 1;
	sessionId: string;
	busy: true;
	/** 最近一次心跳/事件时刻（ISO）。 */
	at: string;
	/** turn 开始时刻（ISO，诊断用：能看出这一轮跑了多久）。 */
	since: string;
	pid: number;
}

export interface BusyWriter {
	/** 标记开始忙（幂等：已在忙则只刷新心跳）。 */
	begin(): void;
	/** 标记 turn 结束（删除文件 + 停心跳）。 */
	settle(): void;
	/** 卸载：停心跳 + 删文件。 */
	dispose(): void;
}

const writers = new Map<string, BusyWriter>();

/**
 * 取/建某会话的 busy writer。
 * `now` / `dir` 可注入（测试确定性/隔离）。
 */
export function busyWriterFor(sessionId: string, opts: { dir?: string; now?: () => Date } = {}): BusyWriter {
	const existing = writers.get(sessionId);
	if (existing !== undefined) return existing;

	const dir = opts.dir ?? busyDir();
	const now = opts.now ?? (() => new Date());
	const path = join(dir, `${sessionId}.json`);
	let since: string | null = null;
	let heartbeat: ReturnType<typeof setInterval> | null = null;

	const writeNow = (): void => {
		try {
			mkdirSync(dir, { recursive: true });
			const snap: BusySnapshot = {
				version: 1,
				sessionId,
				busy: true,
				at: now().toISOString(),
				since: since ?? now().toISOString(),
				pid: process.pid,
			};
			const tmp = `${path}.${process.pid}.tmp`;
			writeFileSync(tmp, JSON.stringify(snap), "utf8");
			renameSync(tmp, path);
		} catch {
			/* never-throw */
			try {
				rmSync(`${path}.${process.pid}.tmp`, { force: true });
			} catch {
				/* ignore */
			}
		}
	};

	const stopHeartbeat = (): void => {
		if (heartbeat !== null) {
			clearInterval(heartbeat);
			heartbeat = null;
		}
	};

	const writer: BusyWriter = {
		begin() {
			if (since === null) since = now().toISOString();
			writeNow();
			if (heartbeat === null) {
				heartbeat = setInterval(writeNow, BUSY_HEARTBEAT_MS);
				(heartbeat as { unref?: () => void }).unref?.();
			}
		},
		settle() {
			stopHeartbeat();
			since = null;
			try {
				rmSync(path, { force: true });
			} catch {
				/* ignore */
			}
			writers.delete(sessionId);
		},
		dispose() {
			stopHeartbeat();
			since = null;
			try {
				rmSync(path, { force: true });
			} catch {
				/* ignore */
			}
			writers.delete(sessionId);
		},
	};
	writers.set(sessionId, writer);
	return writer;
}

/** 清空所有 busy writer（session_shutdown / 测试）。 */
export function disposeAllBusyWriters(): void {
	for (const w of [...writers.values()]) w.dispose();
	writers.clear();
}

/** 是否有活跃 writer（测试断言用）。 */
export function activeBusyWriterCount(): number {
	return writers.size;
}
