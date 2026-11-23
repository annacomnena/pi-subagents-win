/**
 * gui/src/filePath.ts — 判断一段内联 code 文本是否像**本地文件路径**（2026-11-20）。
 *
 * 纯逻辑、无 React / 无 DOM，供 node 直载测试（同 railState.ts 口径）。
 * 只做「值得渲染成可点击链接」的粗筛；真正的范围/类型校验在 daemon（file-preview.ts）。
 *
 * 为什么用白名单式粗筛：agent 回复里大量 code span 是符号（`net48`、`$4`、`Math.max`），
 * 误判成路径会把普通术语变成可点链接，反而干扰阅读。判据是「含分隔符 + 末段有短扩展名 +
 * 不含明显非法字符」，宁可漏掉少数怪路径，也不能满屏假链接。
 */

/** 明显不是文件路径的字符：空白、引号、shell/HTML 元字符、通配符、控制符。 */
const BAD_CHARS_RE = /[\s"'`<>|*?\x00-\x1f\x7f]/;
/** 协议头（含 file://）——URL 不当本地路径处理；Windows 盘符单独放行。 */
const PROTOCOL_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
/** 末段扩展名：1–12 位字母数字/_/+-（.md / .tsx / .tar.gz 只看最后一段）。 */
const EXT_RE = /\.[A-Za-z0-9_+-]{1,12}$/;

export function looksLikeFilePath(raw: string): boolean {
	if (typeof raw !== "string") return false;
	const s = raw.trim();
	if (s.length < 3 || s.length > 1024) return false;
	if (BAD_CHARS_RE.test(s) || PROTOCOL_RE.test(s)) return false;
	// 与 daemon 侧同形状约束：UNC/设备路径会触发 SMB 外联、冒号可能是 ADS，别渲染成可点按钮
	if (/^[\\/]{2}/.test(s)) return false;
	const hasDrive = /^[A-Za-z]:/.test(s);
	if ((hasDrive ? s.slice(2) : s).includes(":")) return false;
	// 必须有路径分隔符（`/` 或 `\`），排除 net48 / $4 / Math.max 这类纯符号
	if (!/[/\\]/.test(s)) return false;
	// Windows 盘符 C:\foo.md / C:/foo.md 合法，但盘符后必须紧跟分隔符
	if (/^[A-Za-z]:/.test(s) && !/^[A-Za-z]:[/\\]/.test(s)) return false;
	if (!EXT_RE.test(s)) return false;
	const parts = s.split(/[/\\]+/).filter((p) => p.length > 0 && p !== "." && p !== "..");
	if (parts.length === 0) return false;
	// 文件名点号前必须有内容（排除 `.md`、`/.md`）
	const last = parts[parts.length - 1] ?? "";
	return last.length > 1 && last.indexOf(".") > 0;
}

/** 从 code span 中提取第一个路径（当前只支持整段就是一个路径；多路径不猜）。 */
export function filePathInCode(raw: string): string | null {
	return looksLikeFilePath(raw) ? raw.trim() : null;
}
