/**
 * runtime/session-control-register.ts — 把「会话控制指令」挂到 pi 会话进程（2026-10-20）。
 *
 * 职责：在本进程内消费 `state/session-control/*.json` 里的 pending 请求，调用
 * `ctx.abort()` 之类的**进程内能力**，把结果写回终态。daemon / GUI 只写请求、只读结果。
 *
 * ## 为什么能拿到 ctx
 * `pi.on("session_start", (event, ctx) => ...)` 的第二个参数就是 `ExtensionContext`
 * （含 `abort()` / `isIdle()` / `signal`）。它的 `abort` 是 AgentSession 实例上的闭包，
 * 进程存活期内有效；`/reload` 会 invalidate 旧 runner 并重新 emit `session_start`，
 * 因此这里每次 `session_start` 都**替换** ctx 引用（不缓存跨代）。
 *
 * ## 触发方式：fs.watch（200ms debounce）+ 2s tick 兜底
 * 与 `outbox-bridge` 同范式：watch 提供亚秒响应，tick 兜住 watch 不可用的文件系统。
 * 空闲时 tick 只做一次 readdir，成本可忽略。
 *
 * ## 红线
 * - never-throw：任何异常都吞掉——控制通道坏了不能影响对话本身。
 * - 只处理**本会话**的请求（`sessionId` 精确匹配），不跨会话误伤。
 * - 终态只写一次（`completeControlRequest` 拒绝覆盖）。
 */

import { watch as fsWatch, type FSWatcher } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isSubagent } from "../identity.ts";
import {
	claimControlRequest,
	completeControlRequest,
	defaultControlDir,
	listControlRequests,
	type ControlRequest,
	type ControlResult,
} from "./session-control.ts";

/** 宽松 ctx 形状（避免对 pi 内部类型强耦合；只用到这三样）。 */
interface LooseCtx {
	sessionManager?: { sessionId?: string };
	isIdle?: () => boolean;
	abort?: () => void;
}

export interface RegisterSessionControlOptions {
	/** 控制盘面目录（缺省 controlDir()；测试注入隔离）。 */
	dir?: string;
	/** tick 间隔（缺省 2000ms；测试可调小）。 */
	tickMs?: number;
}

export interface SessionControlHandle {
	/** 手动跑一次消费（测试用；生产由 watch/tick 驱动）。 */
	consumeNow: () => number;
	/** 卸载。 */
	dispose: () => void;
}

/** 执行一条控制动作（纯分支，便于测试直接调）。 */
export function executeControlAction(
	req: ControlRequest,
	ctx: LooseCtx | null,
): { ok: true; result: ControlResult } | { ok: false; error: string } {
	if (req.action !== "abort") return { ok: true, result: "unknown-action" };
	if (ctx === null || typeof ctx.abort !== "function") return { ok: true, result: "stale-ctx" };
	// isIdle 缺失时按「可能在跑」处理：宁可调一次 abort（空闲时 abort 是安全 no-op，
	// 见 agent-session.js:abort 的 `_isAgentRunActive &&` 守卫），也不要静默什么都不做。
	let idle: boolean | null = null;
	try {
		idle = typeof ctx.isIdle === "function" ? ctx.isIdle() : null;
	} catch {
		idle = null;
	}
	if (idle === true) return { ok: true, result: "not-streaming" };
	try {
		ctx.abort();
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
	return { ok: true, result: "aborted" };
}

export function registerSessionControl(pi: ExtensionAPI, opts: RegisterSessionControlOptions = {}): () => void {
	const dir = opts.dir ?? defaultControlDir();
	let ctxRef: LooseCtx | null = null;
	let sid: string | null = null;
	let watcher: FSWatcher | null = null;
	let debounce: ReturnType<typeof setTimeout> | null = null;
	let interval: ReturnType<typeof setInterval> | null = null;
	let sessionGen = 0;

	/** 消费一次：把本会话所有 pending 请求跑掉。返回处理条数。 */
	const consume = (): number => {
		if (sid === null) return 0;
		let n = 0;
		try {
			for (const req of listControlRequests(sid, dir)) {
				if (req.status !== "pending" && req.status !== "running") continue;
				const claimed = claimControlRequest(req.id, `session-control:${sid}`, { dir });
				if (claimed === null) continue; // 别人在飞 / 已终态
				const outcome = executeControlAction(claimed, ctxRef);
				completeControlRequest(claimed.id, outcome, { dir });
				n++;
			}
		} catch {
			/* never-throw */
		}
		return n;
	};

	const stopWatcher = (): void => {
		if (watcher !== null) {
			try {
				watcher.close();
			} catch {
				/* ignore */
			}
			watcher = null;
		}
		if (debounce !== null) {
			clearTimeout(debounce);
			debounce = null;
		}
	};

	const start = (nextCtx: LooseCtx | null): void => {
		const nextSid = nextCtx?.sessionManager?.sessionId;
		if (typeof nextSid !== "string" || nextSid.length === 0) return;
		stopWatcher();
		if (interval !== null) clearInterval(interval);
		const myGen = ++sessionGen;
		sid = nextSid;
		ctxRef = nextCtx;
		const closed = (): boolean => myGen !== sessionGen;
		const run = (): void => {
			if (!closed()) consume();
		};
		// 启动即扫：/reload 后不等首个 tick
		run();
		interval = setInterval(run, opts.tickMs ?? 2000);
		(interval as { unref?: () => void }).unref?.();
		try {
			const w = fsWatch(dir, { persistent: false }, (_ev, filename) => {
				if (!filename || !filename.endsWith(".json")) return;
				if (debounce !== null) clearTimeout(debounce);
				debounce = setTimeout(() => {
					debounce = null;
					run();
				}, 200);
				(debounce as { unref?: () => void }).unref?.();
			});
			w.on("error", () => {
				stopWatcher();
			});
			watcher = w;
		} catch {
			watcher = null; // 目录还不存在 / watch 不可用 → tick 兜底
		}
	};

	try {
		pi.on("session_start", ((_event: unknown, ctx: LooseCtx) => {
			try {
				if (isSubagent()) return;
				start(ctx);
			} catch {
				/* never-throw */
			}
		}) as never);
	} catch {
		/* 注册失败不影响对话 */
	}

	// ctx 刷新：长会话里 session_start 只发生一次，但这些事件会持续带 ctx。
	// 用 message_start（每轮一次，成本极低）把 ctx 引用刷新到最新一代。
	try {
		pi.on("message_start", ((_event: unknown, ctx: LooseCtx) => {
			try {
				if (isSubagent()) return;
				if (ctx !== null && typeof ctx === "object") ctxRef = ctx;
			} catch {
				/* never-throw */
			}
		}) as never);
	} catch {
		/* ignore */
	}

	try {
		pi.on("session_shutdown", (() => {
			sessionGen++;
			sid = null;
			ctxRef = null;
			stopWatcher();
			if (interval !== null) {
				clearInterval(interval);
				interval = null;
			}
		}) as never);
	} catch {
		/* ignore */
	}

	// 清理函数（与 index.ts 的 collect() 约定一致）
	return () => {
		sessionGen++;
		sid = null;
		ctxRef = null;
		stopWatcher();
		if (interval !== null) {
			clearInterval(interval);
			interval = null;
		}
	};
}
