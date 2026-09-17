/**
 * _test_runtime_registry.ts — Phase 4a 测试（附记 A4 F1/F3/F5/F6）
 *
 * 覆盖：
 *   - genesis：首个 attach → gen 1（wx 原子）；次会话无 token → owner-active
 *   - 同会话重复 attach → 心跳刷新不 bump
 *   - detach + token 交接 → gen 2；token 重放 → generation-mismatch
 *   - detach 条件不匹配 → not-owner（旧会话迟到不能摘新 owner，Q4 修正）
 *   - stale-force：心跳新鲜 → not-stale；过期 + force → bump；旧 owner 心跳复活拒绝
 *   - resolver：快照 {sessionId, generation}；无 attachment → null；非 agent 地址 → null
 *   - receipts：first-wins 幂等 + 标准键形状
 *
 * 运行：npm run test:runtime-registry
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "runtime-registry-env-"));

import { masterAddress } from "./runtime/address.ts";
import {
	acquireRegistryLease,
	attachMaster,
	attachmentPathFor,
	detachMaster,
	heartbeatMaster,
	readAttachment,
} from "./runtime/registry.ts";
import { resolveRecipient } from "./runtime/resolver.ts";
import {
	hasNotificationReceipt,
	recordNotificationReceipt,
	runReceiptKey,
} from "./runtime/receipts.ts";

const master = masterAddress();

try {
	// ── 0. resolver：无 attachment → null（未启用，不回退）─────────
	assert.equal(resolveRecipient(master), null);
	assert.equal(resolveRecipient("run://tab/tab_x"), null, "非 agent 地址 → null");

	// ── 1. genesis ────────────────────────────────────────────────
	{
		const r = attachMaster({ sessionId: "sess-A" });
		assert.equal(r.ok, true);
		assert.equal(r.ok && r.attachment.generation, 1);
		assert.equal(r.ok && r.genesis, true);
		assert.equal(readAttachment(master)!.sessionId, "sess-A");
	}

	// ── 2. 次会话无 token → owner-active ───────────────────────────
	{
		const r = attachMaster({ sessionId: "sess-B" });
		assert.equal(r.ok, false);
		assert.equal(!r.ok && r.reason, "owner-active");
	}

	// ── 3. 同会话重复 attach → 心跳刷新，不 bump ───────────────────
	{
		const before = readAttachment(master)!;
		const r = attachMaster({ sessionId: "sess-A" });
		assert.equal(r.ok, true);
		assert.equal(r.ok && r.attachment.generation, 1, "不 bump");
		assert.equal(r.ok && r.genesis, false);
		assert.ok(Date.parse((r.ok && r.attachment.lastHeartbeatAt) || "") >= Date.parse(before.lastHeartbeatAt));
	}

	// ── 4. detach + token 交接 → gen 2 ─────────────────────────────
	let token = "";
	{
		const d = detachMaster({ sessionId: "sess-A", generation: 1, reason: "rollover test" });
		assert.equal(d.ok, true);
		token = d.token!;
		const r = attachMaster({ sessionId: "sess-B", token });
		assert.equal(r.ok, true);
		assert.equal(r.ok && r.attachment.generation, 2);
		assert.equal(readAttachment(master)!.sessionId, "sess-B");
	}

	// ── 5. token 重放 → generation-mismatch ────────────────────────
	{
		const r = attachMaster({ sessionId: "sess-C", token });
		assert.equal(r.ok, false);
		assert.equal(!r.ok && r.reason, "generation-mismatch");
	}

	// ── 6. detach 条件不匹配 → not-owner ───────────────────────────
	{
		// 旧会话 sess-A 拿过期 generation 迟到 detach
		const d = detachMaster({ sessionId: "sess-A", generation: 1 });
		assert.equal(d.ok, false);
		assert.equal(d.reason, "not-owner");
		assert.equal(readAttachment(master)!.sessionId, "sess-B", "owner 不受影响");
	}

	// ── 7. stale-force：新鲜 → not-stale；过期 + force → bump ──────
	{
		const fresh = attachMaster({ sessionId: "sess-C", forceStale: true });
		assert.equal(fresh.ok, false);
		assert.equal(!fresh.ok && fresh.reason, "not-stale");

		// 伪造过期心跳（直接改 attachment 文件时间字段——测试后门走公开读+文件写）
		const { readFileSync, writeFileSync } = await import("node:fs");
		const p = attachmentPathFor(master);
		const cur = JSON.parse(readFileSync(p, "utf8"));
		cur.lastHeartbeatAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
		writeFileSync(p, JSON.stringify(cur), "utf8");

		const bump = attachMaster({ sessionId: "sess-C", forceStale: true });
		assert.equal(bump.ok, true);
		assert.equal(bump.ok && bump.attachment.generation, 3);
	}

	// ── 8. 旧 owner 心跳复活拒绝 ───────────────────────────────────
	{
		assert.equal(heartbeatMaster("sess-B", 2), false, "被 bump 后旧代心跳无效");
		assert.equal(heartbeatMaster("sess-C", 3), true, "现任心跳有效");
		assert.equal(heartbeatMaster("sess-X", 3), false, "冒名心跳无效");
	}

	// ── 9. resolver 快照 ───────────────────────────────────────────
	{
		const snap = resolveRecipient(master)!;
		assert.equal(snap.sessionId, "sess-C");
		assert.equal(snap.generation, 3);
	}

	// ── 10. receipts：first-wins 幂等 ──────────────────────────────
	{
		const key = runReceiptKey("tab_z", "completed");
		assert.equal(key, "run-tab_z-completed");
		assert.equal(hasNotificationReceipt(key), false);
		assert.equal(recordNotificationReceipt(key, "test"), true, "首次记录");
		assert.equal(recordNotificationReceipt(key, "test"), false, "重复记录幂等");
		assert.equal(hasNotificationReceipt(key), true);
		assert.equal(recordNotificationReceipt(""), false, "空键拒绝");
	}

	// ── 11. attach 审计：attaching → attached（同一 attemptId）─────
	{
		const { attachMasterWithAudit } = await import("./runtime/adapters/session-lifecycle.ts");
		const { listRuntimeEnvelopes } = await import("./runtime/journal.ts");
		const journalPath = join(process.env.PI_RUNTIME_DIR!, "events.jsonl");
		const d = detachMaster({ sessionId: "sess-C", generation: 3 });
		assert.equal(d.ok, true);
		const r = attachMasterWithAudit({ sessionId: "sess-D", token: d.token! }, { journalPath });
		assert.equal(r.ok, true);
		assert.equal(r.ok && r.attachment.generation, 4);
		assert.equal(r.audit.attemptEmitted, true);
		assert.equal(r.audit.terminalEmitted, true);
		const { envelopes } = listRuntimeEnvelopes({ path: journalPath });
		const mine = envelopes.filter((e) => e.subject === master);
		assert.equal(mine.filter((e) => e.type === "agent.session.attaching").length, 1);
		const attached = mine.find((e) => e.type === "agent.session.attached")!;
		assert.equal((attached.payload as { generation?: number }).generation, 4);
		assert.equal((attached.payload as { attemptId?: string }).attemptId, r.audit.attemptId, "attempt 关联");
		assert.equal(attached.dedupeKey, `agent.session.attached:${master}:4`);
	}

	// ── 12. 失败 attach 审计：attaching_failed（ok:false）──────────
	{
		const { attachMasterWithAudit } = await import("./runtime/adapters/session-lifecycle.ts");
		const { listRuntimeEnvelopes } = await import("./runtime/journal.ts");
		const journalPath = join(process.env.PI_RUNTIME_DIR!, "events.jsonl");
		const r = attachMasterWithAudit({ sessionId: "sess-E", token: "ho_bogus" }, { journalPath });
		assert.equal(r.ok, false);
		const { envelopes } = listRuntimeEnvelopes({ path: journalPath });
		const failed = envelopes.filter((e) => e.type === "agent.session.attaching_failed");
		assert.equal(failed.length, 1);
		assert.equal((failed[0]!.payload as { ok?: boolean }).ok, false);
		assert.equal((failed[0]!.payload as { attemptId?: string }).attemptId, r.audit.attemptId);
		assert.equal(readAttachment(master)!.sessionId, "sess-D", "失败不碰 registry");
	}

	// ── 13. detach 审计：detached + 错误 detach → detaching_failed ─
	{
		const { detachMasterWithAudit } = await import("./runtime/adapters/session-lifecycle.ts");
		const { listRuntimeEnvelopes } = await import("./runtime/journal.ts");
		const journalPath = join(process.env.PI_RUNTIME_DIR!, "events.jsonl");
		const bad = detachMasterWithAudit({ sessionId: "sess-X", generation: 99 }, { journalPath });
		assert.equal(bad.ok, false);
		const { envelopes } = listRuntimeEnvelopes({ path: journalPath });
		assert.equal(envelopes.filter((e) => e.type === "agent.session.detaching_failed").length, 1);
		const good = detachMasterWithAudit({ sessionId: "sess-D", generation: 4, reason: "test handoff" }, { journalPath });
		assert.equal(good.ok, true);
		const after = listRuntimeEnvelopes({ path: journalPath }).envelopes;
		assert.equal(after.filter((e) => e.type === "agent.session.detached").length, 1);
	}

	// ── 15. F13：lease 互斥（双接管仅一胜）──────────────────────────
	{
		const first = acquireRegistryLease("test-a");
		assert.equal(first.won, true);
		const second = acquireRegistryLease("test-b");
		assert.equal(second.won, false, "lease 被占时认输");
		// attach 在 lease 被占时拒绝（CAS 保护）
		const contended = attachMaster({ sessionId: "sess-G", forceStale: true, staleAfterMs: -1 });
		assert.equal(contended.ok, false);
		assert.equal(!contended.ok && contended.reason, "lease-contended");
		first.release();
		const third = acquireRegistryLease("test-c");
		assert.equal(third.won, true, "释放后可重新获得");
		third.release();
		// stale lease 可接管
		const { writeFileSync } = await import("node:fs");
		const leasePath = join(process.env.PI_RUNTIME_DIR!, "registry", ".lease");
		writeFileSync(leasePath, JSON.stringify({ holder: "dead", purpose: "x", acquiredAt: new Date(Date.now() - 60_000).toISOString() }), "utf8");
		const takeover = acquireRegistryLease("test-d", 30_000);
		assert.equal(takeover.won, true, "过期 lease 可接管");
		takeover.release();
		assert.equal((await import("node:fs")).existsSync(leasePath), false, "release 删自己的 lease");
	}

	// ── 16. F14：注入互斥（claim → confirm）─────────────────────────
	{
		const { claimInjection, confirmInjection } = await import("./runtime/receipts.ts");
		const key = runReceiptKey("tab_mutex", "completed");
		const c1 = claimInjection(key, "chain-A");
		assert.equal(c1.status, "claimed");
		const c2 = claimInjection(key, "chain-B");
		assert.equal(c2.status, "claimed-by-other", "双链同时只能一链拿注入权");
		assert.equal(c2.by, "chain-A");
		assert.equal(confirmInjection(key, "chain-B"), false, "他人冒确认拒绝");
		assert.equal(confirmInjection(key, "chain-A"), true);
		assert.equal(hasNotificationReceipt(key), true, "确认后收据存在");
		const c3 = claimInjection(key, "chain-C");
		assert.equal(c3.status, "injected-already", "已注入后直接短路");
		// stale claiming 接管
		const key2 = runReceiptKey("tab_stale", "failed");
		claimInjection(key2, "crashed-chain");
		const { writeFileSync, readFileSync } = await import("node:fs");
		const claimingPath = join(process.env.PI_RUNTIME_DIR!, "receipts", `${key2}.claiming.json`);
		const old = JSON.parse(readFileSync(claimingPath, "utf8"));
		old.claimedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
		writeFileSync(claimingPath, JSON.stringify(old), "utf8");
		const take = claimInjection(key2, "chain-D");
		assert.equal(take.status, "claimed");
		assert.equal(take.tookOver, true, "过期占位可接管（at-least-once 重试）");
	}

	// ── 14. registry 优先：journal 写失败不影响 attach 结果 ────────
	{
		const { writeFileSync } = await import("node:fs");
		const { attachMasterWithAudit } = await import("./runtime/adapters/session-lifecycle.ts");
		const blocker = join(process.env.PI_RUNTIME_DIR!, "blocker");
		writeFileSync(blocker, "i am a file, not a dir", "utf8");
		const badJournal = join(blocker, "events.jsonl"); // 父级是文件 → mkdir/append 必败
		const before = readAttachment(master)!;
		const r = attachMasterWithAudit({ sessionId: "sess-F", forceStale: true, staleAfterMs: -1 }, { journalPath: badJournal });
		assert.equal(r.ok, true, "registry 提交不受审计失败影响");
		assert.equal(r.audit.terminalEmitted, false, "审计失败如实报告");
		assert.equal(readAttachment(master)!.generation, before.generation + 1);
	}
} finally {
	rmSync(process.env.PI_RUNTIME_DIR!, { recursive: true, force: true });
}

console.log("_test_runtime_registry: all assertions passed");
