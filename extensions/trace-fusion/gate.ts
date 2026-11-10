/**
 * trace-fusion 融入 adaptive 的**门槛判定**（2026-11-09）。
 *
 * ## 为什么需要它
 *
 * 原门槛口径是 gen13 传下来的「连续几次无返修 run」——**不可达成**：
 * 任何一次人为取消/放弃都会清零，而取消与融合质量无关
 * （实测：`595c` cancelled、`58ac` abandoned，两个都把他仓的诊断 run 从「连续」里打断）。
 *
 * gen14 裁定改为「**最近 N 个 qualified run 中 ≥M 个首轮六节齐全**」，
 * 并把 cancelled/abandoned/未进融合阶段的 run 排除出分母。
 *
 * ## ⚠️ repair 的语义边界（gen14 约束 4）
 *
 * `repair` 不是「融合质量」指标，是「**六节齐不齐**」的**格式门**：
 * 触发条件是产物已写但各章节正文 < 2000 字符（见 `fusion-dispatch.ts` 的 repair 分支）。
 * 所以本函数度量的是「**首轮能不能产出结构完整的报告**」，不是「融合得好不好」。
 * detail 文案必须按这个口径写，不许写成「融合质量稳定」。
 *
 * ## 数据形状（实测，2026-11-09，19 个 run）
 *
 * - `repair` 在 `meta.json` 的 **`fusion` 子对象**里，**不在** `collect.json`
 * - `tfl-20261103-192444-c7e2`：completed + fusion.completed + diagnose，但**无 `repair` 字段**
 *   ⇒ 按「缺字段即剔除」处理（**不得**当作 clean；误当 clean 会让分母 5→6，口径错）
 * - `tfl-20261104-034440-repair` 与 `tfl-20261104-111728-8618` 的 `createdAt` **完全相同**
 *   ⇒ 排序必须有次级键，否则判决依赖实现顺序（见 `compareRunDesc`）
 * - `repair` 非 null 的**只有 1 个**（`034440-repair`），而它 `fusion.status=failed` ⇒ 本就不 qualified
 *   ⇒ **`not-yet` 分支的线上覆盖率为 0**，只能靠测试夹具构造（见文件末尾的具名未闭合项）
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** 门槛判定结果：**三态而非布尔** —— 区分「不达标」与「样本不足」是本次裁定的核心。 */
export type FusionGateVerdict =
	| {
			verdict: "pass";
			/** 窗口大小（生效值） */
			window: number;
			/** 窗口内首轮六节齐全的个数 */
			clean: number;
			/** 窗口内 qualified 的个数（= examined，窗口不足时 < window） */
			examined: number;
			detail: string;
	  }
	| {
			verdict: "not-yet";
			window: number;
			clean: number;
			examined: number;
			/** 达标所需的最小 clean 数 */
			needed: number;
			detail: string;
	  }
	| {
			verdict: "insufficient-sample";
			window: number;
			/** 实际扫到的 qualified 数（< window） */
			examined: number;
			/** 这 < window 个里有多少是 clean —— 让人一眼看出「差多远」（gen14 约束 5） */
			clean: number;
			detail: string;
	  };

/** 缺省窗口与达标线（与 gen14 裁定一致）。 */
export const FUSION_GATE_DEFAULT_WINDOW = 5;
export const FUSION_GATE_DEFAULT_MIN_CLEAN = 4;

export interface FusionGateOptions {
	/** 观察窗口（最近 N 个 qualified run）；缺省 5。非法值收敛到缺省（不静默扭曲） */
	window?: number;
	/** 窗口内最少 clean 数；缺省 4。非法值收敛到缺省 */
	minClean?: number;
}

/** 单条 run 的 meta 摘要（内部用；只取判定所需字段）。 */
interface RunMetaLite {
	runId: string;
	createdAt: string;
	status?: string;
	mode?: string;
	fusionStatus?: string;
	/** `true` = fusion 子对象里**确实有** `repair` 字段（值是 null 也算有） */
	hasRepairField: boolean;
	/** 有 repair 字段时的值是否为 null（= 首轮六节齐全） */
	repairIsNull: boolean;
}

/**
 * 解析一条 meta.json。**容错口径（gen14 约束 5）**：
 *   - 单条解析失败 ⇒ 返回 null（调用方跳过该 run，不中断）
 *   - `fusion` 子对象缺失 ⇒ `hasRepairField=false` ⇒ 该 run 会被剔除出分母（不是 clean）
 */
function readRunMetaLite(runDir: string, runId: string): RunMetaLite | null {
	try {
		const raw = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8")) as Record<string, unknown>;
		const createdAt = typeof raw.createdAt === "string" ? raw.createdAt : "";
		const fusion = raw.fusion as Record<string, unknown> | undefined;
		const hasRepairField = Boolean(fusion) && Object.prototype.hasOwnProperty.call(fusion, "repair");
		return {
			runId,
			createdAt,
			status: typeof raw.status === "string" ? raw.status : undefined,
			mode: typeof raw.mode === "string" ? raw.mode : undefined,
			fusionStatus: typeof fusion?.status === "string" ? (fusion.status as string) : undefined,
			hasRepairField,
			repairIsNull: hasRepairField ? (fusion as Record<string, unknown>).repair === null : false,
		};
	} catch {
		return null;
	}
}

/**
 * **qualified 筛选**（顺序固定，任一不满足即跳过该 run）：
 *   1. `status === "completed"`
 *   2. `fusion.status === "completed"`
 *   3. 有 `repair` 字段（缺字段 ⇒ 剔除；**不得**当作 clean）
 *
 * 为什么不要求 `mode === "diagnose"` 作为第 4 条：
 * 实测当前全部 qualified 都是 diagnose，加这条不改变结果；但它会把「将来
 * fusion 在别的 mode 下也产出六节报告」当作不合格 —— 那是**格式门**而非 mode 门。
 * 因此只在 detail 里记录 mode 分布，不用它做筛选。**这是有意放宽，已在测试里登记。**
 */
function isQualified(m: RunMetaLite): boolean {
	if (m.status !== "completed") return false;
	if (m.fusionStatus !== "completed") return false;
	if (!m.hasRepairField) return false;
	return true;
}

/**
 * 排序比较器：**createdAt 倒序 + runId 倒序次级键**（gen14 约束 1）。
 *
 * 为什么必须有次级键：实测 `tfl-20261104-034440-repair` 与 `tfl-20261104-111728-8618`
 * 的 `createdAt` **完全相同**（`2026-11-04T03:17:28.837Z`）。本次不影响判决
 * （前者 fusion=failed 不 qualified），但**两个 qualified 并列时**，
 * 只按 createdAt 排会让「哪个进窗口」依赖 V8 排序实现细节 ⇒ 判决可能翻转。
 *
 * 选 `runId` 倒序而不是正序：`runId` 形如 `tfl-YYYYMMDD-HHMMSS-xxxx`，
 * 字典序与创建时序一致（时间戳在前），倒序 = 更新的优先，与 createdAt 倒序同向。
 * 并列时行为**确定且可复现**，不再依赖实现。
 */
function compareRunDesc(a: RunMetaLite, b: RunMetaLite): number {
	const byDate = b.createdAt.localeCompare(a.createdAt);
	if (byDate !== 0) return byDate;
	return b.runId.localeCompare(a.runId);
}

/** 把未知输入收敛成合法 window/minClean（gen14 约束 2：非法值收敛到缺省，不静默）。 */
function normalizeOpts(opts?: FusionGateOptions): { window: number; minClean: number } {
	const w = opts?.window;
	const window = typeof w === "number" && Number.isInteger(w) && w >= 1 ? w : FUSION_GATE_DEFAULT_WINDOW;
	const m = opts?.minClean;
	let minClean = typeof m === "number" && Number.isInteger(m) && m >= 1 ? m : FUSION_GATE_DEFAULT_MIN_CLEAN;
	// minClean > window 时收敛到 window（「窗口内全都要 clean」是可达的上限；
	// 保留 minClean=6/window=5 会造出**恒 not-yet** 的死档，属配置错误而非有意态）
	if (minClean > window) minClean = window;
	return { window, minClean };
}

/**
 * trace-fusion 是否已稳定到可融入 adaptive（作为**校验性核对之前**的输入）。
 *
 * 位置裁定（gen14 2026-11-09）：**校验性核对之前**。
 * 理由：fusion 产物是三路独立诊断，替代的是「检索与假设验证」，不是「计划」；
 * 放 L2 之前会让 A0/A 档（本就跳过检索）白等一个 45min × 3 lane 的 rollout。
 *
 * 纯函数、**只读** `meta.json`；不跑 fusion、不改任何状态、不写盘。
 *
 * @param runsDir `~/.pi/agent/trace-fusion-runs`（或 env override）
 * @param opts.window 观察窗口，缺省 5；`window<1` 或非整数 ⇒ 收敛到缺省
 * @param opts.minClean 最少 clean 数，缺省 4；`minClean<1` 或非整数 ⇒ 收敛到缺省；
 *        `minClean>window` ⇒ 收敛到 window
 *
 * 容错：`runsDir` 不存在 ⇒ `insufficient-sample{examined:0, clean:0}`，不抛；
 * 单条 meta 解析失败 ⇒ 跳过该条；`fusion` 子对象缺失 ⇒ 剔除出分母。
 */
export function evaluateFusionGate(runsDir: string, opts?: FusionGateOptions): FusionGateVerdict {
	const { window, minClean } = normalizeOpts(opts);

	if (!existsSync(runsDir)) {
		return {
			verdict: "insufficient-sample",
			window,
			examined: 0,
			clean: 0,
			detail: `runsDir 不存在（${runsDir}）⇒ 无样本，门槛未达但不阻断`,
		};
	}

	let names: string[] = [];
	try {
		names = readdirSync(runsDir).filter((n) => n.startsWith("tfl-"));
	} catch {
		return {
			verdict: "insufficient-sample",
			window,
			examined: 0,
			clean: 0,
			detail: `runsDir 不可读（${runsDir}）⇒ 无样本，门槛未达但不阻断`,
		};
	}

	const all: RunMetaLite[] = [];
	for (const n of names) {
		const m = readRunMetaLite(join(runsDir, n), n);
		if (m) all.push(m); // 解析失败 ⇒ 跳过（不中断）
	}

	const qualified = all.filter(isQualified).sort(compareRunDesc);
	const inWindow = qualified.slice(0, window);
	const clean = inWindow.filter((m) => m.repairIsNull).length;
	const examined = inWindow.length;

	if (examined < window) {
		return {
			verdict: "insufficient-sample",
			window,
			examined,
			clean,
			detail:
				`最近只有 ${examined} 个 qualified run（窗口 ${window}）⇒ 样本不足，门槛未达但**不阻断**；` +
				`这 ${examined} 个里有 ${clean} 个首轮六节齐全`,
		};
	}
	if (clean >= minClean) {
		return {
			verdict: "pass",
			window,
			examined,
			clean,
			detail: `最近 ${window} 个 qualified run 中有 ${clean} 个首轮六节齐全（达标线 ${minClean}）`,
		};
	}
	return {
		verdict: "not-yet",
		window,
		examined,
		clean,
		needed: minClean,
		detail: `最近 ${window} 个 qualified run 中有 ${clean} 个首轮六节齐全，低于达标线 ${minClean}（还差 ${minClean - clean} 个）`,
	};
}

/**
 * ## 具名未闭合项（交付时必须随代码一起给出，R-23）
 *
 * 1. **`not-yet` 分支线上覆盖率为 0**（gen14 约束 3，穷举 19 个 run 核实）：
 *    `repair` 非 null 的只有 `tfl-20261104-034440-repair` 一个，而它 `fusion.status=failed`
 *    ⇒ 本就不 qualified。所以「qualified ∧ repair 非 null」这一态**至今 0 例**，
 *    该分支仅由测试夹具构造覆盖（`_test_trace_fusion_gate.ts` 用例③）。
 *    真机复现路径（`fusion-dispatch.ts` repair 分支：primary failed 且 gaps 非空 ⇒ 补写一轮
 *    且成功）存在，但尚未观测到。
 * 2. **`mode` 不参与筛选**（见 `isQualified` 注释）：这是有意放宽，未做「只算 diagnose」
 *    的收紧；若将来 fusion 在别 mode 也产报告，本门槛会计入。
 * 3. 未接入任何调用方（本 commit 只交付纯函数；SKILL.md 的闸门接线是下一步）。
 */
