/**
 * runtime/target-cwd.ts — **local owner 派发**的目标 cwd 政策（纯函数，单处实现）
 *
 * 谁需要它：两处权限平面共用同一条政策 ——
 *   - `launch-tabs`（本仓 local owner 例外，批量：先整批校验再派发）
 *   - `master-dispatch`（ownerKind === "local"，单条）
 * 为什么抽叶子：两个消费方都在 **tool 层**，彼此不能互相 import（`local-owner-gate.ts`
 * → `master-tools.ts` 是既有 tool→tool 方向；反向 import 会成环）。政策本身不依赖任何
 * 工具注册/身份判定，只吃「目标 cwd + 仓根」，因此放在 runtime 叶子层是唯一不破层的落点
 * （`runtime/wake.ts` 不 import 本文件，本文件只 import 它 ⇒ 无环）。
 *
 * 判据来源（**禁止另写一份**，2026-10-19 已 canonicalize）：
 *   `normRepoPath` / `repoPathMatches` —— 与 `supervise-gate.ts`、监管块 repo 过滤同一函数。
 *   特别注意 `C:/repo/../OtherRepo`：`resolve` 只做路径代数，不限制目标仓；旧草案「resolve
 *   天然隔离仓」是错的（计划 §2 F7 边界）。所以先 canonicalize 比较，再把**同一个已检查的
 *   绝对路径**交给派发函数（检查值与 spawn 值不得是两个来源）。
 *
 * 政策（计划 §8.2.4 / §8.3.4）：
 *   1. 省略 cwd ⇒ 用**派发原语的实际默认** `process.cwd()`（`launchWorkflowTab` 的
 *      `(input.cwd ?? "").trim() || process.cwd()`），不改成读 ctx.cwd —— 检查什么就派发什么。
 *   2. 显式 cwd 必须是可解析的绝对路径；空白/相对路径/盘符相对一律拒绝（`normRepoPath`
 *      对相对路径返回 `""`，**绝不对相对路径调 resolve**，否则会吃 process.cwd() 把
 *      「相对路径」变成某个仓内路径，正好是越权放行的形状）。
 *   3. 目标必须落在 owner 仓根子树内（`repoPathMatches`，分段判，`c:/repo2` 不算
 *      `c:/repo` 的子目录）。
 *   4. 仓根（owner attachment 的 `detail`，缺失回退可信 cwd）不可解析 ⇒ fail-closed。
 *
 * 已知边界（**不是**安全沙箱，不得声称已解决）：只做词法子树隔离 —— 不解析符号链接/
 * junction/8.3 短名（实体别名可绕过）；attachment 的可写者已越过本层信任边界。
 */

import { resolve } from "node:path";
import { normRepoPath, repoPathMatches } from "./wake.ts";

/** 目标 cwd 被拒的原因（本层的产物，不进任何既有拒绝枚举）。 */
export type OwnerTargetCwdReason = "owner-root" | "blank" | "relative" | "cross-repo";

export type OwnerTargetCwdVerdict =
	| { ok: true; cwd: string }
	| { ok: false; reason: OwnerTargetCwdReason; detail: string };

/**
 * 校验并归一 **local owner** 的目标 cwd。
 *
 * @param rawCwd      工具参数里的 cwd（`undefined` = 省略；空串/空白 = 显式空白 ⇒ 拒）
 * @param ownerRootRaw owner 仓根原始值（`attachment.detail.trim()`，缺失回退可信 cwd）
 * @param defaultCwd  派发原语的默认 cwd（生产恒为 `process.cwd()`）
 * @returns ok 时 `cwd` = `resolve()` 后的绝对路径，**派发只能使用该值**
 */
export function resolveOwnerTargetCwd(
	rawCwd: string | undefined,
	ownerRootRaw: string,
	defaultCwd: string,
): OwnerTargetCwdVerdict {
	const rootNorm = normRepoPath(ownerRootRaw);
	if (!rootNorm) {
		return {
			ok: false,
			reason: "owner-root",
			detail: `owner 仓根不可判定（detail/cwd=${JSON.stringify(ownerRootRaw ?? "")}）`,
		};
	}
	const provided = typeof rawCwd === "string";
	const raw = provided ? rawCwd.trim() : "";
	if (provided && !raw) {
		// 显式空白 ≠ 省略：省略有明确默认（process.cwd()），空白没有可信语义 ⇒ 拒（fail-closed）
		return { ok: false, reason: "blank", detail: "cwd 为空白字符串" };
	}
	const base = raw || (typeof defaultCwd === "string" ? defaultCwd : "");
	const baseNorm = normRepoPath(base);
	if (!baseNorm) {
		return {
			ok: false,
			reason: "relative",
			detail: `cwd 不是可解析的绝对路径：${JSON.stringify(base)}`,
		};
	}
	let abs: string;
	try {
		abs = resolve(base);
	} catch (e) {
		return { ok: false, reason: "relative", detail: `cwd resolve 失败：${e instanceof Error ? e.message : String(e)}` };
	}
	if (!repoPathMatches(abs, rootNorm)) {
		return { ok: false, reason: "cross-repo", detail: `cwd=${abs} 不在本仓子树 ${rootNorm} 内` };
	}
	return { ok: true, cwd: abs };
}
