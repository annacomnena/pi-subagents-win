/**
 * gui/src/api/runsScope.ts — `/v1/runs?sessionId=` 的**客户端**规范化（2026-10-26 P1B）。
 *
 * 为什么必须与 A 段服务端同一规则：规范化结果同时决定
 *   ① 过滤（服务端 `parseRunsSessionScope` → `listAsyncRunCards` 的 scope 比较）；
 *   ② ETag 输入（服务端 hash 响应体，`?sessionId=b,a` 与 `?sessionId=a,b` 必须同 ETag）；
 *   ③ 客户端 ETag/缓存 key（`client.ts::api.runs` 用**同一个**规范化串拼 query 与 key）。
 * 三处只要有一处用原始串，就会出现「同一查询两个缓存槽」或「A 的 ETag 校验 B 的响应」。
 *
 * 服务端口径（`extensions/runtime-host/server.ts::parseRunsSessionScope`）：
 *   去重 → `Array.prototype.sort()`（**locale 无关**，不是 `localeCompare`）→ 逗号拼接；
 *   最多 5 个 token；字符集 `[A-Za-z0-9_.:-]`；空 token / 空串 **400**。
 *
 * 客户端侧的差异（有意）：非法/空 token **静默丢弃**，而不是把 400 抛给用户 ——
 * 客户端只可能传「当前会话 id」（`chatActiveId`），传坏值属于程序 bug；把 400 变成
 * 「面板报错」只会让右栏长期红字，而丢弃后请求退化为「无 scope」（本机全量）可见且可诊断。
 * 该退化在 `api.runs` 里是**显式**的：`sessionScopeParam()` 返回 null ⇒ 不带该参数。
 */

/** 单次查询允许的 token 数上限（与服务端 `RUNS_SESSION_SCOPE_MAX_TOKENS` 一致）。 */
export const RUNS_SESSION_SCOPE_MAX_TOKENS = 5;

/** 允许的会话 id 字符集（pi 会话 UUID / `tab_*` 都在内）。与 `server.ts` 同式。 */
export const RUNS_SESSION_ID_CHARS = /^[A-Za-z0-9_.:-]+$/;

/**
 * 规范化会话 scope：去空 → 校验字符集 → 去重 → locale 无关升序 → 截断到上限。
 * 返回**数组**（不拼串：调用方决定如何序列化，便于单测直比）。
 */
export function normalizeSessionScope(ids: readonly (string | null | undefined)[]): string[] {
	const tokens: string[] = [];
	for (const raw of ids) {
		if (typeof raw !== "string") continue;
		const t = raw.trim();
		if (t.length === 0) continue;
		if (!RUNS_SESSION_ID_CHARS.test(t)) continue;
		tokens.push(t);
	}
	return [...new Set(tokens)].sort().slice(0, RUNS_SESSION_SCOPE_MAX_TOKENS);
}

/**
 * 规范化后的 query 值（逗号拼接）；无有效 id ⇒ `null`（= **不带** `sessionId` 参数，
 * 服务端语义为「本机全量」——不是空 scope 的 400）。
 */
export function sessionScopeParam(ids: readonly (string | null | undefined)[]): string | null {
	const n = normalizeSessionScope(ids);
	return n.length === 0 ? null : n.join(",");
}
