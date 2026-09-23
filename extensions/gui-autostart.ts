/**
 * gui-autostart — GUI 自动拉起（opt-in，G6 L3；锚 plans/0920_g6_webconsole_plan.md §5）
 *
 * 第一切片（plans/0923_runtime_daemon_final_plan.md §9）：`/gui on|open` 改为 ensure
 * Runtime Daemon（daemon-lifecycle.ensureRuntimeDaemon：detached 单实例 + 身份挑战）+
 * 打开 daemon 同源静态 URL（`http://127.0.0.1:<port>/`，自托管 gui/dist，生产禁 vite）。
 *
 * 语义红线：
 *   - 默认 OFF 零动作（config.json 无 gui 段 / autoStart≠true → session_start 纯只读后返回；
 *     不得隐式建目录/锁/探测/spawn/定时器）；
 *   - vite 属 **dev 服务**：仅 `npm run gui:dev`（独立 dev profile/runtimeDir）可用；
 *     `/gui on|open` 生产路径永不 spawn vite（ensureGuiRuntime 保留作 legacy 导出，不再被命令面调用）；
 *   - 自动拉起（session_start）绝不自动开浏览器；`/gui open` 才开。
 *
 * 行为：
 *   - `/gui on`  → 写 config.json gui 段 {autoStart:true}（read-modify-write 保留其余字段 +
 *                  tmp+rename 原子写，同 index.ts::writeConfig 模式）+ 立即 ensure daemon；
 *   - `/gui off` → 写 false（**不杀已起的** daemon；也不等于 /runtime stop）；
 *   - `/gui status` → config 态 + daemon 探活（discovery 四态）+ 同源静态 GUI URL；
 *   - `/gui open`   → ensure daemon + 系统默认浏览器打开同源静态 URL。
 *   - session_start 自动拉起（仅 gui.autoStart=true）：主会话非 subagent 非 tab
 *     （identity::isMainSession，与 S3/succession 无关）→ ensure daemon（内部幂等复用）。
 *     全程 never-throw + 30s 节流防抖。
 *
 * 子 agent / 子进程零动作：index.ts 主路径早退（isSubagent 分支不接线本模块）+
 * tick 内 isMainSession 纵深防御双保险。
 *
 * 可测性：所有副作用（startHost / probeVite / spawnVite / openBrowser / readAutoStart /
 * now）可注入，_test_gui_autostart.ts 用注入桩覆盖开关读写、幂等 ensure、subagent 跳过、
 * OFF 零动作、节流与命令面；不打真实 host/vite。
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainSession } from "./identity.ts";
import { classifyHost, readHostInfo, type HostInfo } from "./runtime-host/discovery.ts";
import { startRuntimeHost } from "./runtime-host/server.ts";
import { daemonUrlFor, ensureRuntimeDaemon, type DaemonEnsureResult } from "./runtime-host/daemon-lifecycle.ts";
import { traceSpawn } from "./spawn-trace.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GUI_DIR = join(REPO_ROOT, "gui");
const VITE_BIN = join(GUI_DIR, "node_modules", "vite", "bin", "vite.js");
/** vite dev 端口（同 scripts/gui-dev.mjs 的 GUI_VITE_PORT env 缺省）。 */
export const VITE_DEFAULT_PORT = 5173;
/** 自动拉起节流防抖窗口：30s 内重复 session_start 不重复 ensure。 */
export const GUI_AUTOSTART_THROTTLE_MS = 30_000;

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** vite 端口解析：GUI_VITE_PORT env（>0 有效）→ 缺省 5173（同 gui-dev.mjs）。 */
export function vitePortFromEnv(): number {
	const n = Number(process.env.GUI_VITE_PORT);
	return Number.isInteger(n) && n > 0 ? n : VITE_DEFAULT_PORT;
}

// ── config.json gui 段（read-modify-write，保留其余字段）────────────────

/** repo config.json 路径（同 index.ts::configPath）。 */
export function defaultConfigPath(): string {
	return join(REPO_ROOT, "config.json");
}

/** gui.autoStart 当前态（缺段 / 文件不可读 → false = 默认 OFF）。never-throw。 */
export function readGuiAutoStart(path: string = defaultConfigPath()): boolean {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as { gui?: { autoStart?: unknown } };
		return raw?.gui?.autoStart === true;
	} catch {
		return false;
	}
}

/**
 * 写 gui.autoStart（true/false）。read-modify-write：其余顶层字段原样保留；
 * tmp+rename 原子写 + EPERM×3 重试（同 index.ts::writeConfig 模式）。
 * config.json 不可读/非对象时**拒绝覆盖写**（防整文件损毁），返回 {ok:false} 不抛。
 */
export function setGuiAutoStart(on: boolean, path: string = defaultConfigPath()): { ok: boolean; error?: string } {
	let raw: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return { ok: false, error: "config.json 不是 JSON 对象——拒绝覆盖写（防损坏）" };
		}
		raw = parsed as Record<string, unknown>;
	} catch (e) {
		return { ok: false, error: `config.json 不可读（${msg(e)}）——拒绝覆盖写` };
	}
	const gui = (
		typeof raw.gui === "object" && raw.gui !== null && !Array.isArray(raw.gui) ? raw.gui : {}
	) as Record<string, unknown>;
	gui.autoStart = on;
	raw.gui = gui;
	const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
	try {
		writeFileSync(tmp, JSON.stringify(raw, null, 2) + "\n");
		for (let attempt = 0; ; attempt++) {
			try {
				renameSync(tmp, path);
				return { ok: true };
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code === "EPERM" && attempt < 3) {
					Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
					continue;
				}
				throw e;
			}
		}
	} catch (e) {
		try {
			unlinkSync(tmp);
		} catch {
			/* ignore */
		}
		return { ok: false, error: `config.json 写入失败：${msg(e)}` };
	}
}

// ── 探活 / 拉起 ─────────────────────────────────────────────────────

/**
 * vite 探针：GET http://127.0.0.1:<port>/ ——收到**任何** HTTP 响应（任意状态码）= 端口有人
 * 监听 = alive（保守：宁可复用也不重 spawn）。连接拒绝/超时/异常 → false。never-throw。
 */
export function probeViteAlive(port: number, opts: { timeoutMs?: number } = {}): Promise<boolean> {
	const timeoutMs = opts.timeoutMs ?? 1200;
	return new Promise((resolvePromise) => {
		let settled = false;
		const finish = (v: boolean): void => {
			if (!settled) {
				settled = true;
				resolvePromise(v);
			}
		};
		let req: ReturnType<typeof httpRequest> | null = null;
		try {
			req = httpRequest({ host: "127.0.0.1", port, path: "/", method: "GET", timeout: timeoutMs }, (res) => {
				res.resume(); // 排干 body；收到响应头即算活
				res.on("end", () => finish(true));
				res.on("error", () => finish(true));
			});
		} catch {
			finish(false);
			return;
		}
		req.on("timeout", () => {
			req?.destroy();
			finish(false);
		});
		req.on("error", () => finish(false));
		req.end();
	});
}

/** vite dev server 派生（隐藏控制台 + stdio ignore；GUI_HOST_TOKEN 经 env 交 vite proxy 上游注入）。
 *
 * 2026-09-22 空壳 WT 根因修复：此前用 `detached: true`（DETACHED_PROCESS → 子进程无控制台）。
 * vite 启动期会派生短命子进程（esbuild --ping、`node -p process.report` 环境探测等），它们**继承不到
 * 控制台**，只能各自分配新控制台；在「默认终端应用 = Windows Terminal」的机器上，新控制台被委派
 * 给 WT → 弹出一个空壳窗口（短命子进程先退出，WT 承接时已无 tab）。
 * 改为 `windowsHide: true`（CREATE_NO_WINDOW → vite 拥有一个**隐藏**控制台）：子树全部继承该隐藏
 * 控制台，不再分配新控制台 → 不再弹窗。`unref()` 保留：pi 退出不连带杀 vite（隐藏控制台属于
 * vite 自身，关 pi 的终端页签不影响它）。
 * 注意：不要把 `detached: true` 加回来与 windowsHide 叠加——Win32 会忽略与 DETACHED_PROCESS
 * 同用的 CREATE_NO_WINDOW，那就又回到无控制台老路。 */
function defaultSpawnVite(o: { port: number; token: string | null; guiDir: string; viteBin: string }): {
	spawned: boolean;
	pid?: number;
	error?: string;
} {
	try {
		traceSpawn("console-child", `vite pid-less spawn cwd=${o.guiDir} port=${o.port} exec=${process.execPath}`);
		const child = spawn(process.execPath, [o.viteBin, "--port", String(o.port), "--strictPort"], {
			windowsHide: true,
			stdio: "ignore",
			cwd: o.guiDir,
			env: { ...process.env, ...(o.token ? { GUI_HOST_TOKEN: o.token } : {}) },
		});
		child.unref();
		return { spawned: true, pid: child.pid };
	} catch (e) {
		return { spawned: false, error: `spawn vite failed: ${msg(e)}` };
	}
}

/** 系统默认浏览器打开 URL（win32: cmd start / darwin: open / 其他: xdg-open）。never-throw。 */
export function openInBrowser(url: string): { ok: boolean; error?: string } {
	try {
		const bin = process.platform === "win32" ? "cmd.exe" : process.platform === "darwin" ? "open" : "xdg-open";
		const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
		traceSpawn("browser", `${bin} ${args.join(" ")}`);
		const child = spawn(bin, args, { detached: true, stdio: "ignore" });
		child.unref();
		return { ok: true };
	} catch (e) {
		return { ok: false, error: msg(e) };
	}
}

export interface HostStartLike {
	started: boolean;
	already?: boolean;
	info: HostInfo | null;
	error?: string;
}

export interface GuiEnsureDeps {
	/** daemon ensure（缺省 = ensureRuntimeDaemon：detached 单实例 + 身份挑战，幂等）。 */
	ensureDaemon?: () => Promise<DaemonEnsureResult>;
	/** host ensure（legacy：仅 ensureGuiRuntime 用；命令面已改走 ensureDaemon）。 */
	startHost?: () => Promise<HostStartLike>;
	/** vite 探针（缺省 probeViteAlive）。 */
	probeVite?: (port: number) => Promise<boolean>;
	/** vite 拉起（缺省 detached spawn）。 */
	spawnVite?: (o: { port: number; token: string | null; guiDir: string; viteBin: string }) => {
		spawned: boolean;
		pid?: number;
		error?: string;
	};
	vitePort?: number;
	guiDir?: string;
	viteBin?: string;
}

export interface GuiEnsureResult {
	host: { ok: boolean; already?: boolean; pid: number | null; port: number | null; error?: string };
	vite: { action: "reuse" | "spawned" | "skipped"; detail?: string };
}

/**
 * ensure host + vite（幂等：活则不重 spawn；never-throw）。
 * @deprecated legacy dev 路径（第一切片起 `/gui on|open`/自动拉起改走 ensureGuiDaemon +
 * 同源静态；本函数保留仅供既有测试与外部兼容，不再被命令面调用，生产永不 spawn vite）。
 * 顺序：host 先行（vite proxy 启动期读一次 host.json，host 就绪后再拉 vite 才能拿到正确端口/token）。
 */
export async function ensureGuiRuntime(deps: GuiEnsureDeps = {}): Promise<GuiEnsureResult> {
	try {
		const hr = await (deps.startHost ?? ((): Promise<HostStartLike> => startRuntimeHost()))();
		const host: GuiEnsureResult["host"] = {
			ok: Boolean(hr?.started || hr?.already),
			pid: hr?.info?.pid ?? null,
			port: hr?.info?.port ?? null,
			...(hr?.already ? { already: true } : {}),
			...(hr?.error ? { error: hr.error } : {}),
		};
		const token = hr?.info?.token ?? readHostInfo()?.token ?? null;
		const port = deps.vitePort ?? vitePortFromEnv();
		const url = `http://localhost:${port}`;
		if (await (deps.probeVite ?? probeViteAlive)(port)) {
			return { host, vite: { action: "reuse", detail: `${url}（已监听，不重 spawn）` } };
		}
		const guiDir = deps.guiDir ?? GUI_DIR;
		const viteBin = deps.viteBin ?? VITE_BIN;
		if (!existsSync(viteBin)) {
			return {
				host,
				vite: { action: "skipped", detail: `vite 未安装（${viteBin} 缺失）——gui/ 下 npm install 后重试` },
			};
		}
		const sr = (deps.spawnVite ?? defaultSpawnVite)({ port, token, guiDir, viteBin });
		return {
			host,
			vite: sr.spawned
				? { action: "spawned", detail: `vite pid=${sr.pid ?? "?"}（detached，${url}）` }
				: { action: "skipped", detail: sr.error ?? "spawn 失败" },
		};
	} catch (e) {
		return {
			host: { ok: false, pid: null, port: null, error: msg(e) },
			vite: { action: "skipped", detail: "ensure 异常（never-throw 兜底）" },
		};
	}
}

// ── session_start 自动拉起（opt-in + 节流 + never-throw）────────────────

/** 节流状态（模块级；测试可直接归零）。 */
export const guiAutoStartState = { lastAt: 0 };

export interface GuiAutoStartDeps extends GuiEnsureDeps {
	/** config.json 路径（缺省 repo 根；测试注入 tmp）。 */
	configPath?: string;
	/** autoStart 读函数（缺省 readGuiAutoStart(configPath)）。 */
	readAutoStart?: () => boolean;
	openBrowser?: (url: string) => { ok: boolean; error?: string };
	/** OTT 签发（缺省 localhost 调 daemon；测试注入桩，防打真实端口）。 */
	mintBootstrap?: (port: number, token: string) => Promise<{ ok: true; ott: string } | { ok: false; error: string }>;
	now?: () => number;
	throttleMs?: number;
}

/**
 * 本机 OTT 签发（`/gui open` 用：持 host.json token 向 daemon 换一次性 OTT，
 * 浏览器走 exchange 换 HttpOnly 同源 cookie；长 token 永不进 URL）。never-throw。
 */
export async function mintGuiBootstrap(
	port: number,
	token: string,
	timeoutMs = 3000,
): Promise<{ ok: true; ott: string } | { ok: false; error: string }> {
	try {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), timeoutMs);
		try {
			const res = await fetch(`http://127.0.0.1:${port}/v1/bootstrap`, {
				method: "POST",
				headers: { "x-command-token": token },
				signal: ctrl.signal,
			});
			if (!res.ok) return { ok: false, error: `bootstrap refused (${res.status})` };
			const body = (await res.json()) as { ott?: unknown };
			if (typeof body.ott !== "string" || body.ott.length < 16) return { ok: false, error: "bad ott" };
			return { ok: true, ott: body.ott };
		} finally {
			clearTimeout(timer);
		}
	} catch (e) {
		return { ok: false, error: msg(e) };
	}
}

/** daemon ensure（第一切片生产路径；never-throw：异常收敛为 ok:false）。 */
export async function ensureGuiDaemon(deps: GuiAutoStartDeps = {}): Promise<DaemonEnsureResult> {
	try {
		return await (deps.ensureDaemon ?? (() => ensureRuntimeDaemon()))();
	} catch (e) {
		return { ok: false, info: null, url: null, pid: null, port: null, error: e instanceof Error ? e.message : String(e) };
	}
}

function guiDaemonSummary(r: DaemonEnsureResult): string {
	const daemonLine = r.ok
		? r.already
			? `复用已跑实例 pid=${r.pid} port=${r.port}`
			: `已启动 pid=${r.pid} port=${r.port}`
		: r.uncertain
			? `未确权（uncertain，fail-closed）：${r.error ?? "未知"}`
			: `未就绪：${r.error ?? "未知错误"}`;
	const guiLine = r.url ? `同源静态 GUI：${r.url}（daemon 自托管 gui/dist，无 vite）` : "GUI 地址未知（daemon 未就绪）";
	return `daemon: ${daemonLine}${r.note ? `\n注：${r.note}` : ""}\n${guiLine}`;
}

/** session_start tick：主会话 + autoStart=true + 过节流 → 后台 ensure daemon（fire-and-forget，不开浏览器）。 */
export function guiAutoStartTick(deps: GuiAutoStartDeps = {}): void {
	try {
		if (!isMainSession()) return; // 子 agent / tab → 零动作
		const readAutoStart = deps.readAutoStart ?? ((): boolean => readGuiAutoStart(deps.configPath));
		if (readAutoStart() !== true) return; // 默认 OFF → 零动作（不建目录/锁/探测/spawn/定时器）
		const now = (deps.now ?? Date.now)();
		if (now - guiAutoStartState.lastAt < (deps.throttleMs ?? GUI_AUTOSTART_THROTTLE_MS)) return; // 30s 节流
		guiAutoStartState.lastAt = now;
		void ensureGuiDaemon(deps).catch(() => {
			/* 自动拉起 never-throw */
		});
	} catch {
		/* never-throw */
	}
}

// ── 扩展注册（/gui 命令 + session_start 钩子）────────────────────────

/** pi 最小结构面（同 registerOutboxBridge 风格；ExtensionAPI 天然满足）。 */
export interface GuiExtensionApi {
	on: (event: string, cb: (event: unknown, ctx?: unknown) => void) => void;
	registerCommand: (
		name: string,
		cmd: {
			description?: string;
			handler: (
				args: string | undefined,
				ctx: { ui: { notify: (body: string, level?: "info" | "warning" | "error") => void } },
			) => void | Promise<void>;
		},
	) => void;
}

function guiEnsureSummary(r: GuiEnsureResult): string {
	const hostLine = r.host.ok
		? r.host.already
			? `复用已跑实例 pid=${r.host.pid} port=${r.host.port}`
			: `已启动 pid=${r.host.pid} port=${r.host.port}`
		: `未就绪：${r.host.error ?? "未知错误"}`;
	const viteLine =
		r.vite.action === "reuse"
			? `复用（${r.vite.detail}）`
			: r.vite.action === "spawned"
				? `已拉起（${r.vite.detail}）`
				: `未拉起：${r.vite.detail ?? ""}`;
	return `host: ${hostLine}\nvite: ${viteLine}`;
}

/**
 * 注册 /gui 命令 + session_start 自动拉起。返回清理函数（重置节流态）。
 * 注册失败静默（不影响宿主会话加载）。
 */
export function registerGuiAutoStart(pi: GuiExtensionApi, deps: GuiAutoStartDeps = {}): () => void {
	try {
		pi.on("session_start", () => {
			guiAutoStartTick(deps);
		});
	} catch {
		/* 钩子注册失败不影响宿主 */
	}
	try {
		pi.registerCommand("gui", {
			description:
				"Runtime GUI（daemon 同源静态托管 gui/dist；dev 用 npm run gui:dev）：/gui on|off|status|open",
			handler: async (args, ctx) => {
				const notify = (body: string, level: "info" | "warning" = "info"): void => {
					ctx.ui.notify(body, level);
				};
				const cmd = (args ?? "").trim().toLowerCase();
				const cfgPath = deps.configPath ?? defaultConfigPath();
				if (cmd === "on") {
					const w = setGuiAutoStart(true, cfgPath);
					if (!w.ok) {
						notify(`gui.autoStart 写入失败：${w.error}`, "warning");
						return;
					}
					const r = await ensureGuiDaemon(deps);
					notify(`gui.autoStart=true 已写入\n${guiDaemonSummary(r)}`, r.ok ? "info" : "warning");
					return;
				}
				if (cmd === "off") {
					const w = setGuiAutoStart(false, cfgPath);
					notify(
						w.ok
							? "gui.autoStart=false 已写入（自动拉起关闭；已运行的 daemon 不停止——不等于 /runtime stop）"
							: `gui.autoStart 写入失败：${w.error}`,
						w.ok ? "info" : "warning",
					);
					return;
				}
				if (cmd === "status") {
					const auto = readGuiAutoStart(cfgPath);
					const info = readHostInfo();
					const state = info ? await classifyHost(info) : "missing";
					const daemonLine = !info
						? "未启动（无 host.json）"
						: `${state} pid=${info.pid} port=${info.port}` +
							(info.instanceId ? ` instance=${info.instanceId}` : "") +
							(info.releaseId ? ` release=${info.releaseId}` : "");
					const guiLine = info && state === "alive" ? `同源静态 GUI：${daemonUrlFor(info.port)}` : "GUI 未就绪（daemon 未确权前无地址）";
					notify(
						`gui.autoStart=${auto ? "on" : "off"}（config.json gui 段）\n` +
							`daemon: ${daemonLine}\n` +
							`${guiLine}\n` +
							`注：生产 GUI 由 daemon 自托管 gui/dist（无 vite）；dev 用 npm run gui:dev（独立 profile）`,
						state === "stale" || state === "dead" ? "warning" : "info",
					);
					return;
				}
				if (cmd === "open") {
					const r = await ensureGuiDaemon(deps);
					const base = r.url ?? (r.port !== null ? daemonUrlFor(r.port) : "");
					if (!base) {
						notify(`daemon 未就绪，无法打开 GUI：${r.error ?? "未知错误"}`, "warning");
						return;
					}
					// L3 bootstrap：gui 已显式启用 + 持 daemon token 时换 OTT，浏览器经 exchange
					// 拿 HttpOnly 同源 cookie（长 token 永不进 URL）；未启用/无 token/签发失败 →
					// 回退直开（旧行为：读投影 401，写端点保持拒绝，零回归）。
					let url = base;
					let bootNote = "";
					const token = r.info?.token ?? null;
					if (readGuiAutoStart(cfgPath) && typeof r.port === "number" && token) {
						try {
							const m = await (deps.mintBootstrap ?? mintGuiBootstrap)(r.port, token);
							if (m.ok) {
								url = `http://127.0.0.1:${r.port}/v1/bootstrap/exchange?ott=${m.ott}`;
								bootNote = "（已附一次性登录 OTT，浏览器自动换 HttpOnly 同源 cookie）";
							} else {
								bootNote = `（OTT 签发失败：${m.error}，回退直开）`;
							}
						} catch (e) {
							bootNote = `（OTT 签发异常：${msg(e)}，回退直开）`;
						}
					} else if (!readGuiAutoStart(cfgPath)) {
						bootNote = "（GUI 未显式启用：先 /gui on；写端点保持拒绝）";
					}
					const ob = (deps.openBrowser ?? openInBrowser)(url);
					notify(
						ob.ok
							? `${url} 已交系统默认浏览器${bootNote}（同源静态，ensure：\n${guiDaemonSummary(r)}）`
							: `浏览器打开失败：${ob.error}（手动访问 ${url}）`,
						ob.ok && r.ok ? "info" : "warning",
					);
					return;
				}
				notify("用法：/gui on|off|status|open（on=写 config + 立即拉起；off=关自动拉起不杀已起；open=拉起并开浏览器）", "warning");
			},
		});
	} catch {
		/* /gui 注册失败不影响宿主 */
	}
	return () => {
		guiAutoStartState.lastAt = 0;
	};
}

export default function (pi: GuiExtensionApi): void {
	registerGuiAutoStart(pi);
}
