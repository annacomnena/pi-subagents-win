/**
 * _test_session_title.ts — 会话可读标题解析链测试（runtime-host/session-title.ts +
 * runtime/transcript.ts listPiSessions 头部 32KB 扫描；plans/0922_session_title_research.md §5）。
 *
 * 覆盖：
 *   T1 P2 剥前缀纯函数：跳「根据X进行工作」/##/> 行、markdown 噪音、Item N、(P0)、句尾标点、
 *      截 24 字符、全前缀行 → null、null 输入 → null
 *   T2 P1 台账命中（前缀匹配）：首条 user 前缀行 == 根据<mode>进行工作<taskId> → record.title
 *   T3 P1 台账探测：前缀后接空白的兼容变体 → 命中
 *   T4 cwd 桶隔离：record.cwd 异桶 → 不命中（回退 P2/P3）
 *   T5 消歧：同桶同 taskId 重派发按 session 起始时间排除未来记录；taskId 子串不命中；record 无 title → 跳过
 *   T6 P3 回退：无台账 + 无首条 user → { sessionId, source: "id" }
 *   T7 台账容错：坏 JSON / 数组 / 缺字段 / .state.json / .result.json / _archived/ 子目录全 skip，
 *      正常记录仍解析；目录缺失不 throw
 *   T8 PI_TAB_RUNS_DIR env 覆盖 + 缺省路径
 *   T9 listPiSessions.firstUserText：正常抽取；首条 user 越过 8KB 但在 32KB 窗口内；
 *      坏行/半截行容忍；首条 user 超出 32KB → null
 *   T10 resolveSessionTitles 批量：混合来源各归其位；cwd=null 不做台账探测
 *
 * 运行：npm run test:session-title
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_SESSIONS_DIR = mkdtempSync(join(tmpdir(), "session-title-sessions-"));

import { taskTitleLabel } from "./launch.ts";
import { listPiSessions } from "./runtime/transcript.ts";
import {
	deriveTitleFromFirstUserText,
	loadTabLedger,
	resolveSessionTitle,
	resolveSessionTitles,
	tabRunsDir,
} from "./runtime-host/session-title.ts";

const SESSIONS = process.env.PI_SESSIONS_DIR!;
const CWD_A = "C:\\work\\repoA";
const CWD_B = "C:\\work\\repoB";

let n = 0;
const ok = (name: string): void => {
	n += 1;
	console.log(`ok ${n} - ${name}`);
};
const dirs: string[] = [SESSIONS];
const tmp = (prefix: string): string => {
	const d = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(d);
	return d;
};

/** 写一个 pi 会话文件：首行 session 头 + 其余行。 */
function writeSession(name: string, cwd: string, sessionId: string, extraLines: string[]): string {
	const file = join(SESSIONS, name);
	writeFileSync(
		file,
		[JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-09-22T10:00:00Z", cwd }), ...extraLines, ""].join("\n"),
		"utf8",
	);
	return file;
}

const userMsg = (text: string): string =>
	JSON.stringify({ type: "message", id: `m_${Math.random().toString(36).slice(2, 8)}`, timestamp: "2026-09-22T10:00:01Z", message: { role: "user", content: [{ type: "text", text }] } });
const filler = (bytes: number, i: number): string =>
	JSON.stringify({ type: "custom_message", id: `pad_${i}`, payload: "x".repeat(Math.max(0, bytes)) });

function writeLedger(runsDir: string, rec: Record<string, unknown>, name?: string): void {
	writeFileSync(join(runsDir, name ?? `${String(rec.id)}.json`), JSON.stringify(rec), "utf8");
}

// ── T1 P2 剥前缀（taskTitleLabel 同款规则）────────────────────────
const WF_PREFIX = "根据workflow进行工作G6-T";
assert.equal(deriveTitleFromFirstUserText(`${WF_PREFIX}\n\n## 任务书\n\n> 引用行\n\n实现会话可读标题功能`), "实现会话可读标题功能");
ok("T1a 跳前缀行/##/> 引用行，取首个有意义行");

assert.equal(deriveTitleFromFirstUserText(`${WF_PREFIX}\n\n* 修复定时器盲发`), "修复定时器盲发");
assert.equal(deriveTitleFromFirstUserText(`${WF_PREFIX}\n\n- 修复定时器盲发`), "修复定时器盲发");
ok("T1b 去 markdown 列表前缀（*/-）");

assert.equal(deriveTitleFromFirstUserText("Item 3 — 嵌套散布回归"), "嵌套散布回归");
assert.equal(deriveTitleFromFirstUserText("修复（P0）会话标题"), "修复会话标题");
assert.equal(deriveTitleFromFirstUserText("修复定时器。"), "修复定时器");
assert.equal(deriveTitleFromFirstUserText("修复定时器！"), "修复定时器");
ok("T1c 去 Item N 前缀 / (P0) 标记 / 句尾标点");

const cjk30 = "会".repeat(30);
assert.equal(deriveTitleFromFirstUserText(cjk30)?.length, 24);
assert.equal(deriveTitleFromFirstUserText("a".repeat(30)), "a".repeat(24));
ok("T1d 截 24 字符（CJK 与 ASCII 同规）");

assert.equal(deriveTitleFromFirstUserText(`${WF_PREFIX}\n\n## 只有前缀与标题行`), null);
assert.equal(deriveTitleFromFirstUserText("   \n  "), null);
assert.equal(deriveTitleFromFirstUserText(null), null);
ok("T1e 全前缀/空白/null → null（回退 P3）");

// 独立重实现对照：P2 只走 taskTitleLabel 的 prompt 分支；空值差异由 P3 明确定义。
for (const prompt of [
	`${WF_PREFIX}\n\nItem 7 — 标题对照（P1）。`,
	`${WF_PREFIX}\n\n> 忽略引用\n\n* Markdown 标题`,
	"直开会话标题！",
]) {
	assert.equal(deriveTitleFromFirstUserText(prompt), taskTitleLabel(undefined, prompt));
}
ok("T1f P2 剥前缀与 launch.taskTitleLabel prompt 分支逐例对照一致");

// ── T2 P1 台账命中（前缀匹配）────────────────────────────────────
const runs1 = tmp("session-title-runs-");
writeLedger(runs1, {
	id: "tab_aaa",
	taskId: "G6-T",
	mode: "workflow",
	title: "repoA-G6-T-会话标题台账",
	cwd: CWD_A,
	dispatchedAt: "2026-09-22T09:59:30Z",
	modePrefix: undefined,
});
const s1 = resolveSessionTitle(
	{ sessionId: "sid-1", cwd: CWD_A, firstUserText: `${WF_PREFIX}\n\nTask: 实现标题` },
	loadTabLedger(runs1),
);
assert.deepEqual(s1, { title: "repoA-G6-T-会话标题台账", source: "ledger" });
ok("T2 台账命中：前缀行 == 根据<mode>进行工作<taskId> → record.title");

// ── T3 P1 台账探测（前缀后接空白）────────────────────────────────
const runs2 = tmp("session-title-runs-");
writeLedger(runs2, {
	id: "tab_bbb",
	taskId: "G6-U",
	mode: "research",
	title: "repoA-G6-U-研究链",
	cwd: CWD_A,
	dispatchedAt: "2026-09-22T09:00:00Z",
});
const s2 = resolveSessionTitle(
	{ sessionId: "sid-2", cwd: CWD_A, firstUserText: "根据research进行工作G6-U 带空格变体\n\n任务书正文引用 G6-U 的上下文" },
	loadTabLedger(runs2),
);
assert.deepEqual(s2, { title: "repoA-G6-U-研究链", source: "ledger" });
ok("T3 台账探测：前缀后接空白的兼容变体命中");

// ── T4 cwd 桶隔离 ────────────────────────────────────────────────
const s4 = resolveSessionTitle(
	{ sessionId: "sid-4", cwd: CWD_B, firstUserText: `${WF_PREFIX}\n\n无账本会话` },
	loadTabLedger(runs1),
);
assert.deepEqual(s4, { title: "无账本会话", source: "first-user" });
ok("T4 异桶台账不命中 → 回退 P2 首条 user");

// ── T5 消歧：同 taskId 重派发按 session 起始时间；taskId 子串不命中 ───
const runs5 = tmp("session-title-runs-");
writeLedger(runs5, { id: "r_old", taskId: "G8", mode: "workflow", title: "旧记录", cwd: CWD_A, dispatchedAt: "2026-09-22T07:00:00Z" });
writeLedger(runs5, { id: "r_new", taskId: "G8", mode: "workflow", title: "新记录", cwd: CWD_A, dispatchedAt: "2026-09-22T09:00:00Z" });
const s5 = resolveSessionTitle(
	{ sessionId: "sid-5", cwd: CWD_A, startedAt: "2026-09-22T08:00:00Z", firstUserText: "根据workflow进行工作G8\n\n正文" },
	loadTabLedger(runs5),
);
assert.deepEqual(s5, { title: "旧记录", source: "ledger" });
ok("T5a 同桶同 taskId 重派发：未来台账记录不覆盖更早会话");

const s5aNoTime = resolveSessionTitle(
	{ sessionId: "sid-5a-no-time", cwd: CWD_A, firstUserText: "根据workflow进行工作G8\n\n不猜台账" },
	loadTabLedger(runs5),
);
assert.deepEqual(s5aNoTime, { title: "不猜台账", source: "first-user" });
ok("T5a2 同 taskId 重派发但 session 时间缺失 → 回退 P2，不猜最新台账");

const runs5b = tmp("session-title-runs-");
writeLedger(runs5b, { id: "r_short", taskId: "T7", mode: "workflow", title: "不应命中", cwd: CWD_A, dispatchedAt: "2026-09-22T07:00:00Z" });
const s5b = resolveSessionTitle({ sessionId: "sid-5b", cwd: CWD_A, firstUserText: "正文讨论 T70 与 T7 的风险" }, loadTabLedger(runs5b));
assert.deepEqual(s5b, { title: "正文讨论 T70 与 T7 的风险", source: "first-user" });
ok("T5b 短 taskId 仅在正文/子串出现不命中台账，回退 P2");

const runs5c = tmp("session-title-runs-");
writeLedger(runs5c, { id: "r_notitle", taskId: "G7", mode: "workflow", cwd: CWD_A, dispatchedAt: "2026-09-22T09:00:00Z" });
const s5c = resolveSessionTitle({ sessionId: "sid-5c", cwd: CWD_A, firstUserText: "正文提到 G7 但台账无 title" }, loadTabLedger(runs5c));
assert.deepEqual(s5c, { title: "正文提到 G7 但台账无 title".slice(0, 24), source: "first-user" });
ok("T5c 台账记录缺 title → 不算 P1 命中，回退 P2");

// ── T6 P3 回退 ──────────────────────────────────────────────────
const s6 = resolveSessionTitle({ sessionId: "sid-6", cwd: CWD_A, firstUserText: null }, []);
assert.deepEqual(s6, { title: "sid-6", source: "id" });
ok("T6 无台账/无首条 user → P3 shortId 兜底（source=id）");

// ── T7 台账容错（损坏行 / 干扰文件 / 归档子目录）──────────────────
const runs7 = tmp("session-title-runs-");
writeFileSync(join(runs7, "broken.json"), "{invalid json", "utf8");
writeFileSync(join(runs7, "array.json"), "[1,2,3]", "utf8");
writeFileSync(join(runs7, "null.json"), "null", "utf8");
writeFileSync(join(runs7, "partial.json"), '{"taskId":"X","cwd":"C:\\\\x"}', "utf8"); // 缺 title → skip
writeLedger(runs7, { id: "st", taskId: "S", mode: "workflow", title: "不应读取", cwd: CWD_A }, "st.state.json");
writeLedger(runs7, { id: "rs", taskId: "S", mode: "workflow", title: "不应读取", cwd: CWD_A }, "rs.result.json");
mkdirSync(join(runs7, "_archived"));
writeLedger(join(runs7, "_archived") as string, { id: "arch", taskId: "S", mode: "workflow", title: "不应读取", cwd: CWD_A });
writeLedger(runs7, { id: "r_ok", taskId: "G6-T", mode: "workflow", title: "容错后仍命中", cwd: CWD_A, dispatchedAt: "2026-09-22T09:00:00Z" });
const ledger7 = loadTabLedger(runs7);
assert.equal(ledger7.length, 1);
assert.equal(ledger7[0]?.title, "容错后仍命中");
const s7 = resolveSessionTitle({ sessionId: "sid-7", cwd: CWD_A, firstUserText: `${WF_PREFIX}\n\n正文` }, ledger7);
assert.deepEqual(s7, { title: "容错后仍命中", source: "ledger" });
assert.deepEqual(loadTabLedger(join(tmp("session-title-runs-"), "not-exist")), []);
ok("T7 坏 JSON/缺字段/.state/.result/_archived 全 skip，正常记录仍命中；缺失目录 → 空台账不 throw");

// ── T8 PI_TAB_RUNS_DIR env 覆盖 ─────────────────────────────────
const prevEnv = process.env.PI_TAB_RUNS_DIR;
try {
	process.env.PI_TAB_RUNS_DIR = "  C:\\custom\\runs  ";
	assert.equal(tabRunsDir(), "C:\\custom\\runs");
	process.env.PI_TAB_RUNS_DIR = "";
	assert.ok(tabRunsDir().endsWith(join(".pi", "agent", "tab-runs")));
} finally {
	if (prevEnv === undefined) delete process.env.PI_TAB_RUNS_DIR;
	else process.env.PI_TAB_RUNS_DIR = prevEnv;
}
ok("T8 PI_TAB_RUNS_DIR 覆盖（trim）；空/缺省 → ~/.pi/agent/tab-runs");

// ── T9 listPiSessions.firstUserText（32KB 头部扫描）──────────────
writeSession("t9a_plain.jsonl", CWD_A, "11111111-aaaa-bbbb-cccc-dddddddddddd", [
	userMsg(`${WF_PREFIX}\n\n首条用户消息正文`),
	userMsg("第二条 user 不应被取"),
	JSON.stringify({ type: "message", id: "m_a2", timestamp: "2026-09-22T10:00:02Z", message: { role: "assistant", content: [{ type: "text", text: "回复" }] } }),
]);
const t9a = listPiSessions(SESSIONS).find((s) => s.sessionId.startsWith("11111111"));
assert.ok(t9a);
assert.equal(t9a.firstUserText, `${WF_PREFIX}\n\n首条用户消息正文`);
ok("T9a 首条 user 文本抽取（join text 分片；后续 user 不覆盖）");

// 首条 user 越过旧 8KB 窗口（~20KB 填充），仍在 32KB 内
writeSession("t9b_deep.jsonl", CWD_A, "22222222-aaaa-bbbb-cccc-dddddddddddd", [
	filler(8192, 1),
	filler(8192, 2),
	filler(4096, 3),
	userMsg("深藏在 20KB 后的首条用户消息"),
]);
const t9b = listPiSessions(SESSIONS).find((s) => s.sessionId.startsWith("22222222"));
assert.ok(t9b);
assert.equal(t9b.firstUserText, "深藏在 20KB 后的首条用户消息");
ok("T9b 32KB 窗口：首条 user 越过 8KB 仍可抽取");

// 坏行 + 半截行容忍
writeSession("t9c_corrupt.jsonl", CWD_A, "33333333-aaaa-bbbb-cccc-dddddddddddd", [
	"{broken json",
	userMsg("坏行之后的首条用户消息"),
	'{"type":"message","trunc', // 半截行（无换行收尾）
]);
const t9c = listPiSessions(SESSIONS).find((s) => s.sessionId.startsWith("33333333"));
assert.ok(t9c);
assert.equal(t9c.firstUserText, "坏行之后的首条用户消息");
ok("T9c 坏行/半截行 skip，不干扰抽取");

// 首条 user 超出 32KB → null（回退 P3）
writeSession("t9d_beyond.jsonl", CWD_A, "44444444-aaaa-bbbb-cccc-dddddddddddd", [filler(32768, 1), userMsg("窗口之外")]);
const t9d = listPiSessions(SESSIONS).find((s) => s.sessionId.startsWith("44444444"));
assert.ok(t9d);
assert.equal(t9d.firstUserText, null);
ok("T9d 首条 user 超出 32KB 窗口 → firstUserText=null（优雅降级）");

// ── T10 resolveSessionTitles 批量 ───────────────────────────────
writeSession("t10_ledger.jsonl", CWD_A, "55555555-aaaa-bbbb-cccc-dddddddddddd", [userMsg(`${WF_PREFIX}\n\n正文`)]); // P1
writeSession("t10_user.jsonl", CWD_B, "66666666-aaaa-bbbb-cccc-dddddddddddd", [userMsg("直开会话的任务标题")]); // P2
writeSession("t10_id.jsonl", CWD_B, "77777777-aaaa-bbbb-cccc-dddddddddddd", []); // P3
const all = listPiSessions(SESSIONS);
const titles = resolveSessionTitles(all, runs1);
const byPrefix = (p: string): (typeof all)[number] | undefined => all.find((s) => s.sessionId.startsWith(p));
assert.deepEqual(titles.get(byPrefix("55555555")!.sessionId), { title: "repoA-G6-T-会话标题台账", source: "ledger" });
assert.deepEqual(titles.get(byPrefix("66666666")!.sessionId), { title: "直开会话的任务标题", source: "first-user" });
assert.deepEqual(titles.get(byPrefix("77777777")!.sessionId), { title: byPrefix("77777777")!.sessionId, source: "id" });
ok("T10 批量解析：P1/P2/P3 各归其位（cwd 桶隔离生效）");

// 清理
for (const d of dirs) rmSync(d, { recursive: true, force: true });
console.log(`_test_session_title: all assertions passed (${n})`);
