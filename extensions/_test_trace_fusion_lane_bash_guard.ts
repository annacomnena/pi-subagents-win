/**
 * trace-fusion/lane-bash-guard 守卫测试（2026-11-03，R-13 机械化）
 *
 * 三层：
 *   A 纯判据（拦什么 / 放什么，含斜杠方向与 `C:/` 绕过形状）
 *   B 接线（走真实注册线：registerLaneBashGuard 的 tool_call handler 真的会 block）
 *   C 注册面（index.ts 里确实注册了它——变异只改注册行必须变红，AGENTS.md §4）
 */

import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
	collectPathCandidates,
	isRootishTarget,
	judgeLaneBashCommand,
	registerLaneBashGuard,
	findStrayWriteToolTarget,
	findDestructiveCommand,
} from "./trace-fusion/lane-bash-guard.ts";

const repoRoot = process.cwd();

// ── A. 纯判据 ──────────────────────────────────────────────────────

const MUST_BLOCK: string[] = [
	// 本次实测 lane A 跑的三条（逐字取自其会话 JSONL）
	'ls -la /Users/Annacomnena/plans 2>/dev/null || ls -la plans 2>/dev/null || find / -name "lane_stray_files_brief.md" 2>/dev/null | head -5',
	'find / -name "lane_stray_files_brief.md" 2>/dev/null | head -5',
	// 斜杠方向与盘符形状（R-13 明令「不区分斜杠方向」）
	"find C:/ -type d -name trace-fusion-runs",
	"find C:\\ -type d -name trace-fusion-runs",
	"find C: -name x",
	"find /c -name x",
	"find /c/Users -maxdepth 3 -name pi",
	"find ~ -name cli.js",
	"find $HOME -name cli.js",
	'find "C:/Users" -name x',
	"find /Users -name x",
	"find /Users/Annacomnena -name x",
	"find /home -name x",
	"du -a / | head",
	"du /",
	"grep -r secret /Users/Annacomnena",
	"grep -rn token C:/",
	"rg -n password /",
	"ag token ~",
	"ls -R /",
	"ls -laR C:/Users",
	"Get-ChildItem -Recurse C:\\",
	"gci -Recurse C:/Users",
	// 2026-11-03 L4 实验验实的三个直接可达漏拦形状（旧版全逸出：尾斜杠 / 大写 R / 包装命令）
	"find /c/ -name x",
	"grep -R needle /",
	"env find / -name x",
	// 复合命令里只有后段违规也要拦
	"echo hi && find / -name tab-finish",
	"cd C:/Users/Annacomnena; find / -name x",
];

const MUST_ALLOW: string[] = [
	"find . -name trajectory.md",
	"find plans -name '*lane_stray*'",
	"find extensions/trace-fusion -name '*.ts' -type f",
	"grep -rn laneTerminal extensions/trace-fusion/",
	"grep -c pid C:/Users/Annacomnena/pi-packages/subagent-win/extensions/tab-runs.ts",
	"ls -la plans/",
	"ls -la",
	"ls -la /tmp/x",
	"du plans/pi-corruption-diagnostics",
	"rg -n laneTerminal extensions/",
	"cd C:/Users/Annacomnena/pi-packages/subagent-win && git log --oneline -1",
	// 2026-11-03 L4 实验验实的三个误杀（旧版全拦）：rg 的模式字 `/`、家目录下的具体子目录、盘符下的普通项目录
	"rg '/' extensions/trace-fusion/",
	"find ~/pi-packages/subagent-win/extensions -maxdepth 2 -name '*.ts'",
	"find /c/repo -maxdepth 1 -name '*.md'",
	"ls /", // 非递归列盘根：R-13 管的是递归扫描
	"head -100 C:/Users/Annacomnena/plans/20261103_lane_stray_files_brief.md",
	"cat plans/20261103_task3_lane_stray_files_brief.md",
	"git show 125b735:extensions/trace-fusion/artifacts.ts | head -50",
	"echo done",
	// 非递归的盘根 ls 不算扫描（本门只拦递归形状）
	"ls -la C:/",
	"ls /",
];

for (const cmd of MUST_BLOCK) {
	const v = judgeLaneBashCommand(cmd);
	assert.equal(v.block, true, `应拦未拦：${cmd}`);
	assert.ok(v.reason.includes("R-13"), `理由须带 R-13 标签：${cmd}`);
	assert.ok(v.target.length > 0, `须登记命中目标：${cmd}`);
}
for (const cmd of MUST_ALLOW) {
	const v = judgeLaneBashCommand(cmd);
	assert.equal(v.block, false, `误杀正常仓库内搜索：${cmd}（命中 target=${v.target}）`);
}

// 形状单测：isRootishTarget 的边界
assert.equal(isRootishTarget("/"), true);
assert.equal(isRootishTarget("C:/"), true);
assert.equal(isRootishTarget("C:\\"), true);
assert.equal(isRootishTarget("~"), true);
assert.equal(isRootishTarget('"C:/Users"'), true);
assert.equal(isRootishTarget("plans/"), false);
assert.equal(isRootishTarget("./plans"), false);
assert.equal(isRootishTarget("/tmp/x"), false);
assert.equal(isRootishTarget("extensions/trace-fusion/"), false);
assert.equal(isRootishTarget("-name"), false);

// 原生工具（find/grep/ls）的路径参数提取
assert.deepEqual(collectPathCandidates({ path: "/", query: "x" }), ["/", "x"]);
assert.deepEqual(collectPathCandidates({ paths: ["C:/", "plans"], n: 3 }), ["C:/", "plans"]);

// ── B. 接线：走真实注册线的 tool_call handler ───────────────────────

type Handler = (event: unknown) => { block?: boolean; reason?: string } | undefined;
const handlers: { event: string; fn: Handler }[] = [];
const fakePi = {
	on: (event: string, fn: Handler) => {
		handlers.push({ event, fn });
	},
};

registerLaneBashGuard(fakePi as never, { isLane: () => true, artifactDir: "/repo/run/fusion" });
const callToolCall = (input: unknown, toolName = "bash") => {
	const h = handlers.find((x) => x.event === "tool_call");
	assert.ok(h, "registerLaneBashGuard 必须注册 tool_call handler");
	return h!.fn({ type: "tool_call", toolCallId: "t1", toolName, input });
};

const blocked = callToolCall({ command: 'find / -name "lane_stray_files_brief.md" 2>/dev/null | head -5' });
assert.equal(blocked?.block, true, "注册线必须真的 block 盘根递归（本次实测事故命令）");
assert.ok((blocked?.reason ?? "").includes("R-13"), "拒绝理由必须可解释");

const allowed = callToolCall({ command: "grep -rn laneTerminal extensions/trace-fusion/" });
assert.equal(allowed, undefined, "正常仓库内搜索必须放行（grep 的绝对路径是读取，不是写盘）");

// 写盘目标越界（首跑实测：融合者用 bash 重定向把 fusion.md 写到主仓外，路径还写丢了个点）
const stray = callToolCall({ command: 'cat x | tee "C:/Users/Annacomnena/pi/agent/trace-fusion-runs/t1/fusion/fusion.md"' });
assert.equal(stray?.block, true, "写到 artifactDir 之外的绝对路径必须拦");
const inPlace = callToolCall({ command: 'echo hi > "/repo/run/fusion/notes.md"' });
assert.equal(inPlace, undefined, "写进合法产物目录必须放行");

// 原生 write 工具的落点锁（2026-11-03 第四次实测后：禁 write 拦不住交付 ⇒ 给 write 但锁落点）
assert.equal(findStrayWriteToolTarget("write", { path: "C:/Users/x/.pi/agent/trace-fusion-runs/r/fusion/fusion.md" }, "C:/Users/x/.pi/agent/trace-fusion-runs/r/fusion"), undefined);
assert.equal(findStrayWriteToolTarget("write", { path: "C:/Users/x/pi/agent/trace-fusion-runs/r/fusion/fusion.md" }, "C:/Users/x/.pi/agent/trace-fusion-runs/r/fusion"), "C:/Users/x/pi/agent/trace-fusion-runs/r/fusion/fusion.md", "把 .pi 写成 pi 的野路径必须识别");
assert.equal(findStrayWriteToolTarget("write", { path: "plans/x.md" }, "C:/run/fusion"), undefined, "相对路径交给 cwd 约束，不在本层拦");
assert.equal(findStrayWriteToolTarget("read", { path: "C:/Windows/x" }, "C:/run/fusion"), undefined, "只读工具不在本层拦");
const wBlock = callToolCall({ path: "C:/Users/Annacomnena/evil.md" }, "write");
assert.equal(wBlock?.block, true, "注册线必须真的 block 越界 write");
const wAllow = callToolCall({ path: "/repo/run/fusion/fusion.md" }, "write");
assert.equal(wAllow, undefined, "写进合法产物目录的 write 必须放行");

// 破坏性命令（第 5 次实测：融合者写完 fusion.md 又 `rm` 掉它 ⇒ 交付物自毁）
assert.equal(findDestructiveCommand('rm /c/Users/x/.pi/agent/trace-fusion-runs/r/fusion/fusion.md'), "rm/rmdir/unlink ×1");
assert.equal(findDestructiveCommand('cat a.md'), undefined, "普通读取不得误判");
assert.equal(findDestructiveCommand('cat >> x.md << EOF'), undefined, "追加重定向不是删除");
assert.equal(findDestructiveCommand('powershell -Command "Remove-Item C:/x/y.md"') !== undefined, true);
const rmBlock = callToolCall({ command: 'rm /c/Users/x/.pi/agent/trace-fusion-runs/r/fusion/fusion.md && echo done' });
assert.equal(rmBlock?.block, true, "注册线必须真的 block 删除产物");
const readKeep = callToolCall({ command: 'ls -la /c/Users/x/.pi/agent/trace-fusion-runs/r/fusion/ && head -5 notes.md' });
assert.equal(readKeep, undefined, "只读命令必须放行（不得误杀核验）");

// 原生 find 工具：目标为盘根也拦；仓库内路径放行
assert.equal(callToolCall({ path: "/", query: "cli.js" }, "find")?.block, true, "原生 find 工具盘根目标必须拦");
assert.equal(callToolCall({ path: "plans", query: "x" }, "find"), undefined, "原生 find 工具仓库内路径放行");

// 非 lane 会话（profile 不是 trace-worker）⇒ 零作用
const handlers2: { event: string; fn: Handler }[] = [];
registerLaneBashGuard({ on: (e: string, f: Handler) => handlers2.push({ event: e, fn: f }) } as never, { isLane: () => false });
const outSide = handlers2.find((x) => x.event === "tool_call")!.fn({
	type: "tool_call",
	toolCallId: "t2",
	toolName: "bash",
	input: { command: "find / -name x" },
});
assert.equal(outSide, undefined, "非 trace-worker 会话必须零作用（不得拦主会话）");

// 缺省 isLane（忘传）⇒ 必须零拦截（默认安全 = 不拦，而不是默认全拦）
const handlers3: { event: string; fn: Handler }[] = [];
registerLaneBashGuard({ on: (e: string, f: Handler) => handlers3.push({ event: e, fn: f }) } as never);
const outDefault = handlers3.find((x) => x.event === "tool_call")!.fn({
	type: "tool_call",
	toolCallId: "t3",
	toolName: "bash",
	input: { command: "find / -name x" },
});
assert.equal(outDefault, undefined, "缺省 isLane 必须零拦截（默认全拦会误杀主会话）");

// ── C. 注册面（变异只改注册行必须变红）──────────────────────────────

const indexPath = join(repoRoot, "extensions", "index.ts");
assert.ok(existsSync(indexPath), "extensions/index.ts 必须存在");
const src = readFileSync(indexPath, "utf8");
assert.ok(/lane-bash-guard\.ts/.test(src), "index.ts 必须 import lane-bash-guard");
// 必须是**真调用行**，不是被注释掉的行（上一版只查字串，注释掉的注册能蒙过去）
assert.ok(/^\s*registerLaneBashGuard\(/m.test(src), "index.ts 必须有一行未被注释的 registerLaneBashGuard 调用");
assert.ok(/registerLaneBashGuard\([\s\S]{0,160}isLane/.test(src), "注册必须带 isLane 判据（只作用于 trace-worker）");
// isLane 必须同时覆盖两类受限会话（2026-11-03 首跑实测补面）：
// ① lane = isTraceWorker()（写成恒 true = 误杀主会话；恒 false = 门失效）；
// ② 融合子会话 = PI_TRACE_FUSION_FUSION_DIR 存在（首跑：融合者 write/edit 被排除后用
//    bash 写盘，把 `.pi` 写成 `pi`，在主仓外造出野文件）。
assert.ok(
	/registerLaneBashGuard\(\s*pi\s*,\s*\{\s*isLane:\s*\(\)\s*=>\s*isTraceWorker\(\)\s*\|\|\s*Boolean\(process\.env\.PI_TRACE_FUSION_FUSION_DIR\)/.test(src),
	"注册的 isLane 必须是 isTraceWorker() || Boolean(PI_TRACE_FUSION_FUSION_DIR)（缺任一 = 一类会话无门）",
);
assert.ok(
	/registerLaneBashGuard\([\s\S]{0,400}artifactDir:\s*process\.env\.PI_TRACE_FUSION_FUSION_DIR/.test(src),
	"注册必须把合法产物目录传给守卫（不传 = 野路径写盘无门）",
);

console.log(
	`lane-bash-guard OK：拦 ${MUST_BLOCK.length} 例 / 放 ${MUST_ALLOW.length} 例 / 接线 ${(handlers.length && 1) + (blocked?.block ? 1 : 0)} 例 / 注册面 3 断言`,
);
