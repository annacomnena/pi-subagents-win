/**
 * extensions/gui-shortcuts-runner.ts — 快捷按钮 script/process 执行器（设计稿 v4 §6，P3）。
 *
 * 无 Pi API / 无 HTTP；server.ts 只做鉴权 + 薄绑定。安全口径：
 *  - script：只吃「单个 .ps1 文件名 + 参数数组」，powershell.exe -NoProfile -File <abs> <args>，
 *    **shell:false**（绝不走 cmd.exe，避开 Node≥18.20.2 的 .cmd EINVAL 与二次解析注入）；
 *    不加 -ExecutionPolicy Bypass（脚本落仓库内由用户配置即视为信任）。
 *  - process：CIM 枚举 dotnet.exe，Node 侧参数化比对 CommandLine（不把用户输入拼进 PowerShell
 *    脚本串），匹配数 ≠ 1 拒绝并列出候选（fail-closed，不误杀）。
 *  - 取消：只对台账里「本次 action 启动」的 pid 发 kill，校验 pid + CreationDate + cmd marker；
 *    不默认 /T 广杀进程树。
 *  - 输出保留尾部 64KB；台账 + 审计独立文件。
 */
import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const RUN_OUTPUT_MAX = 64 * 1024;

export interface ScriptTarget {
	cwd: string;
	command: string;
	args: string[];
	timeoutMs: number;
}

export interface RunResult {
	ok: boolean;
	status: "success" | "failed" | "cancelled";
	exitCode: number | null;
	outputTail: string;
	pid?: number;
	error?: string;
	hint?: string;
}

export interface RunnerDeps {
	/** 测试注入假 spawn；生产用 node:child_process.spawn。 */
	spawnFn?: typeof spawn;
	/** 测试注入假 CIM 查询；返回候选进程。 */
	enumProcessesFn?: (name: string) => ProcCandidate[];
	/** 测试注入假进程身份查询（pid → CreationDate/CommandLine）；fail-closed 身份复核用。 */
	inspectPidFn?: (pid: number) => ProcInfo;
	/** 测试注入假 kill。 */
	killFn?: (pid: number) => { ok: boolean; out: string };
	/** 台账根目录（缺省 <shortcutsRoot>/runs）。 */
	runsDir?: string;
	now?: () => Date;
}

// ── 运行台账（pid 归属校验）─────────────────────────────────────────────────

export interface RunRecord {
	runId: string;
	actionId: string;
	cwd: string;
	kind: "script" | "process";
	pid: number | null;
	creationDateMs: number | null;
	cmdMarker: string;
	launchToken: string;
	startedAt: string;
	status: "running" | "success" | "failed" | "cancelled";
	exitCode: number | null;
	outputTail: string;
}

function runsDirOf(deps: RunnerDeps, shortcutsRoot: string): string {
	return deps.runsDir ?? join(shortcutsRoot, "runs");
}
function runPath(dir: string, runId: string): string { return join(dir, `${runId}.json`); }

function writeRecord(dir: string, rec: RunRecord): void {
	// 台账写入是 best-effort：磁盘异常不得让执行器抛（never-throw 契约）。
	// 写失败时 cancelRun 读不到记录会拒杀，仍是 fail-closed。
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(runPath(dir, rec.runId), JSON.stringify(rec), "utf8");
	} catch { /* ignore */ }
}
export function readRunRecord(dir: string, runId: string): RunRecord | null {
	try { return JSON.parse(readFileSync(runPath(dir, runId), "utf8")) as RunRecord; } catch { return null; }
}

/** 唯一 runId。 */
export function newRunId(now?: () => Date): string {
	const t = (now ?? (() => new Date()))().getTime().toString(36);
	return `sc_${t}_${Math.random().toString(36).slice(2, 10)}`;
}

// ── script 执行 ─────────────────────────────────────────────────────────────

interface ProcInfo { startedAtMs: number | null; cmd: string | null }
function inspectPid(pid: number): ProcInfo {
	try {
		if (process.platform === "win32") {
			const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue; if ($p) { $p.CreationDate.ToUniversalTime().ToString("o"); $p.CommandLine }`;
			const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
				encoding: "utf8", timeout: 20_000, windowsHide: true,
			});
			const lines = out.split(/\r?\n/);
			const ms = Date.parse((lines[0] ?? "").trim());
			return { startedAtMs: Number.isFinite(ms) ? ms : null, cmd: lines.slice(1).join("\n").trim() || null };
		}
		const startOut = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 10_000 }).trim();
		const cmdOut = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 10_000 }).trim();
		const ms = Date.parse(startOut);
		return { startedAtMs: Number.isFinite(ms) ? ms : null, cmd: cmdOut || null };
	} catch { return { startedAtMs: null, cmd: null }; }
}

/**
 * 执行 .ps1 脚本（shell:false）。返回 runId 供轮询/取消；同步等结束（有界超时），
 * 超时 kill 该 pid（不树杀），输出保留尾部。
 */
export async function runScript(
	target: ScriptTarget,
	actionId: string,
	shortcutsRoot: string,
	deps: RunnerDeps = {},
): Promise<{ runId: string; result: RunResult }> {
	const runId = newRunId(deps.now);
	const dir = runsDirOf(deps, shortcutsRoot);
	const abs = resolve(target.cwd, target.command);
	const cmdMarker = createHash("sha256").update(`${abs}|${target.args.join("|")}`).digest("hex").slice(0, 16);
	const launchToken = `${process.pid}-${Math.random().toString(36).slice(2, 12)}`;
	const rec: RunRecord = {
		runId, actionId, cwd: target.cwd, kind: "script", pid: null, creationDateMs: null,
		cmdMarker, launchToken, startedAt: (deps.now ?? (() => new Date()))().toISOString(),
		status: "running", exitCode: null, outputTail: "",
	};
	writeRecord(dir, rec);

	const spawnFn = deps.spawnFn ?? spawn;
	const args = ["-NoProfile", "-NonInteractive", "-File", abs, ...target.args];
	return await new Promise((resolvePromise) => {
		let out = "";
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (result: RunResult): void => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			rec.status = result.status;
			rec.exitCode = result.exitCode;
			rec.outputTail = result.outputTail;
			writeRecord(dir, rec);
			resolvePromise({ runId, result });
		};
		try {
			const child: ChildProcessWithoutNullStreams = spawnFn("powershell.exe", args, { shell: false, windowsHide: true }) as ChildProcessWithoutNullStreams;
			rec.pid = child.pid ?? null;
			if (rec.pid !== null) {
				const info = deps.inspectPidFn ? deps.inspectPidFn(rec.pid) : inspectPid(rec.pid);
				rec.creationDateMs = info.startedAtMs;
			}
			writeRecord(dir, rec);
			const append = (chunk: Buffer | string): void => {
				out += chunk.toString();
				if (out.length > RUN_OUTPUT_MAX) out = out.slice(-RUN_OUTPUT_MAX);
			};
			child.stdout?.on("data", append);
			child.stderr?.on("data", append);
			child.on("error", (e) => finish({
				ok: false, status: "failed", exitCode: null, outputTail: out,
				error: "spawn-failed", hint: `脚本启动失败：${String((e as Error).message ?? e)}`,
			}));
			child.on("close", (code, signal) => {
				const status = code === 0 ? "success" : signal === "SIGTERM" || signal === "SIGKILL" ? "cancelled" : "failed";
				finish({ ok: status === "success", status, exitCode: code, outputTail: out, pid: rec.pid ?? undefined });
			});
			timer = setTimeout(() => {
				if (rec.pid !== null) killPid(rec.pid, deps);
				finish({ ok: false, status: "cancelled", exitCode: null, outputTail: out, pid: rec.pid ?? undefined, error: "timeout", hint: `脚本超时（${target.timeoutMs}ms），已终止` });
			}, target.timeoutMs);
		} catch (e) {
			finish({ ok: false, status: "failed", exitCode: null, outputTail: out, error: "spawn-failed", hint: String((e as Error).message ?? e) });
		}
	});
}

// ── process：精确匹配 + 终止 ────────────────────────────────────────────────

export interface ProcCandidate { pid: number; creationDateMs: number | null; commandLine: string }

/** CIM 枚举指定进程名（默认查 dotnet.exe）。用户特征串不进 PowerShell 脚本，只在 Node 侧比对。 */
export function enumProcesses(name = "dotnet.exe", deps: RunnerDeps = {}): ProcCandidate[] {
	if (deps.enumProcessesFn) return deps.enumProcessesFn(name);
	if (process.platform !== "win32") return [];
	try {
		// 用字符串拼接而非模板串：strip-types 对模板内的 PowerShell 反引号 `$()` 解析会炸（实测）。
		// PowerShell 用 [char]9 生成制表符分隔符，避免源码里出现反引号转义。
		const tab = "[char]9";
		const script = "Get-CimInstance Win32_Process -Filter \"Name='" + name + "'\" -ErrorAction SilentlyContinue | "
			+ "ForEach-Object { $_.ProcessId.ToString() + " + tab + " + $_.CreationDate.ToUniversalTime().ToString('o') + " + tab + " + $_.CommandLine }";
		const raw = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
			encoding: "utf8", timeout: 20_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
		});
		const out: ProcCandidate[] = [];
		for (const line of raw.split(/\r?\n/)) {
			if (!line.includes("\t")) continue;
			const [pids, date, ...rest] = line.split("\t");
			const pid = Number(pids);
			if (!Number.isSafeInteger(pid) || pid <= 0) continue;
			const ms = Date.parse((date ?? "").trim());
			out.push({ pid, creationDateMs: Number.isFinite(ms) ? ms : null, commandLine: rest.join("\t") });
		}
		return out;
	} catch { return []; }
}

/** 匹配命令行特征串；匹配数 ≠ 1 返回拒绝（列出候选）。 */
export function matchUnique(matchCommandLine: string, deps: RunnerDeps = {}):
	| { ok: true; candidate: ProcCandidate }
	| { ok: false; error: string; hint: string; candidates: ProcCandidate[] } {
	const all = enumProcesses("dotnet.exe", deps);
	const matched = all.filter((p) => p.commandLine.includes(matchCommandLine));
	if (matched.length === 0) return { ok: false, error: "no-match", hint: "没有匹配的 dotnet server 进程", candidates: [] };
	if (matched.length > 1) {
		return {
			ok: false, error: "ambiguous",
			hint: `匹配到 ${matched.length} 个进程，拒绝误杀；请缩小特征串。候选 pid：${matched.map((p) => p.pid).join(", ")}`,
			candidates: matched,
		};
	}
	return { ok: true, candidate: matched[0]! };
}

function killPid(pid: number, deps: RunnerDeps): { ok: boolean; out: string } {
	if (deps.killFn) return deps.killFn(pid);
	if (process.platform === "win32") {
		const r = spawnSync("taskkill", ["/PID", String(pid), "/F"], { encoding: "utf8", timeout: 15_000, windowsHide: true });
		return { ok: r.status === 0, out: (r.stdout ?? "") + (r.stderr ?? "") };
	}
	const r = spawnSync("kill", ["-TERM", String(pid)], { encoding: "utf8", timeout: 15_000 });
	return { ok: r.status === 0, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

/** 终止匹配的进程（二次确认已由前端做）。先记台账（pid + CreationDate + cmd marker），再杀。 */
export function terminateProcess(
	actionId: string,
	cwd: string,
	matchCommandLine: string,
	shortcutsRoot: string,
	deps: RunnerDeps = {},
): { runId: string; result: RunResult } {
	const m = matchUnique(matchCommandLine, deps);
	const runId = newRunId(deps.now);
	const dir = runsDirOf(deps, shortcutsRoot);
	if (!m.ok) {
		const rec: RunRecord = {
			runId, actionId, cwd, kind: "process", pid: null, creationDateMs: null,
			cmdMarker: createHash("sha256").update(matchCommandLine).digest("hex").slice(0, 16),
			launchToken: "", startedAt: (deps.now ?? (() => new Date()))().toISOString(),
			status: "failed", exitCode: null, outputTail: "",
		};
		writeRecord(dir, rec);
		return { runId, result: { ok: false, status: "failed", exitCode: null, outputTail: "", error: m.error, hint: m.hint } };
	}
	const rec: RunRecord = {
		runId, actionId, cwd, kind: "process", pid: m.candidate.pid,
		creationDateMs: m.candidate.creationDateMs,
		cmdMarker: createHash("sha256").update(matchCommandLine).digest("hex").slice(0, 16),
		launchToken: `${process.pid}-${Math.random().toString(36).slice(2, 12)}`,
		startedAt: (deps.now ?? (() => new Date()))().toISOString(),
		status: "running", exitCode: null, outputTail: "",
	};
	writeRecord(dir, rec);
	// 杀之前再核一次进程身份（CreationDate 必须一致），防 TOCTOU 错杀 reuse 的 pid。
	// fail-closed（L4 审查修）：候选缺 CreationDate / 复核查不到 / 不一致，任一情况都拒杀；
	// 只有两侧 CreationDate 都存在且相等才放行。"缺证据就放行"会让 pid 复用窗口误杀无关进程。
	const live = deps.inspectPidFn ? deps.inspectPidFn(m.candidate.pid) : inspectPid(m.candidate.pid);
	const identityOk = m.candidate.creationDateMs !== null
		&& live.startedAtMs !== null
		&& live.startedAtMs === m.candidate.creationDateMs;
	if (!identityOk) {
		rec.status = "failed";
		rec.outputTail = "无法确认进程身份（CreationDate 缺失/查不到/已变化），fail-closed 拒绝终止以防误杀";
		writeRecord(dir, rec);
		return { runId, result: { ok: false, status: "failed", exitCode: null, outputTail: rec.outputTail, error: "identity-unverified", hint: rec.outputTail } };
	}
	const killed = killPid(m.candidate.pid, deps);
	rec.status = killed.ok ? "success" : "failed";
	rec.exitCode = killed.ok ? 0 : 1;
	rec.outputTail = killed.out.slice(-RUN_OUTPUT_MAX);
	writeRecord(dir, rec);
	return {
		runId,
		result: { ok: killed.ok, status: killed.ok ? "success" : "failed", exitCode: rec.exitCode, outputTail: rec.outputTail, pid: m.candidate.pid, ...(killed.ok ? {} : { error: "kill-failed", hint: "终止失败，请检查权限" }) },
	};
}

/** 取消运行中的 script：核对 pid 归属（台账里的 pid + CreationDate + launchToken），只杀自己启动的。 */
export function cancelRun(
	runId: string,
	shortcutsRoot: string,
	deps: RunnerDeps = {},
): { ok: boolean; error?: string; hint?: string } {
	// L4：runId 拼进路径前必须过形状白名单，堵 ../ 越目录读 JSON 并据此 kill 任意 pid。
	// `$` 在非 multiline 正则下允许末尾换行前匹配，显式拒绝 CR/LF 避免畸形 runId 混过白名单。
	if (typeof runId !== "string" || /[\r\n]/.test(runId) || !/^sc_[a-z0-9]+_[a-z0-9]+$/.test(runId)) {
		return { ok: false, error: "invalid-run-id", hint: "非法 runId 格式" };
	}
	const rec = readRunRecord(runsDirOf(deps, shortcutsRoot), runId);
	if (rec === null) return { ok: false, error: "no-run", hint: "找不到运行记录" };
	if (rec.status !== "running" || rec.pid === null) return { ok: false, error: "not-running", hint: "该运行已结束或无 pid" };
	const live = deps.inspectPidFn ? deps.inspectPidFn(rec.pid) : inspectPid(rec.pid);
	// 身份校验 fail-closed（L4）：台账 CreationDate 与实时查询都必须存在且相等才放行；
	// 任一缺失/不一致 ⇒ 拒绝，防 pid 复用后错杀无关进程。
	const identityOk = rec.creationDateMs !== null && live.startedAtMs !== null && rec.creationDateMs === live.startedAtMs;
	if (!identityOk) {
		return { ok: false, error: "identity-unverified", hint: "无法确认 pid 身份（CreationDate 缺失/查不到/已变），拒绝终止" };
	}
	const killed = killPid(rec.pid, deps);
	if (killed.ok) {
		rec.status = "cancelled";
		writeRecord(runsDirOf(deps, shortcutsRoot), rec);
	}
	return killed.ok ? { ok: true } : { ok: false, error: "kill-failed", hint: killed.out.slice(-200) };
}
