/**
 * extensions/runtime-host/file-preview.ts — GUI 文档预览的**纯逻辑**（2026-11-20）。
 *
 * 用途：让 GUI 右栏能预览 agent 回复里提到的文件，并提供「用默认应用打开」「打开所在文件夹」。
 * 没有任何 markdown 依赖，也不碰 HTTP；server.ts 只做鉴权 + body 解析 + 错误映射（薄绑定）。
 *
 * 安全/健壮性口径（详见 AGENTS.md §0/§4）——**按动作分级，不一刀切**：
 *
 * - `read`（右栏只读预览）/ `reveal`（资源管理器定位）= relaxed：
 *   只做形状检查（长度 / NUL / 控制字符 / URL / UNC / 设备 / ADS / 盘符相对路径）。
 *   **不按"允许工作区"挡路径**：这两条动作不执行任何东西，且 agent 本就能把任意文本文件内容
 *   直接写进回复；按工作区限制只会误伤家目录/其它盘上的正常文档（实测：会话 cwd 是家目录时
 *   `extensions/xxx.ts` 被拒，用户只是想看一眼）。相对路径会在 [显式 cwd, daemon cwd, 已知工作区,
 *   家目录] 里按顺序找第一个真实存在的文件，解决"agent 写的路径相对仓库、会话 cwd 却是家目录"。
 *
 * - `open`（默认应用打开）= strict：形状检查 + **词法范围判定 + realpath 范围判定**（都在任何
 *   statSync 之前，cwd 同理）+ **文档扩展名白名单**。ShellExecute 会执行 .bat/.cmd/.exe/.py/.js，
 *   一次点击就是一次执行 —— 只有这条动作需要完整防线。
 *
 * - 系统打开一律 `spawn` + **参数数组**（永不经 shell 拼接），Windows 用 explorer.exe：
 *   `explorer <path>` 打开默认应用、`explorer /select,<path>` 在资源管理器中定位。
 * - 读预览只接受普通文件，512 KiB 上限 + 二进制嗅探（NUL / 常见图片魔数），永不读 FIFO/设备；
 *
 * 信任模型（L4 审查后修正）：daemon 只监听 loopback，写端点沿用 authorizeCommand（本机 token
 * 或同源派生 cookie，SameSite=Strict）；**但这不等于 agent 文本可信** —— 路径来自 assistant 回复，
 * 需用户显式点击。形状检查对所有动作生效；范围 + 白名单只加在唯一有执行语义的 `open` 上。
 * 不声称这是沙箱：同一台机器上能读 host.json 的进程本就能连 daemon，本端点不扩大那条既有边界。
 */

import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, isAbsolute, parse, resolve, sep } from "node:path";

/** 单次预览最多读取的字节数（超出 → truncated=true，不报错；完整内容走「默认应用打开」）。 */
export const FILE_PREVIEW_MAX_BYTES = 512 * 1024;
/** 路径字符串上限（防超长输入撑爆日志/响应）。 */
export const FILE_PREVIEW_MAX_PATH_CHARS = 4096;

export interface FilePathInput {
	path: string;
	cwd?: string | null;
}

export type PathResolution =
	| { ok: true; path: string; base: string }
	| { ok: false; error: string; hint: string };

function bad(error: string, hint: string): PathResolution {
	return { ok: false, error, hint };
}

/**
 * 字符串层面的形状/长度/控制字符校验，path 与 cwd 共用（I-1：两者是同等不可信的输入）。
 * 返回 null = 可接受；否则返回给用户的说明。cwd 的错误措辞由调用方加前缀区分。
 */
function stringShapeProblem(raw: string, label: string): string | null {
	if (raw.length === 0) return `${label}不能为空`;
	if (raw.length > FILE_PREVIEW_MAX_PATH_CHARS) return `${label}不得超过 ${FILE_PREVIEW_MAX_PATH_CHARS} 字符`;
	// eslint-disable-next-line no-control-regex
	if (/[\x00-\x1f\x7f]/.test(raw)) return `${label}不得含控制字符`;
	// URL / 协议（含 file://）不是文件路径
	if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)) return `只接受本地文件路径，不接受 URL（${label}）`;
	return rejectUnsafePathShape(raw);
}

/**
 * 形状检查（在 resolve 之前，防 Windows 特有绕过）。
 * 返回 null = 形状可接受；否则返回给用户的说明。
 */
export function rejectUnsafePathShape(raw: string): string | null {
	// UNC / 设备路径： explorer 会触发对外 SMB（NTLM 泄露），且不在任何本地工作区内
	if (/^[\\/]{2}/.test(raw)) return "不支持 UNC/网络路径或设备路径（只接受本机绝对路径或工作区相对路径）";
	// 盘符相对路径 C:foo.md 会按各盘当前目录解析，行为不确定
	if (/^[A-Za-z]:[^\\/]/.test(raw)) return "盘符后必须有分隔符（如 C:/dir/file.md）";
	// NTFS 备用数据流 / 协议伪装：除盘符那一个冒号外，任何冒号都拒绝
	// （只看第一个冒号会让 C:\a.md:stream 溜过去 ⇒ 后续 stat 失败伪装成「文件不存在」）
	const hasDrive = /^[A-Za-z]:/.test(raw);
	const rest = hasDrive ? raw.slice(2) : raw;
	if (rest.includes(":")) return "路径不得含冒号（备用数据流 / URL 不支持）";
	if (/[|<>"]/.test(raw)) return "路径含非法字符";
	return null;
}

/** 规范化根目录用于包含判定（Windows 大小写/斜杠不敏感）。 */
function normalized(p: string): string {
	const r = resolve(p);
	return process.platform === "win32" ? r.toLowerCase() : r;
}

/** `target` 是否落在 `roots` 中某个根内（含根本身）。 */
export function isPathInsideRoots(target: string, roots: readonly string[]): boolean {
	const t = normalized(target);
	return roots.some((root) => {
		const n = normalized(root);
		return t === n || t.startsWith(n.endsWith(sep) ? n : n + sep);
	});
}

/** 任意平台的盘符/卷根（Windows `C:\`、POSIX `/`）——这类根过宽，不能当工作区。 */
function isVolumeRoot(p: string): boolean {
	try { return parse(p).root === p; } catch { return false; }
}

/**
 * 从会话 cwd 推导允许根，**剔除过宽的根**（L4 I2：实测 1110 会话推出 131 根，
 * 含整个 C:\Users\Annacomnena ⇒ 可读 .ssh/id_rsa；家目录的祖先如 C:\ 也在内）。
 * 规则（glm-5.3 I-3 加固）：家目录本身及其任何祖先、临时目录本身及其任何祖先、
 * 任意盘符/卷根，一律不算工作区；其余照收。判定统一用 normalized（大小写/斜杠不敏感）。
 */
export function deriveWorkspaceRoots(cwds: Iterable<string | null | undefined>, daemonCwd: string): string[] {
	const home = normalized(homedir());
	const tmp = normalized(tmpdir());
	const isSelfOrAncestor = (x: string, target: string): boolean =>
		x === target || target.startsWith(x.endsWith(sep) ? x : x + sep);
	const out = new Set<string>();
	for (const cwd of [daemonCwd, ...cwds]) {
		if (typeof cwd !== "string" || cwd.trim() === "") continue;
		let n: string;
		try { n = normalized(cwd); } catch { continue; }
		if (isSelfOrAncestor(n, home)) continue; // 家目录本身/祖先
		if (isSelfOrAncestor(n, tmp)) continue;  // 临时目录本身/祖先（含 tmpdir 的父链）
		if (isVolumeRoot(n)) continue;           // 任意盘符根 C:\ D:\ /
		out.add(resolve(cwd));
	}
	return [...out];
}

/**
 * 链接逃逸防护（glm-5.3 I-2）：`absPath` 经词法校验后，再用 realpathSync 求真实路径并
 * 二次判范围。工作区内的 junction/symlink 若指向根外（本仓 node_modules 就有活 junction），
 * realpath 会落到根外 ⇒ 拒绝，避免「一次点击读到 SSH 私钥」。
 *
 * realpath 失败（不存在 / 断链 / 权限）时**保留词法路径**交给下游 read/launcher：它们对
 * 不存在的路径本就报 not-found（404），且经断链的 openSync 同样失败，不会读到根外内容；
 * 此处若 fail-closed 成 out-of-scope 会把「文件不存在」错误地报成 400。
 * 只有 realpath **成功且真实路径落在根外**才拒绝 —— 这才是链接逃逸的真实信号。
 * 调用方须在 read/open/reveal 三处都调用它（不能只挡 read）。
 */
export function assertResolvedPathInRoots(absPath: string, roots: readonly string[]): PathResolution {
	let realPath: string;
	try {
		realPath = realpathSync(absPath);
	} catch {
		return { ok: true, path: absPath, base: absPath };
	}
	if (!isPathInsideRoots(realPath, roots)) {
		return bad("out-of-scope", "该路径经符号链接/junction 指向允许工作区之外，已拒绝访问");
	}
	return { ok: true, path: absPath, base: realPath };
}

/**
 * 解析口径：`strict` 只给 "默认应用打开"（唯一有执行语义的动作）用；
 * `read` / `reveal` 用 `relaxed` —— 只挡形状不合法的串，不按工作区挡路径。
 */
export type ResolveMode = "strict" | "relaxed";

/**
 * relaxed 解析：形状合法的本机路径一律放行；相对路径在候选基准里找第一个真实存在的文件。
 *
 * 为什么要找：agent 写的路径常相对**仓库根**（`extensions/xxx.ts`），但点选时的会话 cwd 可能是
 * 家目录（`C:\Users\Annacomnena`）—— 直接按那一个基准 resolve 必然 404。按顺序试
 * [显式 cwd, daemon cwd, 服务端已知工作区, 家目录]，命中即返回，并把实际基准回给前端展示。
 *
 * cwd 的形状检查与 strict 完全相同（UNC/ADS/控制字符进不了 statSync）；但**不要求 cwd 落在
 * 任何允许集内** —— 家目录就是合法基准。不存在的文件仍返回 ok，交由下游 readTextPreview
 * 报 404（保留"文件不存在"与"类型不对"的区分）。
 */
function resolveRelaxed(raw: string, cwdInput: string | null | undefined, daemonCwd: string, roots: readonly string[]): PathResolution {
	let explicitCwd: string | null = null;
	if (typeof cwdInput === "string" && cwdInput.trim() !== "") {
		const rawCwd = cwdInput.trim();
		const cwdProblem = stringShapeProblem(rawCwd, "cwd");
		if (cwdProblem !== null) return bad("bad-cwd", cwdProblem);
		let candidate: string;
		try {
			candidate = resolve(rawCwd);
		} catch (e) {
			return bad("bad-cwd", `cwd 解析失败：${String((e as Error).message ?? e)}`);
		}
		try {
			if (!statSync(candidate).isDirectory()) return bad("bad-cwd", "相对路径基准（cwd）不是目录");
		} catch {
			return bad("bad-cwd", "相对路径基准（cwd）不存在或不可访问");
		}
		explicitCwd = candidate;
	}

	const daemonBase = resolve(daemonCwd);
	const fallbackBase = explicitCwd ?? daemonBase;
	if (isAbsolute(raw)) return { ok: true, path: resolve(raw), base: fallbackBase };

	const candidates: string[] = [];
	const push = (b: string): void => { if (!candidates.includes(b)) candidates.push(b); };
	if (explicitCwd !== null) push(explicitCwd);
	push(daemonBase);
	for (const r of roots) push(r);
	try { push(homedir()); } catch { /* 取不到家目录就少一个候选，不影响其它基准 */ }

	for (const b of candidates) {
		const target = resolve(b, raw);
		try {
			if (statSync(target).isFile()) return { ok: true, path: target, base: b };
		} catch { /* 该基准下不存在，试下一个 */ }
	}
	return { ok: true, path: resolve(fallbackBase, raw), base: fallbackBase };
}

/**
 * 把 `path`（相对则基于 cwd）解析为绝对路径。
 *
 * strict（仅 open）：`allowedRoots` 由**服务端**从已知会话 cwd + daemon cwd 推导，不接受
 * 客户端自报范围；空集合 ⇒ 用同一剔除规则过滤 `[daemonCwd]`，过滤后仍空 ⇒ 拒绝一切路径
 * （fail-closed）。cwd 也必须落在允许集内，且经 realpath 二次判定，任何 statSync 之前完成。
 *
 * relaxed（read/reveal）：见 resolveRelaxed，只做形状检查。
 */
export function resolvePreviewPath(
	input: FilePathInput,
	daemonCwd: string,
	allowedRoots?: readonly string[],
	mode: ResolveMode = "strict",
): PathResolution {
	if (typeof input?.path !== "string") return bad("bad-path", "path 必须是字符串");
	const raw = input.path.trim();
	const shape = stringShapeProblem(raw, "path");
	if (shape !== null) return bad("bad-path", shape);
	if (input.cwd !== undefined && input.cwd !== null && typeof input.cwd !== "string") {
		return bad("bad-cwd", "cwd 须为字符串或 null");
	}

	// N'-2：兜底根也过剔除规则；daemon 恰从 home/盘根/tmp 启动且无有效会话 ⇒ 空集 ⇒ 全部拒绝。
	const roots = allowedRoots !== undefined && allowedRoots.length > 0
		? allowedRoots.map((r) => resolve(r))
		: deriveWorkspaceRoots([], daemonCwd).map((r) => resolve(r));

	if (mode === "relaxed") return resolveRelaxed(raw, input.cwd, daemonCwd, roots);

	if (roots.length === 0) return bad("out-of-scope", "没有可用的工作区（daemon 启动目录过宽且无已知会话），已拒绝访问");
	let base = resolve(daemonCwd);
	if (typeof input.cwd === "string" && input.cwd.trim() !== "") {
		const rawCwd = input.cwd.trim();
		const cwdProblem = stringShapeProblem(rawCwd, "cwd");
		if (cwdProblem !== null) return bad("bad-cwd", cwdProblem);
		let candidate: string;
		try {
			candidate = resolve(rawCwd);
		} catch (e) {
			return bad("bad-cwd", `cwd 解析失败：${String((e as Error).message ?? e)}`);
		}
		// I-1：范围判定必须先于 statSync —— 绝不以 daemon 身份对范围外路径（含 UNC）发起任何文件系统访问。
		if (!isPathInsideRoots(candidate, roots)) {
			return bad("out-of-scope", "当前路径不在允许打开的工作区内；可用「打开文件夹」自行处理，或复制路径到资源管理器");
		}
		// N'-3：cwd 经 junction 指向根外时，realpath 会落到根外 ⇒ 拒绝，
		// 之后的 statSync 就不会跟随 reparse point 读范围外元数据（UNC cwd 元数据也不再触碰）。
		const cwdReal = assertResolvedPathInRoots(candidate, roots);
		if (!cwdReal.ok) return bad("out-of-scope", "当前路径经符号链接/junction 指向允许范围之外，已拒绝打开");
		try {
			if (!statSync(candidate).isDirectory()) return bad("bad-cwd", "相对路径基准（cwd）不是目录");
		} catch {
			return bad("bad-cwd", "相对路径基准（cwd）不存在或不可访问");
		}
		base = candidate;
	}
	try {
		const target = resolve(base, raw);
		if (!isPathInsideRoots(target, roots)) {
			return bad("out-of-scope", `路径不在允许打开的工作区内（共 ${roots.length} 个已知工作区）；可用「打开文件夹」自行处理`);
		}
		// 显式 cwd 时再约束一次到该基准内：防止「cwd 是合法根、目标靠 .. 跳到另一个根」。
		if (typeof input.cwd === "string" && input.cwd.trim() !== "" && !isPathInsideRoots(target, [base])) {
			return bad("out-of-scope", "路径超出当前工作区（相对路径含 .. 逃逸）");
		}
		return { ok: true, path: target, base };
	} catch (e) {
		return bad("bad-path", `path 解析失败：${String((e as Error).message ?? e)}`);
	}
}

export type PreviewRead =
	| { ok: true; path: string; content: string; size: number; truncated: boolean; encoding: string; mtimeMs: number }
	| { ok: false; error: string; hint: string };

function decodeUtf8OrGb(buf: Buffer): { content: string; encoding: string } | null {
	if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
		return { content: buf.subarray(3).toString("utf8"), encoding: "utf-8 (BOM)" };
	}
	try {
		return { content: new TextDecoder("utf-8", { fatal: true }).decode(buf), encoding: "utf-8" };
	} catch {
		// 中文旧文档常见 GBK/GB18030；Node 自带 full-icu 支持 gb18030
	}
	try {
		return { content: new TextDecoder("gb18030").decode(buf), encoding: "gb18030" };
	} catch {
		return null;
	}
}

function looksBinary(buf: Buffer): boolean {
	if (buf.length === 0) return false;
	if (buf.subarray(0, Math.min(buf.length, 4096)).includes(0)) return true;
	const head = buf.subarray(0, 8);
	// PNG / JPEG / GIF / PDF / ZIP(含 docx/pptx/xlsx) / 常见音频视频容器
	const magics = [
		[0x89, 0x50, 0x4e, 0x47],
		[0xff, 0xd8, 0xff],
		[0x47, 0x49, 0x46, 0x38],
		[0x25, 0x50, 0x44, 0x46],
		[0x50, 0x4b, 0x03, 0x04],
	];
	return magics.some((m) => m.every((b, i) => head[i] === b));
}

/** 读取文本预览（有界 + 二进制拒绝）。返回判别联合，永不抛。 */
export function readTextPreview(absPath: string): PreviewRead {
	let st: ReturnType<typeof statSync>;
	try {
		st = statSync(absPath);
	} catch {
		return { ok: false, error: "not-found", hint: `文件不存在或不可访问：${absPath}` };
	}
	if (st.isDirectory()) return { ok: false, error: "is-directory", hint: "这是文件夹；请点文件本身，或用「打开所在文件夹」" };
	if (!st.isFile()) return { ok: false, error: "not-a-file", hint: "不是普通文件（设备/FIFO 等不予预览）" };
	if (st.size > FILE_PREVIEW_MAX_BYTES * 8) {
		return {
			ok: false,
			error: "too-large",
			hint: `文件 ${Math.round(st.size / 1024)} KiB 过大，预览上限 ${Math.round(FILE_PREVIEW_MAX_BYTES / 1024)} KiB；可用「用默认应用打开」查看完整内容`,
		};
	}
	const bytes = Math.min(st.size, FILE_PREVIEW_MAX_BYTES);
	const buf = Buffer.alloc(bytes);
	let fd: number | undefined;
	try {
		fd = openSync(absPath, "r");
		let read = 0;
		while (read < bytes) {
			const n = readSync(fd, buf, read, bytes - read, read);
			if (n <= 0) break;
			read += n;
		}
	} catch (e) {
		return { ok: false, error: "read-failed", hint: String((e as Error).message ?? e) };
	} finally {
		if (fd !== undefined) {
			try { closeSync(fd); } catch { /* 关闭失败不影响已读入的数据 */ }
		}
	}
	const data = buf.subarray(0, bytes);
	if (looksBinary(data)) {
		return { ok: false, error: "binary", hint: "二进制文件无法在右栏预览；请用「用默认应用打开」" };
	}
	const decoded = decodeUtf8OrGb(data);
	if (decoded === null) return { ok: false, error: "decode-failed", hint: "无法识别文本编码（utf-8 / gb18030 均失败）" };
	return {
		ok: true,
		path: absPath,
		content: decoded.content,
		size: st.size,
		truncated: st.size > bytes,
		encoding: decoded.encoding,
		mtimeMs: st.mtimeMs,
	};
}

export type SystemAction = "open" | "reveal";

export interface SystemActionResult {
	ok: boolean;
	error?: string;
	hint?: string;
	/** true = 已发起（spawn 成功）；外部应用是否成功打开由 OS 决定，daemon 不等待。 */
	launched?: boolean;
}

/**
 * 「默认应用打开」走 **文档扩展名白名单**，不是黑名单。
 *
 * 原因（L4 实测）：本机 `assoc .py=Python.File → py.exe "%L"`、`assoc .js=JSFile → WScript.exe "%1"`，
 * 黑名单拦 .bat/.exe 却漏 .py/.js ⇒ 点一下就执行脚本。按平台惯例猜关联不可靠，
 * 所以只放行明确是「文档/数据/图片/压缩包」的扩展名；源码/不认识的类型请点「打开文件夹」自行处理。
 * reveal（定位）不受此限 —— 它用 explorer /select,，永不执行目标。
 */
const SAFE_OPEN_EXTS = new Set([
	".md", ".markdown", ".mdx", ".txt", ".log", ".csv", ".tsv", ".json", ".jsonc", ".yaml", ".yml",
	".toml", ".ini", ".xml", ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
	".odt", ".ods", ".odp", ".rtf", ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico",
	".zip", ".tar", ".gz", ".7z", ".rar",
]);

/** 该扩展名是否允许「默认应用打开」（false = 拒绝，给出改用「打开文件夹」的提示）。 */
export function isSafeOpenTarget(absPath: string): boolean {
	return SAFE_OPEN_EXTS.has(extname(absPath).toLowerCase());
}

/** 兼容旧调用点/测试的反向命名。 */
export function isDangerousOpenTarget(absPath: string): boolean {
	return !isSafeOpenTarget(absPath);
}

/**
 * 用 OS 默认应用打开 / 在资源管理器中定位。never-throw：失败返回判别联合。
 * `spawnFn` 仅供测试注入假进程（验证 error/exit 事件确实回流），生产用 node:child_process.spawn。
 */
export async function launchSystemAction(
	action: SystemAction,
	absPath: string,
	spawnFn: typeof spawn = spawn,
): Promise<SystemActionResult> {
	const shape = rejectUnsafePathShape(absPath);
	if (shape !== null) return { ok: false, error: "bad-path", hint: shape };
	if (action === "open" && !isSafeOpenTarget(absPath)) {
		return {
			ok: false,
			error: "executable-rejected",
			hint: "仅文档类文件支持默认应用打开（脚本/源码/未知类型可能被系统直接执行，如 .py/.js）；请用「打开文件夹」查看它",
		};
	}
	let targetStat: ReturnType<typeof statSync>;
	try {
		targetStat = statSync(absPath);
	} catch {
		return { ok: false, error: "not-found", hint: `路径不存在或不可访问：${absPath}` };
	}
	// N-3：open 只接受普通文件；目录即便带 .md 后缀也不该「用默认应用打开」弹出文件夹窗口。
	if (action === "open" && !targetStat.isFile()) {
		return { ok: false, error: "not-a-file", hint: "这不是普通文件（目录或设备），无法用默认应用打开；可用「打开文件夹」定位" };
	}
	const platform = process.platform;
	let cmd: string;
	let args: string[];
	if (platform === "win32") {
		cmd = "explorer.exe";
		args = action === "reveal" ? [`/select,${absPath}`] : [absPath];
	} else if (platform === "darwin") {
		cmd = "open";
		args = action === "reveal" ? ["-R", absPath] : [absPath];
	} else {
		cmd = "xdg-open";
		args = action === "reveal" ? [dirname(absPath)] : [absPath];
	}
	// 失败必须回流到 HTTP（AGENTS.md §2）：等 spawn/error/exit 事件再回执，不再吞掉 error。
	return await new Promise<SystemActionResult>((resolvePromise) => {
		let settled = false;
		let observeTimer: ReturnType<typeof setTimeout> | undefined;
		const finish = (result: SystemActionResult): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (observeTimer !== undefined) clearTimeout(observeTimer);
			resolvePromise(result);
		};
		// 兜底 fail-closed：3s 内既没 spawn 也没 error ⇒ 不能声称成功（宁可误报失败，不可静默假成功）。
		const timer = setTimeout(
			() => finish({ ok: false, error: "launch-unconfirmed", hint: `${cmd} 启动状态无法确认（未收到 spawn/error 事件）` }),
			3000,
		);
		try {
			const child = spawnFn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
			// 不要在 spawn 事件立即报成功：实测真实顺序是 spawn → (无关联程序时) 非零 exit。
			// 给 300ms 观察窗；窗内非零 exit/error → 失败，否则才认定 launched。
			child.once("spawn", () => {
				child.unref();
				observeTimer = setTimeout(() => finish({ ok: true, launched: true }), 300);
			});
			child.once("error", (e) => finish({ ok: false, error: "launch-failed", hint: `${cmd} 启动失败：${String((e as Error).message ?? e)}` }));
			child.once("exit", (code, signal) => {
				// N-2：null = 被信号杀死（非正常退出），不能当成功；0 才是成功。
				if (code === 0) finish({ ok: true, launched: true });
				else if (code === null) finish({ ok: false, error: "launch-failed", hint: `${cmd} 被信号 ${signal ?? "未知"} 终止（启动未完成）` });
				else finish({ ok: false, error: "launch-failed", hint: `${cmd} 退出码 ${code}（文件可能没有关联的打开程序）` });
			});
		} catch (e) {
			finish({ ok: false, error: "launch-failed", hint: `${cmd} 启动失败：${String((e as Error).message ?? e)}` });
		}
	});
}
