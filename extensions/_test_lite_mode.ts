/**
 * _test_lite_mode — /lite 命令 + litePromptLines 注入段测试
 * 运行: node --experimental-strip-types ./extensions/_test_lite_mode.ts
 *
 * 覆盖：命令注册 / 三态写入与状态显示 / 非法参数不改动 /
 *       litePromptLines 纯函数（off 零注入、on/auto 内容、档位投影、缺模型降级）。
 * 不触碰真实 config.json（deps 全部内存注入）。
 */
import { registerLiteCommand, litePromptLines, liteTiers, normalizeLiteMode, type LiteConfigLike } from "./lite-mode.ts";

let failed = 0;
function assert(label: string, cond: boolean): void {
	console.log(`${cond ? "PASS" : "FAIL"} ${label}`);
	if (!cond) failed++;
}

// ── fake pi / deps / ctx ────────────────────────────────────────────

let registered: { name: string; def: { handler: (args: string, ctx: any) => Promise<void> } } | null = null;
const pi = { registerCommand: (name: string, def: any) => { registered = { name, def }; } };

// review 修正（Luna regression）：测试可能在子 agent 进程内运行（PI_SUBAGENT=1），
// 此时 /lite 的 capability guard 会正确拒绝。测试关注 handler 逻辑本身，先清身份环境。
delete (process.env as Record<string, string | undefined>).PI_SUBAGENT;
delete (process.env as Record<string, string | undefined>).PI_SESSION_PROFILE;

const BASE_CFG: LiteConfigLike & Record<string, unknown> = {
	models: {
		searcher: "agens/agnes-3.0-flash",
		planner: "Zhipu/glm-5.3",
		implementer: "opencodego/omen-alpha",
		"code-reviewer": "openai-codex/gpt-5.6-luna",
		consultant: "openai-codex/gpt-5.6-terra",
	},
	fallbackModels: {},
	thinking: {},
	notifications: true,
	searcherMode: "serial",
	liteMode: "off",
};
let cfg: any = JSON.parse(JSON.stringify(BASE_CFG));
let writeCount = 0;
const deps = {
	reloadConfig: () => JSON.parse(JSON.stringify(cfg)),
	writeConfig: (c: any) => { cfg = JSON.parse(JSON.stringify(c)); writeCount++; },
};
const notices: string[] = [];
const ctx = { hasUI: false, ui: { notify: (m: string) => notices.push(m) } };

async function run(args: string): Promise<void> {
	if (!registered) throw new Error("command not registered");
	await registered.def.handler(args, ctx);
}

// ── litePromptLines 纯函数 ─────────────────────────────────────────

const onCfg = { ...JSON.parse(JSON.stringify(BASE_CFG)), liteMode: "on" };
const autoCfg = { ...JSON.parse(JSON.stringify(BASE_CFG)), liteMode: "auto" };

assert("off → 零注入", litePromptLines({ ...onCfg, liteMode: "off" }).length === 0);
assert("缺 liteMode 键 → 零注入", litePromptLines({ models: BASE_CFG.models as any }).length === 0);
assert("垃圾值 → 视为 off", litePromptLines({ ...onCfg, liteMode: "yes" }).length === 0);

const onLines = litePromptLines(onCfg);
assert("on → 4 行", onLines.length === 4);
assert("on 首行声明", onLines[0].includes("Lite workflow mode: ON"));
assert("链段含 general", onLines[1].includes('agent="general"'));
assert("链段不写死模型（编排自选）", !onLines[1].includes("agens/agnes-3.0-flash") && !onLines[1].includes("opencodego/omen-alpha") && !onLines[1].includes("openai-codex/gpt-5.6-terra"));
assert("链段声明编排自选", onLines[1].includes("自行选择") && onLines[1].includes("禁止写死模型"));
assert("纪律段含 async-default", onLines[2].includes("默认派 async 非阻塞"));
assert("纪律段含落盘交接", onLines[2].includes(">30 行"));
assert("纪律段含独立审查", onLines[2].includes("交 git diff"));
assert("纪律段含升级线", onLines[2].includes("launch-tabs"));
assert("边界段豁免任务 tab", onLines[3].includes("根据workflow/research/execute/adaptive进行工作"));
assert("边界段允许单次覆盖", onLines[3].includes("这次走完整链"));

const autoLines = litePromptLines(autoCfg);
assert("auto → 5 行（判据+全量纪律）", autoLines.length === 5);
assert("auto 首行声明", autoLines[0].includes("Lite workflow mode: AUTO"));
assert("auto 含判据段", autoLines[1].includes("[lite 判据]"));
assert("auto 含同款纪律", autoLines[2] === onLines[1] && autoLines[3] === onLines[2]);

// 缺模型也不影响链段（链段不再引用具体模型；liteTiers 只供 /lite 展示）
const missing = litePromptLines({ liteMode: "on", models: { planner: "Zhipu/glm-5.3" } });
assert("缺模型链段仍完整", missing[1].includes('agent="general"') && missing[1].includes("自行选择"));

// liteTiers / normalizeLiteMode 直接导出
assert("liteTiers 投影", liteTiers(BASE_CFG.models as any).medium === "opencodego/omen-alpha");
assert("normalizeLiteMode", normalizeLiteMode("auto") === "auto" && normalizeLiteMode("off") === "off" && normalizeLiteMode(42 as any) === "off");

// ── /lite 命令 ─────────────────────────────────────────────────────

registerLiteCommand(pi as any, deps);
assert("注册命令名 = lite", registered?.name === "lite");

await run("on");
assert("/lite on 写入", cfg.liteMode === "on");
assert("/lite on 只写一次", writeCount === 1);
assert("其它配置键保留", cfg.searcherMode === "serial" && cfg.models.consultant === "openai-codex/gpt-5.6-terra");
assert("/lite on 通知确认", notices[0].includes("on"));

await run("auto");
assert("/lite auto 写入", cfg.liteMode === "auto");

await run("off");
assert("/lite off 写入", cfg.liteMode === "off");

const beforeBogus = JSON.stringify(cfg);
await run("bogus");
assert("非法参数不改配置", JSON.stringify(cfg) === beforeBogus && writeCount === 3);
assert("非法参数落到状态显示", notices[notices.length - 1].includes("用法：/lite on | off | auto"));

notices.length = 0;
await run("");
assert("无参显示当前模式", notices[0].includes("当前 lite 模式"));
assert("无参显示档位映射", notices[0].includes("small") && notices[0].includes("agens/agnes-3.0-flash") && notices[0].includes("large"));

console.log(failed === 0 ? "\nAll lite-mode tests passed." : `\n${failed} test(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
