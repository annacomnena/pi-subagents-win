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
} finally {
	rmSync(process.env.PI_RUNTIME_DIR!, { recursive: true, force: true });
}

console.log("_test_runtime_registry: all assertions passed");
