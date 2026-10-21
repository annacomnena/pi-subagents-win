/**
 * _test_notify_bridge.ts — notify 桥回归门（2026-10-21）
 *
 * ## 背景
 * `ctx.ui.notify` 是 TUI-only（`types.d.ts:80`），pi 无 notification 事件钩子
 * ⇒ 本仓 137 个 notify 调用点 GUI 全看不到。典型症状：`/today-usage` 在 TUI 里输出
 * 完整用量统计，GUI 一个字都没有。
 *
 * ## 本门钉住的核心风险
 * 1. **N2 原 notify 必须照常调用** —— 桥若把 TUI 静默弄哑了，比「GUI 看不到」更糟
 * 2. **N1 不改调用点** —— 靠影子化 `pi.registerCommand` 实现，不能要求改 137 处
 * 3. **落盘失败不得阻断** notify（诊断通道永不阻断主链路）
 * 4. `ui` 其余字段（reload/compact/setModel）必须**原样透传**，否则桥会弄坏刚做的内建命令
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendNotify,
	dayKey,
	installNotifyBridge,
	makeNotifyRecord,
	notifyDir,
	notifyFilePath,
	pruneNotifyFiles,
	readNotify,
} from "./runtime/notify-bridge.ts";

let n = 0;
const ok = (m: string): void => {
	n++;
	console.log(`ok ${n} - ${m}`);
};

const mk = (): string => mkdtempSync(join(tmpdir(), "ntf-"));

/** 真实 pi 形态：registerCommand 是普通方法，可被 patch。 */
function fakePi(): { pi: { registerCommand: (n: string, o: Record<string, unknown>) => void }; cmds: Map<string, { handler: (a: unknown, c: unknown) => Promise<unknown> }> } {
	const cmds = new Map<string, { handler: (a: unknown, c: unknown) => Promise<unknown> }>();
	const pi = {
		registerCommand(name: string, o: Record<string, unknown>): void {
			cmds.set(name, { handler: o.handler as never });
		},
	};
	return { pi, cmds };
}

// ── B1 记录形状 / 路径 / 天键 ─────────────────────────────────
{
	const now = new Date(2026, 9, 21, 15, 30, 0); // 本地 2026-10-21
	assert.equal(dayKey(now), "20261021", "本地日键 YYYYMMDD");
	const p = notifyFilePath("sess-abc", now, "/rt");
	assert.ok(p.endsWith("sess-abc-20261021.jsonl"), `路径含 sessionId+天键（${p}）`);
	// 路径穿越防护
	const bad = notifyFilePath("../../evil", now, "/rt");
	assert.ok(bad.includes("_unknown"), `非法 sessionId ⇒ _unknown（${bad}）`);
	assert.ok(!bad.includes(".."), "不得出现路径穿越片段");

	const rec = makeNotifyRecord({ sessionId: "s", level: "warning", text: "t", source: "command:x", now, pid: 42 });
	assert.ok(rec.id.startsWith("ntf_"), "id 前缀");
	assert.equal(rec.level, "warning");
	assert.equal(rec.pid, 42);
	assert.equal(rec.at, now.toISOString());
	ok("B1 记录形状 / 天键 / 路径穿越防护");
}

// ── B2 追加 + 增量读（三态）──────────────────────────────────
{
	const rt = mk();
	const now = new Date();
	// 无文件 ⇒ absent
	const r0 = readNotify("s1", undefined, now, rt);
	assert.deepEqual(r0.records, [], "无文件 ⇒ 空");
	assert.equal(r0.absent, true, "无文件 ⇒ absent=true（无害空态）");

	appendNotify(makeNotifyRecord({ sessionId: "s1", level: "info", text: "第一条", source: "command:a", now }), rt);
	const off1 = readNotify("s1", undefined, now, rt);
	assert.equal(off1.records.length, 1);
	assert.equal(off1.records[0]!.text, "第一条");
	assert.ok(off1.nextOffset > 0, "有 offset");

	appendNotify(makeNotifyRecord({ sessionId: "s1", level: "error", text: "第二条", source: "command:b", now }), rt);
	// 从旧 offset 增量 ⇒ 只拿到第二条
	const off2 = readNotify("s1", off1.nextOffset, now, rt);
	assert.equal(off2.records.length, 1, "增量只返回新增");
	assert.equal(off2.records[0]!.text, "第二条");
	assert.equal(off2.records[0]!.level, "error");
	assert.ok(off2.nextOffset > off1.nextOffset, "offset 前进");

	// 再增量 ⇒ 空（无新内容）
	const off3 = readNotify("s1", off2.nextOffset, now, rt);
	assert.equal(off3.records.length, 0, "无新内容 ⇒ 空");
	ok("B2 追加 + 增量读三态（absent / 增量 / 无新）");
}

// ── B3 会话隔离：不串别的 session ────────────────────────────
{
	const rt = mk();
	const now = new Date();
	// 手工往同一文件里塞两条不同 sessionId 的（模拟极端情况）
	const p = notifyFilePath("sA", now, rt);
	mkdirSync(notifyDir(rt), { recursive: true });
	const a = makeNotifyRecord({ sessionId: "sA", level: "info", text: "A 的", source: "c:a", now });
	const b = makeNotifyRecord({ sessionId: "sB", level: "info", text: "B 的", source: "c:b", now });
	writeFileSync(p, `${JSON.stringify(a)}\n${JSON.stringify(b)}\n`, "utf8");
	const got = readNotify("sA", undefined, now, rt);
	assert.equal(got.records.length, 1, "只返回本会话的");
	assert.equal(got.records[0]!.text, "A 的");
	ok("B3 会话隔离：同文件混入他人记录也被过滤");
}

// ── B4 坏行 / 空行不炸 ──────────────────────────────────────
{
	const rt = mk();
	const now = new Date();
	const p = notifyFilePath("s2", now, rt);
	mkdirSync(notifyDir(rt), { recursive: true });
	const good = makeNotifyRecord({ sessionId: "s2", level: "info", text: "好的", source: "c", now });
	writeFileSync(p, `这不是 JSON\n\n${JSON.stringify(good)}\n{"id":"x"}\n`, "utf8");
	const got = readNotify("s2", undefined, now, rt);
	assert.equal(got.records.length, 1, "坏行（非 JSON / 形状不全）跳过，好的照读");
	assert.equal(got.records[0]!.text, "好的");
	ok("B4 坏行 / 形状不全 / 空行均跳过，不炸整个响应");
}

// ── B5 N2 核心：原 notify 必须照常调用（TUI 不能被弄哑）────────
{
	const rt = mk();
	const { pi, cmds } = fakePi();
	installNotifyBridge(pi as never, { runtimeDir: rt });
	pi.registerCommand("demo", { handler: async (_a: unknown, ctx: unknown) => { (ctx as { ui: { notify: (m: string, t: string) => void } }).ui.notify("你好", "warning"); } });

	const tui: [string, string][] = [];
	await cmds.get("demo")!.handler("", { ui: { notify: (m: string, t: string) => tui.push([m, t]) }, sessionManager: { sessionId: "s9" } });
	assert.deepEqual(tui, [["你好", "warning"]], "**原 notify 照常调用**（TUI 行为不变）");
	const r = readNotify("s9", undefined, new Date(), rt);
	assert.equal(r.records.length, 1, "同时落了盘");
	assert.equal(r.records[0]!.level, "warning", "级别透传");
	assert.equal(r.records[0]!.source, "command:demo", "source 自动标注命令名");
	ok("B5 双通：原 notify 照常 + 落盘完整（含 level/source）");
}

// ── B6 ui 其余字段必须原样透传（不能把 reload/compact/setModel 弄坏）──
{
	const rt = mk();
	const { pi, cmds } = fakePi();
	installNotifyBridge(pi as never, { runtimeDir: rt });
	let seenReload = 0;
	let seenCompact = 0;
	let seenModel: unknown = null;
	const origUi = {
		notify: () => {},
		reload: async () => { seenReload += 1; },
		compact: () => { seenCompact += 1; },
	};
	const origSetModel = async (m: unknown) => { seenModel = m; return true; };
	pi.registerCommand("demo2", {
		handler: async (_a: unknown, ctx: unknown) => {
			const c = ctx as { ui: { reload?: () => Promise<void>; compact?: () => void }; setModel?: (m: unknown) => Promise<boolean> };
			await c.ui.reload?.();
			c.ui.compact?.();
			await c.setModel?.({ provider: "p", id: "m" });
		},
	});
	await cmds.get("demo2")!.handler("", { ui: origUi, setModel: origSetModel, sessionManager: { sessionId: "s10" } });
	assert.equal(seenReload, 1, "ui.reload 透传（内建命令桥依赖它）");
	assert.equal(seenCompact, 1, "ui.compact 透传");
	assert.deepEqual(seenModel, { provider: "p", id: "m" }, "setModel 透传（不在 ui 上，是 ctx 顶层）");
	ok("B6 ui 其余字段 + ctx 顶层方法全部原样透传（不破坏内建命令桥）");
}

// ── B7 落盘失败不得阻断 notify（诊断通道永不阻断主链路）─────────
{
	// 用一个「必然写失败」的 runtimeDir（指向已存在的**文件**而不是目录）
	const rt = mk();
	const badRoot = join(rt, "not-a-dir");
	writeFileSync(badRoot, "x", "utf8");
	const { pi, cmds } = fakePi();
	installNotifyBridge(pi as never, { runtimeDir: badRoot });
	pi.registerCommand("demo3", { handler: async (_a: unknown, ctx: unknown) => { (ctx as { ui: { notify: (m: string) => void } }).ui.notify("还会到达 TUI"); } });
	const tui: string[] = [];
	await cmds.get("demo3")!.handler("", { ui: { notify: (m: string) => tui.push(m) }, sessionManager: { sessionId: "s11" } });
	assert.deepEqual(tui, ["还会到达 TUI"], "落盘失败时原 notify 仍照常调用");
	ok("B7 落盘失败不阻断：原 notify 仍到达 TUI");
}

// ── B8 handler 抛错原样上抛（不吞，pi 有 catch）─────────────────
{
	const rt = mk();
	const { pi, cmds } = fakePi();
	installNotifyBridge(pi as never, { runtimeDir: rt });
	pi.registerCommand("boom", { handler: async () => { throw new Error("kaboom"); } });
	let threw = false;
	try {
		await cmds.get("boom")!.handler("", { ui: { notify: () => {} }, sessionManager: { sessionId: "s12" } });
	} catch (e) {
		threw = e instanceof Error && e.message === "kaboom";
	}
	assert.equal(threw, true, "handler 抛错原样上抛（桥不吞异常）");
	ok("B8 handler 异常不被桥吞掉");
}

// ── B9 enabled:false 可关闭（kill switch）──────────────────────
{
	const rt = mk();
	const { pi, cmds } = fakePi();
	const restore = installNotifyBridge(pi as never, { runtimeDir: rt, enabled: false });
	pi.registerCommand("off", { handler: async (_a: unknown, ctx: unknown) => { (ctx as { ui: { notify: (m: string) => void } }).ui.notify("不该落盘"); } });
	const tui: string[] = [];
	await cmds.get("off")!.handler("", { ui: { notify: (m: string) => tui.push(m) }, sessionManager: { sessionId: "s13" } });
	assert.equal(tui.length, 1, "TUI 照常");
	const r = readNotify("s13", undefined, new Date(), rt);
	assert.equal(r.records.length, 0, "enabled:false ⇒ 零落盘（kill switch 生效）");
	restore();
	ok("B9 enabled:false 是有效 kill switch（零落盘）");
}

// ── B10 保留期清理：> 7 天的天文件被删，新的留着 ──────────────
{
	const rt = mk();
	const now = new Date();
	mkdirSync(notifyDir(rt), { recursive: true });
	const old = join(notifyDir(rt), "s1-20200101.jsonl");
	const recent = join(notifyDir(rt), `${"s1"}-${dayKey(now)}.jsonl`);
	writeFileSync(old, "{}\n", "utf8");
	writeFileSync(recent, "{}\n", "utf8");
	const removed = pruneNotifyFiles(rt, now);
	assert.equal(removed, 1, "删 1 个过期文件");
	assert.throws(() => readFileSync(old), "过期文件已删");
	assert.doesNotThrow(() => readFileSync(recent), "当天文件保留");
	ok("B10 保留期清理：过期删、当天留");
}

console.log(`\n_test_notify_bridge: all assertions passed (${n} groups)`);
