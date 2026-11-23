/**
 * 模型错误分类、失败判定与同模型重试策略
 * 拆分自 extensions/index.ts (Phase 1.2)
 */

export interface SubagentFailureLike {
	status?: "completed" | "failed" | "cancelled" | string;
	error?: string;
	requestedModel?: string;
	model?: string;
	agent?: string;
	text?: string;
}

export function isRetryableModelFailure(result: SubagentFailureLike): boolean {
	if (result.status !== "failed" || !result.error) return false;
	return classifyModelFailure(result.error, result.requestedModel ?? result.model).retryable;
}

/**
 * Classify provider/model-layer failures so the main agent can act
 * (fallback chain + explicit "switch main model" guidance).
 *
 * Zhipu/GLM package exhaustion commonly surfaces as bare HTTP 429
 * (not a Chinese "套餐" string) — treat those as USAGE_CAP, not soft rate-limit.
 */
export function classifyModelFailure(
	error: string,
	modelHint?: string,
): {
	retryable: boolean;
	kind: "usage_cap" | "rate_limit" | "auth" | "provider" | "provider_network" | "timeout" | "stall" | "wall_budget" | "other";
	label: string;
} {
	const message = error.toLowerCase();
	// 墙钟总预算到点（C2）：优先于 timeout/stall 判定（它是调用方显式设的上限，语义最明确）
	if (/wall-budget-exceeded|wall.?budget/i.test(message)) {
		return { retryable: false, kind: "wall_budget", label: "WALL_BUDGET" };
	}
	const model = (modelHint ?? "").toLowerCase();
	const isZhipuFamily =
		/(^|[\/\s_-])(zhipu|glm|智谱)/i.test(model) ||
		/(zhipu|glm|智谱|bigmodel)/i.test(message);

	// Explicit package / billing wording (CN + EN + common Zhipu codes)
	//
	// ⚠ 2026-11-05 事故（R-22）：opendesign-go 返回
	//   `503 {"code":"database_unavailable","message":"resolve Billing Scope: status 503"}`
	// 其中 `Billing` 被本正则命中 ⇒ 归类 `usage_cap` ⇒ 主 agent 被要求**换模型**
	// （而换模型救不了后端 DB 不可用，只是换个 endpoint 继续撞），且重试退避被乘
	// `usageCapMultiplier`（60s/120s）—— 把一个「几秒就自愈」的瞬时故障当成额度耗尽。
	//
	// 修法（两层，各自可独立验）：
	// ① `billing` 不再单独作为额度证据：要求同时有额度词（quota/credit/额度/套餐…），
	//    或本身就是 429。/ 光一个 `billing` 出现在路径名/服务名里（`resolve Billing Scope`）
	//    不算额度耗尽。
	// ② HTTP 5xx **且带 billing/scope 类字样**时优先于额度判定（见下方护栏）。
	const usageKeyword =
		/(用量|额度|套餐|资源包|余量|余额不足|欠费|over.?quota|quota.?exceed|exceeded.{0,40}quota|usage.?limit|limit.?exceed|token.?limit|out of credit|insufficient.?credit|insufficient.?balance|package.?limit|plan.?limit|subscription.?limit|free.?tier|capacity.?exceed|resource.?exhausted|tokens?.{0,20}(用尽|耗尽|上限)|已达上限|到达上限|超出限额|\b1302\b|\b1113\b)/i.test(
			error,
		);
	const bareQuotaCredit = /\b(quota|credit)\b/i.test(message);
	const usageWording = usageKeyword || bareQuotaCredit;

	const is429 = /\b429\b|too many requests|rate.?limit|throttl/i.test(message);

	// ② 5xx **且带额度类字样**（如 `resolve Billing Scope: status 503`）⇒ 额度词不得抢走 5xx。
	//  这条只在「两者同时出现」时才介入，**不改变任何其它 5xx 的既有归类**
	//  （如 `504 gateway timeout` 仍走下方 timeout 规则、`502 bad gateway` 仍走 connectionish）。
	//  额度耗尽的正常表述是 4xx，不会用 5xx 报；带 5xx 的 billing 字样几乎都是服务内部路径/服务名。
	const http5xx = /\b50[0-4]\b|service unavailable|bad gateway|internal server error/i.test(message);
	// ② 唯一生效路径：**`billing` 已不算额度证据**（见上方①）。5xx 里出现 `billing`/`resolve scope`
	//  这类字样是**服务侧路径名/服务名**，不是额度耗尽。保留下面的显式护栏**只为可读性**：
	//  它不改变结果（`billing` 已不在 usageKeyword 里），但如果有人以后把 `billing` 加回去，
	//  这条护栏能先挡住 503 一类的最危险形状。
	//  注：因为它是冗余的，单独回退它**不会**让测试变红——已实测确认；
	//  完整的旧行为回退（billing 加回 + 删护栏）才会红。这是有意的冗余。
	const billingish = /billing|resolve.{0,20}scope/i.test(message);
	if (http5xx && billingish && !is429) {
		return { retryable: true, kind: "provider_network", label: "PROVIDER_NETWORK" };
	}

	// Zhipu: exhausted package almost always returns 429 → USAGE_CAP (switch model).
	if (usageWording || (is429 && isZhipuFamily)) {
		return { retryable: true, kind: "usage_cap", label: "USAGE_CAP" };
	}

	// Non-Zhipu bare 429 without quota wording: still often hard cap on free tiers;
	// prefer USAGE_CAP guidance so main agent switches model rather than busy-waiting.
	if (is429) {
		// "retry-after" / pure overload → soft rate limit; otherwise treat as cap-like.
		if (/(retry.?after|overloaded|temporarily|try again later)/i.test(message) && !usageWording) {
			return { retryable: true, kind: "rate_limit", label: "RATE_LIMIT" };
		}
		return { retryable: true, kind: "usage_cap", label: "USAGE_CAP" };
	}

	if (/(api key|authentication|unauthorized|forbidden|\b401\b|\b403\b)/i.test(message)) {
		return { retryable: true, kind: "auth", label: "AUTH" };
	}
	// 停顿超时（stall）不是模型/Provider 错误——任务卡住换模型也救不回来，不触发 fallback
	if (/(stall|no output for|stall-timeout|\bstalled\b)/i.test(message)) {
		return { retryable: false, kind: "stall", label: "STALL" };
	}
	if (/(timeout|\b408\b|timed?\s*out)/i.test(message)) {
		return { retryable: true, kind: "timeout", label: "TIMEOUT" };
	}
	// 连接类（provider/网络抖动，**可自愈**）：socket 关闭 / 5xx 无 body / undici 等。
	// 为何单列：这些错此前落到 `other`（retryable:false）⇒ `index.ts:959` 的 fatal 门
	// （`!retryable ⇒ onFatalFailure`）会**立即杀子进程**，零重试、零产出。
	// 2026-10-16 实测：今日 3 条长跑的 `error==="terminated"`（undici socket 提前关闭）与
	// `503 status code (no body)` 均为此形；见 `plans/20261016_terminated_provenance_investigation.md`。
	// 归入 retryable 后：不再 fatal-kill，交由 fallback 链/有界重试处理，终态时明写连接类。
	// 2026-10-18 补：`Connection error.` 是本仓最常见的异步派发失败文案（pi 内核 fetch 层包装），
	// 但它此前**两个正则都不匹配** ⇒ 落 `other`（retryable:false）⇒ `onFatalFailure` ⇒ 子进程
	// 被**立即 SIGTERM，零重试零产出**。实测：同一 argv + 同一 env 手动跑成功、sync 派发成功，
	// 唯独 async 3 连挂，全部 `turns=1 / input=0`（请求根本没发出去就被杀）。
	// 归入 retryable 后不再 fatal-kill，交由 fallback 链/有界重试处理。
	// 注：`fetch failed` 已由下方 `providerish` 命中并归类 `provider`（既有语义，勿动）。
	const connectionish =
		/(\bterminated\b|socket hang ?up|other side closed|premature close|undici|socket closed|\bECONNRESET\b|ECONNREFUSED|\bEPIPE\b|EAI_AGAIN|\bETIMEDOUT\b|\b50[0-4]\b|bad gateway|service unavailable|no body|network error|connection error|connection (?:reset|closed|aborted|refused|timed ?out|error))/i.test(
			error,
		);
	if (connectionish) {
		return { retryable: true, kind: "provider_network", label: "PROVIDER_NETWORK" };
	}
	const providerish =
		/(model.{0,80}(not found|unavailable|may not exist|not exist|no access)|issue with the selected model|provider|\b404\b|econnreset|enotfound|fetch failed|network|service unavailable|cli not found on path|exited with code|agent execution terminated|claude failed|claude error|codex failed|codex error|agy|atomcode|zcode|location is not supported)/i.test(
			message,
		);
	if (providerish) {
		return { retryable: true, kind: "provider", label: "PROVIDER" };
	}
	return { retryable: false, kind: "other", label: "OTHER" };
}

export const SAME_MODEL_RETRY = {
	maxSameModel: 2,
	backoffMs: (attemptIndex: number) => {
		// attemptIndex 从 1 开始（第 1 次重试 = 30s；第 2 次 = 60s；再往上 clamp 到 60s）
		const step = Math.min(Math.max(1, attemptIndex), 2);
		return step * 30_000;
	},
	usageCapMultiplier: 2,
} as const;

/** 绝对禁止同模型重试的分类（重试 100% 毫无意义、只会浪费配额或再吃一次超时） */
export const SAME_MODEL_NEVER_RETRY: ReadonlySet<string> = new Set([
	"wall_budget", // 任务已用尽全局墙钟，必须换或停
	"stall", // 无输出挂死：通常是死锁或模型死循环，同模型再跑一次大概率仍挂
	"auth", // 凭证错误，等 30s 毫无意义
]);

/**
 * 读取当前同模型最大重试次数。
 * env `PI_SUBAGENT_RETRY_MAX` 可覆盖（设为 0 完全关闭同模型重试；
 * 与 `PI_MODEL_COST_TIERS_PATH` / `PI_COST_TIER_ENFORCE` 同风格：env 只做注入，不改 config.json）。
 * 非法值（空串/非数字/负数）⇒ 忽略并保留常量值（不崩、不静默采用怪值）；结果 clamp 到 [0,4]（禁止无限重试）。
 */
export function resolveSameModelRetryMax(): number {
	const clamp = (n: number): number => Math.max(0, Math.min(4, Math.trunc(n)));
	const raw = process.env.PI_SUBAGENT_RETRY_MAX;
	if (raw === undefined || raw.trim() === "") return clamp(SAME_MODEL_RETRY.maxSameModel);
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 0) return clamp(SAME_MODEL_RETRY.maxSameModel);
	return clamp(n);
}

/**
 * 有效退避（毫秒）：默认 `SAME_MODEL_RETRY.backoffMs(n)`（30s/60s，上限 60s）；
 * env `PI_SUBAGENT_RETRY_BACKOFF_MS` 给基准值时 `min(base*n, base*2)`（测试缝隙，非数字/负数/空串忽略）；
 * `usage_cap` 再乘 `usageCapMultiplier`（额度型恢复更慢：60s/120s）。
 */
export function retryBackoffMs(kind: string, n: number): number {
	let ms: number;
	const raw = process.env.PI_SUBAGENT_RETRY_BACKOFF_MS;
	const base = raw !== undefined && raw.trim() !== "" ? Number(raw) : Number.NaN;
	if (Number.isFinite(base) && base >= 0) {
		ms = Math.min(base * n, base * 2);
	} else {
		ms = SAME_MODEL_RETRY.backoffMs(n);
	}
	if (kind === "usage_cap") ms *= SAME_MODEL_RETRY.usageCapMultiplier;
	return Math.max(0, Math.trunc(ms));
}

/** 可被 AbortSignal 打断的 sleep：完成返回 true；被 abort 返回 false（监听器必 remove，不泄漏）。 */
export function sleepAbortable(ms: number, signal?: AbortSignal): Promise<boolean> {
	return new Promise<boolean>((resolve_) => {
		if (signal?.aborted) {
			resolve_(false);
			return;
		}
		let done = false;
		const finish = (ok: boolean) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve_(ok);
		};
		const onAbort = () => finish(false);
		const timer = setTimeout(() => finish(true), ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * 同模型重试耗尽的终态文案：把每次尝试写进 error（含 `retries=<n>/<max>` 字样，供主 agent 判断）。
 * 接在被包装的原始 error 之后（原始 error 一字不改，只在尾部追加记录块）。
 */
export function describeSameModelRetries(args: {
	attempts: Array<{ attempt: number; label: string; error: string }>;
	retries: number;
	max: number;
	label: string;
	fallbackCount: number;
}): string {
	const lines: string[] = [
		`--- 同模型重试记录 retries=${args.retries}/${args.max}（${args.label}）---`,
	];
	for (const a of args.attempts) lines.push(`[${a.attempt}] ${a.error}`);
	lines.push(
		`建议：等 30–60s 用同一 model 重派，或改 model= 覆盖（fallback 候选 ${args.fallbackCount} 个）。`,
	);
	return lines.join("\n");
}

/**
 * Build a main-agent-facing failure block: original error + what was tried +
 * explicit instruction to switch the main session model when usage is capped.
 */
export function formatFailureForMainAgent(result: SubagentFailureLike, triedModels?: string[]): string {
	const err = result.error || result.status || "failed";
	const model =
		result.requestedModel ||
		result.model ||
		"(unknown model)";
	const cls = classifyModelFailure(err, model);
	const tried =
		triedModels && triedModels.length > 0
			? triedModels
			: [model].filter(Boolean);
	const lines: string[] = [
		`[subagent-failure kind=${cls.label} retryable=${cls.retryable}]`,
		`agent=${result.agent ?? "(none)"}`,
		`failed_model=${model}`,
		`tried_models=${tried.join(" → ")}`,
		`error=${err}`,
	];
	if (cls.kind === "usage_cap") {
		lines.push(
			"",
			"ACTION_REQUIRED (main agent):",
			"- This is treated as a package/usage cap (Zhipu/GLM often returns bare HTTP 429 when 套餐用量用尽).",
			"- Do NOT retry the same model (waiting will not restore package quota).",
			"- Pick a same-costTier substitute: a model in the SAME costTier that also lies inside this role's [min,max] interval (check layers with /tiers show),",
			"  then re-run the failed subagent step with model= override or updated /sub-models defaults.",
			"- Never escalate above max or downgrade below min; if every same-costTier substitute is exhausted → STOP and ask the user.",
			"- Prefer a model not on the tried_models list above (avoid Zhipu/glm if that is exhausted).",
		);
	} else if (cls.retryable) {
		lines.push(
			"",
			"ACTION_REQUIRED (main agent):",
			"- Provider/model-layer failure after subagent fallback chain (if any).",
			"- Switch main session model (/model) or pass a different model= override, then retry the step.",
		);
	}
	if (result.text) {
		lines.push("", "--- partial output ---", result.text);
	}
	return lines.join("\n");
}
