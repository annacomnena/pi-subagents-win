/**
 * 测试：跑完一个删一个（lane 终态先收产物、再回收 worktree）+ junction-safe 删除（R-16）。
 *
 * 承重断言（沙盒实测过的机制，plans/_wt_junction_experiment.ps1）：
 *   `git worktree remove --force` 的递归删除**会穿过 junction 删掉目标内容**；
 *   我们的原语必须先解链接 ⇒ 目标内容必须一字不损。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectLaneArtifacts } from "./trace-fusion/artifacts.ts";
import { removeWorktreeRetry, removeLinksOnly, listReparseLinks } from "./trace-fusion/worktrees.ts";
import { reclaimLaneWorktree, reclaimTerminalLaneWorktrees } from "./trace-fusion/worktree-reclaim.ts";
import { maybeAutoCollectTraceRun } from "./trace-fusion/supervisor.ts";
import type { TraceRunMeta } from "./trace-fusion/types.ts";

let failCount = 0;
function assert(cond: boolean, msg: string) {
	if (!cond) { console.log("FAIL: " + msg); failCount++; } else console.log("ok: " + msg);
}
function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}
function write(path: string, text: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text, "utf8");
}

const emptyProvision = () => ({ junction: [], copied: [], commandOk: true, degraded: false, issues: [] });

/** 真 git 仓 + 真 worktree + 真 junction（生产同款：symlinkSync 'junction'，无需管理员）。 */
function sandbox(): { root: string; repoRoot: string; wt: string; target: string } {
	const root = mkdtempSync(join(tmpdir(), "tfl-reclaim-"));
	const repoRoot = join(root, "repo");
	mkdirSync(repoRoot, { recursive: true });
	git(repoRoot, "init", "-q");
	write(join(repoRoot, "core.ts"), "export const x = 1;\n");
	write(join(repoRoot, "main.ts"), "import { x } from \"./core\";\nconsole.log(x);\n");
	git(repoRoot, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
	git(repoRoot, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
	const head = git(repoRoot, "rev-parse", "HEAD").trim();

	const wt = join(root, "wt", "a");
	git(repoRoot, "worktree", "add", "--detach", wt, head);
	// 供给出来的 junction：wt/node_modules → 主仓 nm_target（R-16 的穿透目标）
	const target = join(repoRoot, "nm_target");
	mkdirSync(target, { recursive: true });
	write(join(target, "keep.txt"), "IMPORTANT-PAYLOAD\n");
	write(join(target, "extra.txt"), "extra\n");
	symlinkSync(target, join(wt, "node_modules"), process.platform === "win32" ? "junction" : "dir");
	return { root, repoRoot, wt, target };
}

function fakeMeta(s: { root: string; repoRoot: string; wt: string }): { meta: TraceRunMeta; runsDir: string } {
	const runsDir = join(s.root, "runs", "tfl-reclaim-test");
	const meta: TraceRunMeta = {
		runId: "tfl-reclaim-test",
		shortId: "reclaim-test",
		status: "running",
		mode: "implement",
		cwd: s.repoRoot,
		repoRoot: s.repoRoot,
		baseCommit: git(s.repoRoot, "rev-parse", "HEAD").trim(),
		task: "回收测试",
		createdAt: new Date().toISOString(),
		wtDir: join(s.root, "wt"),
		runDir: runsDir,
		laneWallClockMin: 45,
		sessionScopeKey: "test-scope",
		lanes: {
			A: { lane: "A", worktree: s.wt, tabRunId: "tab_a", provision: emptyProvision() },
			B: { lane: "B", worktree: "", tabRunId: "tab_b", provision: emptyProvision() },
			C: { lane: "C", worktree: "", tabRunId: "", provision: emptyProvision() },
		},
	};
	mkdirSync(runsDir, { recursive: true });
	writeFileSync(join(runsDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
	return { meta, runsDir };
}

async function main() {
	// ── 1) junction-safe：删 worktree 后，junction 指向的目标内容必须完好 ──
	{
		const s = sandbox();
		const res = removeWorktreeRetry(s.wt, s.repoRoot, { attempts: 2, baseDelayMs: 50 });
		assert(res.removed === true, `junction-safe: worktree 已移除（linksRemoved=${JSON.stringify(res.linksRemoved)}）`);
		assert(existsSync(join(s.target, "keep.txt")), "junction-safe: 目标 keep.txt 完好（未穿 junction 删除）");
		assert(existsSync(join(s.target, "extra.txt")), "junction-safe: 目标 extra.txt 完好");
		assert((res.linksRemoved ?? []).includes("node_modules"), "junction-safe: 审计记录了被解除的链接名");
		assert(!existsSync(s.wt), "junction-safe: worktree 目录已消失");
		rmSync(s.root, { recursive: true, force: true, maxRetries: 2 });
	}

	// ── 2) listReparseLinks 不进入链接内部（深度只到链接本身） ──
	{
		const s = sandbox();
		const links = listReparseLinks(s.wt);
		assert(links.length === 1 && links[0].endsWith("node_modules"), "listReparseLinks: 只列出链接本身");
		const deep = listReparseLinks(join(s.target, ".."));
		assert(deep.length === 0, "listReparseLinks: 真目录里没有链接时为 0（不会把目标内容当链接）");
		rmSync(s.root, { recursive: true, force: true, maxRetries: 2 });
	}

	// ── 3) 跑完一个删一个：产物先收 ⇒ 树被回收 ⇒ meta 标记 + 审计行 ──
	{
		const s = sandbox();
		const { meta, runsDir } = fakeMeta(s);
		// lane 的自报产物（lane 契约内文件）
		write(join(s.wt, "trajectory.md"), "# TRACE A\n根因在 main.ts:1\n");
		write(join(s.wt, "status.txt"), "completed\n");
		write(join(s.wt, "notes.md"), "lane 契约外\n"); // 契约外文件（进 untracked 归档）
		const out = reclaimLaneWorktree(meta, "A", { enabled: true, tabRunsDir: join(s.root, "tab-runs") });
		assert(out.action === "reclaimed", `回收成功（reason=${out.reason}）`);
		assert(existsSync(join(runsDir, "lanes", "A", "patch.diff")), "先收产物：patch.diff 已落盘");
		assert(existsSync(join(runsDir, "lanes", "A", "status.txt")), "先收产物：status.txt 已落盘");
		assert(existsSync(join(runsDir, "lanes", "A", "untracked", "notes.md")), "先收产物：契约外文件已归档");
		assert(!existsSync(s.wt), "跑完一个删一个：worktree 已回收");
		assert(existsSync(join(s.target, "keep.txt")), "回收过程未伤 junction 目标（R-16）");
		const audit = readFileSync(join(runsDir, "reclaim.jsonl"), "utf8");
		assert(audit.includes('"action":"reclaimed"') && audit.includes('"lane":"A"'), "审计行：reclaim.jsonl 记 reclaimed/A");
		const metaAfter = JSON.parse(readFileSync(join(runsDir, "meta.json"), "utf8"));
		assert(typeof metaAfter.lanes.A.worktreeReclaimedAt === "string", "meta 标记：worktreeReclaimedAt 已写");
		// 幂等：再叫一次 ⇒ noop，不重复写审计
		const again = reclaimLaneWorktree(meta, "A", { enabled: true, tabRunsDir: join(s.root, "tab-runs") });
		assert(again.action === "noop", "幂等：已回收的 lane 再叫 = noop");
		assert(readFileSync(join(runsDir, "reclaim.jsonl"), "utf8").trim().split("\n").length === 1, "幂等：noop 不追加审计行");
		rmSync(s.root, { recursive: true, force: true, maxRetries: 2 });
	}

	// ── 4) 移除失败（git 锁住 worktree）⇒ 保留树 + deferred + stale 标记，绝不删穿 ──
	{
		const s = sandbox();
		const { meta, runsDir } = fakeMeta(s);
		write(join(s.wt, "status.txt"), "completed\n");
		write(join(s.wt, "trajectory.md"), "# TRACE A\n完成\n");
		// 锁住该 worktree（git 的正规锁文件）：remove --force 会拒绝
		const admin = git(s.repoRoot, "worktree", "list", "--porcelain");
		const wtName = admin.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9))
			.find((p) => p.replace(/\\/g, "/").toLowerCase().endsWith("/wt/a"));
		const regName = wtName ? wtName.split("/").slice(-1)[0] : "a";
		mkdirSync(join(s.repoRoot, ".git", "worktrees", regName), { recursive: true });
		writeFileSync(join(s.repoRoot, ".git", "worktrees", regName, "locked"), "", "utf8");
		const out = reclaimLaneWorktree(meta, "A", { enabled: true, tabRunsDir: join(s.root, "tab-runs") });
		assert(out.action === "deferred", `移除失败 ⇒ deferred（reason=${out.reason.slice(0, 70)}）`);
		assert(existsSync(s.wt), "移除失败 ⇒ worktree 保留（不能拿删树换空间）");
		assert(existsSync(join(s.target, "keep.txt")), "移除失败路径同样未伤 junction 目标");
		assert(existsSync(join(runsDir, "lanes", "A", "patch.diff")), "产物已先收（删不掉树也不影响证据）");
		const audit = readFileSync(join(runsDir, "reclaim.jsonl"), "utf8");
		assert(audit.includes('"action":"deferred"'), "审计行：deferred 已记");
		rmSync(s.root, { recursive: true, force: true, maxRetries: 2 });
	}

	// ── 5) 开关关掉 ⇒ 零动作（回到旧的手动 clean 行为） ──
	{
		const s = sandbox();
		const { meta } = fakeMeta(s);
		write(join(s.wt, "status.txt"), "completed\n");
		const out = reclaimLaneWorktree(meta, "A", { enabled: false });
		assert(out.action === "noop" && existsSync(s.wt), "开关关闭 ⇒ 不回收、不收集");
		rmSync(s.root, { recursive: true, force: true, maxRetries: 2 });
	}

	// ── 6) 无 worktree（diagnose / 未派发）⇒ noop，且不得调用收集 ──
	{
		const s = sandbox();
		const { meta } = fakeMeta(s);
		const b = reclaimLaneWorktree(meta, "B", { enabled: true });
		assert(b.action === "noop" && b.reason.includes("无 worktree"), "无 worktree ⇒ noop（diagnose 零影响）");
		const c = reclaimLaneWorktree(meta, "C", { enabled: true });
		assert(c.action === "noop", "未派发 lane ⇒ noop");
		rmSync(s.root, { recursive: true, force: true, maxRetries: 2 });
	}

	// ── 7) 批量入口只处理传入的 done lane（supervisor 传的就是 facts 里 done 的 lane） ──
	{
		const s = sandbox();
		const { meta } = fakeMeta(s);
		write(join(s.wt, "status.txt"), "completed\n");
		write(join(s.wt, "trajectory.md"), "# TRACE A\nx\n");
		const outs = reclaimTerminalLaneWorktrees(meta, ["A", "B", "C"], { enabled: true, tabRunsDir: join(s.root, "tab-runs") });
		const byLane = Object.fromEntries(outs.map((o) => [o.lane, o.action]));
		assert(byLane.A === "reclaimed" && byLane.B === "noop" && byLane.C === "noop", "批量入口：A 回收、B/C noop");
		rmSync(s.root, { recursive: true, force: true, maxRetries: 2 });
	}

	// ── 8) 产物收不成 ⇒ 不删树（deferred）——收派顺序是硬约束 ──
	{
		const s = sandbox();
		const { meta, runsDir } = fakeMeta(s);
		// 造“收集失败”形状：runDir/lanes 是一个普通文件 ⇒ mkdirSync(laneDir) 抛异常
		writeFileSync(join(runsDir, "lanes"), "not-a-dir", "utf8");
		write(join(s.wt, "status.txt"), "completed\n");
		const outs = reclaimTerminalLaneWorktrees(meta, ["A"], { enabled: true, tabRunsDir: join(s.root, "tab-runs") });
		assert(outs[0].action === "deferred", `产物收不成 ⇒ deferred（reason=${outs[0].reason.slice(0, 60)}）`);
		assert(existsSync(s.wt), "产物收不成 ⇒ worktree 保留（不能拿删树换空间）");
		assert(existsSync(join(s.target, "keep.txt")), "产物收不成路径未伤 junction 目标");
		const audit = readFileSync(join(runsDir, "reclaim.jsonl"), "utf8");
		assert(audit.includes('"action":"deferred"'), "审计行：收集失败也留痕");
		rmSync(s.root, { recursive: true, force: true, maxRetries: 2 });
	}

	// ── 9) supervisor 接线：只把 facts 里已终态的 lane 交给回收 ──
	{
		const s = sandbox();
		const { meta, runsDir } = fakeMeta(s);
		const tabRunsDir = join(s.root, "tab-runs");
		write(join(tabRunsDir, "tab_a.result.json"), JSON.stringify({
			id: "tab_a",
			taskId: "reclaim-9",
			status: "completed",
			summary: "A 完成",
			finishedAt: new Date().toISOString(),
		}) + "\n", "utf8");
		const calls: string[][] = [];
		maybeAutoCollectTraceRun("tab_a", {
			runsDir: join(s.root, "runs"),
			tabRunsDir,
			sessionScopeKey: () => "test-scope",
			spawnWorker: () => {},
			reclaimLaneWorktrees: (_m, lanes) => { calls.push([...lanes]); },
		});
		assert(calls.length >= 1, "supervisor 接线：回收被调用（次数=" + calls.length + "）");
		const flat = calls.flat();
		assert(flat.includes("A"), "supervisor 接线：已自报终态的 A 进入回收名单");
		assert(!flat.includes("B") && !flat.includes("C"), "supervisor 接线：未终态的 B/C 不得被回收");
		void runsDir;
		rmSync(s.root, { recursive: true, force: true, maxRetries: 2 });
	}

	// ── 10) reuse 守卫：回收后的二次收集不得把 patch 洗成空 ──
	{
		const s = sandbox();
		const { meta, runsDir } = fakeMeta(s);
		write(join(s.wt, "core.ts"), "export const x = 2;\n"); // 改动跟踪文件 ⇒ patch 非空
		write(join(s.wt, "status.txt"), "completed\n");
		write(join(s.wt, "trajectory.md"), "# TRACE A\n改了 core.ts\n");
		const out = reclaimLaneWorktree(meta, "A", { enabled: true, tabRunsDir: join(s.root, "tab-runs") });
		const patchFile = join(runsDir, "lanes", "A", "patch.diff");
		const bytesBefore = statSync(patchFile).size;
		assert(out.action === "reclaimed" && bytesBefore > 0, `首次收集：patch 非空（${bytesBefore}B）且已回收`);
		const again = collectLaneArtifacts(meta, "A", { tabRunsDir: join(s.root, "tab-runs") });
		assert(statSync(patchFile).size === bytesBefore, "reuse 守卫：二次收集未把 patch 洗成空文件");
		assert(again.changedFiles.includes("core.ts"), "reuse 守卫：changedFiles 从 manifest 还原（cross-test 要用）");
		assert(again.issues.some((i) => i.includes("沿用首次")), "reuse 守卫：沿用事实明示（不静默，R-2）");
		rmSync(s.root, { recursive: true, force: true, maxRetries: 2 });
	}

	if (failCount > 0) { console.log(`FAILURES=${failCount}`); process.exit(1); }
	console.log("PASS");
}

main().then(() => process.exit(process.exitCode ?? 0));
