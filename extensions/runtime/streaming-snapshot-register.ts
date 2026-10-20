/**
 * runtime/streaming-snapshot-register.ts — 把流式快照挂到 pi 事件上（2026-10-20）。
 *
 * 独立成文件的原因：`extensions/index.ts` 体积大、且当前有并行会话的未提交改动；
 * 这里只做「注册」这一件事，index.ts 里加**一行** `collect(registerStreamingSnapshot(pi))` 即可。
 *
 * 订阅的事件：
 *   - `message_update`：逐 token 增量（thinking_delta / text_delta）→ 节流累积 → 覆盖写快照
 *   - `message_end`：assistant 消息结束 → 删除快照（正式行随后从 JSONL 投影进来）
 *   - `session_shutdown`：会话关闭 → 停定时器 + 删除快照
 *
 * 红线：never-throw。任何异常都吞掉——流式预览失败不影响对话本身。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	disposeAllStreamingWriters,
	extractDelta,
	resolveSessionId,
	streamingWriterFor,
} from "./streaming-snapshot.ts";

/** 事件处理器的宽松形状（避免对 pi 内部类型产生强耦合）。 */
type AnyEvent = Record<string, unknown>;
type AnyCtx = { sessionManager?: { sessionId?: string } } | null | undefined;

export function registerStreamingSnapshot(pi: ExtensionAPI): () => void {
	try {
		pi.on("message_update", ((event: AnyEvent, ctx: AnyCtx) => {
			try {
				const sessionId = resolveSessionId(ctx);
				if (sessionId === null) return;
				const delta = extractDelta(event.assistantMessageEvent);
				if (delta === null) return;
				streamingWriterFor(sessionId).push(delta.kind, delta.delta);
			} catch {
				/* never-throw */
			}
		}) as never);
	} catch {
		/* 注册失败也不影响对话 */
	}

	try {
		pi.on("message_end", ((event: AnyEvent, ctx: AnyCtx) => {
			try {
				// 只处理 assistant：toolResult / user 结束不该清 assistant 的快照
				const message = event.message as { role?: unknown } | undefined;
				if (message !== undefined && message !== null && message.role !== "assistant") return;
				const sessionId = resolveSessionId(ctx);
				if (sessionId === null) return;
				// finish() 会从 writers 里摘除，下次流式重新建
				streamingWriterFor(sessionId).finish();
			} catch {
				/* never-throw */
			}
		}) as never);
	} catch {
		/* ignore */
	}

	try {
		pi.on("session_shutdown", (() => {
			try {
				disposeAllStreamingWriters();
			} catch {
				/* never-throw */
			}
		}) as never);
	} catch {
		/* ignore */
	}

	// 返回清理函数（与 index.ts 的 collect() 约定一致）
	return () => {
		try {
			disposeAllStreamingWriters();
		} catch {
			/* ignore */
		}
	};
}
