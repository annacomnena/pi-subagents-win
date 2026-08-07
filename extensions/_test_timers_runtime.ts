import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pumpDueTimers } from "./timers-runtime.ts";
import { readTimerFile, validateTimerRecord, writeTimerAtomic } from "./timers.ts";

// ── fake pi（只实现 sendUserMessage，记录调用）────────────────────
function makeFakePi() {
	const calls: Array<{ content: string; opts: unknown }> = [];
	return {
		calls,
		sendUserMessage: (content: string, opts?: { deliverAs?: string }) => {
			calls.push({ content, opts });
		},
	};
}

const dir = mkdtempSync(join(tmpdir(), "timers-runtime-test-"));

function makeTimer(overrides: Record<string, unknown>) {
	const raw = {
		id: "timer_rt_1",
		version: 1,
		dueAt: new Date(Date.now() - 1000).toISOString(),
		message: "检查批次结果并继续",
		target: "self",
		source: "test",
		status: "pending",
		createdAt: new Date().toISOString(),
		...overrides,
	};
	const check = validateTimerRecord(raw);
	assert.ok(check.ok, JSON.stringify(check.errors));
	return check.value!;
}

// ── 到期触发：一条 timer → 一条用户消息 ───────────────────────────
{
	const pi = makeFakePi();
	writeTimerAtomic(dir, makeTimer({ id: "t_fire1" }));

	const outcomes = pumpDueTimers(pi, dir);
	assert.equal(outcomes.length, 1);
	assert.equal(outcomes[0]?.fired, true);
	assert.equal(pi.calls.length, 1, "到期应注入一条用户消息");
	assert.ok(pi.calls[0]?.content.startsWith("⏰ Timer fired"), pi.calls[0]?.content);
	assert.ok(pi.calls[0]?.content.includes("检查批次结果并继续"), "消息应包含用户指令");
	assert.deepEqual(pi.calls[0]?.opts, { deliverAs: "followUp" }, "忙碌时应 followUp 排队");

	// 磁盘状态 fired
	assert.equal(readTimerFile(dir, "t_fire1")?.status, "fired");

	// 再次 pump → 不重复触发（防双发）
	const again = pumpDueTimers(pi, dir);
	assert.equal(again.length, 0);
	assert.equal(pi.calls.length, 1, "重复 pump 不得重复发消息");
}

// ── 未到期 → 不触发 ───────────────────────────────────────────────
{
	const pi = makeFakePi();
	writeTimerAtomic(dir, makeTimer({ id: "t_notdue", dueAt: new Date(Date.now() + 60_000).toISOString() }));
	const outcomes = pumpDueTimers(pi, dir);
	assert.equal(outcomes.length, 0);
	assert.equal(pi.calls.length, 0);
}

// ── 晚发：pi 未运行期间已到期 → firedLate 标记并补发 ─────────────
{
	const pi = makeFakePi();
	writeTimerAtomic(dir, makeTimer({
		id: "t_late",
		dueAt: new Date(Date.now() - 2 * 60_000).toISOString(), // 2 分钟前到期
	}));
	const outcomes = pumpDueTimers(pi, dir);
	assert.equal(outcomes[0]?.fired, true);
	assert.equal(outcomes[0]?.record?.firedLate, true, "晚发应标记 firedLate");
	assert.ok(pi.calls[0]?.content.includes("晚发"), "消息应带 [晚发] 标记");
}

// ── repeat：触发后重置为 pending，下次到期再触发 ─────────────────
{
	const pi = makeFakePi();
	const repeatMs = 60_000;
	writeTimerAtomic(dir, makeTimer({ id: "t_repeat", repeatMs }));

	pumpDueTimers(pi, dir);
	assert.equal(pi.calls.length, 1);

	// 磁盘回到 pending，dueAt 为 now + repeatMs
	const after = readTimerFile(dir, "t_repeat");
	assert.equal(after?.status, "pending", "repeat timer 触发后应回到 pending");
	assert.ok(after && Date.parse(after.dueAt) > Date.now() - 1000, "dueAt 应重置为将来");

	// 未到新 dueAt → 不再触发
	pumpDueTimers(pi, dir);
	assert.equal(pi.calls.length, 1);

	// 手动把 dueAt 拨回过去 → 第二次触发（模拟周期重发）
	const back = makeTimer({ id: "t_repeat", repeatMs, dueAt: new Date(Date.now() - 1000).toISOString() });
	writeTimerAtomic(dir, back);
	pumpDueTimers(pi, dir);
	assert.equal(pi.calls.length, 2, "周期 timer 应可再次触发");
}

// ── 邮箱作用域：只 pump 自己的邮箱 ────────────────────────────────
{
	const pi = makeFakePi();
	const TAB = "tab_scope_1";
	writeTimerAtomic(dir, makeTimer({ id: "t_mail1", target: { tabRunId: TAB } }), { tabRunId: TAB });

	// 无 tabRunId → 不触发邮箱 timer
	pumpDueTimers(pi, dir);
	assert.equal(pi.calls.length, 0);

	// 指定 tabRunId → 触发
	pumpDueTimers(pi, dir, TAB);
	assert.equal(pi.calls.length, 1);
	assert.ok(pi.calls[0]?.content.startsWith("⏰ Timer fired"));
	assert.equal(readTimerFile(dir, "t_mail1", TAB)?.status, "fired");
}

// ── 清理 ──────────────────────────────────────────────────────────
rmSync(dir, { recursive: true, force: true });

console.log("timers-runtime tests passed");
