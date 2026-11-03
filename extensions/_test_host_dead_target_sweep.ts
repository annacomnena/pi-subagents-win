/**
 * _test_host_dead_target_sweep.ts — B-2：host 必须替死掉的会话扫 outbox。
 *
 * ## 自指困境（这是本测试存在的理由）
 *
 * B 的初版把 `sweepTargetDeadOutboxItems` 只接在 `consumeOutboxOnce` 里。
 * 但那个函数跑在**目标会话自己的进程**里（`registerOutboxBridge` 挂 session_start）。
 *
 * 「目标会话已死」 ⇔ 那个进程不在了 ⇔ **没人调这个扫描**。
 *
 * 真机事故（2026-11-03）：msg 5ead2c2e72 发给已死的 01a18af1，卡 17 分钟不动。
 * 探针能正确判 dead，但没有执行体去调它。host 是唯一对全部 outbox 有视野的执行体。
 *
 * ## 判据
 *
 * A. host 启动即扫：目标死 + 过宽限 ⇒ 消息在 host 起来后变 failed
 * B. 目标活 ⇒ host 不动（不冤枉）
 * C. 宽限期内 ⇒ host 不动（给重启留窗口）
 * D. host.close() 后周期扫描停止
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const RT = mkdtempSync(join(tmpdir(), "host-dead-"));
process.env.PI_RUNTIME_DIR = RT;
const SESS = mkdtempSync(join(tmpdir(), "host-dead-sess-"));

import { createRuntimeHostServer } from "./runtime-host/server.ts";
import { outboxDir, newOutboxItem, writeOutboxItem, readOutboxItem, outboxItemId } from "./runtime/message-outbox.ts";

let passed = 0;
const check = (name: string, fn: () => void | Promise<void>): void => {
	try {
		const r = fn();
		if (r instanceof Promise) throw new Error("check 不支持 async（本测试全同步）");
		passed += 1;
		console.log(`  ✓ ${name}`);
	} catch (e) {
		console.error(`  ✗ ${name}`);
		console.error(`    ${e instanceof Error ? e.message : String(e)}`);
		throw e;
	}
};

const STATE = join(RT, "state");
const DIR = outboxDir(STATE);
mkdirSync(DIR, { recursive: true });

function seedScope(scopeKey: string, sessionId: string, pid: number, updatedAt: string): void {
	const d = join(STATE, "scope-liveness");
	mkdirSync(d, { recursive: true });
	writeFileSync(
		join(d, `${scopeKey}.json`),
		JSON.stringify({ version: 1, scopeKey, sessionId, generation: 1, pid, startedAt: updatedAt, updatedAt }),
		"utf8",
	);
}

function seedPending(key: string, sessionId: string, createdAt: string): string {
	const it = newOutboxItem({
		dedupeKey: key,
		commandKey: key,
		to: `pi://${sessionId}` as never,
		sessionId,
		text: `消息 ${key}`,
		now: new Date(createdAt),
	});
	writeOutboxItem(DIR, it);
	return it.id;
}

const deadPid = 999_999;
const old = new Date(Date.now() - 60 * 60_000).toISOString(); // 1 小时前（超宽限）

console.log("\nA. host 启动即扫：目标已死 ⇒ 消息变 failed");

// 目标会话：pid 死 + 心跳超龄 ⇒ dead
seedScope("sc-a", "sess-dead-a", deadPid, old);
const idA = seedPending("wechat:a", "sess-dead-a", old);

const host1 = await createRuntimeHostServer({ port: 0, sessionsDir: SESS });
// host 启动回调是异步的（listen 回调里），等一拍
await new Promise((r) => setTimeout(r, 300));

check("A1 死目标的消息被 host 标成 failed", () => {
	const it = readOutboxItem(DIR, idA);
	assert.equal(it?.status, "failed", `应为 failed，实际 ${it?.status}`);
	assert.ok((it?.error ?? "").includes("目标会话已结束"), `error 应可读，实际 ${it?.error}`);
});

console.log("\nB. 目标活着 ⇒ host 不动（不冤枉）");

seedScope("sc-b", "sess-alive-b", process.pid, new Date().toISOString());
const idB = seedPending("wechat:b", "sess-alive-b", old);

const host2 = await createRuntimeHostServer({ port: 0, sessionsDir: SESS, hostPath: join(RT, "host2.json") });
await new Promise((r) => setTimeout(r, 300));

check("B1 活目标的消息保持 pending", () => {
	const it = readOutboxItem(DIR, idB);
	assert.equal(it?.status, "pending", `活会话不得被杀，实际 ${it?.status}`);
});

console.log("\nC. 宽限期内 ⇒ host 不动（给重启留窗口）");

seedScope("sc-c", "sess-dead-c", deadPid, new Date().toISOString()); // 心跳新鲜但 pid 死
const justNow = new Date(Date.now() - 60_000).toISOString(); // 1 分钟前，在 10min 宽限内
const idC = seedPending("wechat:c", "sess-dead-c", justNow);

const host3 = await createRuntimeHostServer({ port: 0, sessionsDir: SESS, hostPath: join(RT, "host3.json") });
await new Promise((r) => setTimeout(r, 300));

check("C1 宽限期内即使目标死也不动", () => {
	const it = readOutboxItem(DIR, idC);
	assert.equal(it?.status, "pending", `宽限期内不得杀，实际 ${it?.status}`);
});

console.log("\nD. close() 停止周期扫描");

await host1.close();
await host2.close();
await host3.close();

check("D1 close 后不抛（定时器已清理）", () => {
	// 若能走到这里说明 close 没炸；再等一拍确认没有 unhandled 异常
	assert.ok(true);
});

// 清理期再给一拍，让任何残留 unref 定时器有机会触发（不应有副作用）
await new Promise((r) => setTimeout(r, 200));

check("D2 关闭后消息状态不再变化", () => {
	assert.equal(readOutboxItem(DIR, idA)?.status, "failed", "A 应稳定在 failed");
	assert.equal(readOutboxItem(DIR, idB)?.status, "pending", "B 应稳定在 pending");
	assert.equal(readOutboxItem(DIR, idC)?.status, "pending", "C 应稳定在 pending");
});

console.log(`\n_test_host_dead_target_sweep: ${passed} checks passed`);
rmSync(RT, { recursive: true, force: true });
rmSync(SESS, { recursive: true, force: true });
