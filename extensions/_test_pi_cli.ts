/**
 * _test_pi_cli — findPiCli 加固（2026-10-16，00:19:13 会话崩溃根因）
 *   ① nvm4w / 版本目录感知候选（process.execPath 的 realpath 反推）
 *   ② 候选全缺失 + 稍后出现 → 重试后成功（3 次、间隔生效）
 *   ③ 始终缺失 → 抛可操作的普通错误（列出试过的路径 + PI_CLI_PATH 提示），
 *      被调用方 catch 转结构化失败（不冒泡崩溃；runSingle 的 catch 见 index.ts）
 * 隔离：全部候选指向临时目录（resolvePiCliFrom 直接注入），不碰真实安装树；
 *       PI_CLI_PATH 快路径测试用后即还原。
 * 运行: npm run test:pi-cli
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findPiCli, piCliCandidates, resolvePiCliFrom } from "./index.ts";

let failed = 0;
function check(label: string, cond: boolean): void {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}`);
	if (!cond) failed++;
}

// ① 候选列表包含 execPath 与 realpath（版本目录）两份全局包路径（nvm4w junction 感知）
{
	const nodeDir = dirname(process.execPath);
	const realNodeDir = dirname(realpathSync(process.execPath));
	const cands = piCliCandidates();
	check("① 候选含 execPath node 目录全局包路径",
		cands.includes(join(nodeDir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js")));
	check("① 候选含 realpath 版本目录全局包路径",
		cands.includes(join(realNodeDir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js")));
}

// ② 候选全缺失 + 稍后出现 → 重试后成功（probe seam 模拟第 2 次尝试时「出现」）
{
	const dir = mkdtempSync(join(tmpdir(), "pi-cli-retry-"));
	const target = join(dir, "cli.js");
	let probes = 0;
	let probeGap = 0;
	let lastProbeAt = 0;
	let resolved: string | null = null;
	let threw: unknown = null;
	try {
		resolved = resolvePiCliFrom([target], {
			attempts: 3,
			retryDelayMs: 10,
			exists: (p) => {
				probes++;
				if (probes > 1) probeGap = Date.now() - lastProbeAt;
				lastProbeAt = Date.now();
				return p === target && probes > 1; // 首次缺失，重试后出现
			},
		});
	} catch (e) { threw = e; }
	check("② 瞬时缺失 → 重试后成功（不抛）", threw === null && resolved === target);
	check("② 确实发生了重试（≥2 次探测）", probes >= 2);
	check("② 重试间隔生效（第 2 次探测距首次 ≥5ms，调度 10ms）", probeGap >= 5);
}

// ③ 始终缺失 → 抛普通可操作错误（列出试过的路径 + PI_CLI_PATH 提示），可被 catch（不崩溃）
{
	const dir = mkdtempSync(join(tmpdir(), "pi-cli-miss-"));
	const missing = join(dir, "no-such-cli.js");
	let threw: unknown = null;
	try {
		resolvePiCliFrom([missing], { attempts: 3, retryDelayMs: 1, exists: () => false });
	} catch (e) { threw = e; }
	check("③ 始终缺失 → 抛普通 Error（非静默/非崩溃）", threw instanceof Error);
	const msg = threw instanceof Error ? threw.message : String(threw);
	check("③ 错误列出试过的路径", msg.includes(missing));
	check("③ 错误含 PI_CLI_PATH 提示", msg.includes("PI_CLI_PATH"));
}

// ④ PI_CLI_PATH 快路径不变：已设且存在 → 直接命中（不进重试环）
{
	const dir = mkdtempSync(join(tmpdir(), "pi-cli-env-"));
	const p = join(dir, "cli.js");
	writeFileSync(p, "// fake cli", "utf8");
	const prev = process.env.PI_CLI_PATH;
	process.env.PI_CLI_PATH = p;
	let hit = false;
	try { hit = findPiCli() === p; } catch { hit = false; }
	if (prev === undefined) delete process.env.PI_CLI_PATH;
	else process.env.PI_CLI_PATH = prev;
	check("④ PI_CLI_PATH 存在 → findPiCli 直接命中", hit);
}

console.log(failed === 0 ? "\nAll pi-cli tests passed." : `\n${failed} test(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
