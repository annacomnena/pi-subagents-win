/**
 * supervise-gate.ts — `supervise-push` 的 execute 层**身份门 + 目标约束门**（方案 C：ownership 门）
 *
 * 任务书：`plans/20261019_supervise_push_gate_task_brief.md` §3（方案 C）；
 * 独立审查：`plans/20261019_plan_review_supervise_gate.md`（R1/R3/R9 修订）。
 *
 * ## 为什么需要这一层
 * `supervision-runtime.ts` 原门② 是 `if (getTabRunId()) return 拒绝`——**拒绝一切标签页身份**。
 * 而 local master（`lms-*`）本身就是 tab（`index.ts` 的 `ensureLocalMasterTab` 经 `spawnPiTab(tabRunId)` 拉起）
 * ⇒ 连 local master 都推不了任何 tab（断点 #4）。修法不是放宽成「谁都能推」，而是：
 *   主会话 ∨ **本仓 owner** 可推，且**目标必须落在本仓子树内**。
 *
 * ## 复用已封验证的判定机制（不是新写一套权限模型）
 * ownership 判定本体**照抄** `master-tools.ts::masterDispatchGate`（sub 硬挡 → 身份 unknown 拒 →
 * owner 放行 + **双读 generation fencing** → 其余拒）。本模块只做两件事：
 *   1. 把 gate 的 reason 收窄成本工具可读的四种（并给出拒绝文案）；
 *   2. 在 owner 放行后加**目标约束**（`cross-repo` / `self-push`）——方案 A 缺的那一环。
 *
 * ## R1（致命，已按审查修订）：注入的 attachment 必须是 **local** 地址
 * 调用方（`supervision-runtime.ts`）注入 `readAttachment(localAgentFromCwd(ctx.cwd))`
 * **禁止**照抄 `master-tools.ts:711/:796` 的 `readAttachment(masterAddress())`。
 * 实盘反证（本机 `~/.pi/agent/runtime/registry/attachments/`）：全局 `agent://master_default`
 * 与 `agent://master_local_subagent-win` 的 sessionId **不同**（`01a140e8-…` vs `01a1518c-…`）
 * ⇒ 注入全局地址时 `att.sessionId === sid` 恒假 ⇒ 永远落 `tab-session` ⇒ 改了等于没改。
 *
 * ## R3（硬规则）：非 tab ⇒ 不进本门
 * `selfRunId` 为空（= 主会话，含 `ctx` 缺失的边缘）**直接 `via:"main"` 放行**，
 * 且**不读 attachment、不读 dispatch**（零额外 IO）。理由：主会话路径必须逐字节不变；
 * 否则 `masterDispatchGate` 的 `unknown-session` 分支会误伤「拿不到 ctx 的主会话」。
 *
 * ## 分层（审查第 3 问定夺）
 * 本文件放 `extensions/` 根（tool 层），因为要 import `master-tools.ts`（tool 层）。
 * 放 `runtime/` 会把 tool 层拖进 runtime 层的依赖闭包 —— `runtime/wake.ts:15` 明文禁止的方向。
 *
 * ## 拒绝 reason 的归属（任务书 §5.7）
 * `subagent` / `tab-session` / `generation-mismatch` / `unknown-session` / `cross-repo` / `self-push`
 * 都是**本层**的产物：**不进**七条 `PushRejectReason`、**不进** `SupervisePushResult`。
 * 但 `cross-repo` / `self-push` / `generation-mismatch` 由调用方落 audit 行（W7）。
 *
 * 纯函数：零 IO、零全局状态（`readAttachment` / 目标 repoPath 全注入）。
 */

import { localAgentFromCwd, masterDispatchGate } from "./master-tools.ts";
import { readAttachment, type MasterAttachment } from "./runtime/registry.ts";
import { normRepoPath, repoPathMatches } from "./runtime/wake.ts";

/** 本层拒绝原因（**不是**七条策略门，见文件头「拒绝 reason 的归属」）。 */
export type SuperviseGateReason =
	| "subagent"
	| "tab-session"
	| "generation-mismatch"
	| "unknown-session"
	| "cross-repo"
	| "self-push";

export interface SupervisePushGateInput {
	/** `isSubagent()`。 */
	isSub: boolean;
	/** 是否有标签页身份（`getTabRunId()` 非空）。**空 ⇒ 直接放行，不进门**（R3）。 */
	isTab: boolean;
	/** 自身 tab runId（`getTabRunId()`）；用于 `self-push` 自激防护。 */
	selfRunId?: string;
	/** `durableSessionIdentity(ctx)`（持久会话 UUID；`unknown` ⇒ 拒）。 */
	sessionId: string;
	/** **local** owner 附件读取器（`readAttachment(localAgentFromCwd(cwd))`，见 R1）。惰性调用。 */
	readAttachment: () => MasterAttachment | null;
	/** 可信 cwd（`ctx.cwd`）：owner 附件缺 `detail` 时的仓根回退（只用于本仓子树判定）。 */
	ownerCwd?: string;
	/** 目标 tab 的 runId（空串 = 参数还没校验，本层不因目标缺失而拒）。 */
	targetRunId: string;
	/** 目标 tab 的 `dispatch.cwd`（派发时写死的绝对路径）；惰性读（主会话路径零 IO）。 */
	targetRepoPath: () => string | null;
}

export type SupervisePushGateResult =
	| { ok: true; via: "main" | "owner"; attachment: MasterAttachment | null }
	| { ok: false; reason: SuperviseGateReason; detail: string; text: string };

/**
 * **唯一的 IO 入口**（`supervisePushGate` 本身零 IO）：读**本仓 local** owner 附件。
 *
 * R1（致命）：地址必须由**可信 cwd** 派生 `localAgentFromCwd(cwd)`（= `localMasterAddress(localMasterScope(cwd))`），
 * **禁止**换成 `masterAddress()`（全局地址）—— 实盘全局与 local 是两个不同 sessionId，
 * 注入全局地址时 owner 判定永远为假（详见文件头）。
 * never-throw（`readAttachment` 自身 tolerant 返回 null）。
 */
export function readLocalOwnerAttachment(cwd: string): MasterAttachment | null {
	try {
		return readAttachment(localAgentFromCwd(cwd));
	} catch {
		return null;
	}
}

/** 拒绝文案（execute 直接回给模型；区分 subagent 拒与「tab 非 owner」拒，便于现场定位）。 */
export const SUPERVISE_GATE_TEXT: Record<SuperviseGateReason, string> = {
	subagent: "子 agent 中不可推动（supervise-push 仅主会话或本仓 owner 可用）",
	"tab-session": "监管推动仅主会话或本仓 owner 可用（当前标签页不是本仓 owner，标签页会话不得推动）",
	"unknown-session": "supervise-push：无法确定当前会话身份（session_start 之前？），拒绝",
	"generation-mismatch": "supervise-push：本仓 owner 归属已变化（stale generation），拒绝；重新确认 owner 后重试",
	"cross-repo": "supervise-push：目标 tab 不在本仓 owner 的仓库子树内（cross-repo），拒绝",
	"self-push": "supervise-push：不得推动自身（目标 runId === 自身 tab runId）",
};

function deny(reason: SuperviseGateReason, detail: string): SupervisePushGateResult {
	return { ok: false, reason, detail, text: SUPERVISE_GATE_TEXT[reason] };
}

/**
 * supervisor 身份/目标门（**纯**；三档 fail-closed，顺序即优先级）：
 *
 *   0. `isSub`                  ⇒ 拒（`subagent`，最高优先；与旧门① 同位置）
 *   1. `!isTab`                 ⇒ **放行 `main`**（R3：非 tab 不进 ownership 判定，零额外 IO）
 *   2. tab ∧ 非本仓 owner        ⇒ 拒（`tab-session`；含 `not-owner` / 身份 unknown）
 *   3. tab ∧ 本仓 owner：
 *        a. `targetRunId === selfRunId`                ⇒ 拒（`self-push`，防自激）
 *        b. 目标 `repoPath` 空 ⇒ 拒（`cross-repo`，fail-closed，不猜）
 *        c. 目标 `repoPath` 不在本仓子树 ⇒ 拒（`cross-repo`）
 *        d. 否则 ⇒ 放行 `owner`
 *
 * 「本仓子树」判据 = `runtime/wake.ts::repoPathMatches(target, normRepoPath(ownerRepoRoot))`，
 * 与监管块 `deriveSupervisionItems` 的 repo 过滤**同一函数**（禁止另写一份，否则两处口径会漂）。
 * `ownerRepoRoot` 取 owner attachment 的 `detail`（genesis 写入的 git toplevel），
 * 缺失时回退可信 `ctx.cwd`；两者都拿不到 ⇒ 拒（`cross-repo`，fail-closed）。
 */
export function supervisePushGate(input: SupervisePushGateInput): SupervisePushGateResult {
	// 0) 子 agent 恒拒（门① 的判据不动，只是搬进本纯函数以便单测）
	if (input.isSub) return deny("subagent", "PI_SUBAGENT=1（子 agent 进程）");

	// 1) R3：非 tab ⇒ 旧行为放行（**不得**进 masterDispatchGate，否则 unknown-session 会误伤主会话）
	if (input.isTab !== true || !input.selfRunId) {
		return { ok: true, via: "main", attachment: null };
	}

	// 2) tab ⇒ 复用 masterDispatchGate 的 ownership 判定（内含**双读** generation fencing）
	const gate = masterDispatchGate({
		sessionId: input.sessionId,
		isSub: false, // 已在上面判过
		isTab: true,
		isMain: false, // tab 恒不是 isMainSession（identity.ts::isMainSession）
		readAttachment: input.readAttachment,
	});
	if (!gate.ok) {
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
				// 文案/理由合并：对调用者而言都是「这个 tab 不是本仓 owner」
				return deny(
					"tab-session",
					`本仓 local owner 附件与自身会话不匹配（gate=${gate.reason}；owner 存在吗？gen 是否已推进？）`,
				);
		}
	}

	// 3) owner 放行 —— 但**不等于**可以推任意 tab（方案 A 缺的那一环）
	const targetRunId = typeof input.targetRunId === "string" ? input.targetRunId.trim() : "";
	// 3.0) 目标还没校验（空 runId）：本层不加目标约束，交给调用方的 runId-required 分支
	if (!targetRunId) return { ok: true, via: "owner", attachment: gate.attachment };

	// 3a) 推自己无意义（自激防护）
	const selfRunId = input.selfRunId.trim();
	if (targetRunId === selfRunId) {
		return deny("self-push", `target runId=${targetRunId} 等于自身 tab runId`);
	}

	// 3b) 本仓子树判定：仓根优先取 owner attachment.detail（genesis 写的 toplevel），回退可信 cwd
	const ownerRoot = normRepoPath(
		(gate.attachment?.detail ?? "").trim() || (input.ownerCwd ?? "").trim(),
	);
	if (!ownerRoot) {
		return deny("cross-repo", "无法确定本仓 owner 的仓根（attachment.detail 与 ctx.cwd 均缺失）");
	}
	const targetRepoPath = input.targetRepoPath();
	const targetRepo = typeof targetRepoPath === "string" ? targetRepoPath.trim() : "";
	if (!targetRepo) {
		// 3c) 目标无仓载体 ⇒ 不猜（fail-closed）
		return deny("cross-repo", `目标 runId=${targetRunId} 的 dispatch.cwd 缺失/为空（无法证明属于本仓 ${ownerRoot}）`);
	}
	if (!repoPathMatches(targetRepo, ownerRoot)) {
		return deny(
			"cross-repo",
			`目标 runId=${targetRunId} 的 repoPath=${targetRepo} 不在本仓子树 ${ownerRoot} 内（local master 权责只在本仓）`,
		);
	}

	return { ok: true, via: "owner", attachment: gate.attachment };
}
