/**
 * tab-launch-core — 纯 tab 启动原语（从 launch.ts 抽出，trace-fusion C3）
 *
 * 设计稿 §18/§53 的依赖方向：
 *
 *   launch-tabs → workflow prompt builder（launch.ts）→ tab-launch-core
 *   trace-fusion-loop → trace worker prompt builder → tab-launch-core
 *
 * 即：workflow 与 trace 两类上层都只消费本模块的 spawn 原语，互不感知
 * 对方的 prompt 约束。本模块只负责「把一个 prompt 安全送进一个新
 * Windows Terminal pi 标签页」：wt 命令行风险字符防护、prompt 物化为
 * @file、argv 构造、spawn + 回收身份传递。
 *
 * 行为兼容：launch.ts 通过 re-export 保持既有导入（含 _test_launch）不变；
 * sessionProfile/traceRunId/traceLane 仅在显式传入时发射对应 CLI 旗标
 * （workflow 路径永不传入 → argv 与历史版本一致；旗标注册在 trace-worker
 * profile 提交落地）。
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { traceSpawn } from "./spawn-trace.ts";

/**
 * WT 启动器解析 + 别名失效回退（2026-09-23 空壳 tab 根因修复）。
 *
 * 背景：`%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe` 在本机是普通 EXE 副本而非
 * App Execution Alias（reparse tag 应为 0x8000001b）；断电硬崩后它静默 exit 1
 * （连 `--help` 都零输出），导致 spawnPiTab“返回 OK 但 tab 从未建成”。
 * 实测：直调包内 `WindowsTerminal.exe -w 0 new-tab ...` 可在现有窗口建成 tab
 * （PROBE3_OK），故别名失效时回退到直调，不再依赖别名注册状态。
 *
 * 策略（进程级缓存，首个 spawn 最多慢 ~2.5s）：别名先行（受支持路径）→
 * 别名探针失败则直调包内 exe → 都失败则 fail closed（返回 error 进
 * launch_failed 账本，不谎报 OK）。直调路径每次动态解析（Store 更新会换
 * 版本目录），不写死版本号。
 */

/** 健康探针：`--help` 是文档化无副作用元命令（`--version` 不是，不用它判活）。
 *  pass 条件放宽为 exit==0 即可——实测直调 exe exit 0 但零输出（转交运行实例），
 *  要求输出文本会误杀可用的直调路径；坏别名的指纹是 exit 1 + 双流全空。 */
export function probeWtHelp(exePath: string, timeoutMs = 2500): boolean {
	try {
		// stdio 必须 ignore：WindowsTerminal.exe 是 GUI 程序，pipe 会导致其初始化挂起；
		// 只看退出码（坏别名 exit 1，可用直调 exit 0），不读输出。
		const r = spawnSync(exePath, ["--help"], {
			timeout: timeoutMs,
			windowsHide: true,
			stdio: "ignore",
		});
		return r.status === 0 && !r.error;
	} catch {
		return false;
	}
}

/** 包内直调路径：扫 WindowsApps 取最高版本（读目录即可，无需 powershell）。
 * 测试注入：`PI_WT_APPS_DIR` 非空则改扫该目录（fail-closed 回归测试用）。 */
export function resolveDirectTerminalExe(): string | null {
	try {
		const dir = process.env.PI_WT_APPS_DIR || "C:/Program Files/WindowsApps";
		try {
			const entries = readdirSync(dir);
		let best: { ver: number[]; path: string } | null = null;
		for (const e of entries) {
			const m = /^Microsoft\.WindowsTerminal_([0-9.]+)_x64__8wekyb3d8bbwe$/.exec(e);
			if (!m) continue;
			const ver = m[1]!.split(".").map((x) => parseInt(x, 10) || 0);
			const p = join(dir, e, "WindowsTerminal.exe");
			if (!existsSync(p)) continue;
			if (!best || compareVer(ver, best.ver) > 0) best = { ver, path: p };
		}
		if (best) return best.path;
		} catch {
			/* 目录不可读（WindowsApps ACL 常见）→ 走 powershell 包注册 */
		}
		// 回退：Get-AppxPackage 不受目录 ACL 影响（实测本机可用）
		try {
			const loc = execFileSync(
				"powershell.exe",
				["-NoProfile", "-NonInteractive", "-Command", "(Get-AppxPackage -Name Microsoft.WindowsTerminal).InstallLocation"],
				{ encoding: "utf8", timeout: 8000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
			).trim();
			if (loc) {
				const p = join(loc, "WindowsTerminal.exe");
				if (existsSync(p)) return p;
			}
		} catch {
			/* powershell 也失败 → 无直调 */
		}
		return null;
	} catch {
		return null;
	}
}

function compareVer(a: number[], b: number[]): number {
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const d = (a[i] ?? 0) - (b[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}

let cachedLauncher: { exe: string; kind: "alias" | "direct" } | null = null;

/** 启动器健康探测（**静默 + 零进程执行**）。
 *
 * 为何**不能**用执行探针（`--help`）：本机实测 2026-10-12，`wt.exe --help` 会**弹出可见的
 * wt 帮助窗口**（用户实测）；而 `WindowsTerminal.exe` 是 GUI 程序、`--help` 不同步退出
 * （转交运行实例后 lingering）。启动器探活必须对用户完全静默。
 *
 * 为何**不能**用 `existsSync`/`statSync`：`%LOCALAPPDATA%\Microsoft\WindowsApps` 受保护，
 * 对别名 stat 得 EACCES → 会把健康启动器判死（本机实测，见 20261012 修复）。
 *
 * 采用**只读元数据**判据（不解析 reparse 目标，故绕过 EACCES）：
 *   ① 后缀必须是 `.exe`（剔除"存在但不是启动器"的误传，如 `package.json`）；
 *   ② `lstatSync` 可读（目录项存在；**lstat 不解析目标**，本机实测 OK）；
 *   ③ 若是链接/别名：`readlinkSync` 取目标路径 + 目标必须存在 —— 这同时拓住
 *      "包已卸载 / 更新中"的**坏别名**（= 老 `--help` 探针要抓的那一类）；
 *      若不是链接（普通 exe）：lstat 存在即可信。
 * 本函数**不执行任何进程**，因此结构上不可能弹窗。 */
export function probeLauncherSilent(exePath: string): boolean {
	if (!/\.exe$/i.test(exePath)) return false;
	try {
		lstatSync(exePath);
	} catch {
		return false;
	}
	try {
		const target = readlinkSync(exePath);
		return target.length > 0 && existsSync(target);
	} catch (err) {
		// **只有 EINVAL**（“不是符号链接/别名”＝普通 exe）可直接信任——lstat 已证目录项存在。
		// 其它错误码（EACCES / EPERM / ELOOP / ENOTDIR / 损坏的 reparse 等）**一律 fail closed**：
		// 不得当作“健康”放行，交给直调回退。（独立 L4 delta 复核 must-fix #1：
		// 旧写法把 readlink 的所有错误都当作“普通文件”，对链接读取异常会误放行。）
		return (err as NodeJS.ErrnoException | null)?.code === "EINVAL";
	}
}

/** 解析可用启动器（缓存）。返回 null = 别名与直调均不可用，调用方 fail closed。
 *
 * 非对称探针策略（实测依据）：
 *  - 别名：走 `probeLauncherSilent`（只读元数据，静默零副作用）。**不得**改回 `--help`
 *    执行探针——它会弹窗（见上），也不要改回 `existsSync`——它会因 EACCES 误判；
 *  - 直调：**不探**——它来自 Get-AppxPackage 包注册表（系统真相源）+ existsSync 双重确认，
 *    而 WindowsTerminal.exe 是 GUI 程序，`--help` 不同步退出（同步探针必超时误杀）。
 * 直调的真实可用性已由端到端实测背书（PROBE3_OK audit）。 */
export function healthyLauncher(wtPath: string): { exe: string; kind: "alias" | "direct" } | null {
	if (cachedLauncher) return cachedLauncher;
	// 注意：**不得**用 `existsSync(wtPath)`（受保护目录 EACCES → 误判死，2026-10-12 事故），
	// 也**不得**用 `probeWtHelp(wtPath)`（`wt --help` 会弹可见窗，同日用户实测）。
	// 唯一允许的是下面这一个静默、零进程的探测。
	if (probeLauncherSilent(wtPath)) {
		cachedLauncher = { exe: wtPath, kind: "alias" };
		return cachedLauncher;
	}
	const direct = resolveDirectTerminalExe();
	if (direct) {
		cachedLauncher = { exe: direct, kind: "direct" };
		return cachedLauncher;
	}
	return null;
}

/** 测试重置启动器缓存。 */
export function _resetLauncherCache(): void {
	cachedLauncher = null;
}

export interface PiLaunchArgsOptions {
	cwd: string;
	piCli: string;
	execPath: string;
	model?: string;
	/**
	 * 续接已有会话（`--session <file>`）。
	 *
	 * 2026-10-30：local master 续接（owner 裁决「local master 本身应当续接」）。
	 * **必须是绝对路径**且文件存在，且该会话记录的 cwd 必须仍存在——
	 * 实测 pi 会报 `Stored session working directory does not exist` 并拒绝启动。
	 */
	sessionFile?: string;
	/**
	 * Skill roots/files guaranteed via --skill (canonical-path deduped against
	 * package-registered skills, so passing the same skills/ root is a no-op
	 * guarantee rather than a duplicate).
	 */
	skills?: string[];
	/** 标签页回收身份（--tab-run-id <runId>，可靠传递，不依赖 env 继承）。 */
	tabRunId?: string;
	/** 会话身份（trace-fusion 派发 trace worker 时注入；仅显式传入才发射旗标）。 */
	sessionProfile?: string;
	/** trace run 身份（trace-fusion coordinator 记录用）。 */
	traceRunId?: string;
	/** trace lane：A | B | C。 */
	traceLane?: string;
	/** 工具排除名单（trace worker §17）；仅非空时发射 --exclude-tools。 */
	excludeTools?: string[];
}

/** Build argv as an array so prompts are never split or reinterpreted by a shell. */
export function buildWindowsTerminalArgs(
	terminalTitle: string,
	prompt: string,
	options: PiLaunchArgsOptions,
): string[] {
	const piArgs = [options.piCli];
	if (options.model) piArgs.push("--model", options.model);
	for (const skill of options.skills ?? []) piArgs.push("--skill", skill);
	if (options.excludeTools && options.excludeTools.length > 0) {
		piArgs.push("--exclude-tools", options.excludeTools.join(","));
	}
	if (options.sessionProfile) piArgs.push("--session-profile", options.sessionProfile);
	// 续接已有会话：位置在 prompt 之前、身份 flag 附近（pi 解析顺序无关，但保持可读）
	if (options.sessionFile) piArgs.push("--session", options.sessionFile);
	if (options.traceRunId) piArgs.push("--trace-run-id", options.traceRunId);
	if (options.traceLane) piArgs.push("--trace-lane", options.traceLane);
	if (options.tabRunId) piArgs.push("--tab-run-id", options.tabRunId);
	piArgs.push(prompt);
	return [
		"-w", "0",
		"new-tab",
		"--title", terminalTitle,
		"--suppressApplicationTitle",
		"-d", options.cwd,
		options.execPath,
		...piArgs,
	];
}

// ── wt 命令行 prompt 物化（2026-08-13：修复多开无用 tab）───────────────

/** 派发 prompt 的临时目录（~/.pi/agent/launch-prompts）。 */
export function wtPromptDir(): string {
	return join(homedir(), ".pi", "agent", "launch-prompts");
}

/**
 * wt.exe 会用自己的 tokenizer 重解析命令行：含换行的参数会被拆成多条命令，
 * 剩余行变成标题/内容都是 prompt 残留的无用 tab（实证：派发 workflow tab 几乎必现）。
 * 引号/分号/百分号同理有风险（wt 会做引号与 %env% 展开）。
 */
const WT_RISKY_CHARS = /[\r\n;"%]/;

/**
 * 生成传给 wt 命令行的 prompt 参数：凡含风险字符的 prompt 一律物化为临时 @file
 * （pi 原生支持 `pi @file.md` 把文件内容作为首轮消息），命令行上只留一个不含换行的
 * `@路径`；安全单行 prompt 保持内联（零行为变化）。
 */
export function wtPromptArg(prompt: string, key?: string): string {
	if (!WT_RISKY_CHARS.test(prompt)) return prompt;
	const dir = wtPromptDir();
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `pi-launch-${key ?? `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`}.md`);
	writeFileSync(file, prompt, "utf8");
	// 尽力清理：5 分钟后删除（pi 启动早期即读完文件，删除不阻塞）；顺带清理 24h 前陈旧文件
	setTimeout(() => { try { rmSync(file, { force: true }); } catch { /* 清理尽力而为 */ } }, 5 * 60_000).unref?.();
	sweepStaleWtPrompts();
	return `@${file}`;
}

/** 清理超 24h 的陈旧派发 prompt 文件（防 launch-prompts 目录膨胀）。 */
export function sweepStaleWtPrompts(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
	const dir = wtPromptDir();
	let swept = 0;
	try {
		for (const f of readdirSync(dir)) {
			if (!f.startsWith("pi-launch-") || !f.endsWith(".md")) continue;
			try {
				if (Date.now() - statSync(join(dir, f)).mtimeMs > maxAgeMs) {
					rmSync(join(dir, f), { force: true });
					swept++;
				}
			} catch { /* 单个失败无碍 */ }
		}
	} catch { /* 目录不存在等 */ }
	return swept;
}

/** 删除指定 `@file` 参数对应的临时文件（测试/手动清理用）。 */
export function cleanupWtPromptArg(arg: string): void {
	if (!arg.startsWith("@")) return;
	try { rmSync(arg.slice(1), { force: true }); } catch { /* 尽力而为 */ }
}

/**
 * Strip WT-risky characters from a tab title before it hits the wt command line.
 *
 * wt.exe re-parses the command line with its own tokenizer (quote handling +
 * %env% expansion). `wtPromptArg` protects the prompt argument, but `--title`
 * carries a label derived from the prompt's first line (e.g. "修复 50% 回归")
 * or a user-provided title verbatim — same risk class, no protection.
 */
export function sanitizeWtTitle(title: string): string {
	return title.replace(/[\r\n;"%]/g, " ").replace(/\s{2,}/g, " ").trim() || "task";
}

// ── spawn 原语（自 index.ts dispatchPiTab 抽出）────────────────────────

export interface TabLaunchOptions {
	/** where wt.exe 的产物。 */
	wtPath: string;
	/** pi CLI 入口。 */
	piCli: string;
	cwd: string;
	title: string;
	prompt: string;
	model?: string;
	skills?: string[];
	/** 标签页回收身份（launch-tabs / trace-fusion 生成）。 */
	tabRunId?: string;
	/** 标签页账本目录（PI_TAB_RUNS_DIR 注入，回收闭环依赖）。 */
	runsDir?: string;
	/** 会话身份（trace worker 注入；workflow 路径不传）。 */
	sessionProfile?: string;
	/**
	 * 续接已有会话（绝对路径，`pi --session <file>`）。
	 * 2026-10-30 owner 裁决：local master 应续接；GUI 拉起任意 session 也走此字段。
	 * 调用方必须自验：文件存在 + 会话记录的 cwd 仍存在（否则 pi 会拒绝启动）。
	 */
	sessionFile?: string;
	traceRunId?: string;
	traceLane?: string;
	/** 工具排除名单（trace worker §17：隔离 launch/timer/wiki 写工具）；仅显式传入才发射。 */
	excludeTools?: string[];
	/**
	 * node 可执行文件路径（wt new-tab 后启动 pi 用）。缺省回退 process.execPath；
	 * 早期调用点不传该字段，故必须可选（否则 preflight 拿到 undefined 直接拒发）。
	 */
	execPath?: string;
	/** 异步 spawn 失败（child error 事件）回调：调用方用于回写失败账本/事件（派发用）。 */
	onSpawnError?: (err: Error) => void;
	/**
	 * C（2026-10-12）：清空从父进程继承的「标签页/会话身份类」env，使子进程成为
	 * 非标签页常驻会话。仅在无 tabRunId 时有意义（有 tabRunId 时身份就是本次派发）。
	 * 背景：tabRunId 缺省时旧代码传 `env: undefined` → Node spawn 继承父 process.env；
	 * 若父进程本身是标签页 master，其 PI_TAB_RUN_ID 会被后继继承 → 后继仍被判为 tab。
	 */
	clearTabIdentity?: boolean;
}

export interface TabSpawnResult {
	title: string;
	prompt: string;
	model?: string;
	error?: string;
}

/**
 * `clearTabIdentity` 要清空的 env 名单：身份类变量的全量集（对齐
 * `scripts/boot-resume-master.ps1::Get-BootEnvScrubKeys` 的身份子集，「只删不加」，
 * 故意不含 PI_PROVIDER/PI_MODEL 等配置类变量——后继应继承用户的运行环境）。
 */
const TAB_IDENTITY_ENV_KEYS = [
	"PI_TAB_RUN_ID",
	"PI_TAB_RUNS_DIR",
	"PI_SESSION_PROFILE",
	"PI_TRACE_RUN_ID",
	"PI_TRACE_LANE",
	"PI_SESSION_ID",
	"PI_SESSION_FILE",
	"PI_SUBAGENT",
] as const;

export interface TabSpawnEnvOptions {
	tabRunId?: string;
	runsDir?: string;
	sessionProfile?: string;
	traceRunId?: string;
	traceLane?: string;
	clearTabIdentity?: boolean;
}

/**
 * 构造传给 wt.exe 的 env（2026-10-12 C 抽出为纯函数，spawn 副作用可单测）：
 *
 *   - 有 tabRunId：注入本次派发身份 `{...baseEnv, PI_TAB_RUN_ID, PI_TAB_RUNS_DIR, ...trace}`
 *     （与抽出前的内联逻辑逐字等价）；
 *   - 无 tabRunId 且 clearTabIdentity：返回 baseEnv 副本并**删除**身份类变量（显式传 env
 *     以覆盖 Node spawn 的「undefined = 继承父 env」默认）；
 *   - 其余：undefined（继承父 env，历史行为不变）。
 */
export function buildTabSpawnEnv(
	baseEnv: NodeJS.ProcessEnv,
	opts: TabSpawnEnvOptions,
): NodeJS.ProcessEnv | undefined {
	if (opts.tabRunId) {
		return {
			...baseEnv,
			PI_TAB_RUN_ID: opts.tabRunId,
			PI_TAB_RUNS_DIR: opts.runsDir,
			...(opts.sessionProfile ? { PI_SESSION_PROFILE: opts.sessionProfile } : {}),
			...(opts.traceRunId ? { PI_TRACE_RUN_ID: opts.traceRunId } : {}),
			...(opts.traceLane ? { PI_TRACE_LANE: opts.traceLane } : {}),
		};
	}
	if (!opts.clearTabIdentity) return undefined;
	const env: NodeJS.ProcessEnv = { ...baseEnv };
	for (const k of TAB_IDENTITY_ENV_KEYS) delete env[k];
	return env;
}

/**
 * 派发一个可见 pi 标签页（wt new-tab → pi）。
 *
 * 身份三通道：--tab-run-id CLI flag（authoritative）+ PI_TAB_RUN_ID /
 * PI_TAB_RUNS_DIR env（wt.exe 继承链兜底）。trace 身份
 * （--session-profile/--trace-run-id/--trace-lane）仅在显式传入时发射。
 */
export function spawnPiTab(options: TabLaunchOptions): TabSpawnResult {
	const { wtPath, piCli, cwd, title, prompt, model, skills, tabRunId, runsDir, onSpawnError } = options;
	// Pre-flight（空 WT 窗口根因修复）：wt -w 0 匹配不到就开新窗，但 new-tab 参数非法时
	// 执行失败只剩空框。本层 spawn(wt) 只要 wt.exe 起来就算成功，new-tab 的死活无从得知，
	// 故非法参数必须在 spawn 前拦截，直接回 error 走上层 markFailed（launch_failed 账本），
	// 不弹空窗、不留永远 dispatched 的幽灵记录。
	// 注意：wt 路径**不做** existsSync 探测。它来自 findWindowsTerminal() 的 `where wt.exe`，
	// 在多机上命中的是 %LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe（AppExecLink/别名），
	// 而该目录受保护：非提权进程 stat 得到 EACCES，existsSync 返回 **false**（本机实测），
	// 于是这条 preflight 会把健康启动器判死 → **所有标签页 spawn 全废**（含 master 继任者）。
	// 真伪由下方 healthyLauncher() 的**执行探活**判定（fail-closed 语义不变：不可用仍回 error）。
	if (!existsSync(piCli)) return { title, prompt, model, error: `preflight: pi CLI not found: ${piCli}` };
	if (!existsSync(cwd)) return { title, prompt, model, error: `preflight: cwd not found: ${cwd}` };
	const nodeExecPath = options.execPath ?? process.execPath;
	if (!existsSync(nodeExecPath)) {
		return { title, prompt, model, error: `preflight: node exec not found: ${nodeExecPath}` };
	}
	// 取证：wt.exe 派生是「空壳 WT 窗口」的第一嫌疑人（见 spawn-trace.ts 头注；PI_SPAWN_TRACE=0 关）
	traceSpawn("wt", `title=${title} cwd=${cwd} runId=${tabRunId ?? "-"} wt=${wtPath}`);
	// 2026-09-23 别名失效回退：先探活别名，不行则直调包内 exe（动态解析版本目录）；
	// 都不可用直接 fail closed（进 launch_failed），不再谎报 OK。
	const launcher = healthyLauncher(wtPath);
	if (!launcher) {
		const err = `wt launcher unhealthy: alias(${wtPath}) --help failed and no direct WindowsTerminal.exe resolvable`;
		onSpawnError?.(new Error(err));
		return { title, prompt, model, error: err };
	}
	if (launcher.kind === "direct") {
		traceSpawn("wt", `title=${title} alias-unhealthy, fallback direct=${launcher.exe}`);
	}
	try {
		const child = spawn(launcher.exe, buildWindowsTerminalArgs(title, wtPromptArg(prompt, tabRunId), {
			cwd,
			piCli,
			execPath: nodeExecPath,
			model,
			skills,
			tabRunId,
			sessionProfile: options.sessionProfile,
			sessionFile: options.sessionFile,
			traceRunId: options.traceRunId,
			traceLane: options.traceLane,
			excludeTools: options.excludeTools,
		}), {
			shell: false,
			// 把回收身份传入新标签页：wt.exe 继承环境 → shell → pi 进程。
			// review 修正（Luna critical）：session profile 同步注入 env——factory 阶段
			// CLI flag 尚未就绪，只有 env 能保证 profile 在扩展初始化时即生效。
			// C（2026-10-12）：常驻后继形态（无 tabRunId + clearTabIdentity）走纯函数构造
			// 的「身份已清」env，覆盖 Node spawn 的默认父 env 继承。
			env: buildTabSpawnEnv(process.env, {
				tabRunId,
				runsDir,
				sessionProfile: options.sessionProfile,
				traceRunId: options.traceRunId,
				traceLane: options.traceLane,
				clearTabIdentity: options.clearTabIdentity,
			}),
		});
		child.on("error", (err: Error) => {
			// 同步 try/catch 只覆盖 spawn 本身的异常；异步 error（如 wt.exe 立即退出）也回写账本
			console.error(`[subagent-win launch] ${title}: ${err.message}`);
			onSpawnError?.(err);
		});
		child.unref();
		return { title, prompt, model };
	} catch (err) {
		return { title, prompt, model, error: err instanceof Error ? err.message : String(err) };
	}
}
