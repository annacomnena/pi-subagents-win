/**
 * gui/src/sessionFilter.ts — 会话列表过滤谓词（JSX-free 纯函数，供 SessionList 与
 * node 侧冒烟测试 _test_session_first 共用；组件 .tsx 无法被 --experimental-strip-types 直载）。
 *
 * 过滤维度（按仓库分组切片拍板 5 收窄）：title / shortId（sessionId 前 12 位小写）/
 * basename(cwd)（basename 自 SessionList 迁入 workspaceGroup 共用），大小写不敏感子串。
 * 原「全 sessionId / file 全路径 / cwd 全路径」维度移除——basename 冲突由组头全路径 tooltip 兜。
 */

import type { SessionSummary } from "./api/types";
import { basename } from "./workspaceGroup";

export function matchesSessionFilter(s: SessionSummary, query: string): boolean {
	const q = query.trim().toLowerCase();
	if (q.length === 0) return true;
	return (
		s.sessionId.slice(0, 12).toLowerCase().includes(q) ||
		(s.cwd !== null && basename(s.cwd).toLowerCase().includes(q)) ||
		(s.title !== undefined && s.title.toLowerCase().includes(q))
	);
}
