import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	MAX_PENDING_TIMERS,
	MAX_TIMER_MESSAGE,
	MIN_REPEAT_MS,
	cancelTimerFile,
	casFireTimer,
	collectDueTimers,
	countPending,
	defaultTimersDir,
	dueAtFromDelay,
	isDue,
	isLate,
	listTimerFiles,
	mailboxDirForTab,
	newTimerId,
	readAllTimers,
	readTimerFile,
	remainingMs,
	timerFilePath,
	validateTimerRecord,
	writeTimerAtomic,
} from "./timers.ts";

// ── 临时账本目录 ──────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), "timers-test-"));
const TAB_A = "tab_abc123_x1";

function sampleTimer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "timer_abc123_x1",
		version: 1,
		dueAt: new Date(Date.now() + 60_000).toISOString(),
		message: "检查批次结果并继续",
		target: "self",
		source: "test",
		status: "pending",
		createdAt: new Date().toISOString(),
		...overrides,
	};
}

// ── id / 路径 ─────────────────────────────────────────────────────
{
	const a = newTimerId(new Date(1786000000000));
	const b = newTimerId(new Date(1786000000000));
	assert.ok(a.startsWith("timer_"), `timer id prefix: ${a}`);
	assert.notEqual(a, b, "timer ids must be unique");

	assert.equal(defaultTimersDir("C:\\x\\agent"), join("C:\\x\\agent", "timers"));
	assert.equal(mailboxDirForTab("C:\\x\\timers", TAB_A), join("C:\\x\\timers", "mail", TAB_A));
	assert.equal(timerFilePath("C:\\x\\timers", "t1"), join("C:\\x\\timers", "t1.json"));
	assert.equal(timerFilePath("C:\\x\\timers", "t1", TAB_A), join("C:\\x\\timers", "mail", TAB_A, "t1.json"));

	assert.equal(dueAtFromDelay(5_000, new Date(1786000000000)), new Date(1786000005000).toISOString());
	assert.equal(dueAtFromDelay(-100, new Date(1786000000000)), new Date(1786000000000).toISOString());
}

// ── 校验 ──────────────────────────────────────────────────────────
{
	const ok = validateTimerRecord(sampleTimer());
	assert.equal(ok.ok, true, JSON.stringify(ok.errors));
	assert.equal(ok.value?.target, "self");

	// 邮箱 target
	const mail = validateTimerRecord(sampleTimer({ target: { tabRunId: TAB_A, taskId: "219" } }));
	assert.equal(mail.ok, true);
	assert.deepEqual(mail.value?.target, { tabRunId: TAB_A, taskId: "219" });

	// 错误 target
	assert.equal(validateTimerRecord(sampleTimer({ target: { foo: "bar" } })).ok, false);
	assert.equal(validateTimerRecord(sampleTimer({ target: 42 })).ok, false);

	// 非法 status
	assert.equal(validateTimerRecord(sampleTimer({ status: "running" })).ok, false);
	// 非法 dueAt
	assert.equal(validateTimerRecord(sampleTimer({ dueAt: "not-a-date" })).ok, false);
	// 超长 message
	assert.equal(validateTimerRecord(sampleTimer({ message: "x".repeat(MAX_TIMER_MESSAGE + 1) })).ok, false);
	// repeatMs 过小
	assert.equal(validateTimerRecord(sampleTimer({ repeatMs: MIN_REPEAT_MS - 1 })).ok, false);
	assert.equal(validateTimerRecord(sampleTimer({ repeatMs: MIN_REPEAT_MS })).ok, true);
	// 非对象
	assert.equal(validateTimerRecord("nope").ok, false);
	assert.equal(validateTimerRecord(null).ok, false);
}

// ── 到期 / 晚发判定 ───────────────────────────────────────────────
{
	const now = new Date(1786000000000);
	const dueSoon = validateTimerRecord(sampleTimer({ dueAt: new Date(now.getTime() - 1).toISOString() })).value!;
	const dueLater = validateTimerRecord(sampleTimer({ dueAt: new Date(now.getTime() + 5000).toISOString() })).value!;

	assert.equal(isDue(dueSoon, now), true);
	assert.equal(isDue(dueLater, now), false);
	assert.equal(isDue({ ...dueSoon, status: "fired" }, now), false, "fired 不再到期");
	assert.ok(remainingMs(dueLater, now) === 5000);

	// 晚发：超出 grace
	assert.equal(isLate(dueSoon, new Date(now.getTime() + 30_001), 30_000), true);
	assert.equal(isLate(dueSoon, now, 30_000), false);
}

// ── 原子写 + 读 ───────────────────────────────────────────────────
{
	const timer = validateTimerRecord(sampleTimer()).value!;
	writeTimerAtomic(dir, timer);
	assert.equal(existsSync(join(dir, "timer_abc123_x1.json")), true);
	const back = readTimerFile(dir, "timer_abc123_x1");
	assert.deepEqual(back, timer);
	assert.equal(existsSync(join(dir, "timer_abc123_x1.json.tmp")), false, "tmp 文件应已 rename 消失");

	// 损坏文件 → null
	writeFileSync(join(dir, "broken.json"), "{not json", "utf8");
	assert.equal(readTimerFile(dir, "broken"), null);
	rmSync(join(dir, "broken.json"), { force: true });
}

// ── CAS claim（防双发）────────────────────────────────────────────
{
	const timer = validateTimerRecord(sampleTimer({ id: "timer_claim1", dueAt: new Date(Date.now() - 1000).toISOString() })).value!;
	writeTimerAtomic(dir, timer);

	const fired1 = casFireTimer(dir, "timer_claim1");
	assert.ok(fired1, "第一次 claim 应成功");
	assert.equal(fired1?.status, "fired");
	assert.ok(fired1?.firedAt, "应记录 firedAt");

	// 第二次 claim → null（已 fired）
	assert.equal(casFireTimer(dir, "timer_claim1"), null, "重复 claim 必须返回 null");
	// 磁盘上是 fired
	assert.equal(readTimerFile(dir, "timer_claim1")?.status, "fired");

	// cancelled 不能再 fire
	const c = validateTimerRecord(sampleTimer({ id: "timer_claim2" })).value!;
	writeTimerAtomic(dir, c);
	cancelTimerFile(dir, "timer_claim2");
	assert.equal(casFireTimer(dir, "timer_claim2"), null);
}

// ── 取消 ──────────────────────────────────────────────────────────
{
	const timer = validateTimerRecord(sampleTimer({ id: "timer_cancel1" })).value!;
	writeTimerAtomic(dir, timer);
	const cancelled = cancelTimerFile(dir, "timer_cancel1");
	assert.equal(cancelled?.status, "cancelled");
	// 取消后再取消 → null
	assert.equal(cancelTimerFile(dir, "timer_cancel1"), null);
}

// ── 邮箱（tab target）─────────────────────────────────────────────
{
	const mailTimer = validateTimerRecord(sampleTimer({ id: "timer_mail1", target: { tabRunId: TAB_A, taskId: "219" } })).value!;
	writeTimerAtomic(dir, mailTimer, { tabRunId: TAB_A });

	// 只在自己的邮箱里
	assert.equal(readTimerFile(dir, "timer_mail1"), null, "self 账本不应看到邮箱 timer");
	assert.deepEqual(readTimerFile(dir, "timer_mail1", TAB_A), mailTimer);
	assert.deepEqual(listTimerFiles(dir, TAB_A), ["timer_mail1"]);
	assert.equal(listTimerFiles(dir, "tab_other_y2").length, 0, "其他 tab 看不到该邮箱");

	// 邮箱 CAS
	casFireTimer(dir, "timer_mail1", { tabRunId: TAB_A });
	assert.equal(readTimerFile(dir, "timer_mail1", TAB_A)?.status, "fired");
}

// ── 聚合：collectDueTimers / countPending ─────────────────────────
{
	// 清空上一个子目录已有的？—— 用独立子目录隔离本块断言
	const sub = join(dir, "sub");
	const subTimer = (id: string, dueAt: string) => validateTimerRecord(sampleTimer({ id, dueAt })).value!;
	writeTimerAtomic(sub, subTimer("t_due", new Date(Date.now() - 1000).toISOString()));
	writeTimerAtomic(sub, subTimer("t_later", new Date(Date.now() + 60_000).toISOString()));
	writeTimerAtomic(sub, { ...subTimer("t_fired", new Date(Date.now() - 1000).toISOString()), status: "fired", firedAt: new Date().toISOString() });

	const due = collectDueTimers(sub);
	assert.deepEqual(due.map((t) => t.id).sort(), ["t_due"], "只有 pending 且到期的才算 due");

	assert.equal(countPending(sub), 2, "pending 计数不含 fired");
	assert.equal(MAX_PENDING_TIMERS, 50, "上限常量不变");
}

console.log("timers tests passed");
