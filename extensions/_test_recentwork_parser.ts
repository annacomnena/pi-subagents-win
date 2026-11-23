/**
 * _test_recentwork_parser.ts — 任务状态解析回归测试（2026-11-17）
 *
 * 覆盖 2026-11-17 事故：
 *   - 行首 emoji 必须优先于正文关键词（「待 X 完成后开工」曾被误判为已完成）
 *   - 英文 `**Status**` 字段必须被识别（subagent-win/recentwork.md 实际写法）
 *   - 「未完成」不得被 `includes("完成")` 误判为已完成
 *
 * 断言走真实入口 parseWorkspaceOverview(cwd)（读盘 + 段落切分 + 字段提取），
 * 不直接调内部 parseStatus，避免变异函数体却漏掉接线。
 *
 * 运行：node --experimental-strip-types ./extensions/_test_recentwork_parser.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkspaceOverview } from "./runtime-host/recentwork-parser.ts";

function withFixture(markdown: string, check: (tasks: ReturnType<typeof parseWorkspaceOverview>["tasks"]) => void): void {
	const cwd = mkdtempSync(join(tmpdir(), "rw-parser-"));
	try {
		writeFileSync(join(cwd, "recentwork.md"), markdown, "utf8");
		const overview = parseWorkspaceOverview(cwd);
		assert.equal(overview.found, true, "应找到 recentwork.md");
		check(overview.tasks);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

// ── 1. 行首 emoji 优先：GreenCAD 真实事故形状 ───────────────────
withFixture(`# Recent Work

## Maintenance Rules

- 规则正文里 ### Item 000 — 伪条目不能算数。

## Active Tasks

### Item 3567 — 清理 IsCore 收尾
- **状态**: 📋 2026-11-17 登记（待 3566 S3 完成后拍口径并开工）｜ 指针：诊断 plans/x.md

### Item 3566 — IsCore 升级
- **状态**: 🔧 2026-11-17 **进行中，整条未完成**（S1+S2 已入库）

### Item 3552 — 文档收尾
- **状态**: ✅ 2026-11-16 **文档收尾已落盘**

### Item 3554 — 判定在飞
- **状态**: 🔧 2026-11-16 **实现完成、判定 R3-L4 在飞**

### Item 3558 — 挂起
- **状态**: ⏸ 2026-11-16 **挂起**

### Item 3568 — 排序器
- **状态**: 📋 2026-11-17 登记（待拍排序键 A/B 后开工）

### Item 1 — 真推进中
- **状态**: 📋 正在推进中

### Item 2 — 阻塞
- **状态**: ⚠️ 有阻塞
`, (tasks) => {
	const byId = new Map(tasks.map((t) => [t.id, t.status]));
	assert.equal(byId.get("Item 3567"), "pending", "待开工登记条目不得显示已完成/推进中");
	assert.equal(byId.get("Item 3568"), "pending", "待拍口径的登记条目应为待办");
	assert.equal(byId.get("Item 3566"), "fixing", "🔧 + 未完成 应为修复中");
	assert.equal(byId.get("Item 3554"), "fixing", "🔧 + 实现完成判定在飞 不得被正文完成覆盖");
	assert.equal(byId.get("Item 3552"), "completed", "✅ 应为已完成");
	assert.equal(byId.get("Item 3558"), "pending", "⏸ 挂起应为待办");
	assert.equal(byId.get("Item 1"), "active", "📋 且无待办语义才为推进中");
	assert.equal(byId.get("Item 2"), "warning", "⚠️ 应为有阻塞");
	assert.equal(byId.has("Item 000"), false, "Maintenance Rules 里的伪条目不得被解析");
});

// ── 2. 英文 Status 字段 + 全角冒号 ───────────────────────────────
withFixture(`## Active Tasks

### Item 65 — async 面板修复
- **Status**: ✅ 已落 commit

### Item 64 — steer
- **Status**：active（待实测）

### Item 63 — audit
- **Status**: done
`, (tasks) => {
	const byId = new Map(tasks.map((t) => [t.id, t.status]));
	assert.equal(byId.get("Item 65"), "completed", "英文 Status + ✅ 应为已完成");
	assert.equal(byId.get("Item 64"), "active", "英文 Status + 全角冒号 + active 应为推进中");
	assert.equal(byId.get("Item 63"), "completed", "英文 done 应为已完成");
});

// ── 3. 无 emoji 时的正文兜底与否定词 ─────────────────────────────
withFixture(`## Active Tasks

### Item 3 — 纯文本完成
- **状态**: 已完成

### Item 4 — 纯文本未完成
- **状态**: 未完成

### Item 5 — 未来时
- **状态**: 待 3566 完成后开工
`, (tasks) => {
	const byId = new Map(tasks.map((t) => [t.id, t.status]));
	assert.equal(byId.get("Item 3"), "completed");
	assert.equal(byId.get("Item 4"), "pending", "未完成不得算已完成");
	assert.equal(byId.get("Item 5"), "pending", "完成后开工是未来时");
});

console.log("✓ recentwork-parser: emoji 优先级 / 英文 Status / 否定词 全部通过");
