/**
 * _test_trace_fusion_fusion_packet.ts — 三路对照抽取（2026-11-02）
 *
 * 锁定：
 *   ① 解析按 DIAGNOSE_SECTIONS 切节；缺文件/缺节 ⇒ 标记而非编造
 *   ② 分歧判据：完全相同/粗细包含 ⇒ 不分歧；实质不同 ⇒ 分歧
 *   ③ 三路都未填的节单列（比分歧更值得警惕）
 *   ④ 抽取失败 never-throw（构建 packet 不抛）
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildFusionPacket, divergenceShape, parseTrajectoryLane, sectionsDiverge, sectionShortName } from "./trace-fusion/fusion-packet.ts";
import { DIAGNOSE_SECTIONS } from "./trace-fusion/worker-prompt.ts";

const root = mkdtempSync(join(tmpdir(), "tf-packet-"));
const shortNames = DIAGNOSE_SECTIONS.split("\n").map(sectionShortName);

/** 构造一份 8 节齐全的 trajectory；未指定的节写**空正文**（不是「（未填）」字样）——
 * 对照表判「三路都未填」依赖真空串。 */
function traj(bodies: Record<string, string>): string {
	return shortNames.map((s) => `## ${s}\n\n${bodies[s] ?? ""}\n`).join("\n");
}
function writeLane(runDir: string, lane: string, content: string) {
	mkdirSync(join(runDir, "lanes", lane), { recursive: true });
	writeFileSync(join(runDir, "lanes", lane, "trajectory.md"), content, "utf8");
}

try {
	// ── ① 解析：齐全 / 缺节 / 缺文件 ──
	{
		const runDir = join(root, "r1");
		writeLane(runDir, "A", traj({}));
		const a = parseTrajectoryLane(runDir, "A");
		assert.equal(a.found, true);
		assert.equal(Object.keys(a.sections).length, shortNames.length, "8 节全部解析出来");
		assert.equal(a.issues.length, 0, "齐全时无 issue");

		// 缺节：只写前两节
		const runDir2 = join(root, "r2");
		mkdirSync(join(runDir2, "lanes", "B"), { recursive: true });
		writeFileSync(
			join(runDir2, "lanes", "B", "trajectory.md"),
			`## ${shortNames[0]}\n\n有内容\n\n## ${shortNames[1]}\n\n也有\n`,
			"utf8",
		);
		const b = parseTrajectoryLane(runDir2, "B");
		assert.equal(b.found, true);
		assert.equal(b.sections[shortNames[0]], "有内容");
		assert.ok(b.issues.some((i) => i.startsWith("缺节")), "缺 6 节必须记 issue，而不是静默补空");
		assert.ok(b.issues.length >= 6, `应记 6 条以上缺节，实得 ${b.issues.length}`);

		// 缺文件
		const c = parseTrajectoryLane(join(root, "r_nope"), "C");
		assert.equal(c.found, false);
		assert.ok(c.issues[0].includes("缺失"));
		console.log("  ✓ ① 解析：齐全 / 缺节标记 / 缺文件降级");
	}

	// ── ② 分歧判据 ──
	{
		assert.equal(sectionsDiverge(["same text", "same text", "same text"]), false, "三路相同 ⇒ 不分歧");
		assert.equal(sectionsDiverge(["*Same  text*", "same text", "SAME TEXT"]), false, "markdown/大小写归一后相同 ⇒ 不分歧");
		assert.equal(
			sectionsDiverge(["根因是 X", "根因是 X，且证据在 a.ts:12 与 b.ts:30，另需注意 C", "根因是 X"]),
			false,
			"粗细包含关系 ⇒ 是对齐不是分歧",
		);
		assert.equal(sectionsDiverge(["根因是 X", "根因是 Y", "根因是 X"]), true, "实质不同 ⇒ 分歧");
		assert.equal(sectionsDiverge(["根因是 X", "", ""]), false, "只有一路有内容 ⇒ 不算分歧（是覆盖不足）");

		// ---- 2026-11-02 分歧形状：boolean 之外必须能区分「2:1 孤立」与「三方各不同」
		// 背景：实测 21f9 是 A≡B、C 单独一路（7/8 节 A/B jaccard=1.00，A/C=0.00~0.09），
		// 但报告只写「8 节分歧」，与 a726 的「三方全不同」渲染成同一种，读的人无从下手。
		{
			const iso = divergenceShape(["根因是 X", "根因是 X", "根因是 Y"]);
			assert.equal(iso.diverge, true, "2:1 也是分歧");
			assert.equal(iso.minorityIsolated, true, "2:1 必须识别为少数派孤立");
			assert.deepEqual(iso.minority, [2], "少数派应为第 3 路（下标 2）");
			assert.equal(iso.groups.length, 2, "应分 2 组");

			const three = divergenceShape(["根因是 X", "根因是 Y", "根因是 Z"]);
			assert.equal(three.diverge, true);
			assert.equal(three.minorityIsolated, false, "三方各不同 ⇒ 不是少数派孤立（需仲裁）");
			assert.equal(three.groups.length, 3, "应分 3 组");

			const all = divergenceShape(["同样内容", "同样内容", "同样内容"]);
			assert.equal(all.diverge, false);
			assert.equal(all.groups.length, 1, "全相同 ⇒ 1 组");

			// 包含关系（粗细）不得算成分歧组
			const contain = divergenceShape(["根因是 X 详细说明", "根因是 X", "根因是 X"]);
			assert.equal(contain.diverge, false, "包含关系不构成分歧");
			assert.equal(contain.groups.length, 1);

			// 与 sectionsDiverge 同源：boolean 与 shape.diverge 必须永远一致
			const cases = [
				["a", "a", "b"],
				["a", "b", "c"],
				["a", "a", "a"],
				["a", "", ""],
				["a 很长", "a", ""],
			];
			for (const c of cases) {
				assert.equal(sectionsDiverge(c), divergenceShape(c).diverge, `sectionsDiverge 与 divergenceShape 必须同源：${JSON.stringify(c)}`);
			}
		}
		assert.equal(sectionsDiverge(["", "", ""]), false, "全空 ⇒ 不分歧（由 allMissing 负责）");
		console.log("  ✓ ② 分歧判据：归一相同/包含/实质不同/单路有内容");
	}

	// ── ③ 对照表内容：分歧节 + 全缺节 + 禁止投票声明 ──
	{
		const runDir = join(root, "r3");
		writeLane(
			runDir,
			"A",
			traj({
				[shortNames[0]]: "根因是 DI 注册缺失",
				[shortNames[5]]: "恢复 ICadCommandLifecycle",
			}),
		);
		writeLane(
			runDir,
			"B",
			traj({
				[shortNames[0]]: "根因是 GuardPrerequisites 抛异常",
				[shortNames[5]]: "恢复 ICadCommandLifecycle + AddGreenCadHongyeWrite",
			}),
		);
		// C 的第 6 节与 A 完全相同（粗细关系只应出现在 A 与 B 之间）。
		// 注意 traj() 会给未指定的节填「（未填）」——那是**有内容**，会参与比较，
		// 所以 C 必须显式给第 6 节同一段文本。
		writeLane(
			runDir,
			"C",
			traj({
				[shortNames[0]]: "根因是 DI 注册缺失",
				[shortNames[5]]: "恢复 ICadCommandLifecycle",
			}),
		);

		const p = buildFusionPacket({ runDir, task: "诊断 X", baseCommit: "abcdef1234567" });
		assert.ok(p.divergentSections.includes(shortNames[0]), "第 1 节三路有两说 ⇒ 必须标分歧");
		assert.ok(!p.divergentSections.includes(shortNames[5]), "第 6 节是粗细关系 ⇒ 不标分歧");
		assert.ok(p.allMissingSections.includes(shortNames[7]), "第 8 节三路都没填 ⇒ 必须单列");

		assert.ok(p.markdown.includes("禁止多数投票") || p.markdown.includes("禁止**多数投票"), "必须写明禁止多数投票（§25）");
		assert.ok(p.markdown.includes("拼装"), "必须给出正确做法：拼装而非投票");
		assert.ok(p.markdown.includes("A✓") || p.markdown.includes("A✓"), "必须显示三路 artifact 到位情况");
		assert.ok(p.markdown.includes("abcdef1234567".slice(0, 12)), "必须显示诊断基点");
		// ---- 2026-11-02 第一步：设计稿 §61 的硬三段（Hard Facts / Conflicts / Instruction）
		{
			const md = p.markdown;
			assert.ok(md.includes("### Hard Facts"), "必须有 Hard Facts 段（§61）");
			assert.ok(md.includes("### Conflicts"), "必须有 Conflicts 段（§61）");
			assert.ok(md.includes("### Instruction"), "必须有 Instruction 段（§61）");

			// Instruction 必须逐字沿用设计稿四句（防被"优化"成软建议）
			assert.ok(md.includes("Do not vote by majority."), "Instruction 必须含禁多数投票");
			assert.ok(md.includes("Executable evidence dominates self-reported confidence."), "Instruction 必须含证据优先");
			assert.ok(md.includes("Determine the best currently available solution."), "Instruction 必须含定最佳方案");
			assert.ok(md.includes("smallest high-information"), "Instruction 必须含最小高信息探针");

			// 同模型风险提示（本仓特有：三路可能是同一个 9B 模型）
			assert.ok(md.includes("同一个模型"), "必须提示同模型 rollout 的相关性风险");

			// Hard Facts 必须只计数、不判对错
			assert.ok(md.includes("不含对错判定"), "Hard Facts 必须声明不含对错判定");
			assert.ok(/\| A \|.*\| B \|/.test(md) || md.includes("| lane |"), "Hard Facts 必须有逐 lane 表");
		}

		// ---- 2026-11-02 实跑驱动（b31e）两处修复
		{
			// (a) 只有 2 路有内容时，形态不得硬编码「三方各不同」
			const md2 = p.markdown;
			if (!md2.includes("三方各不同") || md2.includes("2 路各不同")) {
				// 本夹具是 3 路齐全，故这里只断言格式合法
			}
			// 真正验证放在独立夹具：2 路有内容
			const tmp2 = mkdtempSync(join(tmpdir(), "fpack2-"));
			for (const [lane, body] of [["A", "根因是 X"], ["B", ""], ["C", "根因是 Y"]] as const) {
				const d = join(tmp2, "lanes", lane);
				mkdirSync(d, { recursive: true });
				writeFileSync(join(d, "trajectory.md"), shortNames.map((s) => `## ${s}\n\n${body}`).join("\n\n"), "utf8");
			}
			const pk2 = buildFusionPacket({ runDir: tmp2, task: "t", baseCommit: "0".repeat(40) });
			assert.ok(
				pk2.markdown.includes("2 路各不同"),
				"只有 2 路有内容时必须写「2 路各不同」，不得硬编码「三方各不同」（b31e 实测缺陷）",
			);
			assert.ok(!pk2.markdown.includes("三方各不同"), "2 路场景下不得出现「三方各不同」");
			rmSync(tmp2, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });

			// (b) result.json 的 unconfirmed 必须在 Hard Facts 里写明原因，而不是只说「缺失」
			const tmp3 = mkdtempSync(join(tmpdir(), "fpack3-"));
			const tabRuns = join(tmp3, "tab-runs");
			mkdirSync(tabRuns, { recursive: true });
			for (const lane of ["A", "B", "C"] as const) {
				const d = join(tmp3, "lanes", lane);
				mkdirSync(d, { recursive: true });
				writeFileSync(join(d, "trajectory.md"), shortNames.map((s) => `## ${s}\n\n内容${lane}`).join("\n\n"), "utf8");
			}
			// 让 B 缺 trajectory，并给 B 一个 unconfirmed 的 result.json
			rmSync(join(tmp3, "lanes", "B", "trajectory.md"));
			writeFileSync(
				join(tabRuns, "tabB.result.json"),
				JSON.stringify({ status: "unconfirmed", summary: "tab 回合结束但未调用 tab-finish" }),
				"utf8",
			);
			const pk3 = buildFusionPacket({
				runDir: tmp3, task: "t", baseCommit: "0".repeat(40),
				tabRunsDir: tabRuns, laneTabRunIds: { A: "tabA", B: "tabB", C: "tabC" },
			});
			assert.ok(pk3.markdown.includes("tab 自报"), "Hard Facts 必须有 tab 自报列");
			assert.ok(pk3.markdown.includes("unconfirmed"), "必须显示 B 的 unconfirmed 状态");
			assert.ok(pk3.markdown.includes("未调用 tab-finish"), "必须给出缺失原因（summary），而非只说缺失");
			assert.ok(pk3.markdown.includes("自报未完成的路"), "必须有专门的「为何缺失」小节");
			rmSync(tmp3, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
		}

		console.log("  ✓ ③ 对照表：分歧节 / 粗细不误报 / 全缺节 / 禁止投票声明");
	}

	// ── ④ never-throw ──
	{
		const p = buildFusionPacket({ runDir: join(root, "完全不存在"), task: "t", baseCommit: "c" });
		assert.equal(p.lanes.length, 3);
		assert.ok(p.lanes.every((l) => !l.found), "三路都缺 ⇒ found=false，而不是抛");
		assert.ok(p.markdown.length > 0, "仍必须产出可读报告");
		console.log("  ✓ ④ 抽取失败降级（不抛）");
	}

	console.log("trace-fusion fusion-packet tests passed");
} finally {
	try { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* 尽力 */ }
}
