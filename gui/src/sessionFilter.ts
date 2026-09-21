/**
 * gui/src/sessionFilter.ts — 会话列表过滤谓词（JSX-free 纯函数，供 SessionList 与
 * node 侧冒烟测试 _test_session_first 共用；组件 .tsx 无法被 --experimental-strip-types 直载）。
 *
 * 过滤维度：shortId / 全量 sessionId / 文件路径 / cwd / 标题 title（大小写不敏感子串）。
 */

import type { SessionSummary } from "./api/types";

export function matchesSessionFilter(s: SessionSummary, query: string): boolean {
	const q = query.trim().toLowerCase();
	if (q.length === 0) return true;
	return (
		s.sessionId.toLowerCase().includes(q) ||
		s.file.toLowerCase().includes(q) ||
		(s.cwd !== null && s.cwd.toLowerCase().includes(q)) ||
		(s.title !== undefined && s.title.toLowerCase().includes(q))
	);
}
