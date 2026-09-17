/**
 * _test_runtime_journal.ts — Phase 1D/1E 测试（设计稿 §16.3 / §16.4 / §44 Step 2）
 *
 * 覆盖：
 *   - envelope：必填字段缺失逐项拒绝、合法 event 通过、未知 kind 拒绝、
 *     可选字段透传、工厂 fail-fast、ObjectAddress 集成
 *   - journal：append / 多次 append / bad line tolerant read / 目录自动创建 /
 *     safe wrapper 失败不抛 / readRuntimeEnvelope 命中与未命中
 *
 * 运行：npm run test:runtime-journal
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newEventEnvelope, validateEnvelope, type RuntimeEnvelope } from "./runtime/envelope.ts";
import {
	appendRuntimeEnvelope,
	appendRuntimeEnvelopeSafe,
	defaultJournalPath,
	emitRuntimeEvent,
	listRuntimeEnvelopes,
	readRuntimeEnvelope,
} from "./runtime/journal.ts";
import { masterAddress, tabRunAddress } from "./runtime/address.ts";

// 临时目录：每个用例独立 journal 文件，绝不触碰真实 ~/.pi/agent/runtime/
const tmp = mkdtempSync(join(tmpdir(), "tfl-journal-test-"));
const jp = (name: string) => join(tmp, `${name}.jsonl`);

try {
	// ── 1. envelope：工厂产合法 event（§16.3）──────────────────────
	{
		const env = newEventEnvelope({
			type: "run.dispatched",
			source: masterAddress(),
			subject: tabRunAddress("tab_x_1"),
			payload: { tabRunId: "tab_x_1" },
		});
		assert.equal(env.version, 1);
		assert.equal(env.kind, "event");
		assert.ok(env.id.startsWith("evt_"), `id 前缀: ${env.id}`);
		assert.ok(Number.isFinite(Date.parse(env.at)), "at 应为可解析时间");
		assert.deepEqual(validateEnvelope(env), [], "工厂产物必须通过校验");
	}

	// ── 2. envelope：可选字段透传 ──────────────────────────────────
	{
		const env = newEventEnvelope({
			type: "run.completed",
			source: masterAddress(),
			target: tabRunAddress("tab_y_2"),
			correlationId: "task_1",
			causationId: "evt_0",
			priority: 5,
			ttlMs: 60000,
			payloadRef: "runtime/objects/run_x.json",
		});
		assert.equal(env.target, "run://tab/tab_y_2");
		assert.equal(env.correlationId, "task_1");
		assert.equal(env.causationId, "evt_0");
		assert.equal(env.priority, 5);
		assert.equal(env.ttlMs, 60000);
		assert.equal(env.payloadRef, "runtime/objects/run_x.json");
		assert.equal(env.payload, undefined, "payloadRef 与 payload 可并存也均可缺省");
	}

	// ── 3. envelope：必填缺失 / 非法逐项拒绝（§16.3）───────────────
	{
		const base = {
			version: 1,
			id: "evt_ok",
			kind: "event",
			type: "run.dispatched",
			source: "agent://master_default",
			at: new Date().toISOString(),
		};
		assert.deepEqual(validateEnvelope(base), [], "base 应合法");

		// 逐项挖掉必填字段
		for (const key of ["version", "id", "kind", "type", "source", "at"]) {
			const broken: Record<string, unknown> = { ...base };
			delete broken[key];
			const errs = validateEnvelope(broken);
			assert.ok(errs.length > 0, `删除 ${key} 后应被拒绝`);
			assert.ok(
				errs.some((m) => m.startsWith(key)),
				`错误信息应指认 ${key}，got: ${errs.join("; ")}`,
			);
		}

		// 非对象 / 未知 kind / 坏 source / 坏 at / 坏 ttl
		assert.ok(validateEnvelope(null).length > 0);
		assert.ok(validateEnvelope("nope").length > 0);
		assert.ok(validateEnvelope({ ...base, kind: "teleport" }).length > 0);
		assert.ok(validateEnvelope({ ...base, source: "http://x" }).length > 0);
		assert.ok(validateEnvelope({ ...base, at: "not-a-time" }).length > 0);
		assert.ok(validateEnvelope({ ...base, ttlMs: -1 }).length > 0);
		assert.ok(validateEnvelope({ ...base, target: "bogus" }).length > 0);

		// 工厂 fail-fast
		assert.throws(() => newEventEnvelope({ type: "", source: masterAddress() }), /invalid envelope/);
	}

	// ── 4. journal：append + 目录自动创建 + round-trip（§16.4）─────
	{
		const path = jp("append"); // 父目录不存在 → append 自动创建
		const env = newEventEnvelope({ type: "run.dispatched", source: masterAddress(), payload: { n: 1 } });
		appendRuntimeEnvelope(env, path);

		const { envelopes, skippedBadLines } = listRuntimeEnvelopes({ path });
		assert.equal(envelopes.length, 1);
		assert.equal(skippedBadLines, 0);
		assert.equal(envelopes[0].id, env.id);
		assert.equal(envelopes[0].type, "run.dispatched");
		assert.deepEqual((envelopes[0].payload as { n: number }), { n: 1 });
	}

	// ── 5. journal：多次 append 保序（§16.4）───────────────────────
	{
		const path = jp("multi");
		const ids: string[] = [];
		for (let i = 0; i < 3; i++) {
			const env = newEventEnvelope({ type: "run.completed", source: masterAddress(), payload: { i } });
			ids.push(env.id);
			appendRuntimeEnvelope(env, path);
		}
		const { envelopes } = listRuntimeEnvelopes({ path });
		assert.deepEqual(envelopes.map((e) => e.id), ids, "append-only 应保持写入顺序");
	}

	// ── 6. journal：bad line tolerant read（§16.4）─────────────────
	{
		const path = jp("tolerant");
		const good1 = newEventEnvelope({ type: "run.dispatched", source: masterAddress() });
		const good2 = newEventEnvelope({ type: "run.completed", source: masterAddress() });
		appendRuntimeEnvelope(good1, path);
		// 手工注入两类坏行：半截 JSON + 形状不合法的 JSON
		writeFileSync(path, '{ "version": 1, "id": "evt_broken"\n', { flag: "a" });
		writeFileSync(path, `${JSON.stringify({ version: 9, kind: "nope" })}\n`, { flag: "a" });
		appendRuntimeEnvelope(good2, path);

		const { envelopes, skippedBadLines } = listRuntimeEnvelopes({ path });
		assert.deepEqual(
			envelopes.map((e) => e.id),
			[good1.id, good2.id],
			"坏行应被跳过、好行完整保留",
		);
		assert.equal(skippedBadLines, 2);
		// type 过滤与 limit
		const onlyCompleted = listRuntimeEnvelopes({ path, type: "run.completed" });
		assert.equal(onlyCompleted.envelopes.length, 1);
		const lastOnly = listRuntimeEnvelopes({ path, limit: 1 });
		assert.deepEqual(lastOnly.envelopes.map((e) => e.id), [good2.id]);
	}

	// ── 7. journal：不存在的文件 → 空结果，不抛 ─────────────────────
	{
		const { envelopes, skippedBadLines } = listRuntimeEnvelopes({ path: jp("missing") });
		assert.deepEqual(envelopes, []);
		assert.equal(skippedBadLines, 0);
		assert.equal(readRuntimeEnvelope("evt_none", { path: jp("missing") }), null);
	}

	// ── 8. journal：safe wrapper 失败不抛（§16.4 关键契约）─────────
	{
		// 失败注入：把「文件路径」指向一个已存在的目录 → append 必然 IO 失败
		const dirAsFile = join(tmp, "dir-as-file");
		mkdirSync(dirAsFile, { recursive: true });
		const env = newEventEnvelope({ type: "run.dispatched", source: masterAddress() });

		const direct = appendRuntimeEnvelopeSafe(env, dirAsFile);
		assert.equal(direct.ok, false);
		assert.ok(typeof direct.error === "string" && direct.error.length > 0, "失败要带原因");

		const emitted = emitRuntimeEvent(env, dirAsFile);
		assert.equal(emitted, false, "emitRuntimeEvent 只返回 boolean，绝不抛");

		// 非法 envelope 同样被 safe 吞掉
		const bad = { version: 1 } as unknown as RuntimeEnvelope;
		assert.equal(appendRuntimeEnvelopeSafe(bad, jp("safe2")).ok, false);
		// 而直接调用会抛
		assert.throws(() => appendRuntimeEnvelope(bad, jp("safe3")), /invalid envelope/);
	}

	// ── 9. readRuntimeEnvelope：命中与未命中 ───────────────────────
	{
		const path = jp("read-one");
		const env = newEventEnvelope({ type: "run.launch_failed", source: masterAddress(), payload: { why: "boom" } });
		appendRuntimeEnvelope(env, path);
		const hit = readRuntimeEnvelope(env.id, { path });
		assert.ok(hit);
		assert.equal(hit.id, env.id);
		assert.equal((hit.payload as { why: string }).why, "boom");
		assert.equal(readRuntimeEnvelope("evt_not_there", { path }), null);
	}

	// ── 10. 默认路径形状（不触碰真实文件，只断言拼接）──────────────
	{
		assert.ok(defaultJournalPath().endsWith("events.jsonl"));
		assert.ok(defaultJournalPath().includes(join(".pi", "agent", "runtime")));
	}
} finally {
	rmSync(tmp, { recursive: true, force: true });
}

console.log("_test_runtime_journal: all assertions passed");
