/**
 * _test_runtime_protocol.ts — Phase 3 Commit A 测试（§24-28）
 *
 * 覆盖：
 *   - MessageFrame 工厂 + 校验（7 种 kind、msg_ id namespace、512B summary 预算）
 *   - CommandFrame 工厂 + 校验（白名单 type、commandKey 必填）
 *   - ACK 不再要求 ack（requiresAck=false，防自指循环）
 *   - Letter 投递状态词表（pending/claimed/delivered/acked/expired）
 *   - 协议寻址一律 ObjectAddress（物理 session 字符串拒绝）
 *
 * 运行：npm run test:runtime-protocol
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 隔离（协议层无 IO，但保持与其它 runtime 测试同一隔离纪律）
process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "runtime-protocol-env-"));

import { isObjectAddress, masterAddress, parseObjectAddress } from "./runtime/address.ts";
import { newEnvelopeId } from "./runtime/ids.ts";
import {
	DELIVERY_STATUSES,
	MESSAGE_KINDS,
	newCommandFrame,
	newMessageFrame,
	validateCommandFrame,
	validateMessageFrame,
	type Letter,
} from "./runtime/protocol.ts";

try {
	const master = masterAddress();
	const sub = "agent://agent_worker_1";
	assert.equal(isObjectAddress(sub), true, "agent://<id> 是合法逻辑地址");

	// ── 1. MessageFrame：7 种 kind 工厂 + 往返校验 ─────────────────
	for (const kind of MESSAGE_KINDS) {
		const m = newMessageFrame({
			id: newEnvelopeId("msg"),
			kind,
			from: sub,
			to: master,
			subject: "run://tab/tab_x",
			sentAt: "2026-09-17T10:00:00.000Z",
			summary: `a ${kind} message`,
		});
		assert.equal(validateMessageFrame(m), true, `kind=${kind} 应通过校验`);
		assert.equal(m.requiresAck, kind !== "ACK", "ACK 不再要求 ack");
	}

	// ── 2. 校验拒绝面 ──────────────────────────────────────────────
	{
		const good = newMessageFrame({
			id: newEnvelopeId("msg"),
			kind: "REPORT",
			from: sub,
			to: master,
			sentAt: "2026-09-17T10:00:00.000Z",
			summary: "ok",
		});
		assert.equal(validateMessageFrame({ ...good, id: "evt_bad" as never }), false, "非 msg_ id 拒绝");
		assert.equal(validateMessageFrame({ ...good, kind: undefined } as never), false, "缺 kind 拒绝");
		assert.equal(
			validateMessageFrame({
				...good,
				body: { summary: "x".repeat(513) },
			}),
			false,
			"summary 超 512B 拒绝",
		);
		// 物理 session 字符串不进协议层（§28）
		assert.equal(
			validateMessageFrame({ ...good, to: "sess-abc-123" as never }),
			false,
			"sessionId 作 recipient 拒绝",
		);
	}

	// ── 3. ObjectAddress 寻址：logical recipient 可 parse 回读 ─────
	{
		const parsed = parseObjectAddress(master);
		assert.ok(parsed, "master 地址可解析");
		assert.equal(parsed!.scheme, "agent");
	}

	// ── 4. CommandFrame：白名单 + commandKey 幂等键 ────────────────
	{
		const c = newCommandFrame({
			type: "agent.wake",
			to: master,
			issuedBy: sub,
			commandKey: "wake:tab_x",
			issuedAt: "2026-09-17T10:00:00.000Z",
			payload: { reason: "tab completed" },
		});
		assert.equal(validateCommandFrame(c), true);
		assert.equal(validateCommandFrame({ ...c, type: "agent.nuke" } as never), false, "白名单外 type 拒绝");
		assert.equal(validateCommandFrame({ ...c, commandKey: "" }), false, "空 commandKey 拒绝");
	}

	// ── 5. Letter 状态词表冻结（§27）───────────────────────────────
	{
		const letter: Letter = {
			frame: newMessageFrame({
				id: newEnvelopeId("msg"),
				kind: "QUESTION",
				from: sub,
				to: master,
				sentAt: "2026-09-17T10:00:00.000Z",
				summary: "blocked on decision",
			}),
			status: "pending",
		};
		assert.ok(DELIVERY_STATUSES.includes(letter.status));
		assert.deepEqual([...DELIVERY_STATUSES], ["pending", "claimed", "delivered", "acked", "expired"]);
	}
} finally {
	rmSync(process.env.PI_RUNTIME_DIR!, { recursive: true, force: true });
}

console.log("_test_runtime_protocol: all assertions passed");
