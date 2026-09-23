import assert from "node:assert/strict";
import { Container, Text } from "@earendil-works/pi-tui";

// Mock minimal theme
const mockTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => `**${text}**`,
};

// Import default extension or check tool registration renderResult
import extension from "./index.ts";

// Mock API for registration
let registeredTool: any = null;
const mockApi: any = {
	registerTool: (def: any) => {
		if (def.name === "subagent-win") {
			registeredTool = def;
		}
	},
	registerCommand: () => {},
	on: () => {},
};

extension(mockApi);

assert.ok(registeredTool, "subagent-win tool should be registered");
assert.ok(typeof registeredTool.renderResult === "function", "renderResult must be a function");

// 1. Test In-Flight Single Task Progress Card
{
	const partialResult = {
		content: [{ type: "text", text: "running..." }],
		details: {
			progress: {
				agent: "planner",
				model: "deepseek/deepseek-chat",
				status: "⚡ read",
				detail: "src/index.ts",
				currentTool: "read",
				currentToolDetail: "src/index.ts",
				turn: 2,
				toolCallsCount: 3,
				startedAt: Date.now() - 5500,
				elapsedMs: 5500,
				recentEvents: ["[0.0s] 子进程启动", "[2.1s] ⚡ read: src/config.ts", "[4.2s] ⚡ read: src/index.ts"],
				latestTextSnippet: "正在分析文件依赖关系并准备制定计划...",
			},
		},
	};

	const rendered = registeredTool.renderResult(partialResult, { expanded: false, isPartial: true }, mockTheme);
	assert.ok(rendered instanceof Container, "In-flight card should return a Container");
	// Check children
	const texts = rendered.children.filter((c: any) => c instanceof Text).map((c: any) => c.text);
	const joined = texts.join("\n");
	assert.ok(joined.includes("planner"), "Should contain agent name");
	assert.ok(joined.includes("deepseek/deepseek-chat"), "Should contain model");
	assert.ok(joined.includes("5.5s"), "Should contain elapsed seconds");
	assert.ok(joined.includes("⚡ read"), "Should contain current tool");
	assert.ok(joined.includes("Turn 2"), "Should contain turn info");
	assert.ok(joined.includes("工具调用 3 次"), "Should contain tool call count");
	assert.ok(joined.includes("执行轨迹:"), "Should contain timeline");
	assert.ok(joined.includes("最新输出"), "Should contain text snippet preview");
}

// 2. Test In-Flight Parallel Tasks Progress Card
{
	const partialParallel = {
		content: [{ type: "text", text: "parallel running..." }],
		details: {
			parallelProgress: {
				startedAt: Date.now() - 8200,
				elapsedMs: 8200,
				tasks: [
					{
						agent: "searcher",
						model: "deepseek/deepseek-chat",
						status: "⚡ bash",
						detail: "git status",
						currentTool: "bash",
						currentToolDetail: "git status",
						startedAt: Date.now() - 8200,
						elapsedMs: 8200,
						recentEvents: ["[1.0s] ⚡ bash: git status"],
					},
					{
						agent: "planner",
						model: "deepseek/deepseek-chat",
						status: "completed",
						detail: "完成",
						startedAt: Date.now() - 8200,
						elapsedMs: 6000,
						recentEvents: [],
					},
					{
						agent: "implementer",
						model: "deepseek/deepseek-chat",
						status: "pending",
						detail: "排队等待中...",
						startedAt: Date.now(),
						elapsedMs: 0,
						recentEvents: [],
					},
				],
			},
		},
	};

	const rendered = registeredTool.renderResult(partialParallel, { expanded: false, isPartial: true }, mockTheme);
	assert.ok(rendered instanceof Container, "In-flight parallel should return Container");
	const texts = rendered.children.filter((c: any) => c instanceof Text).map((c: any) => c.text);
	const joined = texts.join("\n");
	assert.ok(joined.includes("parallel"), "Should indicate parallel");
	assert.ok(joined.includes("1/3 完成"), "Should report completed count");
	assert.ok(joined.includes("1 运行中"), "Should report active count");
	assert.ok(joined.includes("8.2s"), "Should report total elapsed seconds");
	assert.ok(joined.includes("searcher"), "Should list task 1");
	assert.ok(joined.includes("planner"), "Should list task 2");
	assert.ok(joined.includes("implementer"), "Should list task 3");
}

// 3. Test Collapsed Completed Single Task (Extended Screen Real Estate)
{
	const completedResult = {
		content: [{ type: "text", text: "done" }],
		details: {
			result: {
				status: "completed",
				agent: "code-reviewer",
				requestedModel: "deepseek/deepseek-chat",
				durationMs: 14200,
				toolCallsCount: 5,
				usage: { input: 1200, output: 450, cost: 0.0035, turns: 3 },
				text: "## 审查结论\n代码结构良好，已遵循类型规范。\n未发现明显内存泄漏。\n测试覆盖全面。\n建议合并上线。\n(subagent-runs/run_123_full.md)",
			},
		},
	};

	const rendered = registeredTool.renderResult(completedResult, { expanded: false, isPartial: false }, mockTheme);
	assert.ok(rendered instanceof Container, "Collapsed completed result should return Container for rich screen estate");
	const texts = rendered.children.filter((c: any) => c instanceof Text).map((c: any) => c.text);
	const joined = texts.join("\n");
	assert.ok(joined.includes("took 14.2s"), "Should display took time");
	assert.ok(joined.includes("3 turns, 5 tools"), "Should display turns and tool counts");
	assert.ok(joined.includes("摘要概览:"), "Should show multi-line summary header");
	assert.ok(joined.includes("代码结构良好"), "Should display summary line 1");
	assert.ok(joined.includes("未发现明显内存泄漏"), "Should display summary line 2");
	assert.ok(joined.includes("完整报告已落盘: subagent-runs/run_123_full.md"), "Should detect and display artifact path");
	assert.ok(joined.includes("Ctrl+O"), "Should prompt Ctrl+O to expand");
}

console.log("TUI progress and screen expansion tests passed successfully!");
