// 用**已安装**的 pi 包复算 P3：ExtensionAPI.sendUserMessage 的返回值语义。
//
// 证据来源分类（2026-10-16 重新定源，global Master 指令）：
//   (A) 自证实测（**承重**）：本探针 + `extensions/_test_p3_provenance.ts`（断言式，逐条带 file:line），
//       直接读本机已安装 pi 包源码；不依赖任何第三方报告。
//   (B) 旁证（**弱档，未采信**）：异 provider（krill/grok-4.5）报告——该 provider 已被用户删除
//       （理由：模型不可用）⇒ 其结论一律降级为未验证；其主张已由 (A) 逐条独立复现。
// 结论承重依据 = (A)；grok 报告不得单独引用为证据。
// 断言版：`npm run test:p3-provenance`。
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const PI = "C:/nvm4w/nodejs/node_modules/@earendil-works/pi-coding-agent";

// ① 源码事实：loader.js（extension 实际拿到的 API）是否 return 底层 promise
const loaderSrc = readFileSync(`${PI}/dist/core/extensions/loader.js`, "utf8");
const lm = /sendUserMessage\(content, options\) \{\s*([\s\S]{0,220}?)\n\s{8}\}/.exec(loaderSrc);
const loaderBody = lm ? lm[1] : "NOT FOUND";
console.log("=== loader.js sendUserMessage body ===");
console.log(loaderBody.trim());
console.log("loader 有 return:", /\breturn\b/.test(loaderBody));

// ② 源码事实：agent-session.js wrapper（bindCore 注入 runtime 的那一级）
const asSrc = readFileSync(`${PI}/dist/core/agent-session.js`, "utf8");
const i = asSrc.indexOf("sendUserMessage: (content, options) => {");
const wrapperBody = asSrc.slice(i, i + 300);
console.log("\n=== agent-session.js wrapper body ===");
console.log(wrapperBody.trim());
console.log("wrapper 有 return:", /\breturn\b/.test(wrapperBody.split("\n").slice(0, 4).join("\n")));

// ③ 模拟两级链：底层 reject 时，调用方（extension）到底看到什么
const underlying = () => Promise.reject(new Error("Agent is already processing a prompt."));
const wrapper = (c, o) => { underlying(c, o).catch(() => { /* emitError */ }); }; // agent-session:2644 语义
const loaderApi = { sendUserMessage: (c, o) => { wrapper(c, o); } };              // loader:295 语义
const ret = loaderApi.sendUserMessage("x", { deliverAs: "followUp" });
console.log("\n=== 两级链返回值视角 ===");
console.log("ret =", ret, "| typeof =", typeof ret);
console.log("P3（返回值视角）:", ret === undefined ? "CONFIRMED — 底层 reject 时调用方只见 undefined" : "NOT CONFIRMED");

// ④ 反面证据核对：deliverAs 会映射到 streamingBehavior ⇒ busy 分支不触发（只有没传时才抛）
const l1804 = asSrc.split("\n")[1803];
console.log("\n=== 反面证据（防过度修）===");
console.log("agent-session.js:1804 ⇒", l1804.trim());
console.log("⇒ 我们总是传 deliverAs:'followUp'，busy 抛错分支（:1485）对本调用点不适用；");
console.log("  但 compaction（:1468）与 wrapper 不 return 的事实仍成立。");

// ⑤ 类型声明对照
const dts = readFileSync(`${PI}/dist/core/agent-session.d.ts`, "utf8");
console.log("\n=== 类型声明 ===");
console.log("d.ts 声明 sendUserMessage 返回 Promise<void>:", /sendUserMessage\([\s\S]{0,300}?\): Promise<void>/.test(dts));

// ⑥ 载入 loader 模块确认它可导入（只读校验，不注册）
try {
	const mod = await import(pathToFileURL(`${PI}/dist/core/extensions/loader.js`).href);
	console.log("\nloader 模块可导入:", Object.keys(mod).join(","));
} catch (e) {
	console.log("\nloader 导入失败（不影响结论）:", String(e.message).slice(0, 120));
}
