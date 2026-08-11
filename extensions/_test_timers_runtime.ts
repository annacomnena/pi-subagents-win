import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pumpDueTimers } from "./timers-runtime.ts";
import { readTimerFile, validateTimerRecord, writeTimerAtomic, type TimerRecord } from "./timers.ts";

// P0-1：隔离进程环境（PI_SUBAGENT=1 时 pumpDueTimers 的调用方身份语义会被测试污染）
delete process.env.PI_SUBAGENT;
delete process.env.PI_TAB_RUN_ID;
delete process.env.PI_TAB_RUNS_DIR;

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
		ownerCwd: process.cwd(), // 修复后 root timer 必须带所有权目录
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

	// 磁盘状态 fired + P2-3：fireCount 累计
	const firedRec = readTimerFile(dir, "t_fire1");
	assert.equal(firedRec?.status, "fired");
	assert.equal(firedRec?.fireCount, 1, "首次触发 fireCount=1");
	assert.ok(firedRec?.lastFiredAt, "应记录 lastFiredAt");

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

	// 手动把 dueAt 拨回过去 → 第二次触发（模拟周期重发）+ P2-3 fireCount 保留
	const cur = readTimerFile(dir, "t_repeat");
	assert.ok(cur, "repeat timer 应在磁盘上为 pending");
	const back: TimerRecord = { ...cur, dueAt: new Date(Date.now() - 1000).toISOString() };
	writeTimerAtomic(dir, back);
	pumpDueTimers(pi, dir);
	assert.equal(pi.calls.length, 2, "周期 timer 应可再次触发");
	const after2 = readTimerFile(dir, "t_repeat");
	assert.equal(after2?.status, "pending");
	assert.equal(after2?.fireCount, 2, "第二次周期触发后 fireCount=2");
	assert.ok(after2?.lastFiredAt, "lastFiredAt 应保留");
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

// ── 所有权隔离：跨目录的 identityless 进程不得抢 root timer ──────
{
	const pi = makeFakePi();
	const OTHER = "G:\\other\\dir";
	writeTimerAtomic(dir, makeTimer({ id: "t_other_owned", ownerCwd: OTHER }));

	// 本进程 cwd 不匹配 → 不消费
	pumpDueTimers(pi, dir);
	assert.equal(pi.calls.length, 0, "跨目录 root timer 不得被消费");
	assert.equal(readTimerFile(dir, "t_other_owned")?.status, "pending", "不得被 claim");

	// 匹配 cwd 的进程 → 消费
	pumpDueTimers(pi, dir, { cwd: OTHER });
	assert.equal(pi.calls.length, 1, "匹配所有权目录的进程应消费");
	assert.equal(readTimerFile(dir, "t_other_owned")?.status, "fired");
}

// ── 旧账本（无 ownerCwd）：一律不消费（宁可静默，不投错对话）────
{
	const pi = makeFakePi();
	writeTimerAtomic(dir, makeTimer({ id: "t_legacy", ownerCwd: undefined }));

	pumpDueTimers(pi, dir);
	assert.equal(pi.calls.length, 0, "旧账本 root timer 不得消费");
	assert.equal(readTimerFile(dir, "t_legacy")?.status, "pending");
}

// ── repeat 所有权重新盖章：消费后 ownerSessionId 更新为当前会话 ──
{
	const pi = makeFakePi();
	writeTimerAtomic(dir, makeTimer({
		id: "t_reseat",
		repeatMs: 60_000,
		ownerSessionId: "session-old",
	}));

	pumpDueTimers(pi, dir, { cwd: process.cwd(), sessionId: "session-new" });
	assert.equal(pi.calls.length, 1);
	const after = readTimerFile(dir, "t_reseat");
	assert.equal(after?.status, "pending");
	assert.equal(after?.ownerSessionId, "session-new", "repeat 消费后应重新盖章所有权");
}

// ── registerTimers：调度器推迟到 session_start（工厂零后台资源）──────
{
	const { registerTimers } = await import("./timers-runtime.ts");
	const handlers: Record<string, Array<() => void>> = {};
	const makePi = () => ({
		on: (evt: string, h: () => void) => { (handlers[evt] ??= []).push(h); },
		registerTool: () => {},
		registerCommand: () => {},
		sendUserMessage: (_c: string, _o?: unknown) => {},
	});

	// 非子 agent：注册 session_start handler，返回 cleanup
	delete process.env.PI_SUBAGENT;
	const cleanup = registerTimers(makePi() as never);
	assert.ok(typeof cleanup === "function", "registerTimers 应返回 cleanup");
	assert.ok((handlers["session_start"] ?? []).length >= 1, "应在 session_start 注册调度器");
	cleanup?.();

	// 子 agent：handler 仍注册但内部 isSubagent 检查跳过调度（工厂不返回调度器启动）
	process.env.PI_SUBAGENT = "1";
	const cleanupSub = registerTimers(makePi() as never);
	assert.ok(typeof cleanupSub === "function", "子 agent 也返回 cleanup（幂等安全）");
	cleanupSub?.();
	delete process.env.PI_SUBAGENT;
}

// ── 清理 ──────────────────────────────────────────────────────────
rmSync(dir, { recursive: true, force: true });

console.log("timers-runtime tests passed");
