/**
 * boot-ensure-host.mjs — 开机幂等 ensure runtime-host（计划步①）
 *
 * 依据 plans/0926_boot_autostart_plan.md §1a：
 *   计划任务 `pi-runtime-host-boot`（登录触发）→ 本脚本（内置登录后延迟）
 *   → `ensureRuntimeDaemon()`（单实例锁 + 身份挑战 + 僵尸重建；三源并发安全，
 *     L1 §5.1 / daemon-lifecycle.ts 已证）。零生产代码：只是 ensure 的薄封装 + JSONL 日志。
 *
 * 用法（计划任务里）：
 *   node --experimental-strip-types "<repo>\scripts\boot-ensure-host.mjs"
 *
 * 可选参数（自测/排障用，任务不必传）：
 *   --delay <sec>        登录后延迟秒数（默认 30；0 = 不等）
 *   --dry-run            只解析模块/日志路径并落一行 plan 日志，不 import、不 ensure
 *   --log <path>         覆盖日志文件（默认 <runtime>/state/boot-autostart.log）
 *   --runtime-dir <dir>  覆盖 runtime 目录（默认 %USERPROFILE%\.pi\agent\runtime）
 *
 * 退出码：0 = 成功 / dry-run；1 = ensure 未就绪；2 = 内部异常（含模块解析失败）。
 * 日志：追加式 JSONL，每行 `<iso-ts> {"task":"host-ensure",...}`，写失败也不中断判定。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const argv = process.argv.slice(2);

function argOf(name, fallback) {
	const i = argv.indexOf(name);
	return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
}

const delaySec = Number(argOf("--delay", "30"));
const dryRun = argv.includes("--dry-run");
const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runtimeDir = argOf("--runtime-dir", join(process.env.USERPROFILE ?? "", ".pi", "agent", "runtime"));
const logPath = argOf("--log", join(runtimeDir, "state", "boot-autostart.log"));
const modulePath = join(pkgRoot, "extensions", "runtime-host", "daemon-lifecycle.ts");

// 日志 never-throw（写失败也继续走判定）
const note = (o) => {
	try {
		mkdirSync(dirname(logPath), { recursive: true });
		appendFileSync(logPath, `${new Date().toISOString()} ${JSON.stringify({ task: "host-ensure", ...o })}\n`);
	} catch {
		/* 日志不可写不阻断 ensure */
	}
};

try {
	mkdirSync(dirname(logPath), { recursive: true });
	if (Number.isFinite(delaySec) && delaySec > 0) {
		await new Promise((r) => setTimeout(r, delaySec * 1000));
	}
	if (dryRun) {
		// 干跑：证明「延迟 + 日志 + 模块解析」链路，但不 ensure（零副作用）
		note({ phase: "plan", ok: true, dryRun: true, delay: delaySec, module: modulePath, runtimeDir });
		process.exit(0);
	}
	const mod = await import(pathToFileURL(modulePath).href);
	if (typeof mod.ensureRuntimeDaemon !== "function") {
		note({ phase: "boot", ok: false, error: `ensureRuntimeDaemon 未导出：${modulePath}` });
		process.exit(2);
	}
	const r = await mod.ensureRuntimeDaemon();
	note({
		phase: "ensure",
		ok: r.ok,
		already: Boolean(r.already),
		uncertain: Boolean(r.uncertain),
		pid: r.pid ?? null,
		port: r.port ?? null,
		error: r.error ?? null,
		note: r.note ?? null,
	});
	process.exit(r.ok ? 0 : 1);
} catch (e) {
	note({ phase: "boot", ok: false, error: String((e && e.stack) || e) });
	process.exit(2);
}
