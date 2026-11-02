/**
 * 行号引用越界校验测试（2026-11-02）
 *
 * 现场依据（run tfl-20261102-162039-c2f5，主会话逐条 `git show 基点:文件 | wc -l` 手工核出）：
 *   - lane A 引 `line 315`（worker-prompt.ts），基点 300 行 ⇒ 越界
 *   - lane C 引 `fusion-packet.ts:495-506`，基点 483 行 ⇒ 越界
 *   - lane A 14 条引用里 **11 条是裸行号**；lane B/C 引用大量写**裸文件名**（`artifacts.ts:179`）
 *
 * 夹具形状必须贴近真实（AGENTS.md R-5）：本测试刻意包含裸文件名、逗号清单、裸行号、
 * 同名歧义四种真实形态——第一版正是只会测「完整路径」的夹具放过了真实形状，
 * 真跑数据时把存在的文件误判成「基点上无此文件」。
 *
 * 断言两层：① 抽取与判据本体；② **接线**（packet 真调用、给了才调用）。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkLaneCitations,
	collectBareLineRefs,
	extractCitations,
	findFileOnLine,
	renderCitationSection,
} from "./trace-fusion/citation-check.ts";
import { buildFusionPacket } from "./trace-fusion/fusion-packet.ts";

const root = mkdtempSync(join(tmpdir(), "tf-cite-"));

try {
	// ── ① 抽取（真实形状） ──
	{
		const text = [
			"见 `worker-prompt.ts:257` 与 `worker-prompt.ts:259-265`。",
			"另引 `extensions/trace-fusion/fusion-packet.ts:495-506`。",
			"锚点 `artifacts.ts#L84`；清单 `artifacts.ts:179, 182`。",
			"基点 `d412b758` 不是引用；日期 2026-11-02 不是引用。",
		].join("\n");
		const c = extractCitations(text);
		assert.equal(c.length, 5, `应抽到 5 条，实得 ${c.length}`);
		assert.deepEqual([c[1].from, c[1].to], [259, 265], "区间取终点");
		assert.equal(c[2].file, "extensions/trace-fusion/fusion-packet.ts", "带目录路径要完整");
		assert.equal(c[3].from, 84, "#L84 要识别");

		// 裸行号：英文 + 中文形态
		const bare = "line 315 说的事\n第 90 行\n见 lines 278-282 显示";
		const b = collectBareLineRefs(bare);
		assert.equal(b.length, 3, `裸行号应 3 条，实得 ${b.length}`);
		assert.ok(b.every((x) => x.line > 0), "裸行号要提出数字");
		assert.equal(findFileOnLine("见 `worker-prompt.ts` 的 line 315"), "worker-prompt.ts", "同行文件名可用于关联");
		assert.equal(findFileOnLine("完全没有文件的一行"), null, "无文件名时不得凭空关联");
	}

	// ── ② 判据：裸文件名必须按基点清单解析（真实形状） ──
	const runDir = join(root, "run");
	const mkTraj = (lane: string, text: string) => {
		mkdirSync(join(runDir, "lanes", lane), { recursive: true });
		writeFileSync(join(runDir, "lanes", lane, "trajectory.md"), text, "utf8");
	};
	// 基点清单：worker-prompt.ts / fusion-packet.ts 唯一；dup.ts 有两个同名
	const LISTING = [
		"extensions/trace-fusion/worker-prompt.ts",
		"extensions/trace-fusion/fusion-packet.ts",
		"extensions/a/dup.ts",
		"extensions/b/dup.ts",
	];
	const LINES: Record<string, number> = {
		"extensions/trace-fusion/worker-prompt.ts": 300,
		"extensions/trace-fusion/fusion-packet.ts": 483,
		"extensions/a/dup.ts": 10,
		"extensions/b/dup.ts": 10,
	};

	mkTraj(
		"A",
		[
			"`artifacts.ts:179` 裸文件名，基点无此文件。",
			"`worker-prompt.ts:315` 越界；`worker-prompt.ts:200` 合法；`worker-prompt.ts:290-310` 终点越界。",
			"见 worker-prompt.ts 的 line 315 —— 裸行号关联核验。",
			"line 999 没有任何文件名可关联。",
			"`dup.ts:5` 同名歧义。",
		].join("\n"),
	);
	{
		const shown: string[] = [];
		const f = checkLaneCitations({
			runDir,
			lane: "A",
			repoRoot: root,
			baseCommit: "d412b758",
			gitList: () => LISTING,
			gitShow: (_r, _b, rel) => {
				shown.push(rel);
				return LINES[rel] ? { ok: true, lines: LINES[rel] } : { ok: false, lines: 0 };
			},
		});
		assert.equal(f.missingFile.length, 1, "裸文件名解析后仍找不到 ⇒ 基点无此文件");
		assert.ok(!f.missingFile[0].includes("worker-prompt"), "存在的文件绝不得被判「无此文件」（第一版就错在这）");
		assert.equal(f.outOfRange.length, 3, `起点越界 + 终点越界 + 裸行号关联越界 = 3，实得 ${f.outOfRange.length}`);
		assert.ok(f.outOfRange.every((x) => x.includes("300 行")), "越界条目必须带分母（基点行数）");
		assert.ok(f.outOfRange.some((x) => x.includes("关联")), "裸行号关联出的越界必须标注是启发式");
		assert.equal(f.ambiguous, 1, "同名多命中记歧义，不判对错");
		assert.equal(f.unqualified, 1, "无文件名可关联的裸行号 ⇒ 无法核验");
		assert.equal(f.heuristic, 1, "关联核验计数单列");
		assert.equal(f.ok, 1, ":200 应通过");
		assert.equal(
			f.total,
			f.checkable + f.missingFile.length + f.ambiguous + f.unqualified + f.skipped,
			"计数必须自洽（不静默丢引用）",
		);
		assert.equal(shown.length, 1, `同文件多次引用只查一次（缓存）：应 1 次，实得 ${shown.length}`);

		const md = renderCitationSection([f]).join("\n");
		assert.ok(md.includes("行号引用越界校验"), "报告要有越界段");
		assert.ok(md.includes("越界为 0 也不等于引用都对"), "必须写明下界性质（R-2 不得让读者高估）");
	}

	// ── 上限只限**不同文件**的查询数 ──
	// （见下面 maxFiles 用例）

	// ── lane 自产文件的行号：对**产物自身行数**判（c2f5 实测 A 6 条 / B 6 条是这种） ──
	{
		mkdirSync(join(runDir, "lanes", "D"), { recursive: true });
		writeFileSync(
			join(runDir, "lanes", "D", "trajectory.md"),
			["见 patch.diff line 194 的改动。", "status.txt line 3 说明状态。", "本文件 trajectory.md line 400 已写。", "patch.diff lines 90-140 覆盖了改动。"].join("\n"),
			"utf8",
		);
		writeFileSync(join(runDir, "lanes", "D", "patch.diff"), new Array(100).fill("x").join("\n"), "utf8");
		writeFileSync(join(runDir, "lanes", "D", "status.txt"), "a\nb\nc\n", "utf8");
		const f = checkLaneCitations({
			runDir,
			lane: "D",
			repoRoot: root,
			baseCommit: "d412b758",
			gitList: () => LISTING,
			gitShow: (_r, _b, rel) => ({ ok: true, lines: LINES[rel] ?? 0 }),
		});
		assert.equal(f.laneArtifact, 4, `lane 自产引用应单独计 laneArtifact，实得 ${f.laneArtifact}`);
		assert.equal(f.outOfRange.length, 3, `patch.diff:194、trajectory.md:400、patch.diff 90-140（终点越界）应=3，实得 ${f.outOfRange.length}`);
		assert.ok(f.outOfRange.some((x) => x.includes("终点越界") && x.includes("patch.diff 共 100 行")), "产物引用的**终点越界**必须被判定");
		assert.ok(f.outOfRange.some((x) => x.includes("patch.diff 共 100 行")), "产物越界要带产物自身行数做分母");
		assert.equal(f.ok, 1, "status.txt line 3 应通过");
		assert.equal(f.missingFile.length, 0, "产物引用不得被误报成「基点上无此文件」（第一版就错在这）");
	}

	// ── 就近关联：裸行号跟它**前面最近**的文件名，不是行尾最后一个 ──
	{
		mkdirSync(join(runDir, "lanes", "E"), { recursive: true });
		writeFileSync(join(runDir, "lanes", "E", "trajectory.md"), "worker-prompt.ts 里 line 315 是越界（同行后面还出现 patch.diff）\n", "utf8");
		const f = checkLaneCitations({
			runDir,
			lane: "E",
			repoRoot: root,
			baseCommit: "d412b758",
			gitList: () => LISTING,
			gitShow: (_r, _b, rel) => ({ ok: true, lines: LINES[rel] ?? 0 }),
		});
		assert.equal(f.outOfRange.length, 1, "就近关联到 worker-prompt.ts ⇒ 315 > 300 越界");
		assert.equal(f.laneArtifact, 0, "不得被行尾的 patch.diff 抢走（c2f5 lane A 的真实错法）");
	}

	// ── 文件数上限：跳过要记账 ──
	{
		mkTraj("B", "`worker-prompt.ts:1` `fusion-packet.ts:1` `worker-prompt.ts:2`");
		const f = checkLaneCitations({
			runDir,
			lane: "B",
			repoRoot: root,
			baseCommit: "x",
			maxFiles: 1,
			gitList: () => LISTING,
			gitShow: (_r, _b, rel) => ({ ok: true, lines: LINES[rel] ?? 0 }),
		});
		assert.equal(f.skipped, 1, `超上限必须记 skipped，实得 ${f.skipped}`);
		assert.equal(f.checkable, 2, "上限只限**不同文件**的查询数，缓存内已查文件的引用照判");
	}

	// ── ③ 接线：packet 必须真调用，未给 repoRoot 时零调用 ──
	{
		mkTraj("C", "`fusion-packet.ts:495-506` 越界");
		const mk = (extra: Record<string, unknown>) => ({
			runDir,
			task: "t",
			baseCommit: "d412b758",
			mode: "diagnose",
			laneTabRunIds: { A: "tab_a", B: "tab_b", C: "tab_c" },
			...extra,
		});

		let listCalls = 0;
		const gitList = () => {
			listCalls++;
			return LISTING;
		};
		const gitShow = (_r: string, _b: string, rel: string) => ({ ok: true, lines: LINES[rel] ?? 0 });

		const p1 = buildFusionPacket(mk({ citationRepoRoot: root, citationGitShow: gitShow, citationGitList: gitList }) as never);
		assert.ok(listCalls > 0, "给了 citationRepoRoot 就必须真的取基点文件清单（接线）");
		assert.ok(p1.markdown.includes("行号引用越界校验"), "packet 必须带越界段");
		assert.equal(p1.citations.length, 3, "三路都要有引用事实");
		const c3 = p1.citations.find((x) => x.lane === "C");
		assert.ok(c3 && c3.outOfRange.length === 1, "C 路 :495-506 对基点 483 行必须判越界");
		const a1 = p1.citations.find((x) => x.lane === "A");
		assert.ok(a1 && a1.outOfRange.length === 3, "A 路应记 3 处越界");

		listCalls = 0;
		const p2 = buildFusionPacket(mk({ citationGitShow: gitShow, citationGitList: gitList }) as never);
		assert.equal(listCalls, 0, "未给 citationRepoRoot ⇒ 零 git 调用（零回归）");
		assert.ok(!p2.markdown.includes("行号引用越界校验"), "未开启时不得出现越界段");
		assert.equal(p2.citations.length, 0, "未开启时 citations 为空");
	}

	console.log("trace-fusion citation-check tests passed");
} finally {
	try {
		rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
	} catch {
		/* 尽力 */
	}
}
