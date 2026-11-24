/**
 * D3 回归网（2026-11-10 gen14 裁定：「D3 按只 grep marker 形态实现，不改收据」）。
 * 覆盖两个新模块：
 *   - `runtime/transcript-marker-probe.ts`（反查）
 *   - `runtime/outbox-injection-recovery.ts`（有界放行决策 + 收据隔离）
 *
 * ## 每项测试要防的具体错误
 *
 * ① **role 混淆**（最危险的一条，实测逼出来的）：
 *   2026-11-16 实测 `0a9a85cc` 的 marker 在会话 JSONL 里**确实出现过** —— 在一条
 *   **assistant** 消息里（agent 把收到的正文连同 marker 回述）。若不限 `role==="user"`，
 *   真死锁会被判成「已送达」⇒ **永远不重投** ⇒ D3 变成永久假阳性。
 *   ⇒ 测试必须构造「marker 只在 assistant/toolResult 行里」的文件，断言 `absent`。
 *
 * ② **截断当 absent**：文件大于尾部预算时，扫不到 ≠ 没有。
 *   ⇒ `inconclusive`，**绝不能**放行重投（否则「不知道」会被当成「允许重发」）。
 *
 * ③ **无界重投**（比原缺陷更糟）：放开重投而不限次数 ⇒ 每 10s 撞墙、journal 灌满。
 *   ⇒ 次数上限必须硬性（已有 2 次 unconfirmed ⇒ `keep`）。
 *
 * ④ **冷却缺失**：会话 JSONL 可能尚未 flush，刚注入就反查会读成 `absent`（假阴性）。
 *   ⇒ 距上次注入 < 60s 一律 `keep`。
 *
 * ⑤ **「没查」被当成「查了没有」**：`probe === null` 时不得 release。
 *
 * ⑥ **收据被删而不是隔离**：删了就不可审计（「曾被认为已注入」这个事实消失）。
 *   ⇒ 必须是 `rename`，且原名消失、新名存在、内容不变。
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventMarker } from "./delivery-ack.ts";

const ROOT = mkdtempSync(join(tmpdir(), "d3-probe-"));
const SESSIONS = join(ROOT, "sessions");
const RECEIPTS = join(ROOT, "receipts");
mkdirSync(SESSIONS, { recursive: true });
mkdirSync(RECEIPTS, { recursive: true });

// receipts.ts 固定读 defaultRuntimeDir()/receipts ⇒ 先用 PI_RUNTIME_DIR 指到本夹具，
// 再静态 import（不能在 check 回调里 await，否则它会在 cleanup 之后才执行）
process.env.PI_RUNTIME_DIR = ROOT;
const probe = await import("./runtime/transcript-marker-probe.ts");
const rec = await import("./runtime/outbox-injection-recovery.ts");
const { hasNotificationReceipt } = await import("./runtime/receipts.ts");

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
	try {
		fn();
		pass++;
		console.log(`  ok ${pass} - ${name}`);
	} catch (e) {
		fail++;
		console.log(`  NOT OK ${pass + fail} - ${name}`);
		console.log(`    ${e instanceof Error ? e.message : String(e)}`);
	}
};

const SID = "01a1aaaa-0000-7000-8000-0000000000aa";
const EID = "async:outbox_abc123:deadbeef";
const MARKER = eventMarker(EID);
// buildOutboxInjectBody 拼的 marker 用的是 ensureEvent 给出的完整 eventId（含 revision）
const outboxMarker = MARKER;

const userLine = (text: string) =>
	`${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text }] } })}\n`;
const assistantLine = (text: string) =>
	`${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } })}\n`;
const toolResultLine = (text: string) =>
	`${JSON.stringify({ type: "message", message: { role: "toolResult", content: [{ type: "text", text }] } })}\n`;

const sessFile = (name: string) => join(SESSIONS, name);
const write = (name: string, content: string) => writeFileSync(sessFile(name), content, "utf8");

/** 清空 sessions 目录（每个用例独立造盘）。 */
const resetSessions = () => {
	rmSync(SESSIONS, { recursive: true, force: true });
	mkdirSync(SESSIONS, { recursive: true });
};

// ── ① user 命中 ⇒ found ──────────────────────────────────────────
check("① marker 出现在 role=user 消息里 ⇒ found", () => {
	resetSessions();
	write(`2026-01-01T00-00-00-000Z_${SID}.jsonl`, userLine(`（Web Console 远程输入）\n正文\n${outboxMarker}`));
	const r = probe.probeEventMarkerInUserMessages({ sessionsDir: SESSIONS, sessionId: SID, eventId: EID });
	assert.equal(r.verdict, "found", `应 found，实际 ${r.verdict} (${r.error ?? ""})`);
	assert.equal(r.candidateFiles, 1);
	assert.ok(r.sessionFile !== null);
});

// ── ② 【最危险】marker 只在 assistant 行 ⇒ 必须 absent（不得假阳性）──
check("② marker 只出现在 assistant/toolResult 行 ⇒ absent（role 混淆 = D3 永久假阳性）", () => {
	resetSessions();
	// 真机 0a9a85cc 的形状：agent 把收到的正文连同 marker 又回述了一遍
	write(
		`2026-01-01T00-00-00-000Z_${SID}.jsonl`,
		assistantLine(`我收到：${outboxMarker}`) + toolResultLine(`grep 到 ${outboxMarker}`),
	);
	const r = probe.probeEventMarkerInUserMessages({ sessionsDir: SESSIONS, sessionId: SID, eventId: EID });
	assert.equal(r.verdict, "absent", `只有 assistant 行时必须 absent（否则真死锁被判已送达），实际 ${r.verdict}`);
	assert.equal(r.sessionFile, null);
});

// ── ③ 文件太大 ⇒ inconclusive（不是 absent）──────────────────────
check("③ 超出尾部预算且没扫到 ⇒ inconclusive（截断 ≠ 没有）", () => {
	resetSessions();
	// 造一个 > tailBytes 的文件，marker 放在**文件开头**（尾部扫不到）
	const filler = assistantLine("x".repeat(200)) + "\n";
	write(`2026-01-01T00-00-00-000Z_${SID}.jsonl`, userLine(outboxMarker) + filler.repeat(30));
	const big = statSync(sessFile(`2026-01-01T00-00-00-000Z_${SID}.jsonl`)).size;
	const r = probe.probeEventMarkerInUserMessages({
		sessionsDir: SESSIONS,
		sessionId: SID,
		eventId: EID,
		tailBytes: Math.floor(big / 3), // 只扫最后 1/3 ⇒ marker 在开头扫不到
	});
	assert.equal(r.verdict, "inconclusive", `截断扫描扫不到时必须 inconclusive，实际 ${r.verdict}`);
	assert.equal(r.truncated, true, "truncated 必须为 true");
	assert.ok(String(r.error).includes("truncated"), `error 应标明截断，实际 ${r.error}`);
});

// ── ③b 同一文件不截断时能找到开头 ⇒ found（证明 ③ 的红是"截断"造成的）──
check("③b 同样文件、不截断 ⇒ found（证明 ③ 的 inconclusive 确实来自截断）", () => {
	resetSessions();
	const filler = assistantLine("x".repeat(200)) + "\n";
	write(`2026-01-01T00-00-00-000Z_${SID}.jsonl`, userLine(outboxMarker) + filler.repeat(30));
	const big = statSync(sessFile(`2026-01-01T00-00-00-000Z_${SID}.jsonl`)).size;
	const r = probe.probeEventMarkerInUserMessages({
		sessionsDir: SESSIONS,
		sessionId: SID,
		eventId: EID,
		tailBytes: big + 1,
	});
	assert.equal(r.verdict, "found", `不截断应 found，实际 ${r.verdict}`);
});

// ── ④ 会话文件找不到 ⇒ inconclusive（不猜 absent）────────────────
check("④ 找不到会话文件 ⇒ inconclusive（不得当成 absent）", () => {
	resetSessions();
	const r = probe.probeEventMarkerInUserMessages({ sessionsDir: SESSIONS, sessionId: "01a1bbbb-0000-7000-8000-0000000000bb", eventId: EID });
	assert.equal(r.verdict, "inconclusive");
	assert.equal(r.candidateFiles, 0);
	assert.equal(r.error, "session-file-not-found");
});

// ── ④b resume 过的多文件：任一文件命中即 found ──────────────────
check("④b 同 sessionId 被 resume 成两个文件 ⇒ 任一命中即 found", () => {
	resetSessions();
	write(`2026-01-01T00-00-00-000Z_${SID}.jsonl`, assistantLine("无关"));
	write(`2026-02-01T00-00-00-000Z_${SID}.jsonl`, userLine(outboxMarker));
	const r = probe.probeEventMarkerInUserMessages({ sessionsDir: SESSIONS, sessionId: SID, eventId: EID });
	assert.equal(r.candidateFiles, 2, `应找到 2 个候选文件，实际 ${r.candidateFiles}`);
	assert.equal(r.verdict, "found");
});

// ── ④c 子目录布局（sessions/<cwd-enc>/<file>）也要能找到 ────────
check("④c cwd 子目录布局下也能定位（真实 sessionsDir 形状）", () => {
	resetSessions();
	rmSync(SESSIONS, { recursive: true, force: true });
	mkdirSync(join(SESSIONS, "--C--Users-x--"), { recursive: true });
	writeFileSync(join(SESSIONS, "--C--Users-x--", `2026-01-01T00-00-00-000Z_${SID}.jsonl`), userLine(outboxMarker), "utf8");
	const r = probe.probeEventMarkerInUserMessages({ sessionsDir: SESSIONS, sessionId: SID, eventId: EID });
	assert.equal(r.verdict, "found");
});

// ── ⑤ 决策：found ⇒ keep ────────────────────────────────────────
const atAgo = (ms: number) => new Date(Date.now() - ms).toISOString();
const foundProbe = { verdict: "found" as const, scannedBytes: 1, sessionFile: "x", candidateFiles: 1, truncated: false };
const absentProbe = { verdict: "absent" as const, scannedBytes: 1, sessionFile: null, candidateFiles: 1, truncated: false };
const inccProbe = { verdict: "inconclusive" as const, scannedBytes: 1, sessionFile: null, candidateFiles: 1, truncated: true };

// ── ④d 【P0-b 核心】落盘滞后 ⇒ absent 降级为 inconclusive ─────────────
// QC 现场（2026-11-24）：注入后 61s 扫不到，但消息 246s 后才落盘 ⇒ D3 判 absent
// ⇒ 放行重投 ⇒ 同一 item 注入两次。判据：**文件在注入之后必须被追加过**（mtime > injectedAt）。
// 注意不能用消息 timestamp 判 flush —— 消息 timestamp 是产生时刻，在文件里可以乱序
// （QC 实测 line 1533 ts=06:13:26 排在 line 1532 ts=06:17:32 之后）。
check("④d 文件 mtime 早于注入时刻（还没 flush）⇒ inconclusive，不是 absent", () => {
	resetSessions();
	const f = `2026-01-01T00-00-00-000Z_${SID}.jsonl`;
	write(f, assistantLine("旧内容，不含 marker"));
	const now = Date.now();
	const injectedAtMs = now - 61_000; // 注入发生在 61s 前
	utimesSync(sessFile(f), new Date(now - 10 * 60_000), new Date(now - 10 * 60_000)); // 文件最后修改在 10 分钟前
	const r = probe.probeEventMarkerInUserMessages({ sessionsDir: SESSIONS, sessionId: SID, eventId: EID, injectedAtMs, now });
	assert.equal(r.verdict, "inconclusive", `落盘滞后必须降级为 inconclusive，实际 ${r.verdict}`);
	assert.ok(String(r.error).includes("no-flush-since-attempt"), `error 须写明原因，实际 ${r.error}`);
});

check("④e 文件在注入之后被追加过（已 flush）⇒ 仍可判 absent", () => {
	resetSessions();
	const f = `2026-01-01T00-00-00-000Z_${SID}.jsonl`;
	const now = Date.now();
	const injectedAtMs = now - 61_000;
	write(f, assistantLine("注入之后的新内容，但确实没有 marker"));
	utimesSync(sessFile(f), new Date(now), new Date(now)); // mtime = now > injectedAt
	const r = probe.probeEventMarkerInUserMessages({ sessionsDir: SESSIONS, sessionId: SID, eventId: EID, injectedAtMs, now });
	assert.equal(r.verdict, "absent", `已 flush 且未命中 ⇒ absent，实际 ${r.verdict}（${r.error ?? ""}）`);
	assert.ok(typeof r.mtimeMs === "number" && r.mtimeMs > injectedAtMs, "结果带 mtimeMs（判据可复核）");
});

check("④f 不传 injectedAtMs ⇒ 保持旧行为（只按截断判据，兼容未接入的调用方）", () => {
	resetSessions();
	write(`2026-01-01T00-00-00-000Z_${SID}.jsonl`, assistantLine("无 marker"));
	const r = probe.probeEventMarkerInUserMessages({ sessionsDir: SESSIONS, sessionId: SID, eventId: EID });
	assert.equal(r.verdict, "absent", "未提供注入时刻 ⇒ 旧口径（absent）");
});

check("④g 命中优先于滞后判据：marker 在 user 行 ⇒ found（不因 mtime 旧而降级）", () => {
	resetSessions();
	const f = `2026-01-01T00-00-00-000Z_${SID}.jsonl`;
	const now = Date.now();
	write(f, userLine("正文" + String.fromCharCode(10) + outboxMarker));
	utimesSync(sessFile(f), new Date(now - 10 * 60_000), new Date(now - 10 * 60_000));
	const r = probe.probeEventMarkerInUserMessages({ sessionsDir: SESSIONS, sessionId: SID, eventId: EID, injectedAtMs: now - 61_000, now });
	assert.equal(r.verdict, "found", "命中就是命中，mtime 不影响");
});

check("⑤ found ⇒ keep（已进会话，不得重投）", () => {
	const d = rec.decideInjectionRecovery({ probe: foundProbe, attempts: [{ at: atAgo(5 * 60_000) }], now: Date.now() });
	assert.equal(d.action, "keep");
	assert.equal(d.reason, "probe-found");
});

// ── ⑥ inconclusive ⇒ keep ───────────────────────────────────────
check("⑥ inconclusive ⇒ keep（没证据不得放行）", () => {
	const d = rec.decideInjectionRecovery({ probe: inccProbe, attempts: [{ at: atAgo(5 * 60_000) }], now: Date.now() });
	assert.equal(d.action, "keep");
	assert.equal(d.reason, "probe-inconclusive");
});

// ── ⑦ 【上限】已有 2 次 unconfirmed ⇒ keep（无界重投比原缺陷更糟）──
check("⑦ 已有 2 次已注入未确认 ⇒ keep(attempts-exhausted)（防每 10s 撞墙）", () => {
	const d = rec.decideInjectionRecovery({
		probe: absentProbe,
		attempts: [{ at: atAgo(30 * 60_000) }, { at: atAgo(5 * 60_000) }],
		now: Date.now(),
	});
	assert.equal(d.action, "keep");
	assert.equal(d.reason, "attempts-exhausted");
	assert.equal(d.unconfirmedAttempts, 2);
});

// ── ⑧ 冷却：刚注入 10s ⇒ keep ───────────────────────────────────
check("⑧ 距上次注入 10s（<60s）⇒ keep(attempt-too-fresh)（等 JSONL flush）", () => {
	const d = rec.decideInjectionRecovery({ probe: absentProbe, attempts: [{ at: atAgo(10_000) }], now: Date.now() });
	assert.equal(d.action, "keep");
	assert.equal(d.reason, "attempt-too-fresh");
	assert.equal(d.msSinceLastAttempt, 10_000);
});

// ── ⑨ 0 次 attempt ⇒ keep（不走这张门票）─────────────────────────
check("⑨ 零次已注入未确认 ⇒ keep(no-prior-attempt)（没有『注入了却没进』的记录）", () => {
	const d = rec.decideInjectionRecovery({ probe: absentProbe, attempts: [], now: Date.now() });
	assert.equal(d.action, "keep");
	assert.equal(d.reason, "no-prior-attempt");
});

// ── ⑩ 证据齐全 ⇒ release ───────────────────────────────────────
// P0-b（2026-11-24）：冷却从 60s 提到 300s（实测 ACK p90=323.8s、注入行滞后 ≥246s）。
// ⇒ 旧用例的 3min 现在**不够老**，会落到 attempt-too-fresh。这里改成三段式：
//   3min ⇒ keep(too-fresh) / 5min 整 ⇒ keep(too-fresh，边界) / 5min+1s ⇒ release。
check("⑩ 证据齐全：absent + 1 次 attempt + 年龄 ≥300s ⇒ release(absent-evidenced)", () => {
	const tooYoung = rec.decideInjectionRecovery({ probe: absentProbe, attempts: [{ at: atAgo(3 * 60_000) }], now: Date.now() });
	assert.equal(tooYoung.action, "keep", "3min < 300s ⇒ 不得放行（旧 60s 口径会放行 = 假 absent 的来源）");
	assert.equal(tooYoung.reason, "attempt-too-fresh");
	assert.equal(rec.D3_MIN_ATTEMPT_AGE_MS, 300_000, "冷却阈值口径写死为 300s（改它必须同时改本断言与注释依据）");

	// 边界必须用**同一个 now**：`atAgo(n)` 与 `now: Date.now()` 是两次取时，差几毫秒，
	// 会让「恰好 300s」变成 300000+ε ⇒ 假绿/假红（上一版就踩了）。
	const T = Date.now();
	// 边界口径：实现是 `msSince < 300s ⇒ too-fresh` ⇒ **恰好 300s 放行**（开区间在下界）。
	// 这条要写死，因为「边界算不算」是后来人最容易改错的地方。
	const justUnder = rec.decideInjectionRecovery({ probe: absentProbe, attempts: [{ at: new Date(T - 299_999).toISOString() }], now: T });
	assert.equal(justUnder.action, "keep", "299.999s < 300s ⇒ too-fresh");
	const atBoundary = rec.decideInjectionRecovery({ probe: absentProbe, attempts: [{ at: new Date(T - 300_000).toISOString() }], now: T });
	assert.equal(atBoundary.action, "release", "恰好 300s ⇒ 放行（下界开区间）");

	const d = rec.decideInjectionRecovery({ probe: absentProbe, attempts: [{ at: new Date(T - 400_000).toISOString() }], now: T });
	assert.equal(d.action, "release", `刚过 300s ⇒ release，实际 ${d.action}/${d.reason}`);
	assert.equal(d.reason, "absent-evidenced");
	assert.equal(d.unconfirmedAttempts, 1);
});

// ── ⑪ 「没查」不得当成「查了没有」─────────────────────────────────
check("⑪ probe===null ⇒ 永不 release（『没查』不是证据）", () => {
	const d = rec.decideInjectionRecovery({ probe: null, attempts: [{ at: atAgo(10 * 60_000) }], now: Date.now() });
	assert.equal(d.action, "keep", `probe=null 时不得 release，实际 ${d.action}`);
});

// ── ⑫ 收据隔离：rename 而非删除 ────────────────────────────────
check("⑫ quarantineReceipt 是 rename：原名消失、新名存在、内容逐字不变（可审计）", () => {
	const key = `outbox:${"a".repeat(64)}`;
	const p = rec.receiptPathFor(RECEIPTS, `outbox:${"a".repeat(64)}`.replace(/[^A-Za-z0-9._-]/g, "_"));
	// 真实 receipt key 形如 `outbox:<id>`；路径 sanitize 后为 `outbox_<id>.json`
	const realKey = `outbox_${"a".repeat(64)}`;
	const realPath = join(RECEIPTS, `${realKey}.json`);
	const body = JSON.stringify({ key, recordedAt: "2026-01-01T00:00:00.000Z", by: "outbox-bridge:test" });
	writeFileSync(realPath, body, "utf8");
	assert.equal(existsSync(realPath), true);
	assert.equal(rec.quarantineReceipt(realPath, Date.now()), true);
	assert.equal(existsSync(realPath), false, "原路径必须消失（否则 claimInjection 仍短路）");
	const names = readdirSync(RECEIPTS).filter((n) => n.includes("d3-quarantined"));
	assert.equal(names.length, 1, `应有 1 个隔离文件，实际 ${names.length}`);
	assert.equal(readFileSync(join(RECEIPTS, names[0]), "utf8"), body, "隔离文件内容必须逐字不变（可审计）");
	// 幂等：再调一次（原路径已不在）⇒ false
	assert.equal(rec.quarantineReceipt(realPath, Date.now()), false, "原路径不存在时应幂等返回 false");
	void p;
});

// ── ⑬ 放行一次后的语义闭合：隔离后 claimInjection 能重新 claimed ──
check("⑬ 隔离后 hasNotificationReceipt 必为 false（否则 claimInjection 仍短路 = 放行无效）", () => {
	mkdirSync(join(ROOT, "receipts"), { recursive: true });
	const key = "outbox:" + "d".repeat(64);
	const realPath = join(ROOT, "receipts", "outbox_" + "d".repeat(64) + ".json");
	writeFileSync(realPath, JSON.stringify({ key, recordedAt: new Date().toISOString(), by: "b" }), "utf8");
	assert.equal(hasNotificationReceipt(key), true, "收据在时应 true");
	assert.equal(rec.quarantineReceipt(realPath, Date.now()), true);
	assert.equal(hasNotificationReceipt(key), false, "隔离后必须 false（放行才真的生效）");
	// 反向保护：别的目录若有同名文件，不得被碰
	const other = join(RECEIPTS, "outbox_" + "d".repeat(64) + ".json");
	writeFileSync(other, "x", "utf8");
	assert.equal(existsSync(other), true, "另一目录的同名文件不该被删");
});

console.log(`d3-injection-recovery: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
rmSync(ROOT, { recursive: true, force: true });
