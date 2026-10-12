/**
 * _test_gate_dialects.ts — `readGateStatus` 区段化 + 方言并集回归（2026-10-12 修复）
 *
 * 背景（"套件瞎了一只眼"）：旧实现按**整文件** 64KB 卡上限、且只认英文表头
 * （`## Active Tasks` / `### Task Index` / `Item|Priority|Summary`），于是
 *   · recentwork 自然膨胀的仓（GreenCAD 214KB、本仓 100KB+）**永久** `unknown`；
 *   · 中文方言仓（`## 待办事项 (Todo)` / `### 任务简报索引`）**永远** `unknown`；
 * ⇒ gate 类触发（`blocked_to_ready`、"gate=awaiting → needs_user"）永不触发、actions 长期零产出。
 *
 * 本测试锁定：① 区段级上限（超限仍 unknown + warn）；② 两种方言均可解析；
 * ③ 表头漂移 / 缺索引标题 / 缺文件 仍 unknown（原语义不回归）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_GATE_BYTES, readGateStatus } from "./runtime/frontier-carriers.ts";

const root = mkdtempSync(join(tmpdir(), "gate-dialects-"));

function repo(name: string, text: string | null): string {
	const d = join(root, name);
	mkdirSync(d, { recursive: true });
	if (text !== null) writeFileSync(join(d, "recentwork.md"), text, "utf8");
	return d;
}

const EN_HEAD = "# T\n\n## Active Tasks\n\n### Task Index\n\n| Item | Priority | Summary |\n|---|---|---|\n";
const ZH_HEAD = "# T\n\n## 待办事项 (Todo)\n\n### 任务简报索引\n\n| Item | 评级 | 一句话说明 |\n|---|---|---|\n";

// ① 英文方言（本仓形态）：ok / awaiting 由 `**Status**` 行决定
{
	const w: string[] = [];
	assert.equal(readGateStatus(repo("en-ok", EN_HEAD + "| 1 | P1 | 正常条目 |\n"), w), "ok", "英文方言无等人工词 → ok");
	assert.deepEqual(w, [], "英文 ok 不应产生 warning");
	const w2: string[] = [];
	assert.equal(
		readGateStatus(repo("en-await", EN_HEAD + "| 1 | P1 | x |\n\n- **Status**：awaiting 等人工确认\n"), w2),
		"awaiting",
		"英文方言 + **Status** 等人工 → awaiting",
	);
}

// ② 中文方言（GreenCAD 形态）：区段标题/索引标题/表头列名/状态行标记四处都要认
{
	const w: string[] = [];
	assert.equal(
		readGateStatus(repo("zh-await", ZH_HEAD + "| 3500 | P1 | 某任务 |\n\n- **状态**: 📋 待用户 build 后复现\n"), w),
		"awaiting",
		"中文方言 + **状态** 待用户 → awaiting",
	);
	assert.deepEqual(w, [], "中文方言可解析时不应报表头漂移");
	const w2: string[] = [];
	assert.equal(
		readGateStatus(repo("zh-ok", ZH_HEAD + "| 3500 | P1 | 某任务 |\n\n- **状态**: 📋 进行中\n"), w2),
		"ok",
		"中文方言无等人工词 → ok",
	);
}

// ③ 区段级上限：>256KB 的 **Active Tasks 区段** 才降级（整文件大但区段正常 → 不再降级）
{
	const huge = repo("seg-huge", EN_HEAD + "| 1 | P1 | filler |\n".repeat(Math.ceil((MAX_GATE_BYTES * 1.2) / 20) + 500));
	const w: string[] = [];
	assert.equal(readGateStatus(huge, w), "unknown", "区段超上限 → unknown");
	assert.ok(w.some((x) => /gate 区段超 \d+KB 降级 unknown/.test(x)), `应有区段超限 warning，实得 ${JSON.stringify(w)}`);

	// 反例：整文件 >64KB（甚至 >MAX_GATE_BYTES）但 Active 区段正常 + 其后有超长 Archived 区段 → 应可解析
	const bigTail = "# T\n\n## Active Tasks\n\n### Task Index\n\n| Item | Priority | Summary |\n|---|---|---|\n| 1 | P1 | x |\n\n## Archived Tasks\n\n" + "| 0 | - | 历史条目 |\n".repeat(30000);
	const w2: string[] = [];
	assert.equal(readGateStatus(repo("tail-big", bigTail), w2), "ok", "整文件大、区段正常 → 仍可解析（旧实现会 unknown）");
	assert.deepEqual(w2, [], "区段正常时不应 warning");
}

// ④ 原语义不回归：表头漂移 / 缺索引标题 / 缺文件 / 无 Active 区段
{
	const w: string[] = [];
	assert.equal(readGateStatus(repo("drift", "# T\n\n## Active Tasks\n\n### Task Index\n\n| Foo | Bar | Baz |\n"), w), "unknown");
	assert.ok(w.some((x) => /表头漂移/.test(x)), "表头漂移应有 warning");
	assert.equal(readGateStatus(repo("no-index", "# T\n\n## Active Tasks\n\n无索引表\n"), []), "unknown", "缺索引标题 → unknown");
	assert.equal(readGateStatus(repo("no-file", null), []), "unknown", "缺文件 → unknown");
	assert.equal(readGateStatus(repo("no-active", "# T\n\n## 别的区段\n\n### Task Index\n\n| Item | Priority | Summary |\n"), []), "unknown", "无 Active 区段 → unknown");
}

console.log("gate dialects tests passed");
