/**
 * local-owner-gate.ts — `launch-tabs` 的 execute 层**身份门**（ownership 门，方案与
 * `supervise-gate.ts` 同形状，禁止漂移）
 *
 * 任务：`plans/20261019_local_master_dispatch_plane_plan.md` §8.1/§8.2（唯一实施依据；
 * §3 是已被替代的历史草案）。参照实现：`extensions/supervise-gate.ts`（今天刚修的同类门）。
 *
 * ## 为什么需要这一层
 * local master（`lms-*`）**自己也是 tab**（`index.ts::ensureLocalMasterTab` 经
 * `spawnPiTab(tabRunId)` 拉起）⇒ `currentProfile()` 判 `workflow-tab` ⇒
 * `capabilities().launchTabs === false` ⇒ 它连 `launch-tabs` 工具都拿不到。
 * 但它是**本仓 owner**，主动派发本仓 tab 是它的本职。
 *
 * 修法不是「把 local master 变成 main profile」（那会连带扩大 lite / timer / 委派 /
 * 直接执行等无关权限），也不是放宽成「谁都能派」，而是：
 *   主会话（原能力档）∨ **本仓 owner** 可派，且 local owner 的目标 cwd 必须在本仓子树内。
 *
 * ## 与 supervise-gate 的差别（有意，不是漂移）
 *
 * | 维度 | supervise-gate | 本模块 |
 * |---|---|---|
 * | 归属读 | 只读 **local** 地址（R1） | local 地址 + `agentAddress` 形状校验 |
 * | 归属分类 | 无（只分 main/owner） | `ownerKind` 三档枚举（本模块只产出 `main`/`local`） |
 * | 目标 | 目标 tab 的 `dispatch.cwd`（单条） | 本批次 `tasks[].cwd`（批量，先整批校验） |
 * | 额外 | `self-push` 防自激 | `localOwnerStillFresh`（预写前重读，§8.2.6） |
 *
 * ## ownerKind 三档（计划 §7 R-P1，**只有 local 加本仓约束**）
 *   - `main`   —— 主会话（非 tab、非 sub）。原路径，逐字节不变（R3：零附件 IO）。
 *   - `local`  —— 本仓 local master owner（地址 `agent://master_local_<scope>`）。
 *                  ⇒ **必须**加本仓子树约束（local master 权责只在本仓）。
 *   - `global` —— 全局 owner（地址 `agent://master_default`）。
 *                  ⇒ **不得**加本仓约束：全局编排者的核心职责就是跨仓派发。
 * 三档判定的依据只能是**选定的地址**，不能事后靠「谁恰好匹配 sid」猜。
 * **本模块不产出 `global`**：launch-tabs 的例外只认 local 地址（global owner 走主会话
 * 原能力档）。`global` 这一档由 `master-dispatch` 的双地址 gate 使用；两边共用同一枚举语义，
 * 避免“谁算 owner”的口径在三个工具间漂移。
 *
 * ## 分层（审查定夺，不得反向）
 * 本文件在 `extensions/` 根（tool 层），可 import `master-tools.ts`（tool 层，既有方向）。
 * **禁止 `master-tools.ts` 反向 import 本文件**（会成环）。`index.ts` 单向消费本模块。
 *
 * ## R3 硬规则（沿用 supervise-gate）
 * 非 tab ⇒ 直接放行 `main`，**不读 attachment**（主会话路径零额外 IO）。
 * 但本模块的调用点是「capability 判 false 之后」，所以实际只有 tab / sub 会进来；
 * 保留该分支是为了让纯函数自身可证伪、且不依赖调用方的隐含假设。
 *
 * 纯函数：零 IO、零全局状态（`readAttachment` 全注入）。
 */

import { localAgentFromCwd, masterDispatchGate } from "./master-tools.ts";
import { readAttachment, type MasterAttachment } from "./runtime/registry.ts";
import { masterAddress } from "./runtime/address.ts";
import type { ObjectAddress } from "./runtime/address.ts";
import { resolveOwnerTargetCwd, type OwnerTargetCwdReason } from "./runtime/target-cwd.ts";

/** owner 归属三档（见文件头；`master-dispatch` 双地址 gate 复用同一枚举语义）。 */
export type OwnerKind = "main" | "local" | "global";

/** 本层拒绝原因（**不是**七条监管策略门，也**不是** masterDispatchGate 的 reason）。 */
export type LocalOwnerGateReason =
	| "subagent"
	| "not-workflow-tab"
	| "tab-session"
	| "generation-mismatch"
	| "unknown-session"
	| "address-mismatch"
	| "stale-owner"
	| OwnerTargetCwdReason;

export interface LocalOwnerGateInput {
	/** `isSubagent()`。 */
	isSub: boolean;
	/** 是否有标签页身份（`getTabRunId()` 非空）。空 ⇒ 放行 `main`，不进门（R3）。 */
	isTab: boolean;
	/**
	 * `currentProfile() === "workflow-tab"`（§8.1：**只**给真实任务 tab 开这个例外）。
	 * trace-worker 同样有 tabRunId、也可能恰好持有本仓 attachment，但它不是任务 tab，
	 * 不得因「恰好持有附件」而获派发权 ⇒ 单独一档拒（`not-workflow-tab`）。
	 */
	isWorkflowTabProfile: boolean;
	/** `durableSessionIdentity(ctx)`（持久会话 UUID；`unknown` ⇒ 拒）。 */
	sessionId: string;
	/** 可信 cwd（`ctx.cwd ?? process.cwd()`）：owner 地址派生 + `detail` 缺失时的仓根回退。 */
	ownerCwd: string;
	/**
	 * **local** owner 附件读取器（`readAttachment(localAgentFromCwd(cwd))`）。惰性调用；
	 * 每次读取都会校验「返回快照的 `agentAddress` == 本次派生的 local 地址」（不符按 null 处理）。
	 */
	readAttachment: () => MasterAttachment | null;
	/**
	 * 本批次目标 cwd（批量；**先整批校验，任一不符整批拒绝** —— 零 dispatch/timer/link/监管/spawn）。
	 * `undefined` 元素 = 该任务省略 cwd ⇒ 派发原语的默认 `process.cwd()`。
	 */
	targetCwds: ReadonlyArray<string | undefined>;
	/** 派发原语的实际默认 cwd（生产传 `process.cwd()`；测试可注入）。 */
	defaultCwd?: string;
}

export type LocalOwnerGateResult =
	| {
			ok: true;
			via: "main" | "owner";
			ownerKind: OwnerKind;
			/** local owner 的仓根原始值（`detail` 或可信 cwd）；main/global 恒 null。 */
			ownerRoot: string | null;
			/** 归属快照（owner 路径）；main 路径 null。 */
			attachment: MasterAttachment | null;
			/**
			 * 把**已检查过的绝对 cwd** 按原顺序返回（仅 owner+local 路径；其余 null）。
			 * 派发阶段禁止再自行 `resolve(input.cwd)` —— 检查值即派发值。
			 */
			checkedCwds: ReadonlyArray<string | null>;
	  }
	| { ok: false; reason: LocalOwnerGateReason; detail: string };

/** 拒绝文案（execute 直接回给模型；与 supervise-gate 同款：区分「subagent」与「tab 非 owner」）。 */
export const LOCAL_OWNER_GATE_TEXT: Record<LocalOwnerGateReason, string> = {
	subagent: "launch-tabs 只允许主会话或本仓 local owner 调用；子 agent 一律禁止（防扩散硬挡）",
	"not-workflow-tab":
		"launch-tabs 只允许主会话或本仓 local owner（workflow-tab）调用；当前会话不是任务 tab（trace-worker 等不得因持有 owner 附件而派发）",
	"tab-session":
		"launch-tabs 只允许主会话或本仓 local owner 调用；当前标签页不是本仓 owner，任务 tab 严禁再派发（请用 subagent-win 委派各角色，或用 tab-finish 回报主会话）",
	"generation-mismatch":
		"launch-tabs: 本仓 owner 归属已变化（stale generation），拒绝；重新确认 owner 后重试",
	"unknown-session": "launch-tabs: 无法确定当前会话身份（session_start 之前？），拒绝",
	"address-mismatch": "launch-tabs: owner 归属校验失败（附件地址与读取路径不一致），拒绝",
	"stale-owner": "launch-tabs: 本仓 owner 在派发前已变化（stale generation），整批拒绝；重新确认 owner 后重试",
	"owner-root": "launch-tabs: 无法确定本仓 owner 的仓根（attachment.detail 与 ctx.cwd 均缺失/不可解析），拒绝",
	blank: "launch-tabs: 本仓 owner 的 cwd 不得为空白字符串（省略 cwd 才使用当前目录），拒绝",
	relative: "launch-tabs: 本仓 owner 的 cwd 必须是可解析的绝对路径（相对路径会吃 process.cwd()，拒绝）",
	"cross-repo": "launch-tabs: owner 只能在本仓内派发（目标 cwd 不在本仓子树），拒绝",
};

function deny(reason: LocalOwnerGateReason, detail: string): LocalOwnerGateResult {
	return { ok: false, reason, detail };
}

/** 读**本仓 local** owner 附件（唯一 IO 入口；每次校验 `agentAddress` 与请求地址一致）。 */
export function readLocalOwnerAttachmentStrict(agent: ObjectAddress): MasterAttachment | null {
	try {
		const att = readAttachment(agent);
		if (!att) return null;
		// registry.readAttachment 只验证「地址形状」，不验证「与读取路径一致」——
		// 审查 §9.1 W16：文件被放到 local 路径但正文写 global 地址时，必须 fail-closed。
		return att.agentAddress === agent ? att : null;
	} catch {
		return null;
	}
}

/** 按可信 cwd 派生 local 地址（`localAgentFromCwd` 口径；不接受参数指定 scope/地址）。 */
export function localOwnerAddressForCwd(cwd: string): ObjectAddress {
	return localAgentFromCwd(cwd);
}

/** 全局地址（`ownerKind: "global"` 的归属地址；仅供调用方比对/装配 reader 用）。 */
export function globalOwnerAddress(): ObjectAddress {
	return masterAddress();
}

/**
 * launch-tabs 的 owner 门（**纯**；顺序即优先级）：
 *
 *   0. `isSub`              ⇒ 拒（`subagent`，最高优先）
 *   1. `!isTab`             ⇒ **放行 `main`**（R3：零附件 IO，主会话路径不变）
 *   2. tab 但 profile ≠ workflow-tab ⇒ 拒（`not-workflow-tab`）
 *   3. tab ⇒ 复用 `masterDispatchGate`（内含双读 generation fencing）+ 地址形状校验
 *        - 任一次读取快照 `agentAddress` ≠ 本仓 local 地址 ⇒ `address-mismatch`
 *        - sid/gen 双读不一致 ⇒ `generation-mismatch`
 *        - 不匹配 sid / 无附件 ⇒ `tab-session`
 *   3. owner ⇒ 逐项校验目标 cwd（`resolveOwnerTargetCwd`，含 ownerRoot 回退规则）；
 *        **先全批校验，任一不符整批拒绝**（调用方此时还没写任何账本/spawn）
 */
export function localOwnerGate(input: LocalOwnerGateInput): LocalOwnerGateResult {
	// 0) 子 agent 恒拒
	if (input.isSub) return deny("subagent", "PI_SUBAGENT=1（子 agent 进程）");

	// 1) R3：非 tab ⇒ 主会话原路径（不读 attachment、不校验 cwd —— 主会话不收紧）
	if (input.isTab !== true) {
		return { ok: true, via: "main", ownerKind: "main", ownerRoot: null, attachment: null, checkedCwds: [] };
	}

	// 2) tab ⇒ ownership（复用已封验证的 gate；地址必须是本仓 local，且每次读都比对地址）
	// 2.0) 只给真实任务 tab（workflow-tab）开例外：trace-worker 也有 tabRunId，不在例外内。
	if (input.isWorkflowTabProfile !== true) {
		return deny("not-workflow-tab", `currentProfile≠workflow-tab（实际 isTab=${String(input.isTab)}）`);
	}
	const cwdRaw = typeof input.ownerCwd === "string" ? input.ownerCwd.trim() : "";
	const cwd = cwdRaw || process.cwd();
	const agent = localOwnerAddressForCwd(cwd);
	let addressMismatch = false;
	const readStrict = (): MasterAttachment | null => {
		const att = input.readAttachment();
		if (!att) return null;
		if (att.agentAddress !== agent) {
			addressMismatch = true;
			return null;
		}
		return att;
	};

	const gate = masterDispatchGate({
		sessionId: input.sessionId,
		isSub: false, // 已在上面判过
		isTab: true,
		isMain: false, // tab 恒不是 isMainSession
		readAttachment: readStrict,
	});
	if (!gate.ok) {
		// 地址不一致优先报（否则会被 gate 的 tab-session 掩盖成「你不是 owner」，现场无法定位）
		if (addressMismatch) {
			return deny("address-mismatch", `附件正文 agentAddress≠${agent}（读路径与内容不一致）`);
		}
		switch (gate.reason) {
			case "unknown-session":
				return deny("unknown-session", "sessionId 为空或 unknown（durableSessionIdentity 拿不到）");
			case "generation-mismatch":
				return deny("generation-mismatch", "attachment 双读间 sessionId/generation 变化（被接管或已 stale）");
			case "subagent":
				return deny("subagent", "masterDispatchGate 判 subagent");
			case "not-owner":
			case "tab-session":
			default:
				return deny("tab-session", `本仓 local owner 附件与自身会话不匹配（gate=${gate.reason}）`);
		}
	}

	// 3) owner ⇒ 目标 cwd 政策（local 档才约束；只有 local 会走到这里）
	const ownerRoot = ((gate.attachment?.detail ?? "").trim() || (input.ownerCwd ?? "").trim()) || "";
	const defaultCwd = typeof input.defaultCwd === "string" ? input.defaultCwd : process.cwd();
	const checked: Array<string | null> = [];
	for (const raw of input.targetCwds) {
		const v = resolveOwnerTargetCwd(raw, ownerRoot, defaultCwd);
		if (!v.ok) return deny(v.reason, v.detail);
		checked.push(v.cwd);
	}

	return {
		ok: true,
		via: "owner",
		ownerKind: "local",
		ownerRoot,
		attachment: gate.attachment,
		checkedCwds: checked,
	};
}

/**
 * owner 批次**写入前**的重读校验（计划 §8.2.6：时间窗最小化，**不是 lease**）。
 *
 * 比对 `{sessionId, generation}` 并再次校验地址形状（同 `readLocalOwnerAttachmentStrict`）。
 * 返回 false ⇒ 调用方整批拒绝（零 dispatch/timer/link/监管/spawn）。
 *
 * 诚实边界：不承诺与其他进程 takeover 的原子互斥 —— 重读与 spawn 之间仍有窗口
 * （与 `masterDispatchLaunch` 的最终 fencing 同级，不是 CAS）。
 */
export function localOwnerStillFresh(input: {
	attachment: MasterAttachment | null;
	readAttachment: () => MasterAttachment | null;
}): boolean {
	if (!input.attachment) return false;
	const fresh = input.readAttachment();
	if (!fresh) return false;
	if (fresh.agentAddress !== input.attachment.agentAddress) return false;
	return fresh.sessionId === input.attachment.sessionId && fresh.generation === input.attachment.generation;
}
