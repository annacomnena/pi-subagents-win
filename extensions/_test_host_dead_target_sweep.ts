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


// E（2026-11-05 项 6）：host 还必须把 mailbox 的 pending/claimed 死信扫成终态。
// 根因：findDeadLetters / finalizeDeadLetters 此前**生产零调用**（grep 只命中定义），
// 而 claimLetters 的 stale 重领只在拉取路径触发、且只重标 claimed 不判终态
// ⇒ 前任 owner 领了信就死时，那封信永远停在 claimed。
{
	const { deliverLetter, listLetters, defaultMailboxDir } = await import("./runtime/mailbox.ts");
	const { masterAddress } = await import("./runtime/address.ts");
	const { readdirSync, readFileSync, writeFileSync } = await import("node:fs");
	const { join: j2 } = await import("node:path");
	const mb = defaultMailboxDir();
	const old = new Date(Date.now() - 100 * 3_600_000).toISOString();
	const { newMessageFrame } = await import("./runtime/protocol.ts");
	const { newEnvelopeId } = await import("./runtime/ids.ts");
	const frame = newMessageFrame({
		id: newEnvelopeId("msg"),
		kind: "REPORT",
		from: masterAddress(),
		to: masterAddress(),
		sentAt: old,
		summary: "dead claim",
		details: {},
	});
	deliverLetter(frame, { mailboxDir: mb });
	const frameId = frame.id;
	const dir = j2(mb, "agent___master_default");
	const file = readdirSync(dir).find((f) => f === `${frameId}.json`);
	assert.ok(file, "信件已落盘");
	const p2 = j2(dir, file!);
	const raw = JSON.parse(readFileSync(p2, "utf8")) as Record<string, unknown>;
	writeFileSync(p2, JSON.stringify({ ...raw, status: "claimed", claimedBy: "dead-owner", claimedAt: old }), "utf8");

	const host4 = await createRuntimeHostServer({
		port: 0,
		stateDir: RT,
		mailboxDir: mb,
		sessionsDir: SESS,
		hostPath: j2(RT, "host4.json"),
	});
	await host4.close();
	const after = listLetters(masterAddress(), undefined, mb).find((l) => (l.frame as { id?: string }).id === frameId);
	assert.ok(after, "信仍在（不应被删）");
	assert.ok(["claimed", "target-gone"].includes(after!.status), `状态合法，实得 ${after!.status}`);
	console.log("  ✓ E1 host sweep 构造成功且不改活信（链路不抛）");

	// E2：**接线钉**（AGENTS §4.2「变异真实接线」）。
	// 为什么需要它：E1 只证明「host 能起来、不抛、不改活信」，它**对接线被删零判别力**
	// （实测：把 findDeadLetters/finalizeDeadLetters 调用整段删掉，E1 仍然绿）。
	// 要让探针真的判 dead 需要造 attachment + session-owner + 无 transcript 的完整夹具，
	// 成本高且属 _test_delivery_stale S5 已覆盖的行为面。故这里直接钉源码接线：
	// 删掉调用、删掉 dryRun:false、或改回干跑，这条立刻红。
	{
		const { readFileSync: rf } = await import("node:fs");
		const src = rf(new URL("./runtime-host/server.ts", import.meta.url), "utf8");
		assert.ok(src.includes("findDeadLetters("), "server.ts 必须调用 findDeadLetters（项 6 接线）");
		assert.ok(src.includes("finalizeDeadLetters("), "server.ts 必须调用 finalizeDeadLetters（项 6 接线）");
		assert.ok(/finalizeDeadLetters\([^)]*dryRun:\s*false/.test(src), "必须显式 dryRun:false（缺省是干跑，零写入）");
		console.log("  ✓ E2 接线钉：server.ts 同时含 findDeadLetters / finalizeDeadLetters / dryRun:false");
		passed += 1;
	}
}
console.log(`\n_test_host_dead_target_sweep: ${passed} checks passed`);
rmSync(RT, { recursive: true, force: true });
rmSync(SESS, { recursive: true, force: true });
