/**
 * _test_session_note_tui.ts — TUI 侧 note 入口的**接线**断言（设计稿 §8.3 / P3）。
 *
 * 本仓无 TUI DOM 测试框架；命令/widget 的真实入口是 `pi.registerCommand` 与
 * `pi.on("session_start")` 的**注册行**。纯源码断言能抓住「函数写了但没注册」
 * 这一类真实事故（AGENTS.md §4.2：变异必须打接线）。
 *
 * 运行：npm run test:session-note-tui
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
let n = 0;
const ok = (msg: string): void => { n += 1; console.log(`ok ${n} - ${msg}`); };

assert.ok(code.includes('pi.registerCommand("note", {'), "note 命令必须真的注册（变异删注册行 ⇒ 本行红）");
ok("1. /note 命令注册行存在");

assert.ok(code.includes('pi.on("session_start", (_event, ctx) => { refreshNoteWidget(ctx as any); });'),
	"session_start 必须接上 widget 刷新（否则 widget 永不出现）");
assert.ok(code.includes("ctx.ui?.setWidget?.(NOTE_WIDGET_KEY"), "widget 真的挂到 ui.setWidget");
ok("2. widget 注册：session_start → setWidget");

assert.ok(code.includes("new MouseRegion(new LiveNoteText(sid)"), "按钮用 MouseRegion 包实时刷新组件");
assert.ok(code.includes('event.type === "click" && event.button === "left"'), "只响应左键 click");
assert.ok(code.includes("void openNoteEditor(ctx)"), "handler 同步返回，IO 走 void async（不做长 IO）");
assert.ok(code.includes("return { handled: true };"), "点击必须吞掉事件，避免继续滚动/选择");
ok("3. 鼠标按钮：左键 click → 打开编辑器，且事件被 handled");

// 2026-11-18「widget 永远为空」回归：摘要必须在 render() 里实时读盘，不能构造时算死。
assert.ok(code.includes("override render(width: number): string[]"), "LiveNoteText 必须覆写 render");
assert.ok(code.includes("this.setText(liveNoteSummary(this.sid))"), "render 内实时读盘 → 任意端写入后重绘即刷新");
assert.ok(!code.includes("new Text(label, 0, 0)"), "不得再用构造时算好的死 label（旧缺陷原形）");
assert.ok(code.includes('pi.on("agent_end", (_event, ctx) => { refreshNoteWidget(ctx as any); });'),
	"agent_end 必须兜底重挂，保证写完 note 后即使无其它重绘也刷新（变异删此行 ⇒ 红）");
ok("6. 实时刷新：render 读盘 + agent_end 兜底（修「永远为空」）");

assert.ok(code.includes('ctx.mode !== "tui"'), "非 TUI 模式降级 notify 而不是崩");
assert.ok(code.includes("/note: 子 agent 会话不可操作主会话便签"), "子 agent 会话禁用（避免写串 sid）");
ok("4. 键盘兜底路径与子 agent 护栏存在");

assert.ok(code.includes("writeSessionNote(sid, edited, { expectedVersion: current.note.version })"), "保存走共享库 + 乐观锁");
const sharedLib = readFileSync(new URL("./session-note.ts", import.meta.url), "utf8");
assert.ok(sharedLib.includes("📝 Note:") && sharedLib.includes("⚠ Note 读取失败"),
	"摘要/告警文案在共享库 liveNoteSummary 中常驻显示（R-2 不静默）");
assert.ok(src.includes("只有全屏模式") && src.includes("/note` 键盘命令是唯一在所有终端都可用的入口"),
	"硬约束写进代码注释（普通终端鼠标不可路由；注释断言用原文，不用 codeOnly）");
ok("5. 保存/摘要/读取失败可见性 + 终端限制注释到位");

console.log(`\n[session-note-tui] ${n} passed`);
