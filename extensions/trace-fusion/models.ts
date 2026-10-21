/**
 * trace-fusion/models.ts — per-call worker 模型解析（参数化 ①，纯函数）
 *
 * 需求：`plans/20261021_trace_fusion_parametrization.md` §1 改动 ①
 * 计划：`plans/20261021_trace_fusion_parametrization_plan.md` V4/R3
 *
 * ## 权威来源（审查 B3/Q3 定夺）
 * 可用模型集**只由调用方注入**（生产 = tool `ctx.modelRegistry.getAvailable()`）。
 * 本模块**不读 models.json / models-store.json** —— 那两个文件只能证明「本地覆盖目录
 * 没列该模型」，不能证明 CLI 不认识它；用它判「不存在」会误拒合法模型。
 *
 * ## 语义边界（如实登记，勿在文档里简化为一句「误报」）
 *   1. `available` 为空 ⇒ `无法验证模型`（fail-closed，不静默回落）；
 *   2. 非空但未命中 ⇒ `本会话不可用/未找到`（措辞不越界成「CLI 全局不存在」）；
 *   3. 父进程列表含、子进程环境（不同 HOME/agentDir/凭据）不含 ⇒ **父校验通过、子进程仍可能失败**。
 *      这是本 seam 无法闭合的边界，属已知未闭合项，不冒称「等价环境」。
 *
 * ## 「非法」与「省略」必须可区分（AGENTS R-5 精神：静默回落不可接受）
 * `undefined` = 省略 ⇒ 沿用 config.workerModel / lane 默认（向后兼容）；
 * 显式空串 / 非字符串 / `cli:` 后端 ⇒ 一律错误，绝不当作「省略」处理。
 */

/** 可用模型条目（与 pi `ctx.modelRegistry.getAvailable()` 元素形状兼容的子集）。 */
export interface AvailableModelRef {
	provider: string;
	id: string;
	name?: string;
}

export type ResolvedWorkerModel =
	| { ok: true; model: string | undefined }
	| { ok: false; error: string };

/** `provider/id` 归一（id 内可能还有 `/`，只按第一个分隔段拆 provider）。 */
function refOf(m: AvailableModelRef): string {
	return `${m.provider}/${m.id}`;
}

function norm(s: string): string {
	return s.trim().toLowerCase();
}

/**
 * 解析 per-call `model` 参数。
 *
 * @param raw      工具参数原值（`undefined` = 省略；其它任何非空正串都要能解析或报错）
 * @param available 本次会话可用模型集（生产 = `ctx.modelRegistry.getAvailable()`）
 */
export function resolveWorkerModel(raw: unknown, available: readonly AvailableModelRef[]): ResolvedWorkerModel {
	// 1) 省略 ≠ 非法
	if (raw === undefined) return { ok: true, model: undefined };
	if (typeof raw !== "string") {
		return { ok: false, error: `model 必须是字符串（收到 ${raw === null ? "null" : typeof raw}）；省略该参数才是沿用 config/默认。` };
	}
	const input = raw.trim();
	if (!input) {
		return { ok: false, error: "model 不能是空串；省略该参数才是沿用 config/默认（显式空值不会被静默当作省略）。" };
	}
	if (input.toLowerCase().startsWith("cli:")) {
		return { ok: false, error: `trace-fusion 的 lane 是 pi 标签页，不接受外部 CLI 后端模型（${input}）；请给 provider/id 或模型短名。` };
	}

	// 去重（同一 provider/id 在多个目录重复登记不算歧义）
	const uniq = new Map<string, AvailableModelRef>();
	for (const m of available) {
		if (!m || typeof m.provider !== "string" || typeof m.id !== "string" || !m.provider || !m.id) continue;
		const key = norm(refOf(m));
		if (!uniq.has(key)) uniq.set(key, m);
	}
	const catalog = [...uniq.values()];

	// 2) canonical `provider/id`：整串比较（保留 id 内 `/`），命中回给 pi 的**canonical 拼写**
	if (input.includes("/")) {
		const hit = catalog.find((m) => norm(refOf(m)) === norm(input));
		if (hit) return { ok: true, model: refOf(hit) };
		if (catalog.length === 0) {
			return { ok: false, error: `无法校验模型 ${input}：本次会话的 modelRegistry 为空（fail-closed，不静默回落）。` };
		}
		return { ok: false, error: `模型本会话不可用：${input}（不在 modelRegistry 可用列表）。可用示例：${catalog.slice(0, 8).map(refOf).join(", ")}` };
	}

	// 3) 短名：只做精确匹配（大小写不敏感），不做子串启发式——近似匹配会静默选错模型
	const lower = norm(input);
	const exact = catalog.filter((m) => norm(m.id) === lower || norm(m.name ?? "") === lower);
	if (exact.length === 1) return { ok: true, model: refOf(exact[0]) };
	if (exact.length > 1) {
		return { ok: false, error: `模型短名歧义："${input}" 命中 ${exact.length} 个（${exact.map(refOf).join(", ")}）；请给 provider/id。` };
	}
	if (catalog.length === 0) {
		return { ok: false, error: `无法校验模型 "${input}"：本次会话的 modelRegistry 为空（fail-closed，不静默回落）。` };
	}
	return { ok: false, error: `模型本会话不可用："${input}" 未匹配任何可用模型的 id/name（不做模糊匹配）。可用示例：${catalog.slice(0, 8).map(refOf).join(", ")}` };
}
