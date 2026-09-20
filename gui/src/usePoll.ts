/**
 * gui/src/usePoll.ts — 分档轮询 hook（拍板 4）。
 *
 * - 立即跑一次 + setInterval 固定档位（2s 增量 / 5-10s 全量由调用方分档）；
 * - `visibilitychange` hidden 暂停、恢复可见立即补一拍（浏览器友好）；
 * - 上一拍未完成不重叠（busy 门）；effect 引用不进依赖（每拍取最新闭包）；
 * - never-throw：api 层不抛，这里再兜一层防渲染副作用外溢。
 */

import { useEffect, useRef } from "react";

export function usePoll(effect: () => void | Promise<void>, intervalMs: number, enabled = true): void {
	const ref = useRef(effect);
	ref.current = effect;

	useEffect(() => {
		if (!enabled) return;
		let stopped = false;
		let busy = false;

		const tick = async (): Promise<void> => {
			if (stopped || busy) return;
			busy = true;
			try {
				await ref.current();
			} catch {
				/* 不可能（api never-throw）；兜底防外溢 */
			} finally {
				busy = false;
			}
		};

		const onVisibility = (): void => {
			if (document.visibilityState === "visible") void tick();
		};

		void tick();
		const id = setInterval(() => {
			if (document.visibilityState === "visible") void tick();
		}, intervalMs);
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			stopped = true;
			clearInterval(id);
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [intervalMs, enabled]);
}
