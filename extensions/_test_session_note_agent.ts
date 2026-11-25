/**
 * _test_session_note_agent.ts — agent 侧 note 工具与脏时注入的**接线**断言（P4 / §8.1b）。
 *
 * 真值表本身在 _test_session_note.ts（decideNoteInjection，node 直载）；
 * 本文件盯「纯函数有没有接到真 handler」：注册行、静态 sections、压缩重注、乐观锁强制。
 * 变异注册行必须红（AGENTS.md §4.2）。
 *
 * 运行：npm run test:session-note-agent
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
let n = 0;
const ok = (msg: string): void => { n += 1; console.log(`ok ${n} - ${msg}`); };

assert.ok(code.includes('name: "note_read"') && code.includes('name: "note_write"'),
	"两个工具必须真的注册（变异删注册行 ⇒ 本行红）");
ok("1. note_read / note_write 工具注册行存在");

assert.ok(code.includes('typeof params.expectedVersion !== "number"'), "expectedVersion 必填校验存在");
assert.ok(code.includes("禁止无版本裸写"), "description/错误文案明确禁止裸写");
assert.ok(code.includes('mode === "append" ? "append" : "replace"'), "append / replace 双模式接线");
assert.ok(code.includes("<!-- agent ${new Date().toISOString()} -->"), "append 小节带时间戳");
ok("2. 乐观锁强制 + append 时间戳小节");

// 独立 handler：不能并进既有 config handler（那个对 trace-worker 提前 return 且自己返回 message）
assert.ok(code.includes('pi.on("before_agent_start", async (event, ctx) => {'), "独立 before_agent_start handler 注册");
assert.ok(code.includes("composeNoteInjection(r.note, injected.version, undefined, injected.fingerprint)"),
	"完整组合判定接到真 handler（可执行，不只源码串）");
assert.ok(code.includes("if (message === null) return;"), "干净时 return undefined（零新增 token）");
assert.ok(code.includes("markNoteInjected(ctx as never, r.note.version, noteFingerprint(r.note.text))"),
	"注入成功后写 state entry + 正文指纹（指纹判脏的关键接线）");
ok("3. 脏时注入接线：独立 handler → 纯函数 → message/state+指纹");

assert.ok(code.includes('opts.sections["session-note-authority"] = NOTE_AUTHORITY_SECTION'),
	"静态声明挂到 sections（Pi diff：恒定文本零 patch，保 prompt cache）");
assert.ok(!code.includes("forceSystemPrompt"), "禁止整提示符替换（每次变化都 cache miss）");
assert.ok(!/opts\.sections\[[^\]]+\]\s*=\s*`[^`]*\$\{/.test(code), "sections 声明不得拼时间戳等动态内容");
ok("4. 静态 sections 声明恒定（不破坏缓存）");

assert.ok(code.includes('pi.on("session_compact", (_event, ctx) => { markNoteInjected(ctx as never, -1); });'),
	"压缩后 state 写 -1 ⇒ 下轮强制重注");
assert.ok(code.includes("for (let i = entries.length - 1; i >= 0; i--)"), "取最后一条 state entry（append-only 历史）");
ok("5. 压缩重注 + 最新 state entry 判据");

// F1 修复回证：子 agent 门必须在所有 note 注入（含静态 sections）之前。
const start = code.indexOf('pi.on("before_agent_start", async (event, ctx) => {');
const gate = code.indexOf("if (isSubagent()) return;", start);
const section = code.indexOf('opts.sections["session-note-authority"] = NOTE_AUTHORITY_SECTION', start);
assert.ok(start > 0 && gate > start && section > gate,
	"§1.4：子 agent 门先于静态 sections（否则被禁工具却看到『请调 note_read』）");
ok("6. 子 agent 不注入静态 sections 的顺序断言");

// 纯库侧：静态声明恒定 + 两条注入版本头递增（时间戳可判定新旧）
const lib = await import("./session-note.ts");
const base = lib.NOTE_AUTHORITY_SECTION;
assert.equal(typeof base, "string");
assert.ok(base.includes("以时间戳最新的一条为唯一现行版本"));
assert.equal(lib.NOTE_AUTHORITY_SECTION, base, "多轮读取恒定（静态文本，不随 note 变）");
const note = { schemaVersion: 1 as const, sessionId: "d3e4f5a6-b7c8-4d9e-0f1a-2b3c4d5e6f70", text: "## 给 agent 的规则\n- 先 build", updatedAt: "2026-11-17T08:00:00.000Z", version: 7 };
const h1 = lib.buildNoteInjectionContent(note, () => new Date("2026-11-17T09:00:00.000Z"));
const h2 = lib.buildNoteInjectionContent({ ...note, version: 8 }, () => new Date("2026-11-17T10:00:00.000Z"));
assert.ok(h1.startsWith("### 会话便签（session-note）\nv7 · 2026-11-17T09:00:00.000Z"));
assert.ok(h2.startsWith("### 会话便签（session-note）\nv8 · 2026-11-17T10:00:00.000Z"));
assert.ok(h2.split("\n")[1]! > h1.split("\n")[1]!, "版本头递增 ⇒ agent 能按静态规则挑最新");
ok("7. 静态声明恒定 + 注入版本头可判新旧");

// F2 修复回证：handler 的组合判定现在是可执行的纯函数，覆盖「干净 / 变更 / 清空」全套分支。
//变异：把 composeNoteInjection 写成「干净也返回 message」⇒ 第 1 行红；写反 inject 判断 ⇒ 第 2 行红。
const makeNote = (version: number, text: string) => ({ ...note, version, text });
assert.equal(lib.composeNoteInjection(makeNote(3, "## 给 agent 的规则\n- x"), 3), null, "干净 ⇒ 不注入");
const changed = lib.composeNoteInjection(makeNote(4, "## 给 agent 的规则\n- x"), 3);
assert.ok(changed !== null && changed.customType === "session-note" && changed.display === true);
assert.ok(changed.content.startsWith("### 会话便签（session-note）\nv4 · "), "变更 ⇒ 带版本头注入");
const cleared = lib.composeNoteInjection(makeNote(5, ""), 4);
assert.ok(cleared !== null && cleared.content.includes("便签已清空"), "清空 ⇒ tombstone（旧规则不能冒充现行）");
assert.equal(lib.composeNoteInjection(makeNote(0, ""), null), null, "从未写过 ⇒ 零消息（G3）");
// 本次真缺陷的可执行回证：version 空转但正文没变 ⇒ 不注入
const stableText = "## 给 agent 的规则\n- 一条没变";
const stableFp = lib.noteFingerprint(stableText);
assert.equal(lib.composeNoteInjection(makeNote(10, stableText), 9, undefined, stableFp), null,
	"version 空转+指纹相同 ⇒ 不注入（不重复刷屏）");
assert.ok(lib.composeNoteInjection(makeNote(11, stableText + "\n- 新"), 10, undefined, stableFp) !== null,
	"内容真变 ⇒ 注入");
ok("8. composeNoteInjection 可执行真值表（干净/变更/清空/从未写过/指纹防重复）");

console.log(`\n[session-note-agent] ${n} passed`);
