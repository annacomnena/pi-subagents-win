/** 展示层文案小工具：时间/百分比/状态中文映射（无依赖，纯函数；G5.1 人话化）。 */

export function fmtTime(iso: string | null | undefined): string {
	if (!iso) return "—";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function fmtDateTime(iso: string | null | undefined): string {
	if (!iso) return "—";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** 相对时间：「x 秒/分钟/小时前」（超一天显「x 天前」）；完整时间用 title 悬停（RelTime 组件负责）。 */
export function fmtRel(iso: string | null | undefined): string {
	if (!iso) return "—";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	const s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
	if (s < 60) return `${s} 秒前`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m} 分钟前`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h} 小时前`;
	return `${Math.floor(h / 24)} 天前`;
}

/** 压力百分数：统一一位小数；无数据时白话「暂无数据」（G5.1 规格 5/6）。 */
export function fmtPct(pressure: number | undefined | null): string {
	return typeof pressure === "number" && Number.isFinite(pressure) ? `${(pressure * 100).toFixed(1)}%` : "暂无数据";
}

// ── 状态中文映射（仅展示层；store/类型零改动） ──────────────────

export const WS_STATUS_ZH: Record<string, string> = {
	active: "进行中",
	waiting: "等待中",
	blocked: "被阻塞",
	paused: "已暂停",
	completed: "已完成",
	failed: "失败",
};

export const TASK_STATUS_ZH: Record<string, string> = {
	pending: "待处理",
	running: "运行中",
	waiting: "等待中",
	blocked: "被阻塞",
	completed: "已完成",
	failed: "失败",
	cancelled: "已取消",
};

export const RUN_STATUS_ZH: Record<string, string> = {
	created: "已创建",
	dispatched: "已派发",
	running: "运行中",
	waiting: "等待中",
	completed: "已完成",
	failed: "失败",
	cancelled: "已取消",
	orphaned: "已失联",
};

export const PROPOSAL_STATUS_ZH: Record<string, string> = {
	pending: "待处理",
	accepted: "已接受",
	transferring: "交接中",
};

export function zhStatus(map: Record<string, string>, s: string | undefined | null, fallback = "未知"): string {
	return (s !== undefined && s !== null && map[s]) || fallback;
}
