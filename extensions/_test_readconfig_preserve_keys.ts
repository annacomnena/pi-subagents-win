/**
 * _test_readconfig_preserve_keys.ts — 修 1 的**最小针对性验证**（2026-10-13）
 *
 * 背景：`extensions/index.ts` 的 `readConfig()` 此前只返回 7 个枚举键的新对象，而
 * `writeConfig()` 是 `JSON.stringify(cfg)` 整对象覆写 ⇒ 任何一次写配置都会抹掉未枚举的
 * 真实顶层键 `gui`（/gui on 的 autoStart）、`channels`（微信通道）、`autonomy`（唤醒环）。
 *
 * 本脚本只做一件事（真实验证，非 mock readConfig 逻辑）：
 *   1. 备份包根真实 config.json 字节；
 *   2. 写入含未枚举键（gui/channels/autonomy/keepTop/unknownSlice）+ 无 masterSuccession 的夹具；
 *   3. `await import("./index.ts")` 注册真实命令，执行 `/master-succession on`
 *      —— 该路径 = readConfig() → 改切片 → writeConfig()（全仓 writeConfig 调用点的最小代表）；
 *   4. 断言写盘后未枚举顶层键**逐字节保留**，且目标切片确实写入；
 *   5. finally 恢复备份字节（真实配置零残留）。
 *
 * 运行（无需 package.json 脚本）：
 *   node --experimental-strip-types --import ./extensions/runtime-host/pi-deps-loader.mjs \
 *     ./extensions/_test_readconfig_preserve_keys.ts
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const testDir = dirname(fileURLToPath(import.meta.url));
const cfgPath = join(testDir, "..", "config.json");
const backup = existsSync(cfgPath) ? readFileSync(cfgPath, "utf8") : null;

/** 未枚举顶层键夹具：真实 config.json 的 gui/channels/autonomy + roleTier + 两个纯未知键。 */
const KEPT: Record<string, unknown> = {
	gui: { autoStart: true, x: 1 },
	channels: { wechat: { enabled: false }, email: { enabled: true } },
	autonomy: { enabled: true, other: "kept" },
	roleTier: { planner: { min: "standard", max: "premium" }, searcher: { min: "free", max: "cheap" } },
	keepTop: "me",
	unknownSlice: { a: [1, 2, 3], nested: { b: null } },
};

// 身份环境隔离：factory 以主会话执行（同 _test_runtime_master_auto.ts）
const savedTab = process.env.PI_TAB_RUN_ID;
const savedSub = process.env.PI_SUBAGENT;
const savedProf = process.env.PI_SESSION_PROFILE;
delete process.env.PI_TAB_RUN_ID;
delete process.env.PI_SUBAGENT;
delete process.env.PI_SESSION_PROFILE;

const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
const fakePi = {
	registerTool: () => {},
	registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
		commands.set(name, def.handler);
	},
	registerFlag: () => {},
	on: () => {},
	getFlag: () => "",
	sendUserMessage: () => {},
	sendMessage: () => {},
	exec: () => {},
} as unknown as ExtensionAPI;

let code = 1;
try {
	// 夹具：未枚举键 + 缺 masterSuccession 切片（走 normalizeMasterSuccession 补缺省路径）。
	writeFileSync(cfgPath, JSON.stringify(KEPT, null, 2) + "\n", "utf8");

	const indexMod = await import("./index.ts");
	await indexMod.default(fakePi);
	const handler = commands.get("master-succession");
	assert.ok(handler, "/master-succession 已注册");

	await handler("on", { hasUI: true, ui: { notify: () => {} } });

	const after = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
	for (const k of Object.keys(KEPT)) {
		assert.deepEqual(after[k], KEPT[k], `未枚举顶层键 ${k} 必须在 writeConfig 后保留`);
	}
	assert.equal((after.masterSuccession as { enabled: boolean }).enabled, true, "目标切片已写入 enabled=true");
	// readConfig 会给缺失的枚举键补缺省（models 等），故不断言键集合相等，只断言夹具键零丢失。
	for (const k of Object.keys(KEPT)) assert.ok(k in after, `夹具键 ${k} 不得丢失`);
	assert.ok("masterSuccession" in after, "目标切片已写入");
	console.log(`[readconfig-preserve-keys] ALL PASS（保留键：${Object.keys(KEPT).join("/")}）`);
	code = 0;
} catch (err) {
	console.error("[readconfig-preserve-keys] FAIL:", err instanceof Error ? err.stack ?? err.message : String(err));
} finally {
	// 恢复真实配置原字节（含 CRLF 原样）。
	if (backup !== null) writeFileSync(cfgPath, backup);
	if (savedTab === undefined) delete process.env.PI_TAB_RUN_ID; else process.env.PI_TAB_RUN_ID = savedTab;
	if (savedSub === undefined) delete process.env.PI_SUBAGENT; else process.env.PI_SUBAGENT = savedSub;
	if (savedProf === undefined) delete process.env.PI_SESSION_PROFILE; else process.env.PI_SESSION_PROFILE = savedProf;
	process.exit(code);
}
