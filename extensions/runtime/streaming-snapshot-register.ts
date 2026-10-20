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
import { busyWriterFor, disposeAllBusyWriters } from "./session-busy.ts";

/** 事件处理器的宽松形状（避免对 pi 内部类型产生强耦合）。 */
type AnyEvent = Record<string, unknown>;
type AnyCtx = { sessionManager?: { sessionId?: string } } | null | undefined;

export interface RegisterStreamingSnapshotOptions {
	/** 快照目录（缺省 streamingDir()；测试注入隔离用）。 */
	dir?: string;
	/** busy 标记目录（缺省 busyDir()；测试注入隔离用）。 */
	busyDir?: string;
}

export function registerStreamingSnapshot(pi: ExtensionAPI, opts: RegisterStreamingSnapshotOptions = {}): () => void {
	const dir = opts.dir;
	const busyDirOpt = opts.busyDir;
	const writerFor = (sessionId: string) => streamingWriterFor(sessionId, dir !== undefined ? { dir } : {});
	const busyFor = (sessionId: string) => busyWriterFor(sessionId, busyDirOpt !== undefined ? { dir: busyDirOpt } : {});
	try {
		pi.on("message_update", ((event: AnyEvent, ctx: AnyCtx) => {
			try {
				const sessionId = resolveSessionId(ctx);
				if (sessionId === null) return;
				const delta = extractDelta(event.assistantMessageEvent);
				if (delta === null) return;
				writerFor(sessionId).push(delta.kind, delta.delta);
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
				writerFor(sessionId).finish();
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
			try {
				disposeAllBusyWriters();
			} catch {
				/* never-throw */
			}
		}) as never);
	} catch {
		/* ignore */
	}

	// ── 「会话正忙」标记（2026-10-20，停止按钮可点性）────────────────────
	// 用户实测：按钮只在助手**已产出**后才可点，而「点发送 → 第一个 token 之间」
	// 和「工具跑完 → 下一段输出之间」正是最想按停的时刻。
	// 这里在 turn 开始/结束写 `state/session-busy/<sid>.json`，是 agent 是否在跑的权威信号。
	// 折叠进本文件而不是新增 index.ts 注册行：避免再动那个混着他人改动的文件。
	for (const ev of ["agent_start", "turn_start"] as const) {
		try {
			pi.on(ev, ((_event: AnyEvent, ctx: AnyCtx) => {
				try {
					const sessionId = resolveSessionId(ctx);
					if (sessionId === null) return;
					busyFor(sessionId).begin();
				} catch {
					/* never-throw */
				}
			}) as never);
		} catch {
			/* ignore */
		}
	}
	for (const ev of ["agent_settled", "agent_end"] as const) {
		try {
			pi.on(ev, ((_event: AnyEvent, ctx: AnyCtx) => {
				try {
					const sessionId = resolveSessionId(ctx);
					if (sessionId === null) return;
					busyFor(sessionId).settle();
				} catch {
					/* never-throw */
				}
			}) as never);
		} catch {
			/* ignore */
		}
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
