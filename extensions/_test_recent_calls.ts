/**
 * _test_recent_calls — `extensions/recent-calls.ts` 纯函数 + 有界 IO + 判定 + 输出字节上限
 *                     + `subagent-win({action:"recent-calls"})` 集成分发测试。
 *
 * 覆盖（逐项断言）：
 *   T1  truncateUtf8：ASCII / 中文 / emoji 不超字节上限且不切坏字符
 *   T2  readTailBytes：从尾部读、字节有界、半截首行被丢弃、多字节不乱码、never-throw
 *   T3  digestArgs：键排序 + 截断值、≤160、长文本不整段回吐
 *   T4  normalizeArgsDigest：键顺序 / 空白归一、幂等、≤512、循环对象 never-throw
 *   T5  parseRecentCalls：toolCall/toolResult 回填、时间升序、坏行跳过不 throw
 *   T5b collectTabWindow / countAssistantTurns：tab 尾部窗口（entries + windowTurns 同窗单次读）
 *   T6  classifyLoop：ok / repeating / no_progress、n<3 边界、threshold 生效、优先级
 *   T7  clampN：上限夹紧 / 下限夹紧 / 缺省
 *   T8  normalizeLoopGuard：缺省 / 非法回默认 / never-throw
 *   T9  输出字节上限：formatRecentCalls / formatRecentCallsError ≤1536B
 *   T10 集成 action 分发：fake pi + tab 路径（会话 JSONL）/ async 路径（run json 环形）/ 缺失 reason
 *
 * 隔离：USERPROFILE/HOME + PI_* 全部改道 mkdtemp；不写真实 ~/.pi/agent/**。
 * 运行：npm run test:recent-calls
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	clampN,
	classifyLoop,
	collectTabWindow,
	countAssistantTurns,
	DEFAULT_LOOP_GUARD,
	digestArgs,
	formatRecentCalls,
	formatRecentCallsError,
	normalizeArgsDigest,
	normalizeLoopGuard,
	parseRecentCalls,
	readTailBytes,
	RECENT_CALLS_TOTAL_BYTES,
	truncateUtf8,
	type RecentCallEntry,
	type RecentCallsVerdict,
} from "./recent-calls.ts";
import { modePrefix } from "./launch.ts";
import { sessionBucketForCwd } from "./tab-runs.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = (name: string): string => join(__dirname, "fixtures", name);
const by = (s: string): number => Buffer.byteLength(s, "utf8");

let failed = 0;
let count = 0;
function ok(label: string, cond: boolean): void {
	count++;
	if (!cond) { failed++; console.log(`FAIL ${label}`); } else { console.log(`PASS ${label}`); }
}

// ── 环境隔离（必须在 await import("./index.ts") 之前设置）──────────
// recent-calls handler 走 tab-runs.ts 的 defaultTabRunsDir()/defaultSessionsRoot()，
// 二者只认 homedir()（不读 PI_TAB_RUNS_DIR/PI_SESSIONS_DIR）→ 实际改道靠 USERPROFILE。
// PI_* 一并设置以覆盖其它读取面（steer-runtime / transcript / links / usage / runtime）。
const TMP_ROOT = mkdtempSync(join(tmpdir(), "recent-calls-test-"));
const AGENT_DIR = join(TMP_ROOT, ".pi", "agent");
const TAB_RUNS_DIR = join(AGENT_DIR, "tab-runs");
const SESSIONS_ROOT = join(AGENT_DIR, "sessions");
const RUNS_DIR = join(TMP_ROOT, "subagent-runs");
process.env.USERPROFILE = TMP_ROOT;
process.env.HOME = TMP_ROOT;
process.env.PI_TAB_RUNS_DIR = TAB_RUNS_DIR;
process.env.PI_SESSIONS_DIR = SESSIONS_ROOT;
process.env.PI_SUBAGENT_RUNS_DIR = RUNS_DIR;
process.env.PI_LINKS_PATH = join(TMP_ROOT, "links.jsonl");
process.env.PI_SUBAGENT_USAGE_DIR = join(TMP_ROOT, "usage");
process.env.PI_RUNTIME_DIR = join(TMP_ROOT, "runtime");
process.env.PI_NOTIFY_DISABLE = "1";
delete (process.env as Record<string, string | undefined>).PI_SUBAGENT;
delete (process.env as Record<string, string | undefined>).PI_TAB_RUN_ID;
delete (process.env as Record<string, string | undefined>).PI_SESSION_PROFILE;
assert.ok(TMP_ROOT.startsWith(tmpdir()), "隔离根目录必须在 tmpdir 内");

// ── T1 truncateUtf8 ───────────────────────────────────────────────
ok("T1 ASCII 不超字节上限", by(truncateUtf8("a".repeat(100), 10)) <= 10);
ok("T1 ASCII 追加省略标记", truncateUtf8("a".repeat(100), 10).endsWith("…"));
ok("T1 ASCII 未超限时原样", truncateUtf8("abcdefghij", 10) === "abcdefghij");
ok("T1 中文不超字节上限", by(truncateUtf8("中".repeat(50), 10)) <= 10);
ok("T1 中文不切坏字符（无 U+FFFD）", !truncateUtf8("中".repeat(50), 10).includes("\uFFFD"));
ok("T1 中文正文按整字符切", truncateUtf8("中".repeat(50), 10).replace("…", "").split("").every((c) => c === "中"));
ok("T1 emoji 不超字节上限", by(truncateUtf8("😀".repeat(10), 9)) <= 9);
ok("T1 emoji 不切坏字符（无 U+FFFD）", !truncateUtf8("😀".repeat(10), 9).includes("\uFFFD"));
ok("T1 极小上限仍不超限", by(truncateUtf8("中文", 1)) <= 1 && by(truncateUtf8("abc", 2)) <= 2);

// ── T2 readTailBytes ──────────────────────────────────────────────
{
	const dir = mkdtempSync(join(tmpdir(), "recent-calls-tail-"));
	const p = join(dir, "tail.jsonl");
	const lines = Array.from({ length: 50 }, (_, i) => JSON.stringify({ i, s: `值${i}` }));
	writeFileSync(p, lines.join("\n"), "utf8"); // 无尾换行
	const r1 = readTailBytes(p, 64);
	ok("T2 bytesRead ≤ maxBytes", r1.bytesRead <= 64);
	ok("T2 truncated=true", r1.truncated === true);
	ok("T2 至少留一整行", r1.lines.length >= 1);
	ok("T2 返回行均为完整 JSON（半截首行已丢）", r1.lines.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }));
	ok("T2 尾行是最新一行", JSON.parse(r1.lines[r1.lines.length - 1] as string).i === 49);
	const size = statSync(p).size;
	const r2 = readTailBytes(p, size + 10);
	ok("T2 全量读 truncated=false", r2.truncated === false);
	ok("T2 全量读行数完整", r2.lines.length === 50 && r2.bytesRead === size);
	let sawMulti = false;
	for (let mb = 12; mb <= 40; mb++) {
		const r = readTailBytes(p, mb);
		if (r.lines.length === 0) continue;
		sawMulti = true;
		ok(`T2 多字节边界 mb=${mb} 无乱码`, r.lines.every((l) => !l.includes("\uFFFD")));
	}
	ok("T2 多字节边界样本非空", sawMulti);
	const r3 = readTailBytes(join(dir, "nope.jsonl"), 16);
	ok("T2 不存在路径 never-throw", r3.lines.length === 0 && r3.bytesRead === 0 && r3.truncated === false);
}

// ── T3 digestArgs ─────────────────────────────────────────────────
ok("T3 键排序", digestArgs({ b: 2, a: 1 }) === "a=1; b=2");
{
	const long = digestArgs({ file_text: "x".repeat(5000) });
	ok("T3 长文本 ≤160 字符", long.length <= 160);
	ok("T3 长文本 ≤160 字节", by(long) <= 160);
	ok("T3 长文本不整段回吐", !long.includes("x".repeat(200)));
	ok("T3 键名保留", long.startsWith("file_text="));
}
ok("T3 数组只给长度", digestArgs([1, 2, 3]) === "[3]");
ok("T3 非对象原样", digestArgs("hello") === "hello");
ok("T3 null → 空串", digestArgs(null) === "");
ok("T3 嵌套对象只列键名", digestArgs({ a: { z: 1, y: 2 } }) === "a={y,z}");
ok("T3 多键仍 ≤160 字符", digestArgs(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, "v".repeat(20)]))).length <= 160);
// 凭据硬规则：敏感键名值一律 ***，不得出现任何凭据前缀/片段
{
	const cred = digestArgs({
		authorization: "Bearer sk-live-abcdef1234567890",
		api_key: "sk-1234567890abcdef",
		"api-key": "sk-1234567890abcdef",
		password: "hunter2-secret-pass",
		client_secret: "sec-xyz-456",
		auth_token: "tok-999-abc",
		username: "alice",
	});
	ok("T3 敏感键值一律 ***", [
		"authorization=***", "api_key=***", "api-key=***", "password=***",
		"client_secret=***", "auth_token=***",
	].every((kv) => cred.includes(kv)));
	ok("T3 非敏感键不 mask", cred.includes("username=alice"));
	ok("T3 digest 不含任何凭据片段/前缀", !["sk-", "Bearer", "hunter2", "sec-xyz", "tok-999", "abcdef", "1234567890"].some((frag) => cred.includes(frag)));
}
// 2026-10-16 二轮必修：值侧凭据——非敏感键值内凭据片段 + resultPreview（工具回显）必须同样脱敏；
// 3 条 secret 在所有输出路径零出现。
{
	const S1 = "sk-live-abc123XYZ789token";
	const S2 = "tok-leak-hunter2456";
	const S3 = "pw-leak-SuperSecret77";
	const cmd = digestArgs({ command: `curl -H "Authorization: Bearer ${S1}"` });
	ok("T3v 非敏感键值侧 Bearer/sk- 脱敏", !cmd.includes(S1) && cmd.includes("***"));
	const tok = digestArgs({ command: `--header token=${S2}` });
	ok("T3v 非敏感键值侧 token= 脱敏", !tok.includes(S2) && tok.includes("***"));
	const pw = digestArgs({ command: `set password=${S3}` });
	ok("T3v 非敏感键值侧 password= 脱敏", !pw.includes(S3) && pw.includes("***"));
	// resultPreview（工具回显）：toolResult 含 3 条 secret → 输出零出现。
	const secretLines = [
		JSON.stringify({ type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: `curl Bearer ${S1}` } }] } }),
		JSON.stringify({ type: "message", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: `resp token=${S2} and password=${S3}` }] } }),
	];
	const secretEntries = parseRecentCalls(secretLines);
	ok("T5v resultPreview 回填即脱敏",
		secretEntries[0]?.resultPreview !== undefined
		&& !secretEntries[0].resultPreview.includes(S2)
		&& !secretEntries[0].resultPreview.includes(S3)
		&& secretEntries[0].resultPreview.includes("***"));
	const out = formatRecentCalls(
		{ id: "run_secret", source: "tab", n: 3 },
		secretEntries,
		{ verdict: "ok", basis: "ok", hint: "继续观察" },
	);
	ok("T9v 3 条 secret 在 formatRecentCalls 输出零出现", ![S1, S2, S3].some((s) => out.includes(s)));
	ok("T9v 输出含 *** 脱敏标记", out.includes("***"));
	// 旧记录防御：entry 里已存未脱敏的 digest/resultPreview → 渲染层再罩一遍。
	const stale: RecentCallEntry = { tool: "bash", argsDigest: `cmd token=${S2}`, ts: "2026-01-01T00:00:02.000Z", turn: 1, resultPreview: `Bearer ${S1}` };
	const out2 = formatRecentCalls({ id: "run_stale", source: "async", n: 1 }, [stale], { verdict: "ok", basis: "ok", hint: "ok" });
	ok("T9v 未脱敏旧记录渲染层脱敏", ![S1, S2].some((s) => out2.includes(s)));
}

// ── T4 normalizeArgsDigest ────────────────────────────────────────
ok("T4 键顺序归一后相等", normalizeArgsDigest({ a: 1, b: 2 }) === normalizeArgsDigest({ b: 2, a: 1 }));
ok("T4 空白差异归一后相等", normalizeArgsDigest({ a: " x\n  y " }) === normalizeArgsDigest({ a: "x y" }));
ok("T4 嵌套键顺序归一", normalizeArgsDigest({ a: { p: 1, q: 2 } }) === normalizeArgsDigest({ a: { q: 2, p: 1 } }));
ok("T4 数组顺序仍敏感", normalizeArgsDigest({ a: [1, 2] }) !== normalizeArgsDigest({ a: [2, 1] }));
ok("T4 幂等", (() => { const s = normalizeArgsDigest({ a: { b: " x " } }); return s === normalizeArgsDigest(s); })());
ok("T4 ≤512 字符", normalizeArgsDigest({ a: "y".repeat(2000) }).length <= 512);
ok("T4 循环对象 never-throw", (() => { const o: Record<string, unknown> = {}; o.self = o; try { normalizeArgsDigest(o); return true; } catch { return false; } })());

// ── T5 parseRecentCalls ───────────────────────────────────────────
{
	const distinctLines = readFileSync(FIX("recent-calls-distinct.jsonl"), "utf8").split("\n");
	const parsed = parseRecentCalls(distinctLines);
	ok("T5 提取 3 条 toolCall", parsed.length === 3);
	ok("T5 tool 名与顺序", parsed.map((e) => e.tool).join(",") === "bash,read,edit");
	ok("T5 toolResult 回填 resultPreview", parsed[0]?.resultPreview?.includes("file-a") === true);
	ok("T5 durationMs 回填（1500/250/1000）", parsed[0]?.durationMs === 1500 && parsed[1]?.durationMs === 250 && parsed[2]?.durationMs === 1000);
	ok("T5 时间升序", Date.parse(parsed[0]!.ts) <= Date.parse(parsed[1]!.ts) && Date.parse(parsed[1]!.ts) <= Date.parse(parsed[2]!.ts));
	ok("T5 turn 递增（1/2/3）", parsed[0]?.turn === 1 && parsed[1]?.turn === 2 && parsed[2]?.turn === 3);
	ok("T5 坏行跳过不 throw", parseRecentCalls(["not json{", "", "[]", "{]", ...distinctLines]).length === 3);
	const orphanLines = [
		JSON.stringify({ type: "toolCall", callId: "x", name: "bash", arguments: { c: 1 }, at: "2026-01-01T00:00:00.000Z" }),
		JSON.stringify({ type: "message", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "toolResult", toolCallId: "nope", content: [{ type: "text", text: "ignored" }] } }),
	];
	const orphan = parseRecentCalls(orphanLines);
	ok("T5 无匹配 callId 的 toolResult 忽略", orphan.length === 1 && orphan[0]?.resultPreview === undefined);
	ok("T5 扁平 toolCall 行可解析", orphan[0]?.tool === "bash" && orphan[0]?.turn === 0);
}

// ── T5b collectTabWindow / countAssistantTurns（tab turnClock 修复的纯函数面）──
{
	const npWinLines = readFileSync(FIX("recent-calls-tab-noprogress.jsonl"), "utf8").split("\n");
	ok("T5b countAssistantTurns：tab-noprogress 夹具 5 个 assistant 回合", countAssistantTurns(npWinLines) === 5);
	ok("T5b countAssistantTurns：distinct 夹具 3 个 assistant 回合", countAssistantTurns(readFileSync(FIX("recent-calls-distinct.jsonl"), "utf8").split("\n")) === 3);
	ok("T5b countAssistantTurns：坏行/空行/扁平 toolCall 行不计", countAssistantTurns([
		"not json{",
		"",
		"   ",
		JSON.stringify({ type: "toolCall", callId: "x", name: "bash" }),
		JSON.stringify({ type: "message", message: { role: "assistant" } }),
		JSON.stringify({ type: "message", message: { role: "user" } }),
		JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "x" } }),
	]) === 1);
	ok("T5b collectTabWindow：缺失文件 never-throw 空", (() => {
		const w = collectTabWindow(join(TMP_ROOT, "no-such-tab-window.jsonl"), 3);
		return w.entries.length === 0 && w.windowTurns === 0;
	})());
	const winPath = join(TMP_ROOT, "tab-window.jsonl");
	writeFileSync(winPath, readFileSync(FIX("recent-calls-tab-noprogress.jsonl"), "utf8"), "utf8");
	const win = collectTabWindow(winPath, 3);
	ok("T5b collectTabWindow：entries=1（1 次工具调用）", win.entries.length === 1 && win.entries[0]?.tool === "bash");
	ok("T5b collectTabWindow：windowTurns=5（同窗单次读）", win.windowTurns === 5);
	ok("T5b collectTabWindow：deps.readTail 注入生效", collectTabWindow("ignored", 2, {
		readTail: () => ({ lines: [JSON.stringify({ type: "message", message: { role: "assistant" } })], truncated: true, bytesRead: 10 }),
	}).windowTurns === 1);
	// 修复语义：turnClock（窗口 assistant 回合）- lastToolTurn > 0 可判 no_progress
	//（原接线 turnClock = lastToolTurn ⇒ 差值恒 0，tab 永不可判 no_progress）。
	const winLoop = classifyLoop(win.entries, { turnClock: win.windowTurns, lastToolTurn: win.entries.reduce((m, e) => Math.max(m, e.turn), 0) });
	ok("T5b 尾部 4 个纯文本 assistant 回合 → no_progress", winLoop.verdict === "no_progress" && winLoop.basis.includes("4 turns without tool"));
}

// ── T6 classifyLoop ───────────────────────────────────────────────
const T = (s: number): string => new Date(Date.parse("2026-08-06T03:45:00.000Z") + s * 1000).toISOString();
const E = (tool: string, args: unknown, turn: number, s: number): RecentCallEntry => ({ tool, argsDigest: normalizeArgsDigest(args), ts: T(s), turn });
const THREE_SAME = [E("bash", { command: "ls" }, 1, 1), E("bash", { command: "ls" }, 2, 2), E("bash", { command: "ls" }, 3, 3)];
{
	const distinct = [E("bash", { command: "ls" }, 1, 1), E("read", { path: "a" }, 2, 2), E("edit", { path: "b" }, 3, 3)];
	ok("T6 3 次不同调用 → ok", classifyLoop(distinct, { turnClock: 3, lastToolTurn: 3 }).verdict === "ok");
	const rep = classifyLoop(THREE_SAME, { turnClock: 3, lastToolTurn: 3 });
	ok("T6 连续重复 3 次 → repeating", rep.verdict === "repeating");
	ok("T6 repeating basis 含 ×3", rep.basis.includes("×3"));
	ok("T6 args 不同打断重复", classifyLoop([...THREE_SAME.slice(0, 2), E("bash", { command: "pwd" }, 3, 3)], { turnClock: 3, lastToolTurn: 3 }).verdict === "ok");
	ok("T6 tool 不同打断重复", classifyLoop([...THREE_SAME.slice(0, 2), E("read", { command: "ls" }, 3, 3)], { turnClock: 3, lastToolTurn: 3 }).verdict === "ok");
	ok("T6 键顺序归一后的 args 计入重复", classifyLoop([E("bash", { a: 1, b: 2 }, 1, 1), E("bash", { b: 2, a: 1 }, 2, 2), E("bash", { b: 2, a: 1 }, 3, 3)], { turnClock: 3, lastToolTurn: 3 }).verdict === "repeating");
	ok("T6 ≥3 turn 无工具调用 → no_progress", classifyLoop([], { turnClock: 3, lastToolTurn: 0 }).verdict === "no_progress");
	ok("T6 2 turn 无工具调用 → ok", classifyLoop([], { turnClock: 2, lastToolTurn: 0 }).verdict === "ok");
	ok("T6 turnClock<threshold 不判 no_progress", classifyLoop([E("bash", {}, 1, 1), E("read", {}, 2, 2)], { turnClock: 2, lastToolTurn: 0 }).verdict === "ok");
	ok("T6 仅 2 次重复 → ok（n<3 边界）", classifyLoop(THREE_SAME.slice(0, 2), { turnClock: 2, lastToolTurn: 2 }).verdict === "ok");
	ok("T6 threshold=2 生效", classifyLoop(THREE_SAME.slice(0, 2), { turnClock: 2, lastToolTurn: 2 }, 2).verdict === "repeating");
	ok("T6 threshold=5 不触发", classifyLoop(THREE_SAME, { turnClock: 3, lastToolTurn: 3 }, 5).verdict === "ok");
	ok("T6 repeating 优先于 no_progress", classifyLoop(THREE_SAME, { turnClock: 9, lastToolTurn: 3 }).verdict === "repeating");
}
ok("T6 fixture 连续重复 → repeating", classifyLoop(parseRecentCalls(readFileSync(FIX("recent-calls-repeat.jsonl"), "utf8").split("\n")), { turnClock: 3, lastToolTurn: 3 }).verdict === "repeating");
{
	const npLines = readFileSync(FIX("recent-calls-noprogress.jsonl"), "utf8").split("\n");
	const npEntries = parseRecentCalls(npLines);
	const assistantTurns = npLines.filter((l) => { try { return JSON.parse(l).message?.role === "assistant"; } catch { return false; } }).length;
	ok("T6 fixture 无工具调用", npEntries.length === 0);
	ok("T6 fixture 连续 3 turn 无工具 → no_progress", classifyLoop(npEntries, { turnClock: assistantTurns, lastToolTurn: 0 }).verdict === "no_progress");
}

// ── T7 clampN ─────────────────────────────────────────────────────
ok("T7 n=9→5", clampN(9) === 5);
ok("T7 n=0→1", clampN(0) === 1);
ok("T7 n=-1→1", clampN(-1) === 1);
ok("T7 n=NaN→3", clampN(Number.NaN) === 3);
ok("T7 n=undefined→3", clampN(undefined) === 3);
ok("T7 n='3'→3", clampN("3") === 3);
ok("T7 n=Infinity→3", clampN(Number.POSITIVE_INFINITY) === 3);
ok("T7 n=2.9→2", clampN(2.9) === 2);
ok("T7 n=5→5（上限内）", clampN(5) === 5);

// ── T8 normalizeLoopGuard ─────────────────────────────────────────
ok("T8 缺省 enabled=false", normalizeLoopGuard(undefined).enabled === false);
ok("T8 缺省 threshold=3", normalizeLoopGuard(undefined).threshold === 3);
ok("T8 缺省 action=warn", normalizeLoopGuard(undefined).action === "warn");
ok("T8 {} 回默认", JSON.stringify(normalizeLoopGuard({})) === JSON.stringify(DEFAULT_LOOP_GUARD));
ok("T8 非对象回默认", normalizeLoopGuard("x").threshold === 3 && normalizeLoopGuard(42).enabled === false);
ok("T8 null 回默认", JSON.stringify(normalizeLoopGuard(null)) === JSON.stringify(DEFAULT_LOOP_GUARD));
ok("T8 垃圾 threshold 回默认 3", normalizeLoopGuard({ threshold: "nope" }).threshold === 3);
ok("T8 enabled 非 true 视为 false（fail-closed）", normalizeLoopGuard({ enabled: "true" }).enabled === false);
ok("T8 threshold=99 clamp 到 10", normalizeLoopGuard({ enabled: true, threshold: 99, action: "x" }).threshold === 10);
ok("T8 非法 action → warn", normalizeLoopGuard({ enabled: true, action: "x" }).action === "warn");
ok("T8 action=kill 保留", normalizeLoopGuard({ action: "kill" }).action === "kill");
ok("T8 threshold=-1 clamp 到下限 2（文档语义）", normalizeLoopGuard({ threshold: -1 }).threshold === 2);
ok("T8 循环对象 never-throw", (() => { const o: Record<string, unknown> = {}; o.self = o; try { return normalizeLoopGuard(o).threshold === 3; } catch { return false; } })());

// ── T9 输出字节上限（关键）──────────────────────────────────────
{
	const big: RecentCallEntry[] = Array.from({ length: 5 }, (_, i) => ({
		tool: "bash",
		argsDigest: normalizeArgsDigest({ blob: "x".repeat(4000), i }),
		ts: T(i + 1),
		turn: i + 1,
		resultPreview: "y".repeat(4000),
		durationMs: 1000 + i,
	}));
	const verdict: RecentCallsVerdict = { verdict: "ok", basis: "ok: test basis", hint: "继续观察" };
	const out = formatRecentCalls(
		{ id: "run_test", source: "tab", agent: "implementer", model: "Test/model", status: "running", n: 5, loopGuard: { enabled: true, threshold: 3, action: "warn" }, loopGuardBasis: "repeating: bash×3 same args" },
		big,
		verdict,
	);
	ok("T9 formatRecentCalls ≤1536B", by(out) <= RECENT_CALLS_TOTAL_BYTES);
	ok("T9 输出含 tool 名", out.includes("tool=bash"));
	ok("T9 loopGuard 行已渲染", out.includes("[loopGuard: warn"));
	const err = formatRecentCallsError("not-found", "run_x", "detail " + "z".repeat(5000));
	ok("T9 formatRecentCallsError ≤1536B", by(err) <= RECENT_CALLS_TOTAL_BYTES);
	ok("T9 formatRecentCallsError 含 reason", err.includes("not-found"));
	const err2 = formatRecentCallsError("ambiguous");
	ok("T9 无 id/detail 错误响应也 ≤1536B", by(err2) <= RECENT_CALLS_TOTAL_BYTES && err2.includes("ambiguous"));
}

// ── T11 运行中增量写：合并安全 + 节流（mergeRunRecord）─────────────
{
	// 动态 import：subagent-kill 在模块加载时读 PI_SUBAGENT_RUNS_DIR 固定 DEFAULT_RUNS_DIR，
	// 必须在顶层 env 改道之后再求值（静态 import 会被提升到 env 赋值之前）。
	const { createThrottledRunMerger, mergeRunRecord } = await import("./subagent-kill.ts");
	const dir = mkdtempSync(join(tmpdir(), "recent-calls-merge-"));
	const runningId = "run_merge_running";
	const startedAt = new Date().toISOString();
	writeFileSync(join(dir, `${runningId}.json`), JSON.stringify({ id: runningId, agent: "implementer", task: "观察", status: "running", startedAt, pid: 424242, pidRecordedAt: startedAt, lastActivity: "2026-08-06T03:45:00.000Z" }));
	ok("T11 mergeRunRecord 写入成功", mergeRunRecord(runningId, { recentCalls: THREE_SAME, lastToolTurn: 3, turnClock: 3 }, dir) === true);
	const after = JSON.parse(readFileSync(join(dir, `${runningId}.json`), "utf8"));
	ok("T11 merge 后 recentCalls 落盘 3 条", Array.isArray(after.recentCalls) && after.recentCalls.length === 3);
	ok("T11 merge 保留 pid", after.pid === 424242);
	ok("T11 merge 保留 lastActivity", after.lastActivity === "2026-08-06T03:45:00.000Z");
	ok("T11 merge 保留 status=running", after.status === "running");
	ok("T11 merge 保留 startedAt", after.startedAt === startedAt);
	ok("T11 merge 保留其它字段（agent/task）", after.agent === "implementer" && after.task === "观察");

	// 带 killedAt/无 pid 的 killed 记录：增量写后 kill 字段不被回滚。
	const killedId = "run_merge_killed";
	const killedAtIso = "2026-08-06T03:50:00.000Z";
	writeFileSync(join(dir, `${killedId}.json`), JSON.stringify({ id: killedId, status: "cancelled", killedAt: killedAtIso, killedBy: "tool:subagent-win", lastActivity: killedAtIso }));
	mergeRunRecord(killedId, { recentCalls: THREE_SAME, lastToolTurn: 3, turnClock: 3 }, dir);
	const killedAfter = JSON.parse(readFileSync(join(dir, `${killedId}.json`), "utf8"));
	ok("T11 killed 记录 merge 保留 killedAt", killedAfter.killedAt === killedAtIso);
	ok("T11 killed 记录 merge 保留 status=cancelled", killedAfter.status === "cancelled");
	ok("T11 killed 记录 merge 保留 killedBy", killedAfter.killedBy === "tool:subagent-win");
	ok("T11 killed 记录 merge 不回滚出 pid", killedAfter.pid === undefined);

	// 不存在的 run → no-op false（尚未落盘/已清理）。
	ok("T11 记录不存在 → no-op false", mergeRunRecord("run_missing_zz", { recentCalls: [] }, dir) === false);

	// 节流器：首调用立即写；窗口内二次被节流；超窗后恢复。
	const throttledId = "run_merge_throttle";
	writeFileSync(join(dir, `${throttledId}.json`), JSON.stringify({ id: throttledId, status: "running" }));
	const throttled = createThrottledRunMerger(throttledId, dir, 200);
	ok("T11 节流器首次写入=true", throttled({ recentCalls: THREE_SAME.slice(0, 1), lastToolTurn: 1 }) === true);
	ok("T11 节流器窗口内二次=false", throttled({ recentCalls: THREE_SAME.slice(0, 2), lastToolTurn: 2 }) === false);
	ok("T11 节流器窗口内未落盘（仍 1 条）", JSON.parse(readFileSync(join(dir, `${throttledId}.json`), "utf8")).recentCalls.length === 1);
	await new Promise((r) => setTimeout(r, 230));
	ok("T11 节流器超窗后恢复=true", throttled({ recentCalls: THREE_SAME, lastToolTurn: 3 }) === true);
	ok("T11 节流器超窗后落盘 3 条", JSON.parse(readFileSync(join(dir, `${throttledId}.json`), "utf8")).recentCalls.length === 3);
	rmSync(dir, { recursive: true, force: true });
}

// ── T10 集成：action 分发（fake pi 捕获 subagent-win 定义）─────────
async function main(): Promise<void> {
	mkdirSync(TAB_RUNS_DIR, { recursive: true });
	mkdirSync(SESSIONS_ROOT, { recursive: true });
	mkdirSync(RUNS_DIR, { recursive: true });
	const cwd = join(TMP_ROOT, "work");
	mkdirSync(cwd, { recursive: true });
	const sessDir = join(SESSIONS_ROOT, sessionBucketForCwd(cwd));
	mkdirSync(sessDir, { recursive: true });
	const taskId = "1007";
	const mode = "workflow";
	// 会话 JSONL：直接复用 distinct fixture（其首条 user 文本 = modePrefix(1007, workflow)）。
	const sessPath = join(sessDir, "2026-08-06T03-45-15-433Z_33333333-3333-7333-8333-333333333333.jsonl");
	writeFileSync(sessPath, readFileSync(FIX("recent-calls-distinct.jsonl"), "utf8"), "utf8");
	// tab dispatch 记录（cwd 指向临时目录 → session 桶命中上面的文件）。
	const tabRunId = "tab_test_recent_1";
	writeFileSync(join(TAB_RUNS_DIR, `${tabRunId}.json`), JSON.stringify({ id: tabRunId, version: 1, taskId, mode, cwd, requestedModel: "Test/recent", dispatchedAt: new Date().toISOString(), dispatchStatus: "dispatched" }));
	// async run 记录（带环形明细 / 旧记录无明细）。
	const runId = "run_test_recent_1";
	const fixtureEntries = parseRecentCalls(readFileSync(FIX("recent-calls-distinct.jsonl"), "utf8").split("\n"));
	writeFileSync(join(RUNS_DIR, `${runId}.json`), JSON.stringify({ id: runId, agent: "implementer", task: "观察用", status: "completed", startedAt: new Date().toISOString(), recentCalls: fixtureEntries }));
	const noDetailRunId = "run_test_recent_nodetail";
	writeFileSync(join(RUNS_DIR, `${noDetailRunId}.json`), JSON.stringify({ id: noDetailRunId, task: "旧记录", status: "completed", startedAt: new Date().toISOString() }));

	const tools = new Map<string, any>();
	const fakePi = {
		registerTool: (def: { name: string }): void => { tools.set(def.name, def); },
		registerCommand: (): void => {},
		registerFlag: (): void => {},
		on: (): void => {},
		getFlag: (): string => "",
		sendUserMessage: (): void => {},
		sendMessage: (): void => {},
		exec: (): void => {},
	};
	const mod = await import("./index.ts");
	await (mod as any).default(fakePi);
	const tool = tools.get("subagent-win");
	ok("T10 subagent-win 已注册", typeof tool?.execute === "function");
	const ctx = { sessionManager: { sessionId: "test-recent-calls" }, ui: { notify: (): void => {} } };
	const call = (params: Record<string, unknown>): Promise<any> => tool.execute("rc", params, undefined, undefined, ctx);
	const textOf = (r: any): string => r?.content?.[0]?.text ?? "";

	// tab 路径：分隔 JSONL 尾部 → 3 条明细，verdict ok。
	const tabRes = await call({ action: "recent-calls", tabRunId, n: 3 });
	const tabTxt = textOf(tabRes);
	ok("T10/tab 非 error", !tabRes.isError);
	ok("T10/tab source=tab", tabTxt.includes("[source=tab]"));
	ok("T10/tab verdict ok", tabTxt.includes("verdict: ok"));
	ok("T10/tab 含 3 个 tool 名", tabTxt.includes("tool=bash") && tabTxt.includes("tool=read") && tabTxt.includes("tool=edit"));
	ok("T10/tab ≤1536B", by(tabTxt) <= RECENT_CALLS_TOTAL_BYTES);

	// tab 路径 verdict 矩阵（2026-10-16 turnClock 修复）：每个场景独立 cwd 桶，避免同前缀会话互抢。
	// （taskId/mode 同为 1007/workflow → modePrefix 相同；bucket 由 cwd 区分。）
	const mkTab = (suffix: string, cwdDir: string, fixture: string | null, inline?: string): string => {
		const id = `tab_recent_vc_${suffix}`;
		mkdirSync(cwdDir, { recursive: true });
		const bDir = join(SESSIONS_ROOT, sessionBucketForCwd(cwdDir));
		mkdirSync(bDir, { recursive: true });
		writeFileSync(join(bDir, `2026-08-06T05-20-00-000Z_44444444-4444-7444-8444-44444444${suffix}.jsonl`), inline ?? readFileSync(FIX(fixture!), "utf8"), "utf8");
		writeFileSync(join(TAB_RUNS_DIR, `${id}.json`), JSON.stringify({ id, version: 1, taskId, mode, cwd: cwdDir, requestedModel: "Test/recent", dispatchedAt: new Date().toISOString(), dispatchStatus: "dispatched" }));
		return id;
	};
	// ① 重复同一调用 → repeating（复用 repeat 夹具：3 次同 args bash）。
	const repTabId = mkTab("rep", join(TMP_ROOT, "work-rep"), "recent-calls-repeat.jsonl");
	const repTabRes = await call({ action: "recent-calls", tabRunId: repTabId, n: 3 });
	const repTabTxt = textOf(repTabRes);
	ok("T10/tab-repeat 非 error", !repTabRes.isError);
	ok("T10/tab-repeat verdict=repeating", repTabTxt.includes("verdict: repeating"));
	ok("T10/tab-repeat 含 ×3 证据", repTabTxt.includes("×3"));
	// ② 回合推进但无产出 → no_progress（工具调用后 4 个纯文本 assistant 回合；turnClock=5 > lastToolTurn=1）。
	const npTabId = mkTab("np", join(TMP_ROOT, "work-np"), "recent-calls-tab-noprogress.jsonl");
	const npTabRes = await call({ action: "recent-calls", tabRunId: npTabId, n: 3 });
	const npTabTxt = textOf(npTabRes);
	ok("T10/tab-noprogress 非 error", !npTabRes.isError);
	ok("T10/tab-noprogress verdict=no_progress", npTabTxt.includes("verdict: no_progress"));
	ok("T10/tab-noprogress basis 含 4 turns without tool", npTabTxt.includes("4 turns without tool"));
	// ③ 窗口内零工具调用但回合已达标 → 同样 no_progress（不再降级 unknown）。
	const notoolTabId = mkTab("notool", join(TMP_ROOT, "work-notool"), "recent-calls-noprogress.jsonl");
	const notoolTabTxt = textOf(await call({ action: "recent-calls", tabRunId: notoolTabId, n: 3 }));
	ok("T10/tab-no-tool-calls verdict=no_progress", notoolTabTxt.includes("verdict: no_progress"));
	ok("T10/tab-no-tool-calls 非 unknown", !notoolTabTxt.includes("verdict: unknown"));
	// ④ 短会话（1 个纯文本回合，不足阈值）→ 仍 no-detail/unknown（不虚报）。
	const shortLines = [
		JSON.stringify({ type: "session", version: 3, id: "019f0000-0000-7000-8000-0000000000d5", timestamp: "2026-08-06T05:30:00.000Z", cwd: "x" }),
		JSON.stringify({ type: "message", id: "u1", timestamp: "2026-08-06T05:30:01.000Z", message: { role: "user", content: [{ type: "text", text: "根据workflow进行工作1007" }], timestamp: "2026-08-06T05:30:01.000Z" } }),
		JSON.stringify({ type: "message", id: "a1", timestamp: "2026-08-06T05:30:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "想一想。" }], stopReason: "stop" } }),
	].join("\n");
	const shortTabId = mkTab("short", join(TMP_ROOT, "work-short"), null, shortLines);
	const shortTabRes = await call({ action: "recent-calls", tabRunId: shortTabId, n: 3 });
	const shortTabTxt = textOf(shortTabRes);
	ok("T10/tab-short 非 error", !shortTabRes.isError);
	ok("T10/tab-short verdict=unknown（回合不足阈值）", shortTabTxt.includes("verdict: unknown") && shortTabTxt.includes("no tool detail"));

	// async 路径：run json 环形明细。
	const asyncRes = await call({ action: "recent-calls", runId, n: 3 });
	const asyncTxt = textOf(asyncRes);
	ok("T10/async 非 error", !asyncRes.isError);
	ok("T10/async source=async", asyncTxt.includes("[source=async]"));
	ok("T10/async 含明细 tool 名", asyncTxt.includes("tool=bash") && asyncTxt.includes("tool=edit"));
	ok("T10/async verdict ok", asyncTxt.includes("verdict: ok"));
	ok("T10/async ≤1536B", by(asyncTxt) <= RECENT_CALLS_TOTAL_BYTES);
	ok("T10 缺省 n=3", textOf(await call({ action: "recent-calls", runId })).includes("[n=3/3]"));

	// async 旧记录（无 recentCalls）→ 明确 no-detail 语义（非空、isError=false、verdict unknown）。
	const ndRes = await call({ action: "recent-calls", runId: noDetailRunId, n: 3 });
	const ndTxt = textOf(ndRes);
	ok("T10 async 无明细 → verdict unknown", ndTxt.includes("verdict: unknown"));
	ok("T10 async 无明细 → isError 非 true", !ndRes.isError);
	ok("T10 async 无明细 → 非空输出", ndTxt.length > 0);

	// async 运行中（status:"running"，明细已由 onRecentCalls 增量落盘）→ 不判 no-detail，且能看出重复。
	const runningRunId = "run_test_recent_running";
	writeFileSync(join(RUNS_DIR, `${runningRunId}.json`), JSON.stringify({ id: runningRunId, agent: "implementer", task: "循环观察", status: "running", startedAt: new Date().toISOString(), lastToolTurn: 3, turnClock: 3, recentCalls: THREE_SAME }));
	const rpRes = await call({ action: "recent-calls", runId: runningRunId, n: 3 });
	const rpTxt = textOf(rpRes);
	ok("T10/running 非 error", !rpRes.isError);
	ok("T10/running verdict=repeating", rpTxt.includes("verdict: repeating"));
	ok("T10/running 不是 no-detail/unknown", !rpTxt.includes("no tool detail") && !rpTxt.includes("verdict: unknown"));
	ok("T10/running 含 ×3 证据", rpTxt.includes("×3"));

	// 不存在 → 明确 reason + isError=true（不静默空）。
	const nfRes = await call({ action: "recent-calls", runId: "run_no_such_zz" });
	ok("T10 不存在 runId → reason not-found", textOf(nfRes).includes("not-found"));
	ok("T10 不存在 runId → isError true", nfRes.isError === true);
	const tnfRes = await call({ action: "recent-calls", tabRunId: "tab_no_such_zz" });
	ok("T10 不存在 tabRunId → reason not-found", textOf(tnfRes).includes("not-found"));
	ok("T10 不存在 tabRunId → isError true", tnfRes.isError === true);

	// tab 有 dispatch 但无对应会话 → no-session（不静默空）。
	const orphanId = "tab_test_recent_orphan";
	const cwd2 = join(TMP_ROOT, "work2");
	mkdirSync(cwd2, { recursive: true });
	writeFileSync(join(TAB_RUNS_DIR, `${orphanId}.json`), JSON.stringify({ id: orphanId, version: 1, taskId: "9999", mode, cwd: cwd2, dispatchedAt: new Date().toISOString(), dispatchStatus: "dispatched" }));
	const orRes = await call({ action: "recent-calls", tabRunId: orphanId });
	ok("T10 tab 有 dispatch 无 session → reason no-session", textOf(orRes).includes("no-session"));
	ok("T10 tab 无 session → isError true", orRes.isError === true);
}

try {
	await main();
} catch (err) {
	failed++;
	console.error("T10 集成报错:", err instanceof Error ? err.stack ?? err.message : String(err));
} finally {
	try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
}
console.log(`\n_test_recent_calls: assertions=${count} failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
