/**
 * _test_mailbox_command_consume.ts — 0920 backlog A：mailbox 命令信消费接线测试
 *（契约 plans/0920_backlog_A_B_plan.md §A 测试清单）
 *
 *   T1 全链：master_default spool 投 post-cutover command 信 → consumeMailboxOnce(owner)
 *      → executor 真实执行（journal command.accepted + .claim/.outcome 产物 + config 落盘）
 *      → 信 acked → 收到纯报告回执（红线：命令绝不进 LLM 注入）。
 *   T2 重放幂等：同 commandKey 再投一封 → replayed:true 回放赢家 outcome → acked，
 *      .claim 仍一份、无二次副作用（config 不被重写）；同 fileId 重放（stale reclaim 模拟）
 *      → 同样 replayed:true。
 *   T3 rejected 不死循环：invalid-payload 信 → rejected → acked 终态，spool 无
 *      pending/claimed 残留，重复消费零动作。
 *   T4 非 master 域不变：workstream://（无 attachment → 零动作）与 agent://master_local_*
 *      （有 attachment → command-deferred，信保持 pending）行为与接线前一致。
 *
 * 运行：npm run test:mailbox-command-consume
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 隔离（同既有 runtime 测试纪律：env 先于 import）
process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "mailbox-command-consume-env-"));
const ROOT = process.env.PI_RUNTIME_DIR!;
const MAILBOX = join(ROOT, "mailbox");
const JOURNAL = join(ROOT, "events.jsonl");

import { masterAddress, workstreamAddress, type ObjectAddress } from "./runtime/address.ts";
import { localMasterAddress } from "./runtime/scope.ts";
import { commandArtifactName } from "./runtime/command-executor.ts";
import { deliverCommand, listLetters } from "./runtime/mailbox.ts";
import { attachMaster, readAttachment, readCutover, setCutover } from "./runtime/registry.ts";
import { listRuntimeEnvelopes } from "./runtime/journal.ts";
import { newCommandFrame } from "./runtime/protocol.ts";
import { consumeMailboxOnce } from "./mailbox-consumer.ts";

// ── 工具 ───────────────────────────────────────────────────────────

const iso = (): string => new Date().toISOString();

function deliver(to: ObjectAddress, type: Parameters<typeof newCommandFrame>[0]["type"], commandKey: string, payload?: Record<string, unknown>): void {
	deliverCommand(newCommandFrame({ type, to, issuedBy: "agent://agent_worker_1", commandKey, issuedAt: iso(), ...(payload ? { payload } : {}) }), { mailboxDir: MAILBOX });
}

function commandLetter(commandKey: string): { status: string } | undefined {
	const l = listLetters(masterAddress(), undefined, MAILBOX).find(
		(x) => x.frame.frame === "command" && x.frame.commandKey === commandKey,
	);
	return l ? { status: l.status } : undefined;
}

const commandsDir = join(ROOT, "state", "commands");
const artifactsFor = (dedupeKey: string): { claim: boolean; outcome: boolean } => ({
	claim: existsSync(join(commandsDir, commandArtifactName(dedupeKey, ".claim"))),
	outcome: existsSync(join(commandsDir, commandArtifactName(dedupeKey, ".outcome.json"))),
});

try {
	// ── 前置：cutover on + master owner ─────────────────────────────
	setCutover(true, "test");
	assert.ok(readCutover()?.enabled);
	const genesis = attachMaster({ sessionId: "sess-owner" });
	assert.equal(genesis.ok, true, "master owner 就位");
	const sid = genesis.ok ? genesis.attachment.sessionId : "";
	mkdirSync(MAILBOX, { recursive: true });
	const tmpCfg = join(mkdtempSync(join(tmpdir(), "mbcmd-cfg-")), "config.json");
	writeFileSync(tmpCfg, JSON.stringify({ models: [1, 2, 3] }, null, 2), "utf8");
	const execOpts = { configPath: tmpCfg, journalPath: JOURNAL };

	// ── T1 全链真实执行 ────────────────────────────────────────────
	{
		const key = "auto-on:t1";
		deliver(masterAddress(), "master.auto-handoff.set", key, { auto: true, reason: "t1" });
		const sent: string[] = [];
		const r = consumeMailboxOnce({
			sessionId: sid, mailboxDir: MAILBOX, runsDir: join(ROOT, "tab-runs"),
			sendUserMessage: (b) => sent.push(b),
			executeCommandOptions: execOpts,
		});
		const entry = r.consumed.find((c) => c.action === "executed");
		assert.ok(entry, "命令信被消费执行");
		assert.equal(entry!.reason, "command-accepted", "executor accepted");
		assert.equal(sent.length, 1, "恰一条回执 followUp");
		assert.ok(sent[0]!.includes("命令回执") && sent[0]!.includes("accepted"), "回执含 status");
		assert.ok(!sent[0]!.includes("待执行"), "红线：回执是纯报告，无待执行指令语义");
		assert.equal(commandLetter(key)!.status, "acked", "信 acked 终态");

		// executor 副作用真实落盘：config patch + journal + 幂等盘面
		const cfg = JSON.parse(readFileSync(tmpCfg, "utf8")) as { masterSuccession?: { auto?: boolean }; models?: number[] };
		assert.equal(cfg.masterSuccession?.auto, true, "auto-handoff.set 真实写 config");
		assert.deepEqual(cfg.models, [1, 2, 3], "config 其他切片逐字保留");
		const accepted = listRuntimeEnvelopes({ path: JOURNAL }).envelopes.filter((e) => e.type === "command.accepted");
		assert.equal(accepted.length, 1, "journal command.accepted 恰一条（沿用 executor 现状，consumer 零新事件）");
		assert.equal((accepted[0]!.source), "agent://agent_worker_1", "journal source = frame.issuedBy 原样");
		const arts = artifactsFor(`master.auto-handoff.set:${key}`);
		assert.ok(arts.claim && arts.outcome, ".claim + .outcome 产物就位");
	}

	// ── T2 重放幂等（同 commandKey 新信 → replayed；同 fileId 重投 → replayed）──
	{
		const key = "auto-on:t1"; // 同 T1 的 commandKey
		// 先篡改 config：若 executor 重复执行会把 auto 改回 true；回放必须零二次副作用
		writeFileSync(tmpCfg, JSON.stringify({ models: [1, 2, 3], masterSuccession: { auto: false } }, null, 2), "utf8");
		deliver(masterAddress(), "master.auto-handoff.set", key, { auto: true });
		const sent: string[] = [];
		consumeMailboxOnce({
			sessionId: sid, mailboxDir: MAILBOX, runsDir: join(ROOT, "tab-runs"),
			sendUserMessage: (b) => sent.push(b), executeCommandOptions: execOpts,
		});
		assert.equal(sent.length, 1, "重放信也回执");
		assert.ok(sent[0]!.includes("重放"), "回执标注 replayed");
		const cfg = JSON.parse(readFileSync(tmpCfg, "utf8")) as { masterSuccession?: { auto?: boolean } };
		assert.equal(cfg.masterSuccession?.auto, false, "回放不二次执行（config 保持被篡改后的值）");
		assert.equal(commandLetter(key)!.status, "acked", "重放信 acked");
		const arts = artifactsFor(`master.auto-handoff.set:${key}`);
		assert.ok(arts.claim && arts.outcome, ".claim 仍一份（不新增）");

		// 同 fileId 重放：模拟 ack 前 crash → 10min stale reclaim 后重扫（status 手工回 pending）
		const dir = join(MAILBOX, "agent___master_default");
		const file = readdirSync(dir).find((f) => {
			if (!f.endsWith(".json")) return false;
			const l = JSON.parse(readFileSync(join(dir, f), "utf8")) as { frame?: { frame?: string; commandKey?: string } };
			return l.frame?.frame === "command" && l.frame.commandKey === key;
		});
		assert.ok(file, "重放信文件在 spool");
		const path = join(dir, file!);
		const letter = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		writeFileSync(path, JSON.stringify({ ...letter, status: "pending" }, null, 2) + "\n", "utf8");
		const sent2: string[] = [];
		consumeMailboxOnce({
			sessionId: sid, mailboxDir: MAILBOX, runsDir: join(ROOT, "tab-runs"),
			sendUserMessage: (b) => sent2.push(b), executeCommandOptions: execOpts,
		});
		assert.equal(sent2.length, 1, "fileId 重放也回执");
		assert.ok(sent2[0]!.includes("重放"), "fileId 重放标注 replayed");
		assert.equal((JSON.parse(readFileSync(path, "utf8")) as { status: string }).status, "acked", "fileId 重放再次 ack 终态");
	}

	// ── T3 rejected 不死循环 ───────────────────────────────────────
	{
		const key = "bad:t3";
		deliver(masterAddress(), "workstream.pause", key, { bogus: 1 }); // payload 白名单外 → invalid-payload
		const sent: string[] = [];
		const r = consumeMailboxOnce({
			sessionId: sid, mailboxDir: MAILBOX, runsDir: join(ROOT, "tab-runs"),
			sendUserMessage: (b) => sent.push(b), executeCommandOptions: execOpts,
		});
		const entry = r.consumed.find((c) => c.action === "executed");
		assert.ok(entry && entry.reason === "command-rejected:invalid-payload", "白名单 payload 拒绝");
		assert.equal(sent.length, 1);
		assert.ok(sent[0]!.includes("invalid-payload"), "回执带拒绝原因");
		assert.equal(commandLetter(key)!.status, "acked", "rejected 终态 ack（不重投）");
		const statuses = listLetters(masterAddress(), undefined, MAILBOX)
			.filter((l) => l.frame.frame === "command")
			.map((l) => l.status);
		assert.ok(statuses.every((s) => s === "acked"), "spool 无 pending/claimed 命令信残留（无死循环源）");
		// 再消费一轮：无 pending → 零动作（不死循环）
		const r2 = consumeMailboxOnce({
			sessionId: sid, mailboxDir: MAILBOX, runsDir: join(ROOT, "tab-runs"),
			sendUserMessage: (b) => sent.push(b), executeCommandOptions: execOpts,
		});
		assert.equal(r2.consumed.filter((c) => c.action === "executed").length, 0, "重复消费零执行");
	}

	// ── T4 非 master 域不变 ────────────────────────────────────────
	{
		// workstream 域：无 attachment → consumeMailboxOnce 零动作（信保持 pending，现状）
		const wsAddr = workstreamAddress("ws_deferred");
		deliver(wsAddr, "agent.wake", "ws:defer", { note: "x" });
		const rWs = consumeMailboxOnce({ sessionId: sid, recipient: wsAddr, mailboxDir: MAILBOX, runsDir: join(ROOT, "tab-runs"), sendUserMessage: () => undefined, executeCommandOptions: execOpts });
		assert.equal(rWs.owner, null, "workstream 域无 attachment → 零动作");
		assert.equal(rWs.consumed.length, 0, "零消费条目");
		assert.equal(listLetters(wsAddr, "pending", MAILBOX).length, 1, "ws 命令信保持 pending");

		// scope 域：有 attachment → command-deferred（行为不变断言）
		const scopeAddr = localMasterAddress("repoCmdDefer");
		assert.equal(attachMaster({ sessionId: "sess-scope", agent: scopeAddr }).ok, true, "scope owner 就位");
		deliver(scopeAddr, "agent.wake", "scope:defer", { note: "x" });
		const sentScope: string[] = [];
		const rScope = consumeMailboxOnce({ sessionId: "sess-scope", recipient: scopeAddr, mailboxDir: MAILBOX, runsDir: join(ROOT, "tab-runs"), sendUserMessage: (b) => sentScope.push(b), executeCommandOptions: execOpts });
		const deferred = rScope.consumed.find((c) => c.reason === "command-deferred");
		assert.ok(deferred && deferred.action === "skipped", "scope 域命令信仍 command-deferred");
		assert.equal(sentScope.length, 0, "scope 域零注入零回执");
		assert.equal(listLetters(scopeAddr, "pending", MAILBOX).length, 1, "scope 命令信保持 pending 不 ack");
	}
} finally {
	rmSync(ROOT, { recursive: true, force: true });
}

console.log("_test_mailbox_command_consume: all assertions passed");
