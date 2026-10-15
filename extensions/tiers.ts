/**
 * tiers — costTier（模型成本层级）派发门 + 维护面
 *
 * 两张正交的表：
 *   1. 角色策略 `config.json.roleTier`（角色 → 允许层级区间，代码默认 DEFAULT_ROLE_TIER）
 *   2. 模型属性 `~/.pi/agent/model-cost-tiers.json`（模型 → 层级，全局、角色无关）
 *
 * 本模块只做纯函数 + `/tiers` 命令面；index.ts 负责接线（派发门挂点、透传）。
 * 命名纪律：只用 `costTier`（free|cheap|standard|premium|selfpaid|unknown），
 * 绝不复用/覆盖既有 `tier` 语义。
 *
 * 命令：
 *   /tiers show                 roleTier + 成本表现状 + 引用模型解析摘要
 *   /tiers set <model> <tier>   写入 table.tiers（原子写）
 *   /tiers rm <model>           删除 table.tiers 条目
 *   /tiers draft                扫已配置模型，输出未标注模型的空白骨架
 *   /tiers check                roleTier 区间 × models/fallbackModels 互校验
 *   /tiers pending              列出「该标注」的模型（unknown ∪ 配置引用未标注）
 *   /tiers usage                按 role × costTier 聚合用量
 *   /tiers role <role> <min> <max> | role <role> clear   编辑 config.roleTier
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// ── 层级与角色默认 ──────────────────────────────────────────────────

export type CostTier = "free" | "cheap" | "standard" | "premium" | "selfpaid" | "unknown";

export const COST_TIERS: CostTier[] = ["free", "cheap", "standard", "premium", "selfpaid", "unknown"];

/** 只有 free..premium 可比较；selfpaid / unknown 的 rank = null（不落任何区间）。 */
export const TIER_RANK: Record<CostTier, number | null> = {
	free: 0,
	cheap: 1,
	standard: 2,
	premium: 3,
	selfpaid: null,
	unknown: null,
};

export interface RoleTierInterval { min: CostTier; max: CostTier; }

export const DEFAULT_ROLE_TIER: Record<string, RoleTierInterval> = {
	searcher: { min: "free", max: "cheap" },
	implementer: { min: "free", max: "cheap" },
	general: { min: "free", max: "cheap" },
	planner: { min: "standard", max: "premium" },
	"plan-reviewer": { min: "standard", max: "premium" },
	"code-reviewer": { min: "standard", max: "premium" },
	consultant: { min: "standard", max: "premium" },
};

const ROLE_TIER_KEYS = Object.keys(DEFAULT_ROLE_TIER);

function isCostTier(value: unknown): value is CostTier {
	return typeof value === "string" && (COST_TIERS as string[]).includes(value);
}

// ── roleTier 归一化（DEFAULT ∪ 合法覆盖）────────────────────────────

/** 收集角色区间里的非法项（未知角色 / 非法 tier / max<min / selfpaid|unknown 边界）。 */
function collectRoleTierIssues(raw: unknown): string[] {
	if (raw === undefined || raw === null) return [];
	if (typeof raw !== "object" || Array.isArray(raw)) return ["roleTier 不是对象，已整体忽略"];
	const issues: string[] = [];
	for (const [role, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!ROLE_TIER_KEYS.includes(role)) {
			issues.push(`未知角色 "${role}"（不在默认 7 键内），已忽略`);
			continue;
		}
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			issues.push(`角色 "${role}" 的区间不是对象，已忽略`);
			continue;
		}
		const { min, max } = value as { min?: unknown; max?: unknown };
		if (!isCostTier(min) || !isCostTier(max)) {
			issues.push(`角色 "${role}" 的 min/max 非法（须为 ${COST_TIERS.join("|")}），已忽略`);
			continue;
		}
		if (TIER_RANK[min] === null || TIER_RANK[max] === null) {
			issues.push(`角色 "${role}" 的 min/max 为 selfpaid|unknown（不可比较），已忽略`);
			continue;
		}
		if (TIER_RANK[max]! < TIER_RANK[min]!) {
			issues.push(`角色 "${role}" 的 max(${max}) < min(${min})，已忽略`);
		}
	}
	return issues;
}

/** DEFAULT_ROLE_TIER ∪ 合法覆盖；未知角色 / 非法值 → 忽略并记录（console.warn），never-throw。 */
export function normalizeRoleTier(raw: unknown): Record<string, RoleTierInterval> {
	const merged: Record<string, RoleTierInterval> = {};
	for (const role of ROLE_TIER_KEYS) merged[role] = { ...DEFAULT_ROLE_TIER[role] };
	for (const issue of collectRoleTierIssues(raw)) console.warn(`[tiers] ${issue}`);
	if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		for (const [role, value] of Object.entries(raw as Record<string, unknown>)) {
			if (!ROLE_TIER_KEYS.includes(role)) continue;
			const { min, max } = (value ?? {}) as { min?: unknown; max?: unknown };
			if (!isCostTier(min) || !isCostTier(max)) continue;
			if (TIER_RANK[min] === null || TIER_RANK[max] === null) continue;
			if (TIER_RANK[max]! < TIER_RANK[min]!) continue;
			merged[role] = { min, max };
		}
	}
	return merged;
}

function tierInInterval(tier: CostTier, interval: RoleTierInterval): boolean {
	const rank = TIER_RANK[tier];
	const minRank = TIER_RANK[interval.min];
	const maxRank = TIER_RANK[interval.max];
	if (rank === null || minRank === null || maxRank === null) return false;
	return rank >= minRank && rank <= maxRank;
}

// ── 全局成本小表 ────────────────────────────────────────────────────

export interface ModelCostTiersTable {
	version: 1;
	tiers: Record<string, string>;
	byProvider: Record<string, string>;
	patterns: { match: string; tier: string }[];
}

/** 缺省表：带一个非枚举的 `present:false` 运行时标记（不进入 JSON、不进导出接口）。 */
function emptyTable(): ModelCostTiersTable {
	const table: ModelCostTiersTable = { version: 1, tiers: {}, byProvider: {}, patterns: [] };
	Object.defineProperty(table, "present", { value: false, enumerable: false, writable: false });
	return table;
}

function tablePresent(table: ModelCostTiersTable | undefined): boolean {
	if (!table || typeof table !== "object") return false;
	return (table as { present?: boolean }).present !== false;
}

export function costTiersPath(): string {
	const override = process.env.PI_MODEL_COST_TIERS_PATH;
	return override && override.trim() ? override : join(homedir(), ".pi", "agent", "model-cost-tiers.json");
}

function normalizeTable(parsed: unknown): ModelCostTiersTable | null {
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const raw = parsed as Record<string, unknown>;
	if (raw.version !== 1) return null;
	const table: ModelCostTiersTable = { version: 1, tiers: {}, byProvider: {}, patterns: [] };
	for (const key of ["tiers", "byProvider"] as const) {
		const source = raw[key];
		if (!source || typeof source !== "object" || Array.isArray(source)) continue;
		for (const [name, tier] of Object.entries(source as Record<string, unknown>)) {
			if (isCostTier(tier)) table[key][name] = tier;
		}
	}
	if (Array.isArray(raw.patterns)) {
		for (const entry of raw.patterns) {
			if (!entry || typeof entry !== "object") continue;
			const { match, tier } = entry as { match?: unknown; tier?: unknown };
			if (typeof match === "string" && match && isCostTier(tier)) table.patterns.push({ match, tier });
		}
	}
	return table;
}

/** 缺省 / 坏 JSON / 版本不符 → { present:false, table:emptyTable() }，never-throw。 */
export function loadCostTiers(path?: string): { present: boolean; table: ModelCostTiersTable } {
	try {
		const parsed = JSON.parse(readFileSync(path ?? costTiersPath(), "utf8"));
		const table = normalizeTable(parsed);
		return table ? { present: true, table } : { present: false, table: emptyTable() };
	} catch {
		return { present: false, table: emptyTable() };
	}
}

// ── 模型 → costTier 解析（越具体越优先）────────────────────────────

/** glob → 正则：`*` 任意字符（含 `/`）、`?` 单字符，其余元字符转义。 */
function globToRegExp(pattern: string): RegExp {
	let body = "";
	for (const ch of pattern) {
		if (ch === "*") body += ".*";
		else if (ch === "?") body += ".";
		else body += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${body}$`);
}

/** tiers[全名] > patterns（首个命中，全名或尾部 id）> byProvider[provider] > unknown。 */
export function resolveCostTier(model: string | undefined, table: ModelCostTiersTable): CostTier {
	const name = typeof model === "string" ? model.trim() : "";
	if (!name) return "unknown";
	const tiers = table?.tiers ?? {};
	if (isCostTier(tiers[name])) return tiers[name];
	const slash = name.indexOf("/");
	const id = slash >= 0 ? name.slice(slash + 1) : name;
	for (const pattern of table?.patterns ?? []) {
		if (typeof pattern?.match !== "string" || !pattern.match || !isCostTier(pattern?.tier)) continue;
		const re = globToRegExp(pattern.match);
		if (re.test(name) || (id !== name && re.test(id))) return pattern.tier;
	}
	const provider = slash >= 0 ? name.slice(0, slash) : "";
	if (provider && isCostTier(table?.byProvider?.[provider])) return table.byProvider[provider] as CostTier;
	return "unknown";
}

// ── 派发门判定 ────────────────────────────────────────────────────

export type GateCode =
	| "ok"
	| "table_missing"
	| "in_range"
	| "unknown_override"
	| "unknown_blocked"
	| "selfpaid_override"
	| "selfpaid_blocked"
	| "out_of_range_blocked"
	| "escalated";

export interface GateDecision {
	allowed: boolean;
	code: GateCode;
	tier: CostTier;
	message: string;
	warn?: boolean;
	side?: "above-max" | "below-min";
}

function intervalText(interval: RoleTierInterval | undefined): string {
	return interval ? `[${interval.min},${interval.max}]` : "[-,-]";
}

/** 错误信息固定 4 要素：越了哪一侧 / 角色区间 / 当前模型层级 / 怎么改。 */
function fixHint(role: string, model: string): string {
	return `修复：/tiers set ${model || "<model>"} <tier> 重新标注，`
		+ `/tiers role ${role || "<role>"} <min> <max> 调整区间；`
		+ "主会话可在派发时加 allowTierEscalation:true 升层（须显式向用户报告）";
}

function tierBlockMessage(
	role: string,
	model: string,
	tier: CostTier,
	interval: RoleTierInterval | undefined,
	side: "above-max" | "below-min" | undefined,
	detail: string,
): string {
	return `[subagent-tier-blocked role=${role || "(none)"} model=${model || "(none)"} tier=${tier} `
		+ `interval=${intervalText(interval)} side=${side ?? "-"}] ${detail}`;
}

function gateNote(message: string): string {
	return `[subagent-tier-gate] ${message}`;
}

/** 门判定矩阵（10 行）。roleTier 传合并后的表；roleTier[role] 缺省时回退 DEFAULT_ROLE_TIER。 */
export function checkDispatchTier(args: {
	role?: string;
	model?: string;
	table: ModelCostTiersTable;
	roleTier: Record<string, RoleTierInterval>;
	explicitOverride: boolean;
	allowTierEscalation: boolean;
	mainCall: boolean;
}): GateDecision {
	const role = args.role ?? "";
	const model = args.model ?? "";
	const tier = resolveCostTier(args.model, args.table);

	// 1) 表缺失 → 放行（全部 unknown，指引「同层替身，找不到停下问人」）
	if (!tablePresent(args.table)) {
		return {
			allowed: true, code: "table_missing", tier: "unknown",
			message: gateNote(`成本表缺失（${costTiersPath()}），全部 unknown → 放行。`
				+ "请在候选里找 same-costTier 替身（/tiers show 查层）；同层替身全用尽则停下问人。"),
		};
	}

	// 10) 兜底：roleTier[role] 缺省 → DEFAULT_ROLE_TIER[role]；再无 → 报错拒绝（不静默放行）
	const interval = role ? (args.roleTier?.[role] ?? DEFAULT_ROLE_TIER[role]) : undefined;
	if (!interval) {
		return {
			allowed: false, code: "unknown_blocked", tier,
			message: tierBlockMessage(role, model, tier, undefined, undefined,
				`角色 "${role || "(none)"}" 未定义层级区间（不在默认 7 键内、也未在 config.roleTier 中定义），拒绝派发。`
				+ fixHint(role, model)),
		};
	}

	// 6/7) unknown：仅主会话显式覆盖/升层可放行（+告警）
	if (tier === "unknown") {
		if (args.mainCall && (args.explicitOverride || args.allowTierEscalation)) {
			return {
				allowed: true, code: "unknown_override", tier, warn: true,
				message: gateNote(`模型 "${model}" 层级 unknown，角色 "${role}" 区间 ${intervalText(interval)}；`
					+ "主会话显式 override → 放行，但必须向用户报告「层级未知」。"),
			};
		}
		return {
			allowed: false, code: "unknown_blocked", tier,
			message: tierBlockMessage(role, model, tier, interval, undefined,
				`模型未标注层级（unknown），不满足主会话显式覆盖条件 → 一律拦。` + fixHint(role, model)),
		};
	}

	// 8/9) selfpaid：默认不落任何区间，仅主会话显式点名可用
	if (tier === "selfpaid") {
		if (args.mainCall && (args.explicitOverride || args.allowTierEscalation)) {
			return {
				allowed: true, code: "selfpaid_override", tier, warn: true,
				message: gateNote(`模型 "${model}" 为 selfpaid，角色 "${role}" 区间 ${intervalText(interval)}；`
					+ "主会话显式 override → 放行（自费额度），必须向用户报告。"),
			};
		}
		return {
			allowed: false, code: "selfpaid_blocked", tier,
			message: tierBlockMessage(role, model, tier, interval, undefined,
				"模型为 selfpaid（不参与层级比较、默认不落任何角色区间），非主会话显式点名 → 拦。" + fixHint(role, model)),
		};
	}

	// 2/3/4/5) free..premium：按 rank 比较
	const rank = TIER_RANK[tier];
	const minRank = TIER_RANK[interval.min];
	const maxRank = TIER_RANK[interval.max];
	if (rank === null || minRank === null || maxRank === null) {
		return {
			allowed: false, code: "out_of_range_blocked", tier, side: "above-max",
			message: tierBlockMessage(role, model, tier, interval, "above-max",
				`角色 "${role}" 的区间 ${intervalText(interval)} 含不可比较边界（selfpaid|unknown），无法判定 → 拦。` + fixHint(role, model)),
		};
	}
	if (rank < minRank) {
		// 5) 低于 min → 任意情况硬拦
		return {
			allowed: false, code: "out_of_range_blocked", tier, side: "below-min",
			message: tierBlockMessage(role, model, tier, interval, "below-min",
				`模型层级 ${tier} 低于角色 "${role}" 区间下界 ${interval.min}（below-min）→ 硬拦拒派发。` + fixHint(role, model)),
		};
	}
	if (rank > maxRank) {
		// 3) 高于 max 且主会话允许升层 → 放行 + 告警；4) 否则硬拦
		if (args.mainCall && args.allowTierEscalation) {
			return {
				allowed: true, code: "escalated", tier, warn: true, side: "above-max",
				message: gateNote(`已升层 escalated：模型 "${model}" 层级 ${tier} > 角色 "${role}" 区间上界 ${interval.max}`
					+ `（interval ${intervalText(interval)}），allowTierEscalation=true → 放行；必须向用户显式报告 tier_escalated。`),
			};
		}
		return {
			allowed: false, code: "out_of_range_blocked", tier, side: "above-max",
			message: tierBlockMessage(role, model, tier, interval, "above-max",
				`模型层级 ${tier} 高于角色 "${role}" 区间上界 ${interval.max}（above-max）→ 硬拦拒派发。` + fixHint(role, model)),
		};
	}

	// 2) 区间内 → 放行
	return {
		allowed: true, code: "in_range", tier,
		message: gateNote(`层级 ${tier} 落在角色 "${role}" 区间 ${intervalText(interval)} 内 → 放行。`),
	};
}

// ── 配置互校验（roleTier × models/fallbackModels）──────────────────

export interface TierContradiction {
	role: string;
	field: "models" | "fallbackModels";
	model: string;
	tier: CostTier;
	interval: RoleTierInterval;
}

/**
 * 已标注且越界 → errors（硬错）；未标注 → unknown（pending，非错）；表缺失 → skipped（fail-soft）。
 * 未知角色 key：无区间可比，跳过（由 /tiers check 单独报 roleTier 非法项）。
 */
export function validateRoleTierAgainstModels(
	cfg: { roleTier?: any; models: Record<string, string>; fallbackModels: Record<string, string[]> },
	table: ModelCostTiersTable,
): {
	errors: TierContradiction[];
	unknown: Array<{ role: string; field: string; model: string }>;
	skipped: boolean;
} {
	const errors: TierContradiction[] = [];
	const unknown: Array<{ role: string; field: string; model: string }> = [];
	if (!tablePresent(table)) return { errors, unknown, skipped: true };

	const merged = normalizeRoleTier(cfg?.roleTier);
	const roles = new Set<string>([
		...Object.keys(merged),
		...Object.keys(cfg?.models ?? {}),
		...Object.keys(cfg?.fallbackModels ?? {}),
	]);
	for (const role of roles) {
		const interval = merged[role] ?? DEFAULT_ROLE_TIER[role];
		if (!interval) continue;
		const check = (field: "models" | "fallbackModels", model: string): void => {
			const tier = resolveCostTier(model, table);
			if (tier === "unknown") { unknown.push({ role, field, model }); return; }
			if (!tierInInterval(tier, interval)) errors.push({ role, field, model, tier, interval });
		};
		const primary = cfg?.models?.[role];
		if (typeof primary === "string" && primary) check("models", primary);
		for (const fallback of cfg?.fallbackModels?.[role] ?? []) {
			if (typeof fallback === "string" && fallback) check("fallbackModels", fallback);
		}
	}
	return { errors, unknown, skipped: false };
}

// ── 用量聚合（role × costTier）─────────────────────────────────────

interface UsageBucketLike {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
	count: number;
}

function numOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function costOf(usage: any): number {
	if (typeof usage?.cost === "number") return numOrZero(usage.cost);
	return numOrZero(usage?.cost?.total);
}

function addToBucket(map: Map<string, UsageBucketLike>, key: string, usage: any): void {
	let bucket = map.get(key);
	if (!bucket) {
		bucket = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, count: 0 };
		map.set(key, bucket);
	}
	bucket.input += numOrZero(usage?.input);
	bucket.output += numOrZero(usage?.output);
	bucket.cacheRead += numOrZero(usage?.cacheRead);
	bucket.cacheWrite += numOrZero(usage?.cacheWrite);
	bucket.cost += costOf(usage);
	bucket.turns += numOrZero(usage?.turns);
	bucket.count += 1;
}

/**
 * role = ledger 行的 agent（null/空 → "(unattributed)"）；costTier 由 resolveCostTier join。
 * byRoleTier 的键为 `role|costTier`。
 */
export function aggregateUsageByRoleAndTier(
	records: Array<{ agent?: string | null; model?: string | null; usage: any }>,
	table: ModelCostTiersTable,
): { byRole: Map<string, UsageBucketLike>; byRoleTier: Map<string, UsageBucketLike>; byTier: Map<string, UsageBucketLike> } {
	const byRole = new Map<string, UsageBucketLike>();
	const byRoleTier = new Map<string, UsageBucketLike>();
	const byTier = new Map<string, UsageBucketLike>();
	for (const record of records ?? []) {
		const role = typeof record?.agent === "string" && record.agent ? record.agent : "(unattributed)";
		const model = typeof record?.model === "string" ? record.model : undefined;
		const tier = resolveCostTier(model, table);
		addToBucket(byRole, role, record?.usage);
		addToBucket(byRoleTier, `${role}|${tier}`, record?.usage);
		addToBucket(byTier, tier, record?.usage);
	}
	return { byRole, byRoleTier, byTier };
}

// ── 命令面基础设施 ───────────────────────────────────────────────

function localDayBounds(): { label: string; startMs: number; endMs: number } {
	const now = new Date();
	const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const end = new Date(start);
	end.setDate(end.getDate() + 1);
	const pad = (n: number): string => String(n).padStart(2, "0");
	return {
		label: `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`,
		startMs: start.getTime(),
		endMs: end.getTime(),
	};
}

/** 配置里引用的模型（models ∪ fallbackModels），去重排序。 */
function referencedModels(cfg: { models?: Record<string, string>; fallbackModels?: Record<string, string[]> }): string[] {
	const out = new Set<string>();
	for (const model of Object.values(cfg?.models ?? {})) if (typeof model === "string" && model) out.add(model);
	for (const chain of Object.values(cfg?.fallbackModels ?? {})) {
		for (const model of chain ?? []) if (typeof model === "string" && model) out.add(model);
	}
	return [...out].sort();
}

/** 扫 ~/.pi/agent/models.json + ~/.pi/agent/models-store.json，抽 `provider/id`。 */
function listStoreModels(): string[] {
	const out = new Set<string>();
	const add = (provider: string, id: unknown): void => {
		if (typeof id !== "string" || !id) return;
		out.add(provider && !id.includes("/") ? `${provider}/${id}` : id);
	};
	const readJson = (path: string): any => {
		try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
	};
	const agentModels = readJson(join(homedir(), ".pi", "agent", "models.json"));
	for (const [provider, value] of Object.entries<any>(agentModels?.providers ?? {})) {
		for (const model of value?.models ?? []) add(provider, model?.id);
	}
	const store = readJson(join(homedir(), ".pi", "agent", "models-store.json"));
	for (const [provider, value] of Object.entries<any>(store ?? {})) {
		for (const model of value?.models ?? []) add(provider, model?.id);
	}
	return [...out].sort();
}

/** tmp + rename 原子写（对齐 writeConfig 的 EPERM×3 重试）。 */
function writeTiersFile(table: ModelCostTiersTable): string {
	const path = costTiersPath();
	mkdirSync(dirname(path), { recursive: true });
	const payload = JSON.stringify({ version: 1, tiers: table.tiers, byProvider: table.byProvider, patterns: table.patterns }, null, 2) + "\n";
	const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
	writeFileSync(tmp, payload);
	for (let attempt = 0; ; attempt++) {
		try {
			renameSync(tmp, path);
			return path;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "EPERM" && attempt < 3) {
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
				continue;
			}
			try { unlinkSync(tmp); } catch { /* ignore */ }
			throw e;
		}
	}
}

function fmtBucket(bucket: UsageBucketLike | undefined): string {
	if (!bucket) return "0 req, 0 tok, $0.0000";
	return `${bucket.count} req, ${bucket.input + bucket.output} tok, $${bucket.cost.toFixed(4)}`;
}

// ── 子命令实现 ────────────────────────────────────────────────────

interface TiersDeps {
	reloadConfig: () => any;
	writeConfig: (cfg: any) => void;
	readUsageRecords: (day: { label: string; startMs: number; endMs: number }) => Array<{ agent?: string | null; model?: string | null; usage: any }>;
	notifyOnce?: (msg: string) => void;
}

let unknownNotified = false;

/** M5：会话内只提醒一次（进程 = 主会话生命周期）。 */
function notifyUnknownOnce(deps: TiersDeps, count: number): void {
	if (unknownNotified) return;
	unknownNotified = true;
	if (deps.notifyOnce) deps.notifyOnce(`[tiers] ${count} 个模型未标注 costTier（/tiers pending 查看）；未标注模型在非主会话一律拦。`);
}

function sortedEntries<T>(map: Map<string, T>): Array<[string, T]> {
	return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function cmdShow(ctx: ExtensionCommandContext, deps: TiersDeps): void {
	const cfg = deps.reloadConfig();
	const merged = normalizeRoleTier(cfg?.roleTier);
	const loaded = loadCostTiers();
	const lines: string[] = ["roleTier（默认 ∪ config 覆盖）："];
	for (const role of Object.keys(merged).sort()) {
		const overridden = cfg?.roleTier?.[role] ? " (覆盖)" : "";
		lines.push(`  ${role.padEnd(15)} [${merged[role].min},${merged[role].max}]${overridden}`);
	}
	const table = loaded.table;
	lines.push(loaded.present
		? `成本表：${costTiersPath()} — tiers ${Object.keys(table.tiers).length} / byProvider ${Object.keys(table.byProvider).length} / patterns ${table.patterns.length}`
		: `成本表：${costTiersPath()} — 缺失（全部 unknown，门放行）`);
	lines.push("引用模型 → 解析层级：");
	for (const model of referencedModels(cfg)) {
		const tier = resolveCostTier(model, loaded.table);
		lines.push(`  ${model} → ${tier}${tier === "unknown" ? " ⚠" : ""}`);
	}
	ctx.ui.notify(lines.join("\n"), "info");
}

function cmdSet(ctx: ExtensionCommandContext, deps: TiersDeps, model: string | undefined, tier: string | undefined): void {
	if (!model || !isCostTier(tier)) {
		ctx.ui.notify(`用法: /tiers set <provider/id> <${COST_TIERS.join("|")}>`, "error");
		return;
	}
	try {
		const cfg = deps.reloadConfig();
		const loaded = loadCostTiers();
		loaded.table.tiers[model] = tier;
		// 写前 roleTier 互校验（对齐 cmdRole 语义）：硬矛盾拒写，unknown 不拒，表缺失 fail-soft。
		// 防一条错标（如把 planner 主模型标 cheap）静默打挂 planner 全链。
		const report = validateRoleTierAgainstModels(cfg, loaded.table);
		if (report.errors.length > 0) {
			ctx.ui.notify("✗ 写前互校验失败，未写盘：\n" + report.errors
				.map((e) => `  ${e.role}.${e.field} = ${e.model}（tier ${e.tier}）不在 [${e.interval.min},${e.interval.max}]`)
				.join("\n"), "error");
			return;
		}
		const path = writeTiersFile(loaded.table);
		ctx.ui.notify(`✅ ${model} → ${tier}（写入 ${path}）`, "info");
	} catch (e) {
		ctx.ui.notify(`✗ 写表失败：${(e as Error).message}`, "error");
	}
}

function cmdRm(ctx: ExtensionCommandContext, _deps: TiersDeps, model: string | undefined): void {
	if (!model) {
		ctx.ui.notify("用法: /tiers rm <provider/id>", "error");
		return;
	}
	try {
		const loaded = loadCostTiers();
		if (!(model in loaded.table.tiers)) {
			ctx.ui.notify(`表里没有 ${model}（仅 tiers 显式标注可 rm；patterns/byProvider 请手改文件）`, "warning");
			return;
		}
		delete loaded.table.tiers[model];
		const path = writeTiersFile(loaded.table);
		ctx.ui.notify(`🧹 已删除 ${model}（写入 ${path}）`, "info");
	} catch (e) {
		ctx.ui.notify(`✗ 写表失败：${(e as Error).message}`, "error");
	}
}

function cmdRole(ctx: ExtensionCommandContext, deps: TiersDeps, parts: string[]): void {
	const role = parts[1];
	const cfg = deps.reloadConfig();
	const raw: Record<string, RoleTierInterval> = { ...(cfg?.roleTier ?? {}) };
	if (!role) {
		ctx.ui.notify("用法: /tiers role <role> <min> <max>  |  /tiers role <role> clear", "error");
		return;
	}
	if (parts[2] === "clear") {
		delete raw[role];
	} else {
		const min = parts[2];
		const max = parts[3];
		if (!isCostTier(min) || !isCostTier(max) || TIER_RANK[min] === null || TIER_RANK[max] === null || TIER_RANK[max] < TIER_RANK[min]) {
			ctx.ui.notify(`用法: /tiers role ${role} <min> <max>（free..premium，且 min ≤ max）`, "error");
			return;
		}
		raw[role] = { min, max };
	}
	const loaded = loadCostTiers();
	const next = { ...cfg, roleTier: raw };
	const report = validateRoleTierAgainstModels(next, loaded.table);
	if (report.errors.length > 0) {
		ctx.ui.notify("✗ 反向校验失败，未写盘：\n" + report.errors
			.map((e) => `  ${e.role}.${e.field} = ${e.model}（tier ${e.tier}）不在 [${e.interval.min},${e.interval.max}]`)
			.join("\n"), "error");
		return;
	}
	const writeCfg = { ...cfg };
	if (Object.keys(raw).length > 0) writeCfg.roleTier = raw;
	else delete writeCfg.roleTier;
	deps.writeConfig(writeCfg);
	deps.reloadConfig();
	ctx.ui.notify(`✅ roleTier.${role} → ${raw[role] ? `[${raw[role].min},${raw[role].max}]` : "(默认)"}`, "info");
}

function cmdDraft(ctx: ExtensionCommandContext, deps: TiersDeps): void {
	const cfg = deps.reloadConfig();
	const loaded = loadCostTiers();
	const referenced = new Set(referencedModels(cfg));
	const all = [...new Set([...referenced, ...listStoreModels()])].sort();
	const pending = all.filter((model) => resolveCostTier(model, loaded.table) === "unknown");
	if (pending.length === 0) {
		ctx.ui.notify("所有已知模型都已标注 costTier ✅", "info");
		return;
	}
	const lines = [`待判模型（${pending.length}）—— 不猜层，请人工判层后 /tiers set <model> <tier>：`];
	for (const model of pending.slice(0, 200)) lines.push(`  ${referenced.has(model) ? "★" : " "} ${model}`);
	if (pending.length > 200) lines.push(`  ...（共 ${pending.length}，已截断）`);
	const skeleton: Record<string, string> = {};
	for (const model of pending) skeleton[model] = "";
	lines.push("", `空白骨架（填 tier 后手改或逐个 /tiers set；目标文件 ${costTiersPath()}）：`,
		JSON.stringify({ version: 1, tiers: skeleton, byProvider: {}, patterns: [] }, null, 2));
	ctx.ui.notify(lines.join("\n"), "info");
}

function cmdCheck(ctx: ExtensionCommandContext, deps: TiersDeps): void {
	const cfg = deps.reloadConfig();
	const loaded = loadCostTiers();
	const lines: string[] = [];
	const issues = collectRoleTierIssues(cfg?.roleTier);
	if (issues.length > 0) {
		lines.push("roleTier 非法项：");
		for (const issue of issues) lines.push(`  ⚠ ${issue}`);
	}
	const report = validateRoleTierAgainstModels(cfg, loaded.table);
	if (report.skipped) {
		lines.push(`成本表缺失（${costTiersPath()}）→ 跳过区间校验（fail-soft）；先 /tiers draft 建表。`);
	} else {
		for (const e of report.errors) {
			lines.push(`  ✗ ${e.role}.${e.field} = ${e.model}（tier ${e.tier}）不在 [${e.interval.min},${e.interval.max}]`);
		}
		if (report.errors.length === 0 && issues.length === 0) lines.push("✓ 无区间矛盾。");
	}
	if (report.unknown.length > 0) {
		lines.push(`未标注（pending，${report.unknown.length}）：`);
		for (const u of report.unknown) lines.push(`  ⚠ ${u.role}.${u.field} = ${u.model}`);
		notifyUnknownOnce(deps, report.unknown.length);
	}
	ctx.ui.notify(lines.join("\n") || "✓ 无区间矛盾。", report.errors.length > 0 ? "error" : "info");
}

function cmdPending(ctx: ExtensionCommandContext, deps: TiersDeps): void {
	const cfg = deps.reloadConfig();
	const loaded = loadCostTiers();
	const need = new Set(referencedModels(cfg).filter((model) => resolveCostTier(model, loaded.table) === "unknown"));
	if (need.size === 0) {
		ctx.ui.notify("pending: 无（配置引用的模型均已标注）", "info");
		return;
	}
	ctx.ui.notify(`pending 待标注模型（${need.size}）：\n`
		+ [...need].sort().map((model) => `  ${model}`).join("\n")
		+ "\n用 /tiers set <model> <tier> 标注，或 /tiers draft 看骨架。", "warning");
	notifyUnknownOnce(deps, need.size);
}

function cmdUsage(ctx: ExtensionCommandContext, deps: TiersDeps): void {
	const loaded = loadCostTiers();
	const day = localDayBounds();
	const records = deps.readUsageRecords(day) ?? [];
	const agg = aggregateUsageByRoleAndTier(records, loaded.table);
	const lines = [`用量聚合（${day.label}，${records.length} 条账本记录；成本表 ${loaded.present ? "present" : "缺失 → 全 unknown"}）：`];
	lines.push("byRole:");
	for (const [role, bucket] of sortedEntries(agg.byRole)) lines.push(`  ${role.padEnd(18)} ${fmtBucket(bucket)}`);
	lines.push("byRole × costTier:");
	for (const [key, bucket] of sortedEntries(agg.byRoleTier)) lines.push(`  ${key.padEnd(30)} ${fmtBucket(bucket)}`);
	const unknownCount = agg.byTier.get("unknown")?.count ?? 0;
	const pct = records.length > 0 ? ((unknownCount / records.length) * 100).toFixed(1) : "0.0";
	lines.push(`未标注模型占比：${unknownCount}/${records.length}（${pct}%）${unknownCount > 0 ? " — 用 /tiers draft 自愈" : ""}`);
	ctx.ui.notify(lines.join("\n"), "info");
}

const TIERS_HELP = [
	"用法: /tiers <show|set|rm|draft|check|pending|usage|role>",
	"  show                      roleTier 区间 + 成本表现状 + 引用模型解析",
	"  set <provider/id> <tier>  标注模型层级（写前 roleTier 互校验；原子写 model-cost-tiers.json）",
	"  rm <provider/id>          删除 tiers 显式标注",
	"  draft                     扫已配置模型，输出未标注模型的空白骨架",
	"  check                     roleTier 区间 × models/fallbackModels 互校验",
	"  pending                   列出「被引用但未标注」的模型",
	"  usage                     按 role × costTier 聚合当日用量",
	"  role <role> <min> <max>   编辑 config.roleTier 区间（| role <role> clear）",
	`tier 取值: ${COST_TIERS.join("|")}；成本表: ${costTiersPath()}`,
].join("\n");

// ── 命令注册 ──────────────────────────────────────────────────────

const TIERS_ACTIONS = [
	"show 查看区间与解析",
	"set 标注模型层级",
	"rm 删除标注",
	"draft 生成待判骨架",
	"check 校验区间",
	"pending 待标注清单",
	"usage 用量聚合",
	"role 编辑角色区间",
];

export function registerTiersCommand(pi: any, deps: TiersDeps): void {
	pi.registerCommand("tiers", {
		description: "costTier 派发门维护面：show/set/rm/draft/check/pending/usage/role",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			let action = (parts[0] ?? "").toLowerCase();

			if (!action) {
				if (!ctx.hasUI) {
					ctx.ui.notify(TIERS_HELP, "info");
					return;
				}
				const picked = await ctx.ui.select("costTier 门维护：", [...TIERS_ACTIONS]);
				if (!picked) return;
				action = picked.split(/\s+/)[0].toLowerCase();
				if (action === "set" || action === "rm") {
					const hint = action === "set" ? "model tier（如 ling/Ling-3.1-flash free）" : "model provider/id";
					const entered = await ctx.ui.input(`/tiers ${action} ${hint}:`);
					if (!entered) return;
					const [model, tier] = entered.trim().split(/\s+/);
					if (action === "set") cmdSet(ctx, deps, model, tier);
					else cmdRm(ctx, deps, model);
					return;
				}
				if (action === "role") {
					const entered = await ctx.ui.input("/tiers role <role> <min> <max>（或 <role> clear）:");
					if (!entered) return;
					cmdRole(ctx, deps, ["role", ...entered.trim().split(/\s+/).filter(Boolean)]);
					return;
				}
			}

			switch (action) {
				case "show": return cmdShow(ctx, deps);
				case "set": return cmdSet(ctx, deps, parts[1], parts[2]);
				case "rm": return cmdRm(ctx, deps, parts[1]);
				case "draft": return cmdDraft(ctx, deps);
				case "check": return cmdCheck(ctx, deps);
				case "pending": return cmdPending(ctx, deps);
				case "usage": return cmdUsage(ctx, deps);
				case "role": return cmdRole(ctx, deps, parts);
				default:
					ctx.ui.notify(TIERS_HELP, "info");
			}
		},
	});
}

