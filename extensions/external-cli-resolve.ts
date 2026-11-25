/**
 * external-cli-resolve — 外部 CLI 的「真实入口」解析（Windows 感知；纯逻辑 + 可注入依赖，便于单测）
 *
 * 为什么必须有这一层（2026-11-16 本机实测事故，见 plans/20261116_cli_codex_param_passing.md）：
 *
 *  1. PATH 上的 npm 全局包在 Windows 只有 `.cmd` shim（`where codex.exe` 找不到）。
 *  2. Node ≥18.20.2 / 20.12.2（CVE-2024-27980 硬化）**拒绝** `spawn(".cmd", args, {shell:false})`：直接 EINVAL。
 *     ⇒ 旧实现只能 `shell:true`，于是参数穿过 cmd.exe 被重解析：
 *         真换行 → 字面 `\n`；`C:\Users\x` → `C:\\Users\\x`；
 *         **`%PATH%` → 被展开成整条 PATH（≈4000 字符注入）**；引号被吞。
 *     实测：现役 `agents/searcher.md`（2747 chars）经 cmd 后读回 2824 chars，body 已损坏。
 *  3. nvm4w 的 `C:\nvm4w\nodejs` 是 Junction → `%LOCALAPPDATA%\nvm\v22.19.0`。一旦 `nvm use` 到没装该 CLI
 *     的版本，`codex.cmd` 直接消失 ⇒ 旧实现回落**裸名 spawn** ⇒ 静默 ENOENT（极难归因）。
 *
 * 本层的职责：把「PATH 上的入口」解析成一个**不经 shell 的真实 spawn 目标**：
 *   - `.cmd`/`.bat` shim → 读出它真正要跑的 js/exe 入口，改由 `node <js>` 或直接 exe 启动（`shell:false`）；
 *   - 原生 `.exe` → 直接 spawn（`shell:false`）；
 *   - 解析不出来 → 明确报「已安装但入口不可解析」/「未安装」，**绝不**回落裸名。
 *
 * 绝不自己猜 `codex.exe`：本机存在两套 codex（顶层 0.143 陈旧 alias / 嵌套 0.161 实际使用），
 * 猜 exe 会选到旧版本（实测 0.143 跑 `gpt-6.1-sol` 直接 model_not_found）。只接管到 shim 指向的那一层。
 */

import { existsSync as fsExistsSync, readFileSync as fsReadFileSync, readdirSync as fsReaddirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, join } from "node:path";

/** spawn 目标形态（供诊断/展示）。 */
export type ExternalSpawnKind =
	/** 原生可执行文件（.exe 或 shim 指向的 .exe） */
	| "native"
	/** npm/pnpm shim 指向的 Node.js 入口（spawn: `node <js>`） */
	| "shim-js"
	/** 由本仓显式指定的 Node 脚本（zcode.cjs 一类） */
	| "node-script"
	/** 非 Windows 平台：PATH 上的裸可执行 */
	| "posix";

export interface ExternalSpawnTarget {
	/** 真正被 spawn 的可执行文件（Windows 下恒为 exe 或 process.execPath）。 */
	command: string;
	/** 前置参数：js 入口 / Node 脚本路径。 */
	prefixArgs: string[];
	/** spawn 的 shell 开关。解析到真实入口后恒为 false（这正是修复的核心）。 */
	shell: boolean;
	/** action=kill 的命令行归属 marker（必须真的出现在子进程命令行里）。 */
	marker: string;
	/** 展示名（TUI/错误文本用）。 */
	display: string;
	kind: ExternalSpawnKind;
	/** 解析来源，便于诊断「它是从哪找到的」。 */
	via: string;
}

export type ResolveResult =
	| { ok: true; target: ExternalSpawnTarget }
	| { ok: false; error: string; searched: string[]; searchedDirs: string[] };

/** 可注入依赖：使解析逻辑可单测（不依赖本机真实安装）。 */
export interface ResolveDeps {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	/** 用来跑 Node 脚本的可执行（默认 process.execPath）。 */
	execPath?: string;
	exists?: (path: string) => boolean;
	readFile?: (path: string) => string;
	readdir?: (dir: string) => string[];
	/** PATH 查找：返回首个命中路径（默认用 where/which）。 */
	whereLookup?: (name: string) => string | undefined;
}

const WINDOWS_SHIM_EXTENSIONS = [".cmd", ".bat"];
const NODE_ENTRY_EXTENSIONS = [".js", ".cjs", ".mjs"];

// ── 纯函数：shim 解析 ──────────────────────────────────────────────────────

/**
 * 展开 npm/pnpm/cmd-shim 里的路径变量（**不执行 cmd**，只做等价替换）。
 *
 * 覆盖三种真实形状（均已在本机实测）：
 *   npm (cmd-shim):  `"%dp0%\node_modules\@openai\codex\bin\codex.js"` + `SET dp0=%~dp0`
 *   pnpm:            `"$basedir/node_modules/..."`
 *   ps1/cmd 混用:    `%~dp0`
 */
export function expandShimPaths(raw: string, shimDir: string): string {
	return raw
		.replace(/\uFEFF/g, "")
		.replace(/%~dp0%/gi, shimDir)
		.replace(/%~dp0/gi, shimDir)
		.replace(/%dp0%/gi, shimDir)
		.replace(/\$basedir/g, shimDir);
}

/** 归一化 Windows 路径分隔符（shim 里 npm 用 `\`、pnpm 用 `/`，可能混用）。 */
function normalizeWinPath(raw: string): string {
	return raw.replace(/\//g, "\\");
}

/** 该 token 是否是解释器自身（node.exe / %_prog% 之类），必须排除。 */
function isInterpreterToken(token: string): boolean {
	const lower = token.toLowerCase();
	if (lower.includes("%")) return true; // %_prog% / 未展开变量：不可信
	const base = basename(normalizeWinPath(token)).toLowerCase();
	return base === "node" || base === "node.exe" || base === "node.cmd" || base === "cmd.exe";
}

/**
 * 从一个 Windows shim 的文本里解析出**可能的真实入口**（按可信度排序）。
 *
 * 返回的是候选列表而非单个结果：调用方用 `exists` 过滤，取第一个真正存在的。
 * 排序：`.js/.cjs/.mjs` 优先（Node 入口），其次含 `node_modules` 的无扩展名入口（如 cline 的 `bin/cline`）。
 *
 * 纯函数：不读盘、不执行任何东西，便于单测锁定形状。
 */
export function parseShimEntryCandidates(shimPath: string, raw: string): string[] {
	const shimDir = dirname(shimPath);
	const expanded = expandShimPaths(raw, shimDir);

	// 1) 引号包裹的 token（npm/pnpm/cmd-shim 一律给入口加引号）
	const quoted = [...expanded.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
	// 2) 兜底：未加引号但明显是 node_modules 里的入口
	const bareTokens = expanded
		.split(/[\s&|<>^()]+/)
		.filter((t) => t && t.includes("node_modules") && !t.startsWith("\\"));

	const all = [...quoted, ...bareTokens]
		.map((t) => t.trim())
		.filter(Boolean)
		.filter((t) => !isInterpreterToken(t))
		.map((t) => normalizeWinPath(t));

	const withNodeScriptExt = all.filter((t) => NODE_ENTRY_EXTENSIONS.some((ext) => t.toLowerCase().endsWith(ext)));
	const underNodeModules = all.filter((t) => t.toLowerCase().includes("node_modules"));
	const nativeExe = all.filter((t) => t.toLowerCase().endsWith(".exe"));

	const seen = new Set<string>();
	const out: string[] = [];
	// `.exe` 入口排最前（能直接 spawn，无需 node），其次 Node 脚本，最后 node_modules 里的无扩展名入口。
	for (const candidate of [...nativeExe, ...withNodeScriptExt, ...underNodeModules]) {
		if (seen.has(candidate)) continue;
		seen.add(candidate);
		out.push(candidate);
	}
	return out;
}

// ── 纯函数：shell 开关 ─────────────────────────────────────────────────────

/**
 * spawn 的 shell 开关。
 *
 * 规则（顺序固定）：
 *  1. 调用方显式给了 `explicitShell` → 用它（解析到真入口后一律 false）。
 *  2. 没给 → 保持历史行为：Windows 上 `.cmd`/`.bat` 必须 `shell:true`
 *     （Node ≥18.20.2 对 `.cmd` + `shell:false` 直接 EINVAL，跑不起来）。
 *
 * 这条规则是**唯一**允许走 cmd 的路径；生产解析器不会让 `.cmd` 走到这里（它会先解析成真入口）。
 */
export function resolveSpawnShell(command: string, explicitShell?: boolean, platform: NodeJS.Platform = process.platform): boolean {
	if (typeof explicitShell === "boolean") return explicitShell;
	if (platform !== "win32") return false;
	const lower = command.toLowerCase();
	return WINDOWS_SHIM_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** 展示用：去掉厂牌后缀，便于错误文本归纳。 */
function displayNameFor(backend: string): string {
	return `cli:${backend}`;
}

// ── 解析器 ────────────────────────────────────────────────────────────────

const BACKEND_BINARY: Record<string, string> = {
	claude: "claude",
	codex: "codex",
	agy: "agy",
	atomcode: "atomcode",
	mimo: "mimo",
};

/** zcode 是 Node 脚本（固定 GLM-5.3），由本仓显式指定入口。 */
const ZCODE_DEFAULT_SCRIPT = "D:\\Software\\zcode\\resources\\glm\\zcode.cjs";

function defaultWhereLookup(platform: NodeJS.Platform): (name: string) => string | undefined {
	return (name: string) => {
		try {
			const output = execFileSync(platform === "win32" ? "where.exe" : "which", [name], {
				encoding: "utf8",
				shell: false,
				stdio: ["ignore", "pipe", "ignore"],
			});
			return output
				.split(/\r?\n/)
				.map((line) => line.trim())
				.find(Boolean);
		} catch {
			return undefined;
		}
	};
}

/**
 * Windows 上「不在 PATH 但都在约定位置」的额外搜索目录。
 *
 * 动机（实测）：nvm4w 的 symlink 一旦切到没装该 CLI 的 node 版本，PATH 上就彻底找不到；
 * 但 `NVM_HOME\v<ver>` 里仍然留着那个版本的 shim。给出这些兜底目录，让 `cli:codex`
 * 在 `nvm use 24.x` 之后仍可用，而不是静默 ENOENT。
 */
export function windowsFallbackDirs(env: NodeJS.ProcessEnv, readdir: (dir: string) => string[]): Array<{ dir: string; via: string }> {
	const out: Array<{ dir: string; via: string }> = [];
	const push = (dir: string | undefined, via: string) => {
		if (!dir) return;
		const normalized = normalizeWinPath(dir).replace(/\\+$/, "");
		if (!normalized) return;
		if (out.some((entry) => entry.dir.toLowerCase() === normalized.toLowerCase())) return;
		out.push({ dir: normalized, via });
	};

	// 1) nvm 当前 symlink（PATH 命中失败时的第一兜底）
	push(env.NVM_SYMLINK, "nvm-symlink");
	// 2) npm 全局 bin（`npm i -g` 不一定在 PATH 上）
	if (env.APPDATA) push(join(env.APPDATA, "npm"), "appdata-npm");
	// 3) bun / 本地 bin 约定
	if (env.USERPROFILE) push(join(env.USERPROFILE, ".local", "bin"), "userprofile-local-bin");
	if (env.USERPROFILE) push(join(env.USERPROFILE, ".bun", "bin"), "userprofile-bun-bin");
	// 4) nvm 各版本目录（按语义版本降序：优先较新装的那份）
	if (env.NVM_HOME) {
		let versions: string[] = [];
		try {
			versions = readdir(env.NVM_HOME).filter((name) => /^v?\d+\.\d+\.\d+/.test(name));
		} catch {
			versions = [];
		}
		const sorted = versions.slice().sort((a, b) => {
			const va = a.replace(/^v/, "").split(".").map(Number);
			const vb = b.replace(/^v/, "").split(".").map(Number);
			for (let i = 0; i < 3; i++) {
				const d = (vb[i] ?? 0) - (va[i] ?? 0);
				if (d !== 0) return d;
			}
			return 0;
		});
		for (const version of sorted) push(join(env.NVM_HOME, version), `nvm-version:${version}`);
	}
	return out;
}

function toTargetFromPath(
	backend: string,
	foundPath: string,
	via: string,
	deps: Required<Pick<ResolveDeps, "platform" | "execPath" | "exists" | "readFile">>,
): ResolveResult {
	const normalized = deps.platform === "win32" ? normalizeWinPath(foundPath) : foundPath;
	const lower = normalized.toLowerCase();
	const isWindowsShim = deps.platform === "win32" && WINDOWS_SHIM_EXTENSIONS.some((ext) => lower.endsWith(ext));

	if (!isWindowsShim) {
		return {
			ok: true,
			target: {
				command: normalized,
				prefixArgs: [],
				shell: resolveSpawnShell(normalized, false, deps.platform),
				marker: normalized,
				display: basename(normalized),
				kind: deps.platform === "win32" ? "native" : "posix",
				via,
			},
		};
	}

	// Windows shim：解析它真正要跑的入口，改由「不经 shell」的方式启动。
	let raw = "";
	try {
		raw = deps.readFile(normalized);
	} catch (err) {
		return {
			ok: false,
			error: `${displayNameFor(backend)} is installed but its Windows shim could not be read (${normalized}): ${err instanceof Error ? err.message : String(err)}`,
			searched: [normalized],
			searchedDirs: [dirname(normalized)],
		};
	}
	const candidates = parseShimEntryCandidates(normalized, raw).filter((candidate) => deps.exists(candidate));
	if (candidates.length === 0) {
		return {
			ok: false,
			error: `${displayNameFor(backend)} Windows shim is unresolvable: ${normalized} does not point to an existing Node entry or .exe (parsed ${parseShimEntryCandidates(normalized, raw).length} candidate(s), none exist on disk)`,
			searched: [normalized],
			searchedDirs: [dirname(normalized)],
		};
	}
	const entry = candidates[0];

	// shim 指向 .exe → 直接 spawn 那个 exe（不经 shell，零重新解析）
	if (entry.toLowerCase().endsWith(".exe")) {
		return {
			ok: true,
			target: {
				command: entry,
				prefixArgs: [],
				shell: false,
				marker: entry,
				display: basename(entry),
				kind: "native",
				via: `${via}:shim→exe`,
			},
		};
	}

	// shim 指向 Node 入口 → `node <entry>`（这是参数无损的关键：shell:false）
	return {
		ok: true,
		target: {
			command: deps.execPath,
			prefixArgs: [entry],
			shell: false,
			marker: entry,
			display: basename(entry),
			kind: "shim-js",
			via: `${via}:shim→js`,
		},
	};
}

/**
 * 解析某后端「该怎么 spawn」。
 *
 * 搜索顺序（Windows）：
 *   1. `PI_EXTERNAL_CLI_BIN_<BACKEND>` 显式覆盖（+ 历史的 `MIMOCODE_BIN` / `ZCODE_CJS`）
 *   2. PATH：`<name>.exe` → `<name>.cmd` → `<name>`（**exe 优先**：原生可执行不需要 shell，天然无损）
 *   3. 约定目录兜底（见 `windowsFallbackDirs`）
 * 每命中一个就以「能不经 shell 启动」为目标做转换；解析失败明确报错，**绝不回落裸名**。
 */
export function resolveExternalSpawnTarget(backend: string, deps: ResolveDeps = {}): ResolveResult {
	const platform = deps.platform ?? process.platform;
	const env = deps.env ?? process.env;
	const execPath = deps.execPath ?? process.execPath;
	const exists = deps.exists ?? ((p: string) => fsExistsSync(p));
	const readFile = deps.readFile ?? ((p: string) => fsReadFileSync(p, "utf8"));
	const readdir = deps.readdir ?? ((d: string) => fsReaddirSync(d));
	const whereLookup = deps.whereLookup ?? defaultWhereLookup(platform);
	const defaults = { platform, execPath, exists, readFile } as Required<Pick<ResolveDeps, "platform" | "execPath" | "exists" | "readFile">>;

	// ── zcode：本仓显式 Node 脚本入口（不是 PATH 上的可执行）──
	if (backend === "zcode") {
		const script = (env.ZCODE_CJS ?? "").trim() || (env.ZCODE_BIN ?? "").trim() || ZCODE_DEFAULT_SCRIPT;
		if (!exists(script)) {
			return {
				ok: false,
				error: `${displayNameFor("zcode")} script not found: ${script} (set ZCODE_CJS to override)`,
				searched: [script],
				searchedDirs: [dirname(script)],
			};
		}
		return {
			ok: true,
			target: {
				command: execPath,
				prefixArgs: [script],
				shell: false,
				marker: script,
				display: basename(script),
				kind: "node-script",
				via: env.ZCODE_CJS || env.ZCODE_BIN ? "env-override" : "builtin-path",
			},
		};
	}

	const binary = BACKEND_BINARY[backend];
	if (!binary) {
		return { ok: false, error: `unknown external CLI backend "${backend}"`, searched: [], searchedDirs: [] };
	}

	// ── 1) 显式覆盖 ──
	const overrideKey = `PI_EXTERNAL_CLI_BIN_${backend.toUpperCase()}`;
	const overrides: Array<{ value: string | undefined; via: string }> = [
		{ value: (env[overrideKey] ?? "").trim() || undefined, via: `env:${overrideKey}` },
	];
	if (backend === "mimo") {
		overrides.push({ value: (env.MIMOCODE_BIN ?? "").trim() || undefined, via: "env:MIMOCODE_BIN" });
	}
	for (const override of overrides) {
		if (!override.value) continue;
		if (!exists(override.value)) {
			return {
				ok: false,
				error: `${displayNameFor(backend)}: ${override.via} points to a non-existent path: ${override.value}`,
				searched: [override.value],
				searchedDirs: [dirname(override.value)],
			};
		}
		return toTargetFromPath(backend, override.value, override.via, defaults);
	}

	// ── 2) PATH 查找（.exe 优先：原生可执行不需要 shell，天然无损）──
	const searched: string[] = [];
	const searchedDirs: string[] = [];
	const names =
		platform === "win32"
			? [`${binary}.exe`, `${binary}.cmd`, `${binary}.bat`]
			: [binary];
	for (const name of names) {
		searched.push(name);
		const hit = whereLookup(name);
		if (hit && exists(hit)) return toTargetFromPath(backend, hit, "path", defaults);
	}
	// 裸名：Windows 上 `where <name>` 会按 PATHEXT 命中 `.cmd`/`.ps1` 等；
	// 只接受存在且**不是 `.ps1`**（PowerShell 脚本无法用 node/exe 方式绕过 shell 启动）。
	const bare = whereLookup(binary);
	if (bare && exists(bare) && !bare.toLowerCase().endsWith(".ps1")) {
		return toTargetFromPath(backend, bare, "path", defaults);
	}

	// ── 3) 约定目录兜底（Windows）──
	if (platform === "win32") {
		for (const { dir, via } of windowsFallbackDirs(env, readdir)) {
			searchedDirs.push(dir);
			for (const ext of [".exe", ".cmd", ".bat", ""]) {
				const candidate = normalizeWinPath(join(dir, `${binary}${ext}`));
				if (exists(candidate)) return toTargetFromPath(backend, candidate, via, defaults);
			}
		}
	}

	return {
		ok: false,
		error:
			`${displayNameFor(backend)} CLI not found on PATH (looked for ${names.join(" / ")}` +
			(platform === "win32" ? ` plus fallback dirs: ${searchedDirs.slice(0, 6).join(", ") || "(none)"}` : "") +
			`). Install and authenticate it, or set ${overrideKey} to its absolute path.`,
		searched,
		searchedDirs,
	};
}

/**
 * 兼容旧调用点：只关心「是否可用」时用这个（不抛错）。
 * 注意：它返回 false 同时包含「未安装」与「已安装但 shim 不可解析」两种情形——
 * 需要区分时请直接用 `resolveExternalSpawnTarget` 读 `error`。
 */
export function isBackendAvailable(backend: string, deps: ResolveDeps = {}): boolean {
	try {
		return resolveExternalSpawnTarget(backend, deps).ok;
	} catch {
		return false;
	}
}
