/**
 * _test_p3_provenance.ts — P3 证据「重新定源」自证测试（grok 弱档降级后的承重依据）
 *
 * ## 为什么要这个文件（2026-10-16，global Master 指令）
 * 先前采纳 P3（`sent` 假阳性）时，证据来源里混有 **异 provider（krill/grok-4.5）报告**——
 * 用户已删除该 provider（理由：模型不可用）⇒ 来自它的结论**一律降级为未验证**。
 * 因此把「承重证据」**重新定源为自证实测**：本文件直接读**本机已安装**的 pi 包源码，
 * 对每条承重断言做**断言式**自证；不依赖任何第三方报告。
 *
 * 区分（必须保持）：
 *   (A) **自证实测（承重）**：本文件 + `scripts/_probe_p3_senduser_message.mjs` 的实测；
 *   (B) **旁证（弱档，未采信）**：grok 报告的主张 —— 本文件对其逐条**独立复现**，
 *       复现成功也只记为「已被自证覆盖」，不记为「采信第三方」。
 *
 * ## 承重断言（全部来自本机已安装 pi 包源码）
 *   1. `dist/core/extensions/loader.js` 的 `sendUserMessage(content, options)`
 *      **不 return** `runtime.sendUserMessage(...)` —— extension 工厂拿到的那一级；
 *   2. `dist/core/agent-session.js` 的 `sendUserMessage: (content, options) => {…}` wrapper
 *      **不 return** 底层 Promise，只 `.catch(err => runner.emitError(…))`；
 *   3. ⇒ 两级都不 return ⇒ **生产 `pi.sendUserMessage()` 恒返回 `undefined`**（返回值不可作送达证据）；
 *   4. 底层**确实会 reject**：streaming 且未传 `streamingBehavior` ⇒ throw；
 *      compaction 进行中 ⇒ throw；
 *   5. 反面证据：传 `streamingBehavior === "followUp"` ⇒ 走 `_queueFollowUp` **正常返回**
 *      （空值/排队语义），故不得把「非 Promise 返回值」一律判死 —— 只在真 `undefined`/`null` 降级；
 *   6. `deliverAs` 映射到 `streamingBehavior`（`agent-session.js` 内 `streamingBehavior: options?.deliverAs`）；
 *   7. **唯一**返回真 Promise 的注入路径 = `createReplacedSessionContext()` 的
 *      `context.sendUserMessage = (c,o) => this.sendUserMessage(c,o)`（表达式体 ⇒ 真 Promise）；
 *   8. 类型声明写 `): Promise<void>`，**与运行时行为不符**（类型层面看不出的假阳性）。
 *
 * 运行：`npm run test:p3-provenance`
 * 找不到已安装 pi 包时打印 SKIP 并以 0 退出（不阻断无关环境）。
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CANDIDATES = [
	process.env.PI_PACKAGE_DIR,
	"C:/nvm4w/nodejs/node_modules/@earendil-works/pi-coding-agent",
	"C:/Users/Annacomnena/AppData/Local/nvm/v22.19.0/node_modules/@earendil-works/pi-coding-agent",
].filter((p): p is string => typeof p === "string" && p.length > 0);

const PKG = CANDIDATES.find((p) => existsSync(join(p, "dist", "core", "agent-session.js")));
if (!PKG) {
	// GLM-5.3 复核 nit（采纳）：结构性迁移（文件改名/搬目录）时断言会**静默消失**。
	// ⇒ 醒目 WARN；在需要硬门的场景（CI）设 `PI_P3_PROVENANCE_REQUIRED=1` 则非 0 退出。
	console.log("⚠ _test_p3_provenance: SKIP —— 未找到已安装的 @earendil-works/pi-coding-agent（断言面静默消失，非通过）");
	if (process.env.PI_P3_PROVENANCE_REQUIRED === "1") process.exit(1);
	process.exit(0);
}
// 锁定被测版本（便于事后追溯；非断言）
try {
	const pkgJson = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")) as { version?: string };
	console.log(`_test_p3_provenance: 被测包版本 = ${pkgJson.version ?? "unknown"} @ ${PKG}`);
} catch { /* 版本读取失败不影响断言 */ }

let n = 0;
const ok = (name: string): void => { n += 1; console.log(`ok ${n} - ${name}`); };

/** 自证记录（供报告引用；每条都带 file:line）。 */
const provenance: Array<{ id: string; claim: string; where: string; source: "self-verified" | "peer-weak" }> = [];
const record = (id: string, claim: string, where: string, source: "self-verified" | "peer-weak" = "self-verified"): void => {
	provenance.push({ id, claim, where, source });
};

const asSrc = readFileSync(join(PKG, "dist", "core", "agent-session.js"), "utf8");
const loaderSrc = readFileSync(join(PKG, "dist", "core", "extensions", "loader.js"), "utf8");
const dts = readFileSync(join(PKG, "dist", "core", "agent-session.d.ts"), "utf8");
const lines = asSrc.split("\n");
const lineNoOf = (needle: string, from = 0): number => {
	for (let i = from; i < lines.length; i += 1) if (lines[i]!.includes(needle)) return i + 1;
	return -1;
};

// ── P1: loader.js 一级不 return ─────────────────────────────────────────
{
	const m = /sendUserMessage\(content, options\) \{\s*([\s\S]{0,200}?)\n\s{8}\}/.exec(loaderSrc);
	assert.ok(m, "loader.js 中可定位 sendUserMessage 实现");
	const body = m![1]!;
	assert.equal(/\breturn\b/.test(body), false, "**loader.js 一级不 return**（extension 实际拿到的那层）");
	assert.ok(body.includes("assertActive()"), "loader.js：先 assertActive()");
	assert.ok(body.includes("runtime.sendUserMessage(content, options)"), "loader.js：委托 runtime（返回值被丢弃）");
	const at = lineNoOf("sendUserMessage(content, options) {", 0) >= 0 ? "dist/core/extensions/loader.js:295-297" : "dist/core/extensions/loader.js";
	record("P3-1", "extension 工厂拿到的 pi.sendUserMessage 不 return（恒 undefined）", at);
	ok("P3-1 loader.js 一级不 return ⇒ 恒 undefined");
}

// ── P2: agent-session.js wrapper 不 return ─────────────────────────────
{
	const idx = asSrc.indexOf("sendUserMessage: (content, options) => {");
	assert.ok(idx > 0, "agent-session.js 中可定位 bindCore wrapper");
	const wrapper = asSrc.slice(idx, idx + 320);
	assert.equal(/^\s*return\b/m.test(wrapper.split("\n").slice(0, 3).join("\n")), false, "**wrapper 不 return 底层 Promise**");
	assert.ok(wrapper.includes(".catch((err) => {"), "wrapper 只 .catch(…)");
	assert.ok(wrapper.includes('extensionPath: "<runtime>"'), "wrapper 的 emitError 标签是 <runtime>（非某个扩展名）");
	const ln = asSrc.slice(0, idx).split("\n").length;
	record("P3-2", "bindCore wrapper 不 return 底层 Promise（底层 reject ⇒ 调用方见 undefined）", `dist/core/agent-session.js:${ln}-${ln + 8}`);
	ok("P3-2 agent-session.js wrapper 不 return（假阳性来源）");
}

// ── P3: 底层确实会 reject（两个真实分支）───────────────────────────────
{
	const busyLine = lineNoOf('throw new Error("Agent is already processing.');
	assert.ok(busyLine > 0, "存在 busy throw 分支");
	assert.ok(lines[busyLine - 2]!.includes("if (!options?.streamingBehavior)") || lines[busyLine - 3]!.includes("if (!options?.streamingBehavior)"), "busy throw 仅在**未传** streamingBehavior 时触发");
	record("P3-3", "busy：streaming 且未传 streamingBehavior ⇒ throw（真实 reject 分支）", `dist/core/agent-session.js:${busyLine}`);
	const compactLine = lineNoOf("Cannot submit a prompt while compaction is in progress");
	assert.ok(compactLine > 0, "存在 compaction throw 分支");
	record("P3-4", "compaction 进行中 ⇒ throw（真实 reject 分支）", `dist/core/agent-session.js:${compactLine}`);
	ok("P3-3/P3-4 底层两个真实 reject 分支自证");
}

// ── P4: 反面证据 —— followUp 排队路径正常返回 ──────────────────────────
{
	const q = lineNoOf('if (options.streamingBehavior === "followUp")');
	assert.ok(q > 0, "存在 followUp 排队分支");
	assert.ok(lines[q]!.includes("_queueFollowUp") || lines[q + 1]!.includes("_queueFollowUp"), "followUp ⇒ _queueFollowUp（正常返回）");
	record("P3-5", "传 deliverAs:followUp ⇒ 走排队并正常返回（故不得把所有非 Promise 返回值判死）", `dist/core/agent-session.js:${q}`);
	ok("P3-5 反面证据自证：followUp 排队正常返回");
}

// ── P5: deliverAs → streamingBehavior 映射 ─────────────────────────────
{
	const map = lineNoOf("streamingBehavior: options?.deliverAs");
	assert.ok(map > 0, "存在 deliverAs → streamingBehavior 映射");
	record("P3-6", "deliverAs 映射到 streamingBehavior（决定是否走排队分支）", `dist/core/agent-session.js:${map}`);
	ok("P3-6 deliverAs → streamingBehavior 映射自证");
}

// ── P6: 唯一返回真 Promise 的路径 = createReplacedSessionContext ───────
{
	const i = asSrc.indexOf("createReplacedSessionContext() {");
	assert.ok(i > 0, "存在 createReplacedSessionContext");
	const block = asSrc.slice(i, i + 400);
	assert.ok(/context\.sendUserMessage = \(content, options\) => this\.sendUserMessage\(content, options\);/.test(block), "替换上下文的 sendUserMessage 是**表达式体箭头** ⇒ 返回真 Promise");
	const ln = asSrc.slice(0, i).split("\n").length;
	record("P3-7", "唯一返回真 Promise 的注入路径 = createReplacedSessionContext（对照路径）", `dist/core/agent-session.js:${ln}-${ln + 6}`);
	ok("P3-7 createReplacedSessionContext 返回真 Promise 自证（对照路径）");
}

// ── P7: 类型声明与运行时不符 ───────────────────────────────────────────
{
	assert.ok(/sendUserMessage\(content: string \| \(TextContent \| ImageContent\)\[\], options\?: \{[\s\S]{0,200}?\}\): Promise<void>;/.test(dts), "**d.ts 声明 Promise<void>**（类型层面看不出运行时假阳性）");
	const dtsLines = dts.split("\n");
	const declLine = dtsLines.findIndex((l) => l.includes("sendUserMessage(content: string")) + 1;
	const retLine = dtsLines.findIndex((l, i) => i >= declLine - 1 && l.includes("): Promise<void>;")) + 1;
	record("P3-8", "类型声明 Promise<void> 与运行时恒 undefined 不符（类型检查抓不到的假阳性）", `dist/core/agent-session.d.ts:${declLine}-${retLine}`);
	ok("P3-8 类型声明 Promise<void> 自证");
}

// ── 汇总（供报告引用；弱档来源数为 0 = 全部已自证）──────────────────────
{
	const weak = provenance.filter((p) => p.source === "peer-weak").length;
	console.log("\n=== 证据来源表（self-verified 承重；peer-weak 未采信）===");
	for (const p of provenance) console.log(`  [${p.source}] ${p.id} ${p.claim} @ ${p.where}`);
	console.log(`  self-verified=${provenance.length - weak}  peer-weak(未采信)=${weak}`);
	console.log("  外部来源：grok-4.5（krill provider，已被用户删除）报告 = **旁证弱档，未采信**；本表逐条独立复现。");
}

console.log(`\n_test_p3_provenance: all ${n} groups passed (self-verified)`);
