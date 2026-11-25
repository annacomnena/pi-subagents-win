/**
 * gui/src/rightRail/shortcutsForm.ts — 快捷按钮表单的**纯校验**（无 React 依赖，可 node 直测）。
 *
 * 与服务端 extensions/gui-shortcuts.ts::normalizeAction 的约束保持一致：前端先拦住常见错，
 * 错误显示在字段旁；服务端仍是唯一权威（路径逃逸等需 cwd 的判据只在服务端做）。
 * L4 复审重要项：此前表单零校验、全靠服务端 400 + 横幅，用户无法定位错在哪个字段。
 */

import type { ShortcutAction } from "../api/types";

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PS_META_RE = /[;|&`$<>^(){}]|(?:\\r?\\n)/;

/**
 * 由主配置绝对路径推导提案目录（后端是 join(dirs.root,"proposals")）。
 * 只换最后一段并保留原分隔符 —— Windows 反斜杠路径不能按 "/" 切。
 */
export function proposalsDirOf(configPath: string): string {
	return configPath.replace(/([\\/])[^\\/]+$/, "$1proposals");
}

/** chatSessions 里的最小面（避免从纯模块 import store 造成环）。 */
export interface ChatSessionLike {
	sessionId: string;
	cwd: string | null;
}

/**
 * 当前会话的 cwd，用于「不在仓库主页时」给快捷按钮面板定仓库。
 * 只认非空字符串；sessionId 缺失/会话列表未就绪一律 null（不拿空串去请求配置）。
 */
export function sessionCwdOf(sessions: readonly ChatSessionLike[] | undefined, sid: string | null): string | null {
	if (typeof sid !== "string" || sid.length === 0 || !Array.isArray(sessions)) return null;
	const found = sessions.find((s) => s.sessionId === sid);
	return typeof found?.cwd === "string" && found.cwd.length > 0 ? found.cwd : null;
}

/** 返回人类可读的错误串；null 表示通过。 */
export function validateShortcutDraft(draft: ShortcutAction): string | null {
	if (!ID_RE.test(draft.id)) return "id 须匹配 [a-z0-9][a-z0-9_-]{0,63}";
	if (draft.label.trim().length < 1 || draft.label.length > 40) return "显示名称须 1–40 字符";
	if ((draft.kind === "script" || draft.kind === "process") && draft.confirm !== true) {
		return "危险动作必须保持二次确认开启";
	}
	if (draft.timeoutMs !== undefined && (!Number.isSafeInteger(draft.timeoutMs) || draft.timeoutMs < 5000 || draft.timeoutMs > 600000)) {
		return "超时须为 5000–600000 毫秒的整数";
	}

	switch (draft.kind) {
		case "url": {
			if (typeof draft.url !== "string" || draft.url.trim() === "") return "url 不能为空";
			let u: URL;
			try { u = new URL(draft.url); } catch { return "url 格式非法（例：http://localhost:8080）"; }
			if (u.protocol !== "http:" && u.protocol !== "https:") return "url 仅允许 http / https";
			return null;
		}
		case "file": {
			if (typeof draft.path !== "string" || draft.path.trim() === "") return "路径不能为空";
			const p = draft.path.replace(/\\/g, "/");
			if (p.startsWith("/") || /^[a-zA-Z]:/.test(p)) return "路径须为仓库内相对路径，不能用绝对路径";
			if (p.split("/").includes("..")) return "路径不能包含 .. 逃出仓库";
			return null;
		}
		case "script": {
			if (typeof draft.command !== "string" || draft.command.trim() === "") return "脚本文件名不能为空";
			if (!/^[^\\/:*?"<>|\s]+\.ps1$/i.test(draft.command)) return "脚本须为单个 .ps1 文件名（不含路径/空格/元字符）";
			const args = draft.args ?? [];
			if (args.length > 64) return "参数不能超过 64 项";
			for (const a of args) {
				if (a.length > 512) return "单个参数不能超过 512 字符";
				if (PS_META_RE.test(a)) return `参数含 PowerShell 元字符：${a}`;
			}
			return null;
		}
		case "process": {
			const m = draft.matchCommandLine ?? "";
			if (m.length < 4 || m.length > 200) return "命令行特征串须 4–200 字符";
			if (/[*?]/.test(m)) return "命令行特征串不支持 * ? 通配符";
			return null;
		}
	}
}
