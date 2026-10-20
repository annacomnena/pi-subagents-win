/**
 * runtime/streaming-snapshot.ts — 「正在思考 / 正在输出」的**流式快照**写入端（2026-10-20）。
 *
 * ## 为什么需要它
 * pi core 只在 `message_end` 时把 assistant 消息写进会话 JSONL（`session-manager.js::appendMessage`），
 * 流式期间文件没有新行 ⇒ daemon 的 transcript 投影拿不到任何增量 ⇒ GUI 只能等整段生成完
 * 才看到「思考过程」块。这是数据源问题，不是投影慢。
 *
 * pi 的扩展 API 提供官方逐 token 事件 `pi.on("message_update")`，其
 * `assistantMessageEvent` 形如 `{ type: "thinking_delta" | "text_delta", contentIndex, delta }`。
 *
 * ## 设计：节流 + 覆盖写（**不写 journal**）
 * - **不写 journal**：delta 每秒可达上百次，append-only 会让事件日志爆炸，并破坏
 *   「journal = 持久事实」的语义（见 Wiki/Architecture/gui-message-pipeline.md）。
 * - **覆盖写**：`state/streaming/<sessionId>.json` 只保存「当前这一段」的累积文本，
 *   体积恒定（≈ 当前段长度），tmp+rename 原子替换。
 * - **节流 150ms**（≈6.7 次/秒，落在用户要求的 5-10 次/秒）：GUI 侧用 CSS 动画填平间隙，
 *   不做逐 token 渲染。
 * - **生命周期**：`message_end` / `session_shutdown` 删除快照；GUI 只在快照存在且未老化时显示
 *   临时块，正式行从 JSONL 到达后自然替换（不会重复）。
 *
 * ## 红线
 * - never-throw：所有 IO 包 try/catch；写失败只是「这次没有流式预览」，不影响对话。
 * - 不落 journal、不发事件、不改任何既有状态机。
 * - 快照目录独立（`state/streaming/`），不与会话/台账混放。
 */

import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultRuntimeDir } from "./journal.ts";
import { getCurrentSessionId } from "../identity.ts";

/** 节流间隔（ms）：150ms ≈ 6.7 次/秒。用户口径「每秒 5-10 次，用动画填平」。 */
export const STREAMING_FLUSH_MS = 150;

/** 快照目录（`<runtimeDir>/state/streaming`）。 */
export function streamingDir(runtimeDir: string = defaultRuntimeDir()): string {
	return join(runtimeDir, "state", "streaming");
}

export function streamingSnapshotPath(sessionId: string, runtimeDir: string = defaultRuntimeDir()): string {
	return join(streamingDir(runtimeDir), `${sessionId}.json`);
}

/** 快照形状（GUI 消费契约；additive 演进时只加可选字段）。 */
export interface StreamingSnapshot {
	version: 1;
	sessionId: string;
	/** 当前正在流式输出的段落类型。 */
	kind: "reasoning" | "text";
	/** 该段的累积文本（节流快照，非最终值）。 */
	text: string;
	/** 最近一次更新时刻（ISO）；GUI 据此判定是否陈旧。 */
	at: string;
	/** 进程 pid（诊断用：区分「谁写的」）。 */
	pid: number;
}

/**
 * 写入端状态机（每会话一份）。
 *
 * 为什么要累积而不是直接写 `delta`：`message_update` 只给增量，GUI 要的是「到目前为止的全文」。
 * 累积后覆盖写，GUI 侧无需自己拼接（也不需要处理丢帧）。
 */
export interface StreamingWriter {
	/** 收到一个增量（不立即写盘）。 */
	push(kind: "reasoning" | "text", delta: string): void;
	/** 强制落盘（message_end / shutdown 前用）。 */
	flush(): void;
	/** 清空并删除快照（message_end 正常结束 / 会话关闭）。 */
	finish(): void;
	/** 卸载：停定时器 + 删快照。 */
	dispose(): void;
}

/** 每会话 writer（同进程内按 sessionId 复用，避免同一会话多个段落互相覆盖）。 */
const writers = new Map<string, StreamingWriter>();

/**
 * 取/建某会话的 writer。
 *
 * `now` 可注入（测试确定性）；`dir` 可注入（测试隔离）。
 */
export function streamingWriterFor(
	sessionId: string,
	opts: { dir?: string; now?: () => Date } = {},
): StreamingWriter {
	const existing = writers.get(sessionId);
	if (existing !== undefined) return existing;

	const dir = opts.dir ?? streamingDir();
	const now = opts.now ?? (() => new Date());
	let kind: "reasoning" | "text" = "reasoning";
	let text = "";
	let timer: ReturnType<typeof setTimeout> | null = null;
	let dirty = false;

	const path = join(dir, `${sessionId}.json`);

	const writeNow = (): void => {
		dirty = false;
		try {
			mkdirSync(dir, { recursive: true });
			const snap: StreamingSnapshot = {
				version: 1,
				sessionId,
				kind,
				text,
				at: now().toISOString(),
				pid: process.pid,
			};
			const tmp = `${path}.${process.pid}.tmp`;
			writeFileSync(tmp, JSON.stringify(snap), "utf8");
			renameSync(tmp, path);
		} catch {
			/* never-throw：写失败只是没有流式预览 */
			try {
				rmSync(`${path}.${process.pid}.tmp`, { force: true });
			} catch {
				/* ignore */
			}
		}
	};

	const clearTimer = (): void => {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
	};

	const schedule = (): void => {
		if (timer !== null) return; // 已有待触发的 flush（节流：窗口内只排一次）
		timer = setTimeout(() => {
			timer = null;
			if (dirty) writeNow();
		}, STREAMING_FLUSH_MS);
		// 不阻止进程退出（扩展进程被 kill 时不该因这个定时器卡住）
		if (typeof (timer as { unref?: () => void }).unref === "function") (timer as { unref: () => void }).unref();
	};

	const writer: StreamingWriter = {
		push(nextKind, delta) {
			if (delta.length === 0) return;
			// 段落切换（thinking → text 或反向）：立刻落盘，避免把两段拼在一起
			if (nextKind !== kind) {
				kind = nextKind;
				text = delta;
				clearTimer();
				writeNow();
				return;
			}
			kind = nextKind;
			text += delta;
			dirty = true;
			schedule();
		},
		flush() {
			clearTimer();
			if (dirty) writeNow();
		},
		finish() {
			clearTimer();
			text = "";
			dirty = false;
			try {
				rmSync(path, { force: true });
			} catch {
				/* ignore */
			}
			writers.delete(sessionId);
		},
		dispose() {
			clearTimer();
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

/** 清空所有 writer（测试/会话切换用）。 */
export function disposeAllStreamingWriters(): void {
	for (const w of [...writers.values()]) w.dispose();
	writers.clear();
}

/** 从 `assistantMessageEvent` 里取增量；不认识的事件 → null。 */
export function extractDelta(ev: unknown): { kind: "reasoning" | "text"; delta: string } | null {
	if (typeof ev !== "object" || ev === null) return null;
	const rec = ev as Record<string, unknown>;
	const type = typeof rec.type === "string" ? rec.type : "";
	const delta = typeof rec.delta === "string" ? rec.delta : "";
	if (delta.length === 0) return null;
	if (type === "thinking_delta" || type === "reasoning_delta") return { kind: "reasoning", delta };
	if (type === "text_delta") return { kind: "text", delta };
	return null; // toolcall_delta 等：本轮不做（工具卡已有「执行中」态）
}

/** 当前会话 id（优先 pi 传入的 ctx，退回进程内会话身份）。 */
export function resolveSessionId(ctx?: { sessionManager?: { sessionId?: string } } | null): string | null {
	const fromCtx = ctx?.sessionManager?.sessionId;
	if (typeof fromCtx === "string" && fromCtx.length > 0) return fromCtx;
	const sid = getCurrentSessionId();
	return sid !== undefined && sid.length > 0 ? sid : null;
}
