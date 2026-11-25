/**
 * _test_session_note.ts — 会话 Note 共享纯库单测（设计稿 §8.1 + §8.1b）。
 *
 * 运行：npm run test:session-note
 * 覆盖：sid 白名单 / 空读 / 坏文件不伪装空 / round-trip / 乐观锁 / 64KiB 上限 /
 *       **跨进程** per-sid 锁并发 / 同文短路与编辑器归一化边缘（4b/4c）/
 *       脏判定真值表 / 注入正文版本头与截断。
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import {
	MAX_NOTE_BYTES,
	NOTE_AUTHORITY_SECTION,
	NOTE_INJECTION_BUDGET,
	buildNoteInjectionContent,
	canonicalNoteText,
	decideNoteInjection,
	extractNoteRules,
	liveNoteSummary,
	noteFingerprint,
	notePath,
	readSessionNote,
	writeSessionNote,
	type SessionNote,
} from "./session-note.ts";

let passed = 0;
const failures: string[] = [];
function check(name: string, fn: () => void): void {
	try { fn(); passed++; console.log(`  ok  ${name}`); }
	catch (e) { failures.push(name); console.error(`  FAIL ${name}: ${String(e)}`); }
}
async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
	try { await fn(); passed++; console.log(`  ok  ${name}`); }
	catch (e) { failures.push(name); console.error(`  FAIL ${name}: ${String(e)}`); }
}

const root = mkdtempSync(join(tmpdir(), "session-note-test-"));
const SID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"; // 真实 UUID 形态（R-4）
const p = notePath(SID, root)!;
const childLoader = pathToFileURL(resolve("extensions/runtime-host/pi-deps-loader.mjs")).href;
const libUrl = pathToFileURL(resolve("extensions/session-note.ts")).href;

function childWrite(text: string, expectedVersion?: number): Promise<{ ok: boolean; reason?: string; note?: SessionNote }> {
	const code = [
		`import { writeSessionNote } from ${JSON.stringify(libUrl)};`,
		`const r = writeSessionNote(${JSON.stringify(SID)}, ${JSON.stringify(text)}, { agentDir: ${JSON.stringify(root)}, expectedVersion: ${expectedVersion === undefined ? "undefined" : String(expectedVersion)} });`,
		`process.stdout.write(JSON.stringify(r));`,
	].join("\n");
	return new Promise((resolveP, rejectP) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", "--import", childLoader, "--input-type=module", "-e", code], { encoding: "utf8" });
		let out = "", err = "";
		child.stdout.on("data", (c: string) => { out += c; });
		child.stderr.on("data", (c: string) => { err += c; });
		child.on("error", rejectP);
		child.on("close", (status) => {
			if (status !== 0) { rejectP(new Error(`child exit ${status}: ${err}`)); return; }
			try { resolveP(JSON.parse(out.trim())); } catch (e) { rejectP(new Error(`bad child json: ${out} (${String(e)})`)); }
		});
	});
}

console.log("[session-note] unit tests");

check("1. sid 白名单：路径穿越/斜杠/空串 → invalid-session-id，且不落文件", () => {
	for (const bad of ["../etc/passwd", "a/b", "", "a.b", "x".repeat(129)]) {
		assert.equal(notePath(bad, root), null, `path should be null: ${bad}`);
		assert.equal(readSessionNote(bad, { agentDir: root }).ok, false);
		const r = writeSessionNote(bad, "x", { agentDir: root });
		assert.equal(r.ok, false);
		if (r.ok === false) assert.equal(r.reason, "invalid-session-id");
	}
	assert.equal(existsSync(join(root, "session-notes")), false, "非法 sid 不得创建目录");
});

check("2. 文件不存在 → 200 式空读（version=0, updatedAt=null）", () => {
	const r = readSessionNote(SID, { agentDir: root });
	assert.equal(r.ok, true);
	if (r.ok) { assert.equal(r.exists, false); assert.deepEqual(r.note, { schemaVersion: 1, sessionId: SID, text: "", updatedAt: null, version: 0 }); }
});

check("3. 坏 JSON / 缺字段 / schemaVersion≠1 / sid 不匹配 → corrupt，绝不返回空 note", () => {
	mkdirSync(dirname(p), { recursive: true });
	const bads = [
		"{not json",
		JSON.stringify({ schemaVersion: 1, sessionId: SID, text: "x", version: 1 }), // 缺 updatedAt
		JSON.stringify({ schemaVersion: 2, sessionId: SID, text: "x", updatedAt: new Date().toISOString(), version: 1 }),
		JSON.stringify({ schemaVersion: 1, sessionId: "another-session", text: "x", updatedAt: new Date().toISOString(), version: 1 }),
	];
	for (const bad of bads) {
		writeFileSync(p, bad, "utf8");
		const r = readSessionNote(SID, { agentDir: root });
		assert.equal(r.ok, false, `expected corrupt for ${bad}`);
		if (r.ok === false) assert.equal(r.reason, "corrupt");
	}
	// 坏文件时写入也必须拒绝覆盖（不能静默把坏文件当空 note 覆盖掉）
	const w = writeSessionNote(SID, "new", { agentDir: root });
	assert.equal(w.ok, false);
	if (w.ok === false) assert.equal(w.reason, "corrupt");
	rmSync(p);
});

check("4. write → read round-trip：text 一致 / version=1 / ISO 时间", () => {
	const w = writeSessionNote(SID, "## 给 agent 的规则\n- 改完必须 build", { agentDir: root, now: () => new Date("2026-11-17T08:00:00.000Z") });
	assert.equal(w.ok, true);
	if (w.ok) {
		assert.equal(w.note.version, 1);
		assert.equal(w.note.updatedAt, "2026-11-17T08:00:00.000Z");
	}
	const r = readSessionNote(SID, { agentDir: root });
	assert.equal(r.ok, true);
	if (r.ok) { assert.equal(r.note.text, "## 给 agent 的规则\n- 改完必须 build"); assert.equal(r.note.version, 1); }
});

check("4b. 【核心修复】同文重写不写盘不涨版本；改文才 +1（用独立 sid 避免干扰后续版本断言）", () => {
	const sameSid = "5eed0000-0000-4aaa-8bbb-000000000004";
	const w1 = writeSessionNote(sameSid, "## 给 agent 的规则\n- 不变", { agentDir: root });
	assert.equal(w1.ok, true);
	if (w1.ok) assert.equal(w1.note.version, 1);
	const w2 = writeSessionNote(sameSid, "## 给 agent 的规则\n- 不变", { agentDir: root });
	assert.equal(w2.ok, true);
	if (w2.ok) assert.equal(w2.note.version, 1, "同文重写仍返回 v1，不得空转");
	const afterSame = readSessionNote(sameSid, { agentDir: root });
	assert.equal(afterSame.ok, true);
	if (afterSame.ok) assert.equal(afterSame.note.version, 1, "磁盘版本未变");
	// 带正确 expectedVersion 的同文重写也要短路（不能因为带锁就涨版本）
	const w2b = writeSessionNote(sameSid, "## 给 agent 的规则\n- 不变", { agentDir: root, expectedVersion: 1 });
	assert.equal(w2b.ok, true);
	if (w2b.ok) assert.equal(w2b.note.version, 1);
	const w3 = writeSessionNote(sameSid, "## 给 agent 的规则\n- 变了", { agentDir: root });
	assert.equal(w3.ok, true);
	if (w3.ok) assert.equal(w3.note.version, 2, "只有内容真变才 +1");
});

check("4c. 【编辑器边界】tab/CRLF/尾随换行/BOM 伪差异不涨版本；存储原文不动；清空仍真写", () => {
	const BOM = String.fromCharCode(0xfeff); // U+FEFF，不用源码转义避免跨层转义写错
	assert.equal(canonicalNoteText(`${BOM}a\r\n\tb\n\n`), "a\n    b", "canonical 折叠 BOM/CRLF/tab/尾随换行");
	// 场景1：含 tab + CRLF 的便签，TUI 打开 /note 零编辑提交（pi-tui normalizeText 后的文本）
	const edgeSid = "5eed0000-0000-4aaa-8bbb-000000000005";
	const raw = "## 给 agent 的规则\n\t- tab 缩进\r\n- CRLF 行";
	const w1 = writeSessionNote(edgeSid, raw, { agentDir: root });
	assert.equal(w1.ok, true);
	if (w1.ok) assert.equal(w1.note.version, 1);
	const edited = "## 给 agent 的规则\n    - tab 缩进\n- CRLF 行"; // 归一化后的同文
	const w2 = writeSessionNote(edgeSid, edited, { agentDir: root, expectedVersion: 1 });
	assert.equal(w2.ok, true);
	if (w2.ok) {
		assert.equal(w2.note.version, 1, "归一化伪差异不得涨版本");
		assert.equal(w2.note.text, raw, "短路返回磁盘原文，不被归一化文本覆盖");
	}
	const back1 = readSessionNote(edgeSid, { agentDir: root });
	assert.equal(back1.ok, true);
	if (back1.ok) assert.equal(back1.note.text, raw, "磁盘原文不动（回读验证，不只看返回值）");
	// 场景2：外部编辑器路径（stripBom + 剥尾随换行）零编辑回写
	const tailSid = "5eed0000-0000-4aaa-8bbb-000000000006";
	const t1 = writeSessionNote(tailSid, "hello\n\n", { agentDir: root });
	assert.equal(t1.ok, true);
	if (t1.ok) assert.equal(t1.note.version, 1);
	const t2 = writeSessionNote(tailSid, `${BOM}hello`, { agentDir: root, expectedVersion: 1 });
	assert.equal(t2.ok, true);
	if (t2.ok) {
		assert.equal(t2.note.version, 1, "BOM/尾随换行伪差异不得涨版本");
		assert.equal(t2.note.text, "hello\n\n", "存储原文不动");
	}
	// 清空语义不回归：空文本必须真写（tombstone），哪怕旧文只剩换行
	const clrSid = "5eed0000-0000-4aaa-8bbb-000000000007";
	const c0 = writeSessionNote(clrSid, "\n", { agentDir: root });
	assert.equal(c0.ok, true);
	const clr = writeSessionNote(clrSid, "", { agentDir: root, expectedVersion: c0.ok ? c0.note.version : -1 });
	assert.equal(clr.ok, true);
	if (clr.ok) assert.equal(clr.note.version, 2, "清空必须真写，不得被 canonical 短路吞掉");
	// 真改内容仍 +1（确认放宽判定没有吞掉真编辑）
	const t4 = writeSessionNote(tailSid, "hello!", { agentDir: root, expectedVersion: 1 });
	assert.equal(t4.ok, true);
	if (t4.ok) assert.equal(t4.note.version, 2, "真改内容仍 +1");
	// OCC 优先于同文短路：expectedVersion 过期 + canonical 同文 → 仍报 version-conflict（钉死校验顺序）
	const stale = writeSessionNote(edgeSid, edited, { agentDir: root, expectedVersion: 99 });
	assert.equal(stale.ok, false);
	if (stale.ok === false) {
		assert.equal(stale.reason, "version-conflict", "过期版本 + 同文仍走冲突，不得静默短路");
		assert.equal(stale.current?.version, 1);
	}
});

check("5. 乐观锁：错 expectedVersion → version-conflict + current；正确 → version+1", () => {
	const bad = writeSessionNote(SID, "should-not-write", { agentDir: root, expectedVersion: 99 });
	assert.equal(bad.ok, false);
	if (bad.ok === false) { assert.equal(bad.reason, "version-conflict"); assert.equal(bad.current?.version, 1); }
	const before = readSessionNote(SID, { agentDir: root });
	assert.equal(before.ok && before.note.text, "## 给 agent 的规则\n- 改完必须 build");
	const good = writeSessionNote(SID, "v2", { agentDir: root, expectedVersion: 1 });
	assert.equal(good.ok, true);
	if (good.ok) assert.equal(good.note.version, 2);
});

check("6. 上限：UTF-8 超过 64 KiB → too-large，原文件不动", () => {
	const big = "中".repeat(Math.floor(MAX_NOTE_BYTES / 3) + 2); // 中文 3 字节，确保超 64 KiB
	const w = writeSessionNote(SID, big, { agentDir: root });
	assert.equal(w.ok, false);
	if (w.ok === false) assert.equal(w.reason, "too-large");
	const r = readSessionNote(SID, { agentDir: root });
	assert.equal(r.ok && r.note.text, "v2");
});

await checkAsync("7. 跨进程并发：6 个无版本写 → 合法 JSON 且 version=6；6 个 based-on-v6 写 → 至多 1 成功", async () => {
	// 先重置为 v1，避免被上面的测试污染
	const reset = writeSessionNote(SID, "base", { agentDir: root });
	assert.equal(reset.ok, true);
	if (!reset.ok) return;
	const baseV = reset.note.version;
	const writes = await Promise.all(Array.from({ length: 6 }, (_, i) => childWrite(`child-${i}`)));
	assert.equal(writes.length, 6);
	for (const w of writes) assert.equal(w.ok, true, `concurrent write failed: ${JSON.stringify(w)}`);
	const final = readSessionNote(SID, { agentDir: root });
	assert.equal(final.ok, true);
	if (final.ok) assert.equal(final.note.version, baseV + 6);
	// 带 expectedVersion 的并发：只有一个能赢
	const contested = await Promise.all(Array.from({ length: 6 }, (_, i) => childWrite(`race-${i}`, baseV + 6)));
	const wins = contested.filter((w) => w.ok).length;
	assert.equal(wins, 1, `expected exactly 1 winner, got ${wins}: ${JSON.stringify(contested)}`);
	for (const w of contested) if (!w.ok) assert.equal(w.reason, "version-conflict");
	// 文件仍是合法 JSON，版本只前进一次
	const after = readSessionNote(SID, { agentDir: root });
	assert.equal(after.ok, true);
	if (after.ok) assert.equal(after.note.version, baseV + 7);
	JSON.parse(readFileSync(p, "utf8"));
});

console.log("[session-note] decideNoteInjection truth table (§8.1b)");

check("8. 干净不注入（核心断言）：current=3 injected=3 非空 → false", () => {
	assert.deepEqual(decideNoteInjection({ currentVersion: 3, injectedVersion: 3, text: "规则" }), { inject: false });
});
check("9. 首次 / 变更 → 注入 content", () => {
	assert.deepEqual(decideNoteInjection({ currentVersion: 1, injectedVersion: null, text: "规则" }), { inject: true, kind: "content" });
	assert.deepEqual(decideNoteInjection({ currentVersion: 4, injectedVersion: 3, text: "规则" }), { inject: true, kind: "content" });
});
check("10. 正常清空（写路径 text 空） → cleared tombstone", () => {
	assert.deepEqual(decideNoteInjection({ currentVersion: 4, injectedVersion: 3, text: "" }), { inject: true, kind: "cleared" });
});
check("11. 文件被外力删除（current=0 injected=3） → cleared tombstone", () => {
	assert.deepEqual(decideNoteInjection({ currentVersion: 0, injectedVersion: 3, text: "" }), { inject: true, kind: "cleared" });
});
check("12. 从未写过（current=0 无 state 且 text 空） → 不注入", () => {
	assert.deepEqual(decideNoteInjection({ currentVersion: 0, injectedVersion: null, text: "" }), { inject: false });
});
check("13. 压缩后 state=-1 → 必注入", () => {
	assert.deepEqual(decideNoteInjection({ currentVersion: 3, injectedVersion: -1, text: "规则" }), { inject: true, kind: "content" });
});
check("13b. 【核心修复】version 空转但正文指纹相同 → 不注入（不重复刷屏）", () => {
	const text = "## 给 agent 的规则\n- 一条没变的规则";
	const fp = noteFingerprint(text);
	// 真实症状：v2→v10 正文一字未改，旧判据只看 version 会注入 9 次
	assert.deepEqual(decideNoteInjection({ currentVersion: 10, injectedVersion: 9, text, injectedFingerprint: fp }), { inject: false });
	assert.deepEqual(decideNoteInjection({ currentVersion: 4, injectedVersion: 3, text, injectedFingerprint: fp }), { inject: false });
	// 指纹不同（内容真变了）→ 必注入
	assert.deepEqual(decideNoteInjection({ currentVersion: 11, injectedVersion: 10, text: text + "\n- 新增", injectedFingerprint: fp }),
		{ inject: true, kind: "content" });
	// 清空：指纹从有到空 → tombstone
	assert.deepEqual(decideNoteInjection({ currentVersion: 12, injectedVersion: 11, text: "", injectedFingerprint: fp }),
		{ inject: true, kind: "cleared" });
	// 压缩 -1：即使指纹相同也强制重注
	assert.deepEqual(decideNoteInjection({ currentVersion: 10, injectedVersion: -1, text, injectedFingerprint: fp }),
		{ inject: true, kind: "content" });
});
check("13c. 旧 state 无指纹字段 → 回退按 version 比对（升级前会话不漏注入）", () => {
	assert.deepEqual(decideNoteInjection({ currentVersion: 3, injectedVersion: 3, text: "规则", injectedFingerprint: null }), { inject: false });
	assert.deepEqual(decideNoteInjection({ currentVersion: 4, injectedVersion: 3, text: "规则", injectedFingerprint: null }),
		{ inject: true, kind: "content" });
});
check("14. 注入正文带 v<N> · ISO 头；规则段优先；超预算截断带标记；静态声明恒定", () => {
	const note: SessionNote = { schemaVersion: 1, sessionId: SID, text: "## 给 agent 的规则\n- 必做 A\n\n## 待人办\n- 不该出现", updatedAt: "2026-11-17T08:00:00.000Z", version: 4 };
	const content = buildNoteInjectionContent(note, () => new Date("2026-11-17T09:00:00.000Z"));
	assert.ok(content.startsWith("### 会话便签（session-note）\nv4 · 2026-11-17T09:00:00.000Z"));
	assert.ok(content.includes("- 必做 A"));
	assert.ok(!content.includes("不该出现"), "只注入规则段，不注入待人办");
	assert.ok(content.includes("note_read"));
	const long: SessionNote = { ...note, text: "## 给 agent 的规则\n" + "长".repeat(NOTE_INJECTION_BUDGET + 100) };
	const truncated = buildNoteInjectionContent(long);
	assert.ok(truncated.includes("…已截断"));
	assert.equal(extractNoteRules("没有 heading 的纯文本"), "没有 heading 的纯文本");
	assert.equal(typeof NOTE_AUTHORITY_SECTION, "string");
	assert.ok(NOTE_AUTHORITY_SECTION.includes("以时间戳最新的一条为唯一现行版本"));
});

check("15. liveNoteSummary 实时读盘：同一 sid 写两次，摘要必须跟着变（抓死快照缺陷）", () => {
	const liveSid = "c0ffee00-dead-4bee-8bad-101010101010"; // 独立 sid，不受本文件其它 case 写到 v10 影响
	const s0 = liveNoteSummary(liveSid, { agentDir: root });
	assert.ok(s0.includes("空"), `初始应为空：${s0}`);
	const w1 = writeSessionNote(liveSid, "## 给 agent 的规则\n- 先读这里", { agentDir: root });
	assert.equal(w1.ok, true);
	const s1 = liveNoteSummary(liveSid, { agentDir: root });
	assert.ok(s1.includes("v1") && !s1.includes("空"), `v1 摘要：${s1}`);
	// 关键判别：不重建对象、不传新 ctx，再调一次就必须反映新内容
	const w2 = writeSessionNote(liveSid, "规则更新成更长的文本" + "补".repeat(50), { agentDir: root, expectedVersion: 1 });
	assert.equal(w2.ok, true);
	const s2 = liveNoteSummary(liveSid, { agentDir: root });
	assert.ok(s2.includes("v2"), `必须看到 v2，实际=${s2}`);
	assert.notEqual(s2, s1, "摘要必须随文件变化，不能是启动时的死字符串");
	assert.ok(s2.includes("字"), "非空摘要显示字数");
});

rmSync(root, { recursive: true, force: true });
console.log(`\n[session-note] ${passed} passed, ${failures.length} failed${failures.length ? `: ${failures.join(", ")}` : ""}`);
if (failures.length > 0) process.exit(1);
