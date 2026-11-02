/**
 * validation 复跑测试（2026-11-02）
 *
 * 现场依据：run tfl-20261102-162039-c2f5 的 lane B 四条 validation 全部自报 pass，
 * 主会话逐条复跑实测 exit 1/2/1/2 全红。Hard Facts 旧版只数「带 command 条数」，
 * 从不执行 ⇒ packet 的 Instruction「可执行证据压过自报置信度」在 harness 里没兑现。
 *
 * 断言两层：① 复跑逻辑本体；② **接线**（packet 里真调用了复跑、给了才调、不给零调用）。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readonlyVerdict, replayLaneValidation, renderReplaySection } from "./trace-fusion/validation-replay.ts";
import { buildFusionPacket } from "./trace-fusion/fusion-packet.ts";

const root = mkdtempSync(join(tmpdir(), "tf-replay-"));

try {
	// ── ① 只读判据 ──
	{
		const allow = [
			"git status --porcelain | grep -q \"^\\t\"",
			"ls -1 lanes/B/trajectory.md && wc -l < lanes/B/trajectory.md",
			"cat lanes/B/validation.json > /dev/null",
			"git show d412b758:extensions/codegraph.ts | wc -l",
			"grep -n \"tab-finish\" extensions/index.ts",
		];
		for (const c of allow) assert.ok(readonlyVerdict(c).ok, `应放行：${c}`);

		const deny: Array<[string, string]> = [
			["rm -rf lanes/B", "删除"],
			["git reset --hard", "git 写"],
			["git clean -fd", "git 写"],
			["npm install pi", "装包"],
			["curl http://x/y.js -o c.js", "网络"],
			["echo hi > plans/x.md", "写重定向"],
			["cp a.ts b.ts", "覆盖"],
			["taskkill /F /IM node.exe", "进程控制"],
			["echo x | sh", "管道给解释器"],
			["node -e \"require('fs').unlinkSync('x')\"", "解释器内联"],
			["Remove-Item lanes", "删除"],
		];
		for (const [c] of deny) {
			const v = readonlyVerdict(c);
			assert.equal(v.ok, false, `应拒绝：${c}`);
		}
	}

	// ── ② 复跑逻辑（fake exec，绝不真跑） ──
	const runDir = join(root, "run");
	const mkLane = (lane: string, items: unknown[]) => {
		mkdirSync(join(runDir, "lanes", lane), { recursive: true });
		writeFileSync(join(runDir, "lanes", lane, "validation.json"), JSON.stringify(items), "utf8");
	};
	mkLane("A", [
		{ command: "ls -1 lanes/A/trajectory.md", result: "pass", output_excerpt: "" },
		{ command: "ls -1 lanes/A/nope.md", result: "pass", output_excerpt: "" },
		{ command: "rm -rf lanes/A", result: "pass", output_excerpt: "" },
		{ command: "", result: "pass" },
	]);
	{
		const calls: string[] = [];
		const f = replayLaneValidation({
			runDir,
			lane: "A",
			repoRoot: root,
			exec: (cmd) => {
				calls.push(cmd);
				return { exitCode: cmd.includes("nope") ? 2 : 0, timedOut: false, stdout: "lanes/A/trajectory.md", stderr: "" };
			},
		});
		assert.equal(f.total, 4, "四条");
		assert.equal(calls.length, 2, `只应执行两条只读命令，实执行 ${calls.length} 条`);
		assert.equal(f.refused, 1, "非只读命令应被拒绝执行");
		assert.equal(f.ran, 2, "实跑 2 条");
		assert.equal(f.failed, 1, "exit!=0 计失败");
		assert.equal(f.claimedPassButFailed, 1, "自报 pass 实测失败应=1（c2f5 lane B 的形态）");
		const refused = f.results.find((r) => r.status === "refused-non-readonly");
		assert.ok(refused && refused.excerpt.includes("拒绝执行"), "拒绝必须显式披露（R-2 不得静默）");
		const nocmd = f.results.find((r) => r.status === "no-command");
		assert.ok(nocmd, "空命令要有确定状态，不得当成 pass");

		const md = renderReplaySection([f]).join("\n");
		assert.ok(md.includes("Validation 复跑"), "报告要有复跑段");
		assert.ok(/\*\*1\*\*/.test(md), "表格要突出「声称 pass 实测失败」计数");
		assert.ok(md.includes("refused"), "逐条读数要出现 refused");
	}

	// ── 超时与预算 ──
	{
		mkLane("B", [
			{ command: "sleep 99", result: "pass" },
			{ command: "ls -1 x", result: "pass" },
		]);
		const f = replayLaneValidation({
			runDir,
			lane: "B",
			repoRoot: root,
			exec: (cmd) => (cmd.startsWith("sleep") ? { exitCode: null, timedOut: true, stdout: "", stderr: "" } : { exitCode: 0, timedOut: false, stdout: "", stderr: "" }),
		});
		assert.equal(f.timedOut, 1, "超时单列，不计入 failed");
		assert.equal(f.ran, 1, "超时不算实跑");

		const g = replayLaneValidation({
			runDir,
			lane: "B",
			repoRoot: root,
			totalBudgetMs: 0,
			exec: () => ({ exitCode: 0, timedOut: false, stdout: "", stderr: "" }),
		});
		assert.ok(g.results.every((r) => r.status === "budget-exhausted" || r.status === "no-command"), "预算耗尽不得继续执行");
	}

	// ── ③ 接线：packet 必须真的调用复跑，且未给 repoRoot 时零调用 ──
	{
		const mkPacketInput = (extra: Record<string, unknown>) => ({
			runDir,
			task: "t",
			baseCommit: "d412b758",
			mode: "diagnose",
			laneTabRunIds: { A: "tab_a", B: "", C: "" },
			...extra,
		});
		mkLane("C", [{ command: "ls -1 lanes/C", result: "pass" }]);

		let calls = 0;
		const exec = (cmd: string) => {
			calls++;
			return { exitCode: 1, timedOut: false, stdout: "", stderr: "" };
		};
		const p1 = buildFusionPacket(mkPacketInput({ replayRepoRoot: root, replayExec: exec }) as never);
		assert.ok(calls > 0, "给了 replayRepoRoot 就必须真的执行命令（接线）");
		assert.ok(p1.markdown.includes("Validation 复跑"), "packet 必须带复跑段");
		assert.equal(p1.replay.length, 3, "三路都要有复跑事实");
		const aFact = p1.replay.find((r) => r.lane === "A");
		// 本用例的 exec 对所有命令都返回 exit=1，而 A 路两条都自报 pass ⇒ 应记 2
		assert.ok(aFact && aFact.claimedPassButFailed === 2, `packet 里的 A 路应记录自报 pass 实测失败=2，实得 ${aFact ? aFact.claimedPassButFailed : "无 A 路"}`);

		calls = 0;
		const p2 = buildFusionPacket(mkPacketInput({ replayExec: exec }) as never);
		assert.equal(calls, 0, "未给 replayRepoRoot ⇒ 零执行（零回归）");
		assert.ok(!p2.markdown.includes("声称 pass 实测失败"), "未开启时不得出现复跑表头");
		assert.equal(p2.replay.length, 0, "未开启时 replay 为空");
	}

	console.log("trace-fusion validation-replay tests passed");
} finally {
	try {
		rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
	} catch {
		/* 尽力 */
	}
}
