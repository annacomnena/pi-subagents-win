/**
 * runtime/master-home-guard.ts — Global Master home 会话守卫（0923，6-sol 指定）。
 *
 * 唯一规则实现：全局 Master（agent://master_default）只能在用户 home 根目录
 * 启动的会话里被认领。纯函数、无 IO——os.homedir() 只在入口/适配层读取，
 * 经 env 注入；跨平台语义由 platform 参数选择（单测可在非 Windows 主机
 * 验证 win32 边界）。
 *
 * fail-closed：任何不可判定（相对路径、空值、风格不一致、异常）一律拒绝。
 * token / forceStale / genesis / 同会话刷新一律不放行；local 地址不受限。
 */

import { posix, win32 } from "node:path";
import { masterAddress, type ObjectAddress } from "./address.ts";

export type HomeGuardReason = "not-home-dir";

export type HomeGuardResult = { ok: true } | { ok: false; reason: HomeGuardReason };

/**
 * 精确 home 根目录判定：normalize（处理 `.`/`..`/尾部分隔符）后全等比较。
 * - win32：大小写不敏感（含驱动器号），`/` 与 `\` 等价。
 * - posix：大小写敏感。
 * 子目录（home/repo、home/OneDrive、home/.pi）、同前缀（Annacomnena2）、
 * drive-relative（C:foo）、root-relative（\foo）、跨盘符/UNC share 全部拒绝。
 * Windows 8.3 短名 / junction / symlink 等别名不做物理同一性推断（误拒优先）。
 */
export function isExactHomeCwd(cwd: string, home: string, platform: NodeJS.Platform): boolean {
	try {
		if (typeof cwd !== "string" || typeof home !== "string") return false;
		if (!cwd.trim() || !home.trim()) return false;
		const p = platform === "win32" ? win32 : posix;
		// 平台风格一致性：双方都必须是该平台语义下的绝对路径。
		if (!p.isAbsolute(cwd) || !p.isAbsolute(home)) return false;
		// win32 下 drive-relative（C:foo）已被 isAbsolute 筛掉；但 root-relative
		//（\foo）会被 win32.isAbsolute 判为 true（按当前盘符解释），语义不明 → 显式拒绝。
		if (platform === "win32") {
			const rootRelative = /^[/\\](?![/\\])/;
			if (rootRelative.test(cwd) || rootRelative.test(home)) return false;
		}
		// 另拒 NUL 等控制字符（非法路径输入 fail closed）。
		if (/[\x00-\x1f\x7f]/.test(cwd) || /[\x00-\x1f\x7f]/.test(home)) return false;
		const normCwd = p.resolve(cwd);
		const normHome = p.resolve(home);
		if (platform === "win32") return normCwd.toLowerCase() === normHome.toLowerCase();
		return normCwd === normHome;
	} catch {
		return false;
	}
}

/**
 * Global 地址门：缺省（undefined）按 masterAddress() 解析为 global，同样受限；
 * 只有精确等于 global 才走 home 判定（不用 `agent://master_` 前缀匹配）；
 * local / 其他地址直接放行（低层 registry 行为维持原状）。
 * cwd 不可用（null/undefined/空）→ fail closed。
 */
export function checkMasterHomeAttach(
	agent: ObjectAddress | undefined,
	cwd: string | null | undefined,
	home: string,
	platform: NodeJS.Platform,
): HomeGuardResult {
	const resolved = agent ?? masterAddress();
	if (resolved !== masterAddress()) return { ok: true };
	if (typeof cwd !== "string" || !cwd) return { ok: false, reason: "not-home-dir" };
	return isExactHomeCwd(cwd, home, platform) ? { ok: true } : { ok: false, reason: "not-home-dir" };
}

/**
 * slash 与 tool 共用的人类可操作文案（不回显 token；home 由 homedir() 动态格式化）。
 * 无 token 的 genesis / stale 情形调用方改用无 token 版措辞。
 */
export function formatNotHomeDirMessage(home: string, opts: { hasToken?: boolean; unavailable?: boolean } = {}): string {
	const tail = opts.hasToken
		? "请在该目录启动新会话再用原 token 接管，仓库会话请持对应 local Master。"
		: "请在该目录启动新会话再执行 /master-attach（需要时带 token），仓库会话请持对应 local Master。";
	const base =
		`master-attach 已拒绝：全局 Master 只能在用户 home（${home}）会话执行；` + tail;
	return opts.unavailable ? `${base}（请核对 HOME/USERPROFILE 与会话工作目录）` : base;
}
