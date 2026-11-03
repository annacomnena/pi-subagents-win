/**
 * _test_outbox_target_dead.ts — B：目标会话已死时，消息必须快速失败而不是静默卡 24h。
 *
 * ## 真机事故（2026-11-03）
 *
 * GUI 里发 3 条消息，界面永远显示「已提交等待注入」。实际：
 * ```
 * outbox: 3 条 status=pending（02:17 / 02:29 / 02:46）
 * 目标会话 01a18af1：scope-liveness 心跳停在 16:22（10 小时前），pid 81516 早已消失
 * OUTBOX_PENDING_TTL_MS = 24h  ⇒ 还要再等 14 小时才会变 expired
 * ```
 * 中间 10 小时是**完全静默**的 —— 用户看不出是「目标没了」还是「排队中」。
 *
 * ## 判据
 *
 * A. 判定表：pid 死 / 心跳超龄 / pid 复用 各自必须判 dead；凭证不足必须判 unknown
 * B. 宽限期：刚发的消息不因目标死立刻杀（避开正常重启窗口）
 * C. 端到端：过宽限 + 目标死 ⇒ 标 failed 且带可读原因
 * D. 不冤枉：目标活 / 探针 unknown ⇒ 一律不动
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = mkdtempSync(join(tmpdir(), "target-dead-"));
process.env.PI_RUNTIME_DIR = ROOT;

const {
	outboxDir,
	newOutboxItem,
	writeOutboxItem,
	readOutboxItem,
	outboxItemId,
	listOutboxItems,
	sweepTargetDeadOutboxItems,
	OUTBOX_TARGET_DEAD_GRACE_MS,
} = await import("./runtime/message-outbox.ts");
const { probeTargetSessionLiveness, TARGET_HEARTBEAT_STALE_MS } = await import("./runtime/outbox-target-liveness.ts");

const STATE = join(ROOT, "state");
const DIR = outboxDir(STATE);
const SCOPE_DIR = join(STATE, "scope-liveness");
mkdirSync(DIR, { recursive: true });
mkdirSync(SCOPE_DIR, { recursive: true });

let passed = 0;
const check = (name: string, fn: () => void): void => {
	try {
		fn();
		passed += 1;
		console.log(`  ✓ ${name}`);
	} catch (e) {
		console.error(`  ✗ ${name}`);
		console.error(`    ${e instanceof Error ? e.message : String(e)}`);
		throw e;
	}
};

/** 写一条 scope-liveness 心跳记录。 */
function seedLiveness(scopeKey: string, sessionId: string, pid: number, updatedAt: string): void {
	writeFileSync(
		join(SCOPE_DIR, `${scopeKey}.json`),
		JSON.stringify(
			{
				version: 1,
				scopeKey,
				sessionId,
				generation: 20,
				pid,
				startedAt: "2026-11-02T01:00:00.000Z",
				updatedAt,
			},
			null,
			2,
		),
		"utf8",
	);
}

/** 每组用独立目录：sweep 是全目录扫，共用目录会让前几组遗留的 pending 项被一起标。 */
let dirSeq = 0;
function freshDir(): string {
	dirSeq += 1;
	const d = join(ROOT, `ob-${dirSeq}`);
	mkdirSync(d, { recursive: true });
	return d;
}

/** 往指定目录写一条 pending 项。 */
function seedItemIn(dir: string, key: string, sessionId: string, createdAt: string): string {
	const it = newOutboxItem({
		dedupeKey: key,
		commandKey: key,
		to: `pi://${sessionId}` as never,
		sessionId,
		text: `测试消息 ${key}`,
		now: new Date(createdAt),
	});
	writeOutboxItem(dir, it);
	return it.id;
}

function seedItem(key: string, sessionId: string, createdAt: string): string {
	const it = newOutboxItem({
		dedupeKey: key,
		commandKey: key,
		to: `pi://${sessionId}` as never,
		sessionId,
		text: `测试消息 ${key}`,
		now: new Date(createdAt),
	});
	writeOutboxItem(DIR, it);
	return it.id;
}

console.log("\nA. 判定表（三源交叉）");

check("A1 pid 死 ⇒ dead（最硬证据，心跳再新也没用）", () => {
	seedLiveness("sc-a1", "sess-a1", 999999, new Date().toISOString()); // 心跳新鲜
	const p = probeTargetSessionLiveness("sess-a1", {
		stateDir: STATE,
		probePid: () => ({ state: "dead", basis: "test" }),
	});
	assert.equal(p.state, "dead", `应为 dead，实际 ${p.state}（${p.basis}）`);
});

check("A2 pid 活 + 心跳新鲜 ⇒ alive", () => {
	seedLiveness("sc-a2", "sess-a2", 1234, new Date().toISOString());
	const p = probeTargetSessionLiveness("sess-a2", {
		stateDir: STATE,
		probePid: () => ({ state: "alive", basis: "test" }),
	});
	assert.equal(p.state, "alive", `应为 alive，实际 ${p.state}（${p.basis}）`);
});

check("A3 pid 活 + 心跳超龄 ⇒ dead（PID 复用：那个号已经不是它了）", () => {
	const staleAt = new Date(Date.now() - TARGET_HEARTBEAT_STALE_MS - 60_000).toISOString();
	seedLiveness("sc-a3", "sess-a3", 5678, staleAt);
	const p = probeTargetSessionLiveness("sess-a3", {
		stateDir: STATE,
		probePid: () => ({ state: "alive", basis: "test" }),
	});
	assert.equal(p.state, "dead", `应为 dead（pid 复用），实际 ${p.state}（${p.basis}）`);
	assert.match(p.basis, /reused|hung/, `basis 应指明 PID 复用，实际 ${p.basis}`);
});

check("A4 pid unknown + 心跳超龄 ⇒ dead（查不到进程 + 久无心跳）", () => {
	const staleAt = new Date(Date.now() - TARGET_HEARTBEAT_STALE_MS - 60_000).toISOString();
	seedLiveness("sc-a4", "sess-a4", 4321, staleAt);
	const p = probeTargetSessionLiveness("sess-a4", {
		stateDir: STATE,
		probePid: () => ({ state: "unknown", basis: "test" }),
	});
	assert.equal(p.state, "dead", `应为 dead，实际 ${p.state}（${p.basis}）`);
});

check("A5 没有心跳记录 ⇒ unknown（不猜）", () => {
	const p = probeTargetSessionLiveness("sess-nonexistent", {
		stateDir: STATE,
		probePid: () => ({ state: "dead", basis: "test" }),
	});
	assert.equal(p.state, "unknown", `无记录时不得判死，实际 ${p.state}（${p.basis}）`);
});

check("A6 pid unknown + 心跳新鲜 ⇒ unknown（宁漏不枉）", () => {
	seedLiveness("sc-a6", "sess-a6", 1111, new Date().toISOString());
	const p = probeTargetSessionLiveness("sess-a6", {
		stateDir: STATE,
		probePid: () => ({ state: "unknown", basis: "test" }),
	});
	assert.equal(p.state, "unknown", `应为 unknown，实际 ${p.state}（${p.basis}）`);
});

check("A7 探针抛异常 ⇒ unknown（never-throw）", () => {
	seedLiveness("sc-a7", "sess-a7", 2222, new Date().toISOString());
	const p = probeTargetSessionLiveness("sess-a7", {
		stateDir: STATE,
		probePid: () => {
			throw new Error("boom");
		},
	});
	assert.equal(p.state, "unknown", `探针抛异常应为 unknown，实际 ${p.state}`);
});

console.log("\nB. 宽限期（不冤枉正在重启的会话）");

check("B1 刚发的消息（宽限期内）即使目标死也不杀", () => {
	const now = new Date("2026-11-03T10:00:00.000Z");
	const justNow = new Date(now.getTime() - 60_000).toISOString(); // 1 分钟前
	const d = freshDir();
	const id = seedItemIn(d, "wechat:b1", "sess-dead-b1", justNow);
	seedLiveness("sc-b1", "sess-dead-b1", 999999, justNow);

	const out = sweepTargetDeadOutboxItems(d, {
		probe: () => ({ state: "dead", basis: "test" }),
		now,
		by: "test",
	});
	assert.equal(out.length, 0, `宽限期内不得杀，实际杀了 ${out.length} 条`);
	assert.equal(readOutboxItem(d, id)?.status, "pending", "应仍为 pending");
});

check("B2 默认宽限期是 10 分钟", () => {
	assert.equal(OUTBOX_TARGET_DEAD_GRACE_MS, 10 * 60 * 1000, "缺省宽限期应为 10min");
});

console.log("\nC. 端到端：过宽限 + 目标死 ⇒ failed 带可读原因");

check("C1 超宽限 + 目标死 ⇒ 标 failed(reason=target-session-dead)", () => {
	const now = new Date("2026-11-03T10:00:00.000Z");
	const old = new Date(now.getTime() - 60 * 60_000).toISOString(); // 1 小时前
	const d = freshDir();
	const id = seedItemIn(d, "wechat:c1", "sess-dead-c1", old);

	const out = sweepTargetDeadOutboxItems(d, {
		probe: () => ({ state: "dead", basis: "pid-dead(81516,enumerate)" }),
		now,
		by: "test",
	});
	assert.equal(out.length, 1, `应杀 1 条，实际 ${out.length}`);
	const after = readOutboxItem(d, id);
	assert.equal(after?.status, "failed", `应标 failed，实际 ${after?.status}`);
	assert.ok(
		(after?.error ?? "").includes("目标会话已结束"),
		`error 应是可读原因，实际 ${after?.error}`,
	);
});

check("C2 failed 是终态，重复扫不再迁移（幂等）", () => {
	const now = new Date("2026-11-03T10:05:00.000Z");
	const d = freshDir();
	const old = new Date(now.getTime() - 60 * 60_000).toISOString();
	const id = seedItemIn(d, "wechat:c2", "sess-dead-c2", old);
	sweepTargetDeadOutboxItems(d, { probe: () => ({ state: "dead", basis: "t" }), now, by: "test" });
	const out = sweepTargetDeadOutboxItems(d, {
		probe: () => ({ state: "dead", basis: "test" }),
		now,
		by: "test",
	});
	assert.equal(out.length, 0, `终态不得再迁移，实际 ${out.length}`);
});

console.log("\nD. 不冤枉（这条最关键 —— 宁可漏杀不可错杀）");

check("D1 目标活着 ⇒ 一律不动", () => {
	const now = new Date("2026-11-03T10:00:00.000Z");
	const old = new Date(now.getTime() - 60 * 60_000).toISOString();
	const d = freshDir();
	const id = seedItemIn(d, "wechat:d1", "sess-alive-d1", old);

	const out = sweepTargetDeadOutboxItems(d, {
		probe: () => ({ state: "alive", basis: "test" }),
		now,
		by: "test",
	});
	assert.equal(out.length, 0, `活会话不得被杀，实际杀了 ${out.length}`);
	assert.equal(readOutboxItem(d, id)?.status, "pending", "应仍为 pending");
});

check("D2 探针 unknown ⇒ 一律不动（宁漏不枉）", () => {
	const now = new Date("2026-11-03T10:00:00.000Z");
	const old = new Date(now.getTime() - 60 * 60_000).toISOString();
	const d = freshDir();
	const id = seedItemIn(d, "wechat:d2", "sess-unknown-d2", old);

	const out = sweepTargetDeadOutboxItems(d, {
		probe: () => ({ state: "unknown", basis: "test" }),
		now,
		by: "test",
	});
	assert.equal(out.length, 0, `unknown 不得杀，实际杀了 ${out.length}`);
	assert.equal(readOutboxItem(d, id)?.status, "pending", "应仍为 pending");
});

check("D3 同一会话多个 pending 项 ⇒ 探针只调一次（避免重复查进程表）", () => {
	const now = new Date("2026-11-03T10:00:00.000Z");
	const old = new Date(now.getTime() - 60 * 60_000).toISOString();
	// 独立目录：避开前几组遗留的 pending 项（探针固定 dead 会把它们一起标）
	const iso = mkdtempSync(join(tmpdir(), "d3-iso-"));
	process.env.PI_RUNTIME_DIR = iso;
	const isoDir = outboxDir(join(iso, "state"));
	mkdirSync(isoDir, { recursive: true });
	for (let i = 0; i < 3; i++) {
		const it = newOutboxItem({
			dedupeKey: `wechat:d3-${i}`,
			commandKey: `wechat:d3-${i}`,
			to: `pi://sess-multi-d3` as never,
			sessionId: "sess-multi-d3",
			text: `multi ${i}`,
			now: new Date(old),
		});
		writeOutboxItem(isoDir, it);
	}

	let calls = 0;
	const out = sweepTargetDeadOutboxItems(isoDir, {
		probe: () => {
			calls += 1;
			return { state: "dead", basis: "test" };
		},
		now,
		by: "test",
	});
	assert.equal(out.length, 3, `3 条都应标记，实际 ${out.length}`);
	assert.equal(calls, 1, `同会话应只探 1 次（缓存），实际探了 ${calls} 次`);
	rmSync(iso, { recursive: true, force: true });
	process.env.PI_RUNTIME_DIR = ROOT;
});

check("D4 探针完全缺失 ⇒ 不崩、不动（never-throw）", () => {
	const now = new Date("2026-11-03T10:00:00.000Z");
	const out = sweepTargetDeadOutboxItems(freshDir(), { now, by: "test" } as never);
	assert.equal(out.length, 0, "无探针时不得动任何项");
});

console.log("\nE. 真机形态回归（用实际数据形状）");

check("E1 复刻真机：心跳停 10 小时 + pid 不存在 ⇒ 判 dead", () => {
	// 真机：subagent-win.json sessionId=01a18af1, pid=81516, updatedAt=16:22
	seedLiveness("sc-e1", "01a18af1-c7c8-779e-b412-cb4ac4d7287e", 81516, "2026-11-02T16:22:01.079Z");
	const p = probeTargetSessionLiveness("01a18af1-c7c8-779e-b412-cb4ac4d7287e", {
		stateDir: STATE,
		now: new Date("2026-11-03T10:47:00.000Z"),
		probePid: () => ({ state: "dead", basis: "enumerate" }),
	});
	assert.equal(p.state, "dead", `真机形态应判 dead，实际 ${p.state}（${p.basis}）`);
});

check("E2 复刻真机：3 条消息全部标 failed 且各自带原因", () => {
	const now = new Date("2026-11-03T10:47:00.000Z");
	const sid = "01a18af1-c7c8-779e-b412-cb4ac4d7287e";
	const times = ["2026-11-03T02:17:25.463Z", "2026-11-03T02:29:34.688Z", "2026-11-03T02:46:31.174Z"];
	const d = freshDir();
	const ids = times.map((t, i) => seedItemIn(d, `wechat:e2-${i}`, sid, t));

	const out = sweepTargetDeadOutboxItems(d, {
		probe: () => ({ state: "dead", basis: "pid-dead(81516,enumerate)" }),
		now,
		by: "test",
	});
	assert.equal(out.length, 3, `3 条都应标 failed，实际 ${out.length}`);
	for (const id of ids) {
		const it = readOutboxItem(d, id);
		assert.equal(it?.status, "failed", `${id.slice(0, 8)} 应为 failed`);
		assert.ok((it?.error ?? "").length > 0, "必须有可读的 error");
	}
});

console.log(`\n_test_outbox_target_dead: ${passed} checks passed`);
rmSync(ROOT, { recursive: true, force: true });
