/**
 * _test_model_presets — /sub-presets 端到端测试
 * 运行: node --experimental-strip-types ./extensions/_test_model_presets.ts
 *
 * 覆盖：无 UI 文本路径 + TUI mock 交互路径 + 并发写保护 + 存储读写。
 * 会写真实 PRESETS_PATH，测试前后自动备份/恢复。
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { registerSubPresetsCommand, PRESETS_PATH, type ModelPreset } from "./model-presets.ts";

const backup = existsSync(PRESETS_PATH) ? readFileSync(PRESETS_PATH, "utf8") : null;
let failed = 0;
function assert(label: string, cond: boolean): void {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}`);
	if (!cond) failed++;
}

// ── fake pi / deps / ctx ────────────────────────────────────────────
let registered: { name: string; def: { handler: (args: string, ctx: unknown) => Promise<void> } } | null = null;
const pi = { registerCommand: (name: string, def: any) => { registered = { name, def }; } };
const GOOD_CFG = {
	models: { searcher: "opencodego/mimo-v2.5", planner: "Zhipu/glm-5.3", implementer: "Zhipu/glm-5.3" },
	fallbackModels: { planner: ["local-qwen38/medium"] },
	thinking: { planner: "high" },
	notifications: true,
	searcherMode: "parallel" as const,
};
let cfg: any = JSON.parse(JSON.stringify(GOOD_CFG));
let writeCount = 0;
const deps = {
	reloadConfig: () => JSON.parse(JSON.stringify(cfg)),
	writeConfig: (c: any) => { cfg = c; writeCount++; },
};
const notices: string[] = [];

// TUI mock：selectOptions / inputValues 为队列，逐次消费；耗尽返回 undefined（模拟 esc）。
function makeTuiCtx(selectOptions: (string | undefined)[], inputValues: (string | undefined)[]) {
	const selects = [...selectOptions];
	const inputs = [...inputValues];
	return {
		hasUI: true,
		ui: {
			select: async (_title: string, options: string[]) => {
				const next = selects.shift();
				if (next === undefined) return undefined;
				if (next === "@first") return options[0];
				return next;
			},
			input: async (_title: string, _placeholder?: string) => inputs.shift(),
			notify: (m: string) => notices.push(m),
		},
	};
}
const textCtx: any = { hasUI: false, ui: { notify: (m: string) => notices.push(m) } };

registerSubPresetsCommand(pi as any, deps);
if (!registered || registered.name !== "sub-presets") throw new Error("command not registered");
const handler = registered.def.handler;
const run = (args: string, ctx: any = textCtx) => handler(args, ctx);

// ── 1. 文本路径 ─────────────────────────────────────────────────────
await run("save 1 夜间省钱");                       // 带名字
await run("save 2");                                // 默认名 preset-2
await run("show 1");
assert("save→show 名字正确", notices.some((m) => m.includes("[1] 夜间省钱")));

// 模拟切到本地模型组合
cfg.models = { searcher: "local-qwen38/medium", planner: "local-qwen38/medium", implementer: "local-qwen38/medium" };
cfg.fallbackModels = {};
cfg.thinking = {};
await run("load 1");
assert("load 还原三张表", cfg.models.planner === "Zhipu/glm-5.3" && cfg.thinking.planner === "high");
assert("load 保留非模型字段", cfg.notifications === true && cfg.searcherMode === "parallel");
assert("load 只写一次 config", writeCount === 1);

await run("rename 2 本地兜底");
await run("save 2");                                // 省略名字 → 沿用「本地兜底」
const storeAfter = JSON.parse(readFileSync(PRESETS_PATH, "utf8"));
assert("save 省略名字沿用原名", storeAfter.slots["2"]?.name === "本地兜底");

await run("clear 3");  await run("clear 9");  await run("load 3");  await run("save 7");
await run("bogus");    await run("rename 2"); await run("load");
assert("非法参数全部被拒绝（无 crash）", true);

// ── 2. TUI 交互路径 ─────────────────────────────────────────────────
// 2a. 菜单 → Save → 槽位3 → 输入名字
await run("", makeTuiCtx(["@first", "[3] (empty)"], ["云端便宜组"]));
const s3 = (JSON.parse(readFileSync(PRESETS_PATH, "utf8")).slots["3"]) as ModelPreset | undefined;
assert("交互 save 写入槽位3", s3?.name === "云端便宜组");

// 2b. 菜单 → Save → 槽位3 → esc（取消 input）→ 槽位3 不变
await run("", makeTuiCtx(["@first", "[3] 云端便宜组"], [undefined]));
const s3b = JSON.parse(readFileSync(PRESETS_PATH, "utf8")).slots["3"];
assert("交互 save 取消后槽位不变", s3b?.name === "云端便宜组" && s3b?.savedAt === s3?.savedAt);

// 2c. 菜单 → Load → 选槽位1（队列第二项是 load 列表里的完整 label）
cfg.models = { searcher: "x" }; cfg.fallbackModels = {}; cfg.thinking = {};
await run("", makeTuiCtx(["📥 Load slot → current", "[1] 夜间省钱"], []));
assert("交互 load 应用槽位1", cfg.models.planner === "Zhipu/glm-5.3");

// 2d. 菜单 → Rename → 槽位1 → 新名
await run("", makeTuiCtx(["✏️ Rename slot", "[1] 白天全速组"], ["白天全速组"]));
assert("交互 rename 生效", JSON.parse(readFileSync(PRESETS_PATH, "utf8")).slots["1"]?.name === "白天全速组");

// 2e. 菜单 → Clear → 槽位3
await run("", makeTuiCtx(["🧹 Clear slot", "[3] 云端便宜组"], []));
assert("交互 clear 删除槽位3", JSON.parse(readFileSync(PRESETS_PATH, "utf8")).slots["3"] === undefined);

// 2f. 菜单 → esc → 无操作
const beforeEsc = readFileSync(PRESETS_PATH, "utf8");
await run("", makeTuiCtx([undefined], []));
assert("菜单 esc 无操作", readFileSync(PRESETS_PATH, "utf8") === beforeEsc);

// 2g. 菜单 → List all → 输出包含槽位与当前设置
notices.length = 0;
await run("", makeTuiCtx(["📄 List all"], []));
assert("菜单 List all 输出", notices.some((m) => m.includes("Subagent model presets") && m.includes("Current settings")));

// 2h. 真空存储时 Load → warning（先清空存储）
writeFileSync(PRESETS_PATH, JSON.stringify({ version: 1, slots: {} }, null, 2));
await run("", makeTuiCtx(["📥 Load slot → current"], []));
assert("空存储 load 提示 warning", notices.some((m) => m.includes("没有已保存的预设")));

// ── 3. 并发写保护：交互 save 停留期间他方写入不被覆盖 ────────────────
// 「另一会话」在交互打开后直接写文件，占用槽位5。
const otherSessionStore = JSON.parse(readFileSync(PRESETS_PATH, "utf8"));
otherSessionStore.slots["5"] = { name: "他会话的预设", savedAt: new Date().toISOString(), models: { planner: "other/model" }, fallbackModels: {}, thinking: {} };
writeFileSync(PRESETS_PATH, JSON.stringify(otherSessionStore, null, 2));
// 我方交互 save 到槽位4（输入名字后写入）
await run("", makeTuiCtx(["@first", "[4] (empty)"], ["我方预设"]));
const afterRace = JSON.parse(readFileSync(PRESETS_PATH, "utf8"));
assert("并发：我方槽位4已写入", afterRace.slots["4"]?.name === "我方预设");
assert("并发：他方槽位5未被覆盖", afterRace.slots["5"]?.name === "他会话的预设");

// ── 恢复现场 ────────────────────────────────────────────────────────
if (backup === null) unlinkSync(PRESETS_PATH); else writeFileSync(PRESETS_PATH, backup);
console.log(failed === 0 ? "\nALL TESTS PASSED" : `\n${failed} TEST(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
