/**
 * gui/src/useEventStream.ts — G6-P1：WS 事件流 hook（usePoll 的增量升级面，仅供会话页起步；
 * 既有五页轮询零改动）。
 *
 * - 自动重连（1s 起 ×2 退避，封顶 10s）；连接建立/每次重连后用 buildSubscriptions() 取
 *   **最新** base 重订阅（断线续传：seq/logEpoch 由调用方 store 持有）；
 * - ack mode:"snapshot" → 调用方应重 HTTP GET 全量（server 不背大二进制快照）；
 *   resync → 调用方 reGet() 后 bump resyncKey 触发重订阅；
 * - onFrame 回调 ref 化（每拍取最新闭包，usePoll 同款）；never-throw（坏帧忽略）。
 */

import { useEffect, useRef, useState } from "react";
import type { StreamServerFrame, StreamSubscribeMsg } from "./api/types";

export type { StreamServerFrame, StreamSubscribeMsg } from "./api/types";
export type { TranscriptHead as StreamHead } from "./api/types";

export type StreamState = "idle" | "connecting" | "open" | "down";

export interface UseEventStreamOptions {
	/** false → 不建连（页面未激活/无 token）。 */
	enabled: boolean;
	/** WS URL（含 token query；null → 不建连）。 */
	url: string | null;
	/** 连接建立（含每次重连）后调用——返回当前应订阅的消息列表（base 取最新 head）。 */
	buildSubscriptions: () => StreamSubscribeMsg[];
	/** 服务端帧（ack/event/resync/error）。 */
	onFrame: (frame: StreamServerFrame) => void;
	/** resync/snapshot 后调用方重拉全量完成时 bump 此键 → 立即重订阅（不等断线）。 */
	resyncKey?: number;
}

export function useEventStream(opts: UseEventStreamOptions): StreamState {
	const { enabled, url, resyncKey } = opts;
	const ref = useRef(opts);
	ref.current = opts;
	const [state, setState] = useState<StreamState>("idle");

	useEffect(() => {
		if (!enabled || url === null) {
			setState("idle");
			return;
		}
		let stopped = false;
		let ws: WebSocket | null = null;
		let retryTimer: ReturnType<typeof setTimeout> | null = null;
		let attempt = 0;

		const connect = (): void => {
			if (stopped) return;
			setState((s) => (s === "open" ? s : "connecting"));
			try {
				ws = new WebSocket(url);
			} catch {
				scheduleRetry();
				return;
			}
			ws.onopen = () => {
				if (stopped) return;
				attempt = 0;
				setState("open");
				const subs = ref.current.buildSubscriptions();
				for (const m of subs) {
					try {
						ws?.send(JSON.stringify(m));
					} catch {
						/* ignore */
					}
				}
			};
			ws.onmessage = (ev: MessageEvent) => {
				if (stopped) return;
				try {
					const frame = JSON.parse(typeof ev.data === "string" ? ev.data : "") as StreamServerFrame;
					ref.current.onFrame(frame);
				} catch {
					/* 坏帧忽略 */
				}
			};
			ws.onclose = () => {
				if (stopped) return;
				setState("down");
				scheduleRetry();
			};
			ws.onerror = () => {
				try {
					ws?.close();
				} catch {
					/* ignore */
				}
			};
		};

		const scheduleRetry = (): void => {
			if (stopped) return;
			const delay = Math.min(1000 * 2 ** attempt, 10_000);
			attempt += 1;
			retryTimer = setTimeout(connect, delay);
		};

		connect();
		return () => {
			stopped = true;
			if (retryTimer !== null) clearTimeout(retryTimer);
			if (ws !== null) {
				ws.onclose = null;
				ws.onerror = null;
				ws.onmessage = null;
				ws.onopen = null;
				try {
					ws.close();
				} catch {
					/* ignore */
				}
			}
		};
	}, [enabled, url, resyncKey]);

	return state;
}

/** 本机 token：gui-dev 打印的 ?token= URL 进入时捕获 → sessionStorage；后续读缓存。 */
export function hostToken(): string | null {
	try {
		const q = new URLSearchParams(window.location.search).get("token");
		if (q !== null && q.length > 0) {
			window.sessionStorage.setItem("sw-host-token", q);
			return q;
		}
		return window.sessionStorage.getItem("sw-host-token");
	} catch {
		return null;
	}
}

/** WS 流地址（同源 /v1 经 vite proxy ws:true 转发到 runtime-host）。 */
export function streamUrl(token: string | null): string | null {
	const proto = window.location.protocol === "https:" ? "wss" : "ws";
	const q = token !== null ? `?token=${encodeURIComponent(token)}` : "";
	return `${proto}://${window.location.host}/v1/events/stream${q}`;
}
