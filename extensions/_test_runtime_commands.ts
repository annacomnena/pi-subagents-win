/**
 * _test_runtime_commands.ts — G4 测试：deterministic command executor
 * （plans/0920_G4_cmdexec_plan.md §6 测试清单，9 组）
 *
 *   G1 白名单：COMMAND_TYPES additive 全集过 validateCommandFrame；未知 type 仍拒
 *   G2 去重：同 commandKey 重放返回首次 outcome，状态/journal 零二次变化
 *   G3 journal：command.accepted|rejected|failed 各一事件（subject/dedupeKey）+ safe wrapper
 *   G4 四命令行为：pause/resume 迁移校验与幂等 no-op；accept 全分支（含 master-only target
 *      钉死）；auto-handoff.set config 透传 + payload 白名单（封闭字段集）
 *   G5 not-implemented：白名单内无 handler（agent.wake/task.cancel）→ 拒绝且零盘面
 *   G6 并发原子：跨进程真实并发 wx claim（多 child process 竞争同 commandKey，只执行一次）；
 *      崩溃窗口 → replay-unknown-outcome；collision 回归（sanitize 后同名键不互吞）
 *   G7 never-throw：垃圾帧/IO 异常全收敛三态；HTTP 500 JSON 不崩进程
 *   G8 端点契约：POST /v1/commands 200/4xx/413/405 全矩阵 + issuedBy 服务端注入
 *   G9 冒烟：consumer 命令信 command-deferred（零行为变化）+ 四命令端到端
 *
 * 运行：npm run test:runtime-commands
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 隔离（同既有 runtime 测试纪律：env 先于 import）
process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "runtime-commands-env-"));
const ROOT = process.env.PI_RUNTIME_DIR!;
const STATE = join(ROOT, "state");

import { masterAddress, piSessionAddress, workstreamAddress } from "./runtime/address.ts";
import { listRuntimeEnvelopes } from "./runtime/journal.ts";
import { createWorkstream, listAudit, readWorkstream, updateWorkstream } from "./runtime/workstreams.ts";
import { COMMAND_TYPES, newCommandFrame, newMessageFrame, validateCommandFrame, type CommandFrame } from "./runtime/protocol.ts";
import { newEnvelopeId } from "./runtime/ids.ts";
import {
	commandArtifactName,
	executeCommand,
	type CommandOutcome,
	type ExecuteCommandOptions,
} from "./runtime/command-executor.ts";
import { readAttachment, setCutover, attachMaster } from "./runtime/registry.ts";
import { listOutboxItems, outboxDir, readOutboxItem } from "./runtime/message-outbox.ts";
import { maybePropose, readProposal } from "./runtime/master-succession.ts";
import { writeLiveness } from "./runtime/liveness.ts";
import { deliverCommand, deliverLetter, listLetters } from "./runtime/mailbox.ts";
import { consumeMailboxOnce } from "./mailbox-consumer.ts";
import {
	createRuntimeHostServer,
	type RuntimeHostHandle,
} from "./runtime-host/server.ts";

const JOURNAL = join(ROOT, "events.jsonl");
const master = masterAddress();
let nowTick = 0;
function iso(): string {
	return new Date(Date.now() + nowTick++).toISOString();
}

function frame(input: {
	type: CommandFrame["type"];
	to: string;
	commandKey: string;
	payload?: Record<string, unknown>;
	issuedBy?: string;
}): CommandFrame {
	return newCommandFrame({
		type: input.type,
		to: input.to as CommandFrame["to"],
		issuedBy: (input.issuedBy ?? "agent://runtime-host") as CommandFrame["issuedBy"],
		commandKey: input.commandKey,
		issuedAt: iso(),
		payload: input.payload,
	});
}

function exec(f: CommandFrame, opts: ExecuteCommandOptions = {}): CommandOutcome {
	return executeCommand(f, { stateDir: STATE, journalPath: JOURNAL, ...opts });
}

function journalTypes(path: string = JOURNAL): string[] {
	return listRuntimeEnvelopes({ path }).envelopes.map((e) => e.type);
}

function commandsFiles(commandsDir: string): string[] {
	return existsSync(commandsDir) ? readdirSync(commandsDir).sort() : [];
}

let AUTH_TOKEN: string | null = null; // G6-P2：POST /v1/commands 认证（G8 服务端创建后置值；缺省 null = 裸发）

async function postJson(base: string, path: string, body: unknown, opts: { headers?: Record<string, string> } = {}): Promise<{ status: number; body: any }> {
	const headers: Record<string, string> = { "content-type": "application/json", ...(AUTH_TOKEN !== null ? { "x-command-token": AUTH_TOKEN } : {}), ...(opts.headers ?? {}) };
	const res = await fetch(`${base}${path}`, {
		method: "POST",
		headers,
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
	const text = await res.text();
	return { status: res.status, body: JSON.parse(text) };
}

try {
	// ── G1 白名单：+3 additive，未知仍拒 ─────────────────────────────
	{
		assert.deepEqual(
			[...COMMAND_TYPES],
			["agent.wake", "task.cancel", "workstream.pause", "workstream.resume", "master.handoff.accept", "master.auto-handoff.set", "master.handoff.prepare", "session.message"],
			"词表 additive（G4 +3 / G5.2 +prepare / G6-P2 +session.message，只加不改）",
		);
		for (const type of ["workstream.resume", "master.handoff.accept", "master.auto-handoff.set", "master.handoff.prepare"] as const) {
			const f = newCommandFrame({ type, to: master, issuedBy: "agent://x", commandKey: `k-${type}`, issuedAt: iso() });
			assert.equal(validateCommandFrame(f), true, `${type} 过 validateCommandFrame`);
		}
		const old = newCommandFrame({ type: "workstream.pause", to: workstreamAddress("ws_x"), issuedBy: "agent://x", commandKey: "k", issuedAt: iso() });
		assert.equal(validateCommandFrame(old), true, "既有 type 不受影响");
		assert.equal(validateCommandFrame({ ...old, type: "agent.nuke" } as never), false, "白名单外仍拒绝");
	}

	// ── G5 not-implemented：白名单内无 handler → 拒绝且零盘面 ─────────
	{
		const commandsDir = join(STATE, "commands");
		for (const type of ["agent.wake", "task.cancel"] as const) {
			const r = exec(frame({ type, to: master, commandKey: `ni-${type}` }));
			assert.deepEqual(r, { status: "rejected", reason: "not-implemented", replayed: false }, `${type} → not-implemented`);
		}
		assert.equal(commandsFiles(commandsDir).length, 0, "结构性拒绝不占幂等键不写盘面");
		assert.equal(journalTypes().filter((t) => t.startsWith("command.")).length, 0, "结构性拒绝不进 journal");
	}

	// ── G4a pause/resume：迁移校验 + 幂等 no-op + audit ───────────────
	{
		const ws = createWorkstream({ stateDir: STATE, mission: "G4 pause 对象", session: "setup" });
		const to = workstreamAddress(ws.id);

		// missing → no-workstream
		assert.deepEqual(exec(frame({ type: "workstream.pause", to: workstreamAddress("ws_missing"), commandKey: "p-miss" })), {
			status: "rejected", reason: "no-workstream", replayed: false,
		});
		// to 非 workstream:// → invalid-payload
		assert.equal(exec(frame({ type: "workstream.pause", to: master, commandKey: "p-badto" })).status, "rejected");

		// active → paused：写状态 + audit 尾迹（F21 不进 journal，journal 只有 command.*）
		const auditBefore = listAudit(STATE).length;
		const r1 = exec(frame({ type: "workstream.pause", to, commandKey: "p-1" }));
		assert.equal(r1.status, "accepted");
		assert.ok(r1.status === "accepted" && r1.summary.includes("未来 wake 已封"), "回执沿 slash 口径（不杀在飞 tab）");
		assert.equal(readWorkstream(ws.id, STATE)!.status, "paused");
		assert.equal(listAudit(STATE).length, auditBefore + 1, "audit 尾迹 +1");

		// paused 重放（同键）→ 首次 outcome 原样回放；不同键 paused→paused → 幂等 no-op 不写
		const auditNoop = listAudit(STATE).length;
		const r2 = exec(frame({ type: "workstream.pause", to, commandKey: "p-2" }));
		assert.ok(r2.status === "accepted" && r2.summary.includes("no-op"), "paused→paused 幂等 no-op");
		assert.equal(listAudit(STATE).length, auditNoop, "no-op 不写 audit");
		assert.equal(readWorkstream(ws.id, STATE)!.status, "paused");

		// completed → bad-state；resume：paused→active、waiting→拒、active no-op
		const wsC = createWorkstream({ stateDir: STATE, mission: "completed 流", session: "setup" });
		updateWorkstream(wsC.id, { status: "completed", stateDir: STATE, session: "setup" });
		assert.equal(exec(frame({ type: "workstream.pause", to: workstreamAddress(wsC.id), commandKey: "p-c" })).reason, "bad-state");

		const r3 = exec(frame({ type: "workstream.resume", to, commandKey: "r-1" }));
		assert.ok(r3.status === "accepted" && readWorkstream(ws.id, STATE)!.status === "active", "paused→active");
		assert.ok(exec(frame({ type: "workstream.resume", to, commandKey: "r-2" })).summary!.includes("no-op"), "active→active no-op");
		const wsW = createWorkstream({ stateDir: STATE, mission: "waiting 流", session: "setup" });
		updateWorkstream(wsW.id, { status: "waiting", stateDir: STATE, session: "setup" });
		assert.equal(exec(frame({ type: "workstream.resume", to: workstreamAddress(wsW.id), commandKey: "r-w" })).reason, "bad-state", "resume 语义含糊即拒绝");

		// payload 白名单（L4 必修 3）：reason:string 在白名单内；多余字段结构级拒绝（不占幂等键）
		assert.ok(exec(frame({ type: "workstream.pause", to, commandKey: "p-reason", payload: { reason: "maintenance" } })).status === "accepted", "pause 可选 reason 放行");
		const filesBefore = commandsFiles(join(STATE, "commands")).length;
		const jrBefore = journalTypes().filter((t) => t.startsWith("command.")).length;
		assert.equal(exec(frame({ type: "workstream.pause", to, commandKey: "p-extra", payload: { extra: 1 } })).status, "rejected");
		assert.equal(journalTypes().filter((t) => t.startsWith("command.")).length, jrBefore, "payload 多余字段不进 journal（结构级拒绝）");
		assert.equal(commandsFiles(join(STATE, "commands")).length, filesBefore, "payload 多余字段不占幂等键");
	}

	// ── G2 去重：同键重放 = 首次 outcome，零二次副作用 ────────────────
	{
		const ws = createWorkstream({ stateDir: STATE, mission: "G2 去重对象", session: "setup" });
		const to = workstreamAddress(ws.id);
		const f = frame({ type: "workstream.pause", to, commandKey: "dedupe-1" });
		const r1 = exec(f);
		assert.ok(r1.status === "accepted");
		const auditAfterFirst = listAudit(STATE).length;
		const journalAfterFirst = listRuntimeEnvelopes({ path: JOURNAL }).envelopes.length;

		const r2 = exec(f);
		assert.deepEqual({ ...r2 }, { ...r1, replayed: true }, "重放返回首次 outcome（replayed:true）");
		assert.equal(listAudit(STATE).length, auditAfterFirst, "零二次 audit");
		assert.equal(listRuntimeEnvelopes({ path: JOURNAL }).envelopes.length, journalAfterFirst, "零二次 journal");
		assert.equal(readWorkstream(ws.id, STATE)!.status, "paused", "状态只迁移一次");
	}

	// ── G3 journal：三态事件 + safe wrapper ──────────────────────────
	{
		const ws = createWorkstream({ stateDir: STATE, mission: "G3 journal 对象", session: "setup" });
		const to = workstreamAddress(ws.id);
		exec(frame({ type: "workstream.pause", to, commandKey: "j-acc" })); // accepted
		exec(frame({ type: "workstream.pause", to: workstreamAddress("ws_none"), commandKey: "j-rej" })); // rejected
		// failed：configPath 指向目录（EISDIR）→ io-error
		exec(frame({ type: "master.auto-handoff.set", to: master, commandKey: "j-fail", payload: { auto: true } }), {
			configPath: STATE,
		});

		const envelopes = listRuntimeEnvelopes({ path: JOURNAL }).envelopes;
		const acc = envelopes.find((e) => e.type === "command.accepted" && (e.payload as any)?.commandKey === "j-acc");
		const rej = envelopes.find((e) => e.type === "command.rejected" && (e.payload as any)?.commandKey === "j-rej");
		const fail = envelopes.find((e) => e.type === "command.failed" && (e.payload as any)?.commandKey === "j-fail");
		assert.ok(acc && rej && fail, "accepted/rejected/failed 各一事件");
		assert.equal(acc!.kind, "event");
		assert.equal(acc!.subject, to, "subject=frame.to");
		assert.equal(acc!.dedupeKey, "workstream.pause:j-acc", "dedupeKey=<type>:<commandKey>");
		assert.equal(acc!.source, "agent://runtime-host", "source=issuedBy");
		assert.equal(rej && (rej.payload as any).reason, "no-workstream");

		// safe wrapper：journalPath 不可写（指向目录）→ 写失败吞掉，命令回执不受影响
		const r = exec(frame({ type: "workstream.pause", to, commandKey: "j-safe" }), { journalPath: STATE });
		assert.equal(r.status, "accepted", "journal 写失败不影响命令回执");
	}

	// ── G6 并发原子：跨进程真实并发 + 崩溃窗口 + collision 回归 ───────
	{
		const ws = createWorkstream({ stateDir: STATE, mission: "G6 并发对象", session: "setup" });
		const to = workstreamAddress(ws.id);
		const commandsDir = join(STATE, "commands");

		// 模拟另一进程已赢 claim（wx 排他）：本进程变输家，outcome 缺失（claim 后崩溃窗口）
		const crashKey = "workstream.pause:race-crash";
		writeFileSync(join(commandsDir, commandArtifactName(crashKey, ".claim")), "", { flag: "wx" });
		const rCrash = exec(frame({ type: "workstream.pause", to, commandKey: "race-crash" }));
		assert.deepEqual(rCrash, { status: "rejected", reason: "replay-unknown-outcome", replayed: false }, "崩溃窗口拒绝");
		assert.equal(readWorkstream(ws.id, STATE)!.status, "active", "输家零执行");

		// collision 回归（L4 必修 1）：sanitize 后同名的两个合法 commandKey 不得互吞
		const wsA = createWorkstream({ stateDir: STATE, mission: "collision A", session: "setup" });
		const wsB = createWorkstream({ stateDir: STATE, mission: "collision B", session: "setup" });
		const ra = exec(frame({ type: "workstream.pause", to: workstreamAddress(wsA.id), commandKey: "a/b" }));
		const rb = exec(frame({ type: "workstream.pause", to: workstreamAddress(wsB.id), commandKey: "a?b" }));
		assert.ok(ra.status === "accepted" && rb.status === "accepted", "两个不同 commandKey 各自执行");
		assert.equal(readWorkstream(wsA.id, STATE)!.status, "paused", "a/b 独立生效");
		assert.equal(readWorkstream(wsB.id, STATE)!.status, "paused", "a?b 不被 a/b 的 outcome 互吞、独立生效");
		const rbReplay = exec(frame({ type: "workstream.pause", to: workstreamAddress(wsB.id), commandKey: "a?b" }));
		assert.ok(rbReplay.status === "accepted" && rbReplay.replayed, "a?b 重放走自己的 outcome（非 a/b 的）");

		// 真实并发（L4 必修 4）：4 个 child process 竞争同一 commandKey，恰好一个执行
		const raceKey = "race-real";
		const raceFrame = frame({ type: "workstream.pause", to, commandKey: raceKey });
		const framePath = join(ROOT, "race-frame.json");
		const optsPath = join(ROOT, "race-opts.json");
		const workerTs = join(ROOT, "race-worker.ts");
		writeFileSync(framePath, JSON.stringify(raceFrame));
		writeFileSync(optsPath, JSON.stringify({ stateDir: STATE, journalPath: JOURNAL }));
		writeFileSync(workerTs, [
			`import { readFileSync } from "node:fs";`,
			`const { executeCommand } = await import(${JSON.stringify(new URL("./runtime/command-executor.ts", import.meta.url).href)});`,
			`const f = JSON.parse(readFileSync(process.argv[2], "utf8"));`,
			`const o = JSON.parse(readFileSync(process.argv[3], "utf8"));`,
			`process.stdout.write(JSON.stringify(executeCommand(f, o)));`,
		].join("\n"));
		const race = (): Promise<CommandOutcome> =>
			new Promise((resolve, rj) => {
				const child = spawn(process.execPath, ["--experimental-strip-types", workerTs, framePath, optsPath], { stdio: ["ignore", "pipe", "pipe"] });
				let out = "";
				let err = "";
				child.stdout.on("data", (c: Buffer) => { out += c; });
				child.stderr.on("data", (c: Buffer) => { err += c; });
				child.on("error", rj);
				child.on("close", (code) => {
					if (code !== 0) { rj(new Error(`race worker exit ${code}: ${err.slice(0, 400)}`)); return; }
					resolve(JSON.parse(out) as CommandOutcome);
				});
			});
		const results = await Promise.all([race(), race(), race(), race()]);
		assert.equal(results.filter((r) => r.status === "accepted" && r.replayed === false).length, 1, "4 进程并发同键：恰好一个赢家真实执行");
		for (const r of results) {
			const ok = r.status === "accepted" || (r.status === "rejected" && r.reason === "replay-unknown-outcome");
			assert.ok(ok, `并发结果合法（accepted 或崩溃窗口拒绝）：${JSON.stringify(r)}`);
		}
		const summaries = results.filter((r) => r.status === "accepted").map((r) => (r as { summary?: string }).summary ?? "");
		assert.ok(new Set(summaries).size <= 1, "outcome 一致（同一次执行的回执）");
		const cmdEvents = listRuntimeEnvelopes({ path: JOURNAL }).envelopes.filter((e) => e.type === "command.accepted" && (e.payload as any)?.commandKey === raceKey);
		assert.equal(cmdEvents.length, 1, "journal 单条 command.accepted");
		assert.equal(listAudit(STATE).filter((a) => a.id === ws.id && a.op === "workstream.update").length, 1, "audit 仅一条 update");
		assert.equal(readWorkstream(ws.id, STATE)!.status, "paused", "只执行一次：终态 paused");
	}

	// ── G4b master.handoff.accept 全分支 ─────────────────────────────
	{
		// master-only 钉死（L4 必修 2）：非 master 地址 → invalid-payload（先于 not-attached）
		assert.equal(exec(frame({ type: "master.handoff.accept", to: "agent://other_worker", commandKey: "acc-mt" })).reason, "invalid-payload");

		// 未 attach → not-attached（必须先于本进程任何 attachMaster）
		assert.equal(exec(frame({ type: "master.handoff.accept", to: master, commandKey: "acc-0" })).reason, "not-attached");

		attachMaster({ sessionId: "sess-H" });
		const att = readAttachment(master)!;
		const reading = { tokens: 220_000, contextWindow: 272_000, percent: 80 };

		// 无 proposal → no-proposal（payload 白名单内 reason 放行）
		assert.equal(exec(frame({ type: "master.handoff.accept", to: master, commandKey: "acc-1" })).reason, "no-proposal");
		assert.equal(exec(frame({ type: "master.handoff.accept", to: master, commandKey: "acc-reason", payload: { reason: "ok" } })).reason, "no-proposal", "accept 可选 reason 放行");

		// pending → accepted：proposal 置 accepted + 双 journal 事件（proposal 侧 + command 侧）
		const prop = maybePropose(
			{ sessionId: att.sessionId, generation: att.generation, reading },
			{ stateDir: STATE, journalPath: JOURNAL },
		);
		assert.ok(prop && prop.proposed, "前置：落 pending proposal");
		const r = exec(frame({ type: "master.handoff.accept", to: master, commandKey: "acc-2" }));
		assert.ok(r.status === "accepted" && r.summary!.includes("accepted"), "accept 成功回执");
		assert.equal(readProposal(STATE)!.status, "accepted");
		const types = journalTypes();
		assert.ok(types.includes("master.handoff.accepted"), "S2 库自带 journal 事件");
		assert.ok(types.includes("command.accepted"), "command 侧 journal 事件");

		// 他人 proposal → not-owner（pending + sessionId ≠ attachment.sessionId）
		const state3 = join(ROOT, "state-other");
		mkdirSync(state3, { recursive: true });
		writeFileSync(join(state3, "master-succession.json"), JSON.stringify({
			version: 1, proposalId: "hp_other", generation: 99, sessionId: "sess-OTHER",
			pressure: 80, status: "pending", proposedAt: iso(),
		}));
		assert.equal(exec(frame({ type: "master.handoff.accept", to: master, commandKey: "acc-3" }), { stateDir: state3 }).reason, "not-owner");

		// 非 agent 地址 → invalid-payload
		assert.equal(exec(frame({ type: "master.handoff.accept", to: workstreamAddress("ws_x"), commandKey: "acc-4" })).reason, "invalid-payload");
	}

	// ── G4c master.auto-handoff.set：config 透传 + payload 校验 ───────
	{
		const cfgPath = join(ROOT, "config.json");
		writeFileSync(cfgPath, JSON.stringify({
			models: { planner: "Zhipu/glm-5.3" },
			unknownTopLevel: { keep: true, n: 1 },
			masterSuccession: { enabled: true, auto: false, proposalPercent: 75, autoPercent: 90, extraSliceKey: "keep-me" },
		}));

		const on = exec(frame({ type: "master.auto-handoff.set", to: master, commandKey: "auto-1", payload: { auto: true } }), { configPath: cfgPath });
		assert.ok(on.status === "accepted");
		let cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
		assert.equal(cfg.masterSuccession.auto, true, "on → auto=true");

		const off = exec(frame({ type: "master.auto-handoff.set", to: master, commandKey: "auto-2", payload: { auto: false, reason: "user" } }), { configPath: cfgPath });
		assert.ok(off.status === "accepted");
		cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
		assert.equal(cfg.masterSuccession.auto, false, "off → auto=false");
		assert.deepEqual(cfg.models, { planner: "Zhipu/glm-5.3" }, "已知切片逐字保留");
		assert.deepEqual(cfg.unknownTopLevel, { keep: true, n: 1 }, "未知顶层键逐字保留");
		assert.equal(cfg.masterSuccession.extraSliceKey, "keep-me", "切片内未知键逐字保留");
		assert.equal(cfg.masterSuccession.autoPercent, 90, "切片已知键不被 normalize 重写");

		// payload 白名单：缺 auto / auto 非布尔 / reason 非字符串 / 多余字段 → invalid-payload
		const filesBeforeAuto = commandsFiles(join(STATE, "commands")).length;
		for (const payload of [undefined, {}, { auto: "yes" }, { auto: 1 }, { auto: true, reason: 3 }, { auto: true, extra: "x" }, { reason: "no-auto" }]) {
			const r = exec(frame({ type: "master.auto-handoff.set", to: master, commandKey: `auto-bad-${JSON.stringify(payload)}`, payload } as never), { configPath: cfgPath });
			assert.equal(r.status, "rejected");
			assert.equal(r.status === "rejected" && r.reason, "invalid-payload");
		}
		assert.equal(commandsFiles(join(STATE, "commands")).length, filesBeforeAuto, "payload 结构性拒绝不占幂等键");
		// master-only 钉死：非 master 地址即使 payload 合法也拒绝、config 不动
		const cfgBeforeMt = readFileSync(cfgPath, "utf8");
		assert.equal(exec(frame({ type: "master.auto-handoff.set", to: "agent://other", commandKey: "auto-mt", payload: { auto: true } }), { configPath: cfgPath }).reason, "invalid-payload");
		assert.equal(readFileSync(cfgPath, "utf8"), cfgBeforeMt, "非 master target 零写面");
		// 无 config 文件 → 空对象起步可写
		const fresh = join(ROOT, "config-fresh.json");
		const rf = exec(frame({ type: "master.auto-handoff.set", to: master, commandKey: "auto-fresh", payload: { auto: true } }), { configPath: fresh });
		assert.ok(rf.status === "accepted" && JSON.parse(readFileSync(fresh, "utf8")).masterSuccession.auto === true);
		// 坏 JSON config → io-error（不静默重建防覆盖）
		const broken = join(ROOT, "config-broken.json");
		writeFileSync(broken, "{not json");
		assert.equal(exec(frame({ type: "master.auto-handoff.set", to: master, commandKey: "auto-broken", payload: { auto: true } }), { configPath: broken }).reason, "io-error");
	}

	// ── G7 never-throw：一切异常收敛三态 ─────────────────────────────
	{
		for (const bad of [null, undefined, 42, "cmd", {}, { frame: "command" }, { frame: "command", type: "workstream.pause", to: "bogus", issuedBy: "agent://x", commandKey: "k", issuedAt: "2026-09-20T00:00:00.000Z" }]) {
			const r = executeCommand(bad as never, { stateDir: STATE, journalPath: JOURNAL });
			assert.ok(r.status === "rejected" || r.status === "failed", `垃圾帧不抛（${JSON.stringify(bad)}）`);
		}
		// commandsDir 指向文件 → mkdir 失败 → failed（不抛）
		const fileAsDir = join(ROOT, "file-as-dir");
		writeFileSync(fileAsDir, "x");
		const r = exec(frame({ type: "workstream.pause", to: workstreamAddress("ws_x"), commandKey: "nt-1" }), { commandsDir: fileAsDir });
		assert.equal(r.status, "failed", "IO 异常收敛 failed");
	}

	// ── G8 + G9 端点契约 / 冒烟（HTTP server，路径全注入）────────────
	{
		const D = mkdtempSync(join(tmpdir(), "runtime-commands-http-"));
		const stateDir = join(D, "state");
		const cfgPath = join(D, "config.json");
		writeFileSync(cfgPath, JSON.stringify({ models: {}, custom: [1, 2, 3] }));
		const ws = createWorkstream({ stateDir, mission: "HTTP 冒烟流", session: "setup" });
		const to = workstreamAddress(ws.id);

		const h: RuntimeHostHandle = await createRuntimeHostServer({
			hostPath: join(D, "host.json"),
			timersDir: join(D, "timers"),
			stateDir,
			mailboxDir: join(D, "mailbox"),
			journalPath: join(D, "events.jsonl"),
			configPath: cfgPath,
		});
		const base = `http://127.0.0.1:${h.info.port}`;
		try {
			// G6-P2 认证矩阵：无凭据 401 / 错 token 401 / X-Command-Token 200 / Cookie 200
			AUTH_TOKEN = h.info.token;
			assert.ok(typeof AUTH_TOKEN === "string" && AUTH_TOKEN.length > 0, "host token 已生成");
			const saved = AUTH_TOKEN;
			AUTH_TOKEN = null;
			const unauth = await postJson(base, "/v1/commands", { frame: "command", type: "workstream.pause", to, commandKey: "noauth", issuedAt: iso() });
			assert.equal(unauth.status, 401, "无凭据 → 401 fail-closed");
			assert.equal(unauth.body.error, "unauthorized");
			const badTok = await postJson(base, "/v1/commands", { frame: "command", type: "workstream.pause", to, commandKey: "badtok", issuedAt: iso() }, { headers: { "x-command-token": "wrong" } });
			assert.equal(badTok.status, 401, "错 token → 401");
			const badCookie = await fetch(`${base}/v1/commands`, { method: "POST", headers: { "content-type": "application/json", cookie: "sw_host_token=nope" }, body: JSON.stringify({ frame: "command", type: "workstream.pause", to, commandKey: "badck", issuedAt: iso() }) });
			assert.equal(badCookie.status, 401, "错 cookie → 401");
			const okCookie = await fetch(`${base}/v1/commands`, { method: "POST", headers: { "content-type": "application/json", cookie: `sw_host_token=${saved}` }, body: JSON.stringify({ frame: "command", type: "workstream.pause", to, commandKey: "okck-noop", issuedAt: iso() }) });
			assert.equal(okCookie.status, 200, "对 cookie → 200（同源 UI 通道）");
			AUTH_TOKEN = saved;
			// POST 合法帧 → 200 + 回执；同键重放 → replayed:true
			const p1 = await postJson(base, "/v1/commands", { frame: "command", type: "workstream.pause", to, commandKey: "http-1", issuedAt: iso() });
			assert.equal(p1.status, 200);
			assert.equal(p1.body.status, "accepted");
			assert.ok(typeof p1.body.summary === "string" && p1.body.summary.includes("未来 wake 已封"));
			const p2 = await postJson(base, "/v1/commands", { frame: "command", type: "workstream.pause", to, commandKey: "http-1", issuedAt: iso() });
			assert.equal(p2.status, 200);
			assert.equal(p2.body.replayed, true, "同键重放幂等回执");
			assert.equal(readWorkstream(ws.id, stateDir)!.status, "paused");

			// issuedBy 缺省 → 服务端注入 agent://runtime-host（journal source 可证）
			const { listRuntimeEnvelopes: lr } = await import("./runtime/journal.ts");
			const envs = lr({ path: join(D, "events.jsonl") }).envelopes;
			assert.ok(envs.some((e) => e.type === "command.accepted" && e.source === "agent://runtime-host"), "issuedBy 注入");

			// 白名单外 / 缺字段 / 坏 JSON → 400
			assert.equal((await postJson(base, "/v1/commands", { frame: "command", type: "agent.nuke", to: master, commandKey: "x", issuedAt: iso() })).status, 400);
			assert.equal((await postJson(base, "/v1/commands", { frame: "command", type: "workstream.pause", commandKey: "x", issuedAt: iso() })).status, 400);
			assert.equal((await postJson(base, "/v1/commands", "not-json")).status, 400);

			// body > 64KB → 413
			assert.equal((await postJson(base, "/v1/commands", { frame: "command", type: "workstream.pause", to, commandKey: "big", issuedAt: iso(), payload: { blob: "x".repeat(70 * 1024) } })).status, 413);

			// GET /v1/commands → 405；POST 其他路径 → 405
			assert.equal((await fetch(`${base}/v1/commands`)).status, 405);
			assert.equal((await postJson(base, "/v1/health", {})).status, 405);

			// L4 必修 2/3 HTTP 反向用例：非 master target → 400；payload 多余字段 → 400；白名单内 reason → 200
			const mtA = await postJson(base, "/v1/commands", { frame: "command", type: "master.handoff.accept", to: "agent://other_worker", commandKey: "http-mt-accept", issuedAt: iso() });
			assert.equal(mtA.status, 400);
			assert.equal(mtA.body.reason, "invalid-payload", "非 master accept → 400");
			const mtB = await postJson(base, "/v1/commands", { frame: "command", type: "master.auto-handoff.set", to: "agent://other_worker", commandKey: "http-mt-auto", issuedAt: iso(), payload: { auto: true } });
			assert.equal(mtB.status, 400);
			assert.equal(mtB.body.reason, "invalid-payload", "非 master auto-handoff.set → 400");
			const bp1 = await postJson(base, "/v1/commands", { frame: "command", type: "workstream.pause", to, commandKey: "http-bp-extra", issuedAt: iso(), payload: { reason: "ok", extra: 1 } });
			assert.equal(bp1.status, 400);
			assert.equal(bp1.body.reason, "invalid-payload", "pause 多余字段 → 400");
			const bp2 = await postJson(base, "/v1/commands", { frame: "command", type: "master.auto-handoff.set", to: master, commandKey: "http-bp-auto", issuedAt: iso(), payload: { auto: true, extra: 1 } });
			assert.equal(bp2.status, 400);
			assert.equal(bp2.body.reason, "invalid-payload", "auto 多余字段 → 400");
			const prOk = await postJson(base, "/v1/commands", { frame: "command", type: "workstream.pause", to, commandKey: "http-pr-reason", issuedAt: iso(), payload: { reason: "maintenance" } });
			assert.equal(prOk.status, 200, "pause 白名单内 reason 放行（paused no-op 200）");

			// G9 四命令端到端冒烟（accept 无 pending → 404 no-proposal 亦为有效回执）
			const smokeResume = await postJson(base, "/v1/commands", { frame: "command", type: "workstream.resume", to, commandKey: "smoke-r", issuedAt: iso() });
			assert.equal(smokeResume.status, 200);
			const smokeAuto = await postJson(base, "/v1/commands", { frame: "command", type: "master.auto-handoff.set", to: master, commandKey: "smoke-a", issuedAt: iso(), payload: { auto: false } });
			assert.equal(smokeAuto.status, 200);
			assert.deepEqual(JSON.parse(readFileSync(cfgPath, "utf8")).custom, [1, 2, 3], "config 未知顶层键逐字保留");
			const smokeAcc = await postJson(base, "/v1/commands", { frame: "command", type: "master.handoff.accept", to: master, commandKey: "smoke-h", issuedAt: iso() });
			assert.equal(smokeAcc.status, 404);
			assert.equal(smokeAcc.body.reason, "no-proposal");

			// G5.2 prepare HTTP：非 master → 400；无心跳 → 400 + detail 提示；有心跳 → 200 生成提案
			const prepMt = await postJson(base, "/v1/commands", { frame: "command", type: "master.handoff.prepare", to: "agent://other", commandKey: "http-prep-mt", issuedAt: iso() });
			assert.equal(prepMt.status, 400);
			assert.equal(prepMt.body.reason, "invalid-payload", "非 master prepare → 400");
			const prep0 = await postJson(base, "/v1/commands", { frame: "command", type: "master.handoff.prepare", to: master, commandKey: "http-prep-0", issuedAt: iso() });
			assert.equal(prep0.status, 400);
			assert.equal(prep0.body.reason, "invalid-payload");
			assert.ok(typeof prep0.body.detail === "string" && prep0.body.detail.includes("心跳"), "无心跳 → detail 提示透传 HTTP");
			const hAtt = readAttachment(master)!;
			assert.equal(writeLiveness({ sessionId: hAtt.sessionId, generation: hAtt.generation, pressure: 83 }, { stateDir }), true, "HTTP 场景写心跳");
			const prep1 = await postJson(base, "/v1/commands", { frame: "command", type: "master.handoff.prepare", to: master, commandKey: "http-prep-1", issuedAt: iso() });
			assert.equal(prep1.status, 200);
			assert.equal(prep1.body.status, "accepted");
			assert.ok(typeof prep1.body.summary === "string" && prep1.body.summary.includes("已生成"), "HTTP prepare 生成提案");

			// handler 内部失败 → 500 JSON 不崩进程（configPath 换成目录 → EISDIR → io-error）
			rmSync(cfgPath);
			mkdirSync(cfgPath);
			const bad = await postJson(base, "/v1/commands", { frame: "command", type: "master.auto-handoff.set", to: master, commandKey: "http-io", issuedAt: iso(), payload: { auto: true } });
			assert.equal(bad.status, 500);
			assert.equal(bad.body.reason, "io-error");
			assert.equal((await fetch(`${base}/v1/health`)).status, 200, "500 后 server 存活");
			assert.equal((await fetch(`${base}/v1/snapshot`)).status, 200);
		} finally {
			await h.close();
			rmSync(D, { recursive: true, force: true });
		}
	}

	// ── G10 master.handoff.prepare（G5.2）：确定性提案路径 ─────────────
	{
		const att = readAttachment(master)!;
		const P = join(ROOT, "state-prepare");
		mkdirSync(P, { recursive: true });
		const cfgPath10 = join(ROOT, "config.json"); // G4c 已写（masterSuccession.enabled=true）
		const prep = (commandKey: string, payload?: Record<string, unknown>, to: string = master) =>
			frame({ type: "master.handoff.prepare", to, commandKey, payload });

		// master-only 钉死 + payload 结构校验（先于 claim，零盘面）
		assert.equal(exec(prep("prep-mt", undefined, "agent://other_worker")).reason, "invalid-payload", "非 master target → invalid-payload");
		const cmdsBefore = commandsFiles(join(P, "commands")).length;
		assert.equal(exec(prep("prep-extra", { reason: "x", extra: 1 }), { stateDir: P }).reason, "invalid-payload", "多余字段拒绝");
		assert.equal(commandsFiles(join(P, "commands")).length, cmdsBefore, "结构性拒绝不占幂等键");

		// 无心跳 → invalid-payload + detail 提示（handler 内拒绝：claim 后，可重放）
		const rNoHb = exec(prep("prep-nohb"), { stateDir: P });
		assert.ok(rNoHb.status === "rejected" && rNoHb.reason === "invalid-payload", "无心跳拒绝");
		assert.ok(rNoHb.status === "rejected" && typeof rNoHb.detail === "string" && rNoHb.detail.includes("心跳"), "拒绝带提示");
		const rNoHbReplay = exec(prep("prep-nohb"), { stateDir: P });
		assert.ok(rNoHbReplay.status === "rejected" && rNoHbReplay.replayed, "拒绝 outcome 幂等重放");

		// pressure=null 的心跳 → 同拒绝（不伪造压力）
		assert.equal(writeLiveness({ sessionId: "sess-H", generation: att.generation, pressure: null }, { stateDir: P, now: new Date() }), true);
		assert.equal(exec(prep("prep-nullp"), { stateDir: P }).status, "rejected", "null 压力心跳 → 拒绝");

		// R1 回归（plans/0921_G52_patch_review.md 必修 1）：旧 owner 心跳 + 新 attachment →
		// invalid-payload（心跳未绑定当前 owner 身份），不写 proposal、不发 proposed 事件
		{
			const P4 = join(ROOT, "state-prepare-stale");
			mkdirSync(P4, { recursive: true });
			const j4 = join(ROOT, "events-prepare-stale.jsonl");
			// 旧 owner 同 state 残留心跳：sessionId 不匹配（新 owner 尚未写心跳）
			assert.equal(writeLiveness({ sessionId: "sess-OLD", generation: att.generation, pressure: 95 }, { stateDir: P4, now: new Date() }), true);
			const rStale1 = exec(prep("prep-stale-sid"), { stateDir: P4, journalPath: j4 });
			assert.ok(rStale1.status === "rejected" && rStale1.reason === "invalid-payload", "旧 sessionId 心跳 → invalid-payload");
			assert.ok(rStale1.status === "rejected" && typeof rStale1.detail === "string" && rStale1.detail.includes("尚未产生心跳"), "detail 说明当前 owner 尚未产生心跳");
			// 旧 generation 心跳：同 sessionId 但 gen 过期
			assert.equal(
				writeLiveness({ sessionId: "sess-H", generation: att.generation - 1, pressure: 95 }, { stateDir: P4, now: new Date(Date.now() + 31_000) }),
				true,
			);
			const rStale2 = exec(prep("prep-stale-gen"), { stateDir: P4, journalPath: j4 });
			assert.ok(rStale2.status === "rejected" && rStale2.reason === "invalid-payload", "旧 generation 心跳 → invalid-payload");
			assert.equal(readProposal(P4), null, "身份不匹配零 proposal 落盘");
			assert.equal(
				listRuntimeEnvelopes({ path: j4 }).envelopes.filter((e) => e.type === "master.handoff.proposed").length,
				0,
				"身份不匹配零 proposed 事件",
			);
			// 正向对照：心跳身份与当前 attachment 完全一致 → prepare 恢复可用
			assert.equal(
				writeLiveness({ sessionId: att.sessionId, generation: att.generation, pressure: 88 }, { stateDir: P4, now: new Date(Date.now() + 62_000) }),
				true,
			);
			const rOk4 = exec(prep("prep-stale-ok"), { stateDir: P4, journalPath: j4, configPath: cfgPath10 });
			assert.ok(rOk4.status === "accepted" && rOk4.summary.includes("已生成"), "身份一致后 prepare 恢复可用");
		}

		// 有心跳 → accepted：maybePropose pending，pressure 来自 liveness
		assert.equal(
			writeLiveness({ sessionId: "sess-H", generation: att.generation, pressure: 82, windowTokens: 200000 }, { stateDir: P, now: new Date(Date.now() + 31_000) }),
			true,
			"同身份节流窗外覆写",
		);
		const rOk = exec(prep("prep-1"), { stateDir: P, journalPath: JOURNAL, configPath: cfgPath10 });
		assert.ok(rOk.status === "accepted" && rOk.summary.includes("已生成"), `prepare 生成提案：${JSON.stringify(rOk)}`);
		const prop = readProposal(P)!;
		assert.equal(prop.status, "pending");
		assert.equal(prop.pressure, 82, "pressure 来自 liveness（Host 不伪造）");
		assert.equal(prop.sessionId, "sess-H");
		assert.equal(prop.generation, att.generation);
		const prepEnvs = listRuntimeEnvelopes({ path: JOURNAL }).envelopes;
		assert.equal(prepEnvs.filter((e) => e.type === "master.handoff.proposed" && (e.payload as any)?.proposalId === prop.proposalId).length, 1, "S2 proposed 事件一条");
		assert.ok(prepEnvs.some((e) => e.type === "command.accepted" && (e.payload as any)?.commandKey === "prep-1"), "G4 command.accepted 一条");

		// pending 幂等：不同键再 prepare → accepted 幂等回执，不重复建
		const rIdem = exec(prep("prep-2"), { stateDir: P, journalPath: JOURNAL, configPath: cfgPath10 });
		assert.ok(rIdem.status === "accepted" && rIdem.summary.includes("幂等"), `同代已有提案幂等返回：${JSON.stringify(rIdem)}`);
		assert.equal(readProposal(P)!.proposalId, prop.proposalId, "proposalId 不变");
		assert.equal(
			listRuntimeEnvelopes({ path: JOURNAL }).envelopes.filter((e) => e.type === "master.handoff.proposed" && (e.payload as any)?.proposalId === prop.proposalId).length,
			1,
			"不重复发 proposed 事件（G4b 先前的同型事件不属本提案）",
		);

		// 同键重放 → 首次 outcome 原样（replayed:true）
		const rReplay = exec(prep("prep-1"), { stateDir: P, journalPath: JOURNAL, configPath: cfgPath10 });
		assert.ok(rReplay.status === "accepted" && rReplay.replayed);

		// 总开关关闭 → bad-state + detail（config 切片尊重 enabled=false）
		const cfgOff = join(ROOT, "config-prep-off.json");
		writeFileSync(cfgOff, JSON.stringify({ masterSuccession: { enabled: false } }));
		const P2 = join(ROOT, "state-prepare-off");
		mkdirSync(P2, { recursive: true });
		assert.equal(writeLiveness({ sessionId: "sess-H", generation: att.generation, pressure: 50 }, { stateDir: P2 }), true);
		const rOff = exec(prep("prep-off"), { stateDir: P2, configPath: cfgOff });
		assert.ok(rOff.status === "rejected" && rOff.reason === "bad-state", `总开关关闭 → bad-state：${JSON.stringify(rOff)}`);

		// R2 回归（plans/0921_G52_patch_review.md 必修 2）：跨进程不同 commandKey 并发
		// prepare → 恰一个 proposalId + 一条 proposed journal（代级 wx claim / 原子 create；
		// 输家回读同代提案 already-proposed，绝不覆盖）
		{
			const P5 = join(ROOT, "state-prepare-race");
			mkdirSync(P5, { recursive: true });
			const j5 = join(ROOT, "events-prepare-race.jsonl");
			assert.equal(
				writeLiveness({ sessionId: att.sessionId, generation: att.generation, pressure: 91 }, { stateDir: P5, now: new Date() }),
				true,
				"race 前置：当前 owner 心跳",
			);
			const workerTs = join(ROOT, "prepare-race-worker.ts");
			const optsPath = join(ROOT, "prepare-race-opts.json");
			writeFileSync(optsPath, JSON.stringify({ stateDir: P5, journalPath: j5, configPath: cfgPath10 }));
			writeFileSync(workerTs, [
				`import { readFileSync } from "node:fs";`,
				`const { executeCommand } = await import(${JSON.stringify(new URL("./runtime/command-executor.ts", import.meta.url).href)});`,
				`const f = JSON.parse(readFileSync(process.argv[2], "utf8"));`,
				`const o = JSON.parse(readFileSync(process.argv[3], "utf8"));`,
				`process.stdout.write(JSON.stringify(executeCommand(f, o)));`,
			].join("\n"));
			const race = (commandKey: string): Promise<CommandOutcome> => {
				const framePath = join(ROOT, `prepare-race-frame-${commandKey}.json`);
				writeFileSync(framePath, JSON.stringify(frame({ type: "master.handoff.prepare", to: master, commandKey })));
				return new Promise((resolve, rj) => {
					const child = spawn(process.execPath, ["--experimental-strip-types", workerTs, framePath, optsPath], { stdio: ["ignore", "pipe", "pipe"] });
					let out = "";
					let err = "";
					child.stdout.on("data", (c: Buffer) => { out += c; });
					child.stderr.on("data", (c: Buffer) => { err += c; });
					child.on("error", rj);
					child.on("close", (code) => {
						if (code !== 0) { rj(new Error(`prepare race worker exit ${code}: ${err.slice(0, 400)}`)); return; }
						resolve(JSON.parse(out) as CommandOutcome);
					});
				});
			};
			const results = await Promise.all([race("race-a"), race("race-b"), race("race-c"), race("race-d")]);
			const fresh = results.filter((r) => r.status === "accepted" && r.summary!.includes("已生成"));
			const idem = results.filter((r) => r.status === "accepted" && r.summary!.includes("幂等"));
			assert.equal(fresh.length, 1, `恰一个赢家真实创建：${JSON.stringify(results)}`);
			assert.equal(idem.length, 3, "输家全部回读同代提案幂等返回（already-proposed）");
			const prop5 = readProposal(P5)!;
			assert.ok(prop5, "proposal 已落盘");
			const hpIds = new Set(
				results.flatMap((r) => (r.status === "accepted" ? (r.summary!.match(/hp_[0-9a-z]+_[0-9a-z]+/) ?? []) : [])),
			);
			assert.deepEqual([...hpIds], [prop5.proposalId], "所有回执指向同一 proposalId（不覆盖不双建）");
			const proposed5 = listRuntimeEnvelopes({ path: j5 }).envelopes.filter((e) => e.type === "master.handoff.proposed");
			assert.equal(proposed5.length, 1, "恰一条 proposed journal");
			assert.equal((proposed5[0]!.payload as { proposalId?: string }).proposalId, prop5.proposalId);
		}
	}

	// ── G11 session.message（G6-P2）：Master 403 护栏 / pi scheme 封闭 / 存在性校验 / payload 恶意输入 / outbox 两段式第一段 ──
	{
		const SM = join(ROOT, "state-sm");
		mkdirSync(SM, { recursive: true });
		const J11 = join(ROOT, "events-sm.jsonl");
		const sessionsDir = join(ROOT, "sessions-sm");
		mkdirSync(sessionsDir, { recursive: true });
		const targetSid = "11111111-2222-3333-4444-555555555555";
		writeFileSync(join(sessionsDir, `2026-09-22T09-00-00-000Z_${targetSid}.jsonl`), `{\"type\":\"session\",\"version\":3,\"id\":\"${targetSid}\",\"timestamp\":\"2026-09-22T09:00:00.000Z\",\"cwd\":\"C:\\\\ws\\\\sm\"}\n`, "utf8");
		const sm = (commandKey: string, to: string, payload?: Record<string, unknown>) =>
			frame({ type: "session.message", to, commandKey, payload });
		const msg = (text: string, extra?: Record<string, unknown>) => ({ text, ...(extra ?? {}) });
		const obDir = outboxDir(SM);
		const outboxCount = (): number => listOutboxItems(obDir).length;

		// 护栏一：to=agent://master_default → 403 master-session-protected（executor 层，先于 scheme/payload 校验）
		const r403 = exec(sm("sm-master", master, msg("hi")), { stateDir: SM, journalPath: J11, sessionsDir });
		assert.ok(r403.status === "rejected" && r403.reason === "master-session-protected", `master_default → 403：${JSON.stringify(r403)}`);
		assert.equal(outboxCount(), 0, "403 不写 outbox");
		assert.equal(commandsFiles(join(SM, "commands")).length, 0, "403 前置拒绝不占幂等键");
		assert.equal(listRuntimeEnvelopes({ path: J11 }).envelopes.length, 0, "403 不进 journal");

		// 护栏二：pi://<当前 master attachment 会话> → 同 403（换皮地址）
		const att11 = readAttachment(master)!;
		const r403b = exec(sm("sm-master-sid", piSessionAddress(att11.sessionId), msg("hi")), { stateDir: SM, journalPath: J11, sessionsDir });
		assert.ok(r403b.status === "rejected" && r403b.reason === "master-session-protected", "master attachment 会话换 pi 地址 → 同 403");

		// pi scheme 封闭：其它 scheme → invalid-payload
		assert.equal(exec(sm("sm-ws", "workstream://whatever", msg("hi")), { stateDir: SM, sessionsDir }).reason, "invalid-payload");
		assert.equal(exec(sm("sm-agent", "agent://other_worker", msg("hi")), { stateDir: SM, sessionsDir }).reason, "invalid-payload");

		// 存在性校验：pi://<不存在的会话> → no-session（post-claim，可重放）
		const rMissing = exec(sm("sm-missing", piSessionAddress("99999999-9999-9999-9999-999999999999"), msg("hi")), { stateDir: SM, journalPath: J11, sessionsDir });
		assert.ok(rMissing.status === "rejected" && rMissing.reason === "no-session", "目标不存在 → no-session");
		const rMissing2 = exec(sm("sm-missing", piSessionAddress("99999999-9999-9999-9999-999999999999"), msg("hi")), { stateDir: SM, journalPath: J11, sessionsDir });
		assert.ok(rMissing2.status === "rejected" && rMissing2.replayed, "no-session 幂等重放（outcome 已落）");

		// payload 恶意输入矩阵（结构性拒绝，claim 之前）
		const smDir = (k: string, payload: unknown) => exec(sm(k, piSessionAddress(targetSid), payload as Record<string, unknown>), { stateDir: SM, sessionsDir });
		assert.equal(smDir("sm-empty", { text: "" }).reason, "invalid-payload", "空文本拒绝");
		assert.equal(smDir("sm-missing-text", {}).reason, "invalid-payload", "缺 text 拒绝");
		assert.equal(smDir("sm-num", { text: 42 }).reason, "invalid-payload", "text 非字符串拒绝");
		assert.equal(smDir("sm-long", { text: "x".repeat(8001) }).reason, "invalid-payload", "超长（8001 字节）拒绝");
		assert.equal(smDir("sm-ctrl", { text: "a\u0000b" }).reason, "invalid-payload", "控制字符 NUL 拒绝");
		assert.equal(smDir("sm-esc", { text: "a\u001bb" }).reason, "invalid-payload", "控制字符 ESC 拒绝");
		assert.equal(smDir("sm-extra", { text: "hi", extra: 1 }).reason, "invalid-payload", "多余字段拒绝");
		assert.equal(smDir("sm-reason-long", { text: "hi", reason: "r".repeat(513) }).reason, "invalid-payload", "reason >512 字节拒绝");
		assert.equal(outboxCount(), 0, "恶意输入零 outbox 盘面");

		// G6-P2 L4 补矩阵：多字节字节上限 / DEL / 全量 C0（保留 \t\n\r）/ 结构拒绝不占幂等键
		assert.equal(smDir("sm-mb-over", { text: "中".repeat(2667) }).reason, "invalid-payload", "多字节 8001 字节拒绝（UTF-8 字节上限非字符数）");
		assert.equal(smDir("sm-mb-mixed", { text: "中".repeat(2666) + "abc" }).reason, "invalid-payload", "混合 8001 字节拒绝");
		{
			const rMbOk = smDir("sm-mb-ok", { text: "中".repeat(2666) + "a" });
			assert.ok(rMbOk.status === "accepted", `恰 7999 字节多字节放行（2666×3+1）：${JSON.stringify(rMbOk)}`);
		}
		assert.equal(smDir("sm-del", { text: "a\u007fb" }).reason, "invalid-payload", "DEL 拒绝");
		for (let code = 1; code <= 31; code++) {
			if (code === 9 || code === 10 || code === 13) continue; // \t\n\r 保留
			assert.equal(smDir(`sm-c0-${code}`, { text: `a${String.fromCodePoint(code)}b` }).reason, "invalid-payload", `C0 ${code} 拒绝`);
		}
		// 结构性拒绝发生在 claim 之前：同键先 invalid 后 valid → valid 全新执行（非 replay）
		assert.equal(smDir("sm-key-reuse", { text: "" }).reason, "invalid-payload");
		{
			const rReuse = smDir("sm-key-reuse", { text: "reuse" });
			assert.ok(rReuse.status === "accepted" && rReuse.replayed === false, "结构拒绝不占幂等键：同键 valid 全新执行");
		}

		// 边界放行：8000 字节整 / \t\n\r 保留 / reason 512 字节
		const r8000 = smDir("sm-8000", { text: "y".repeat(8000) });
		assert.ok(r8000.status === "accepted", "8000 字节整 → accepted");
		const rWs = smDir("sm-wschars", { text: "line1\nline2\ttab\rcr" });
		assert.ok(rWs.status === "accepted", "\t\n\r 放行");
		const itemWs = listOutboxItems(obDir).find((it) => it.commandKey === "sm-wschars")!;
		assert.equal(itemWs.text, "line1\nline2\ttab\rcr", "正文逐字保留");

		// happy path：accepted → outbox pending 落盘 + journal queued；正文不进 journal
		const jBefore = listRuntimeEnvelopes({ path: J11 }).envelopes;
		const rOk = exec(sm("sm-ok", piSessionAddress(targetSid), msg("你好，远程会话", { reason: "gui" })), { stateDir: SM, journalPath: J11, sessionsDir });
		assert.ok(rOk.status === "accepted" && rOk.summary.includes("queued"), `accepted：${JSON.stringify(rOk)}`);
		const items = listOutboxItems(obDir);
		const item = items.find((it) => it.commandKey === "sm-ok")!;
		assert.ok(item, "outbox 项已落盘");
		assert.equal(item.status, "pending", "第一段状态 = pending");
		assert.equal(item.to, piSessionAddress(targetSid));
		assert.equal(item.sessionId, targetSid);
		assert.equal(item.text, "你好，远程会话");
		assert.equal(item.reason, "gui");
		const jAfter = listRuntimeEnvelopes({ path: J11 }).envelopes;
		const accepted = jAfter.find((e) => e.type === "command.accepted" && (e.payload as any)?.commandKey === "sm-ok");
		const queued = jAfter.find((e) => e.type === "message.queued" && (e.payload as any)?.commandKey === "sm-ok");
		assert.ok(accepted && queued, "journal 双事件（command.accepted + message.queued）");
		assert.equal((queued!.payload as any).outboxId, item.id, "queued.outboxId 关联");
		assert.equal((queued!.payload as any).sessionId, targetSid);
		assert.equal(JSON.stringify(jAfter).includes("你好"), false, "正文绝不进 journal");
		// pi 会话文件零接触（§29：executor 不写会话，注入是桥的事）
		assert.equal(readFileSync(join(sessionsDir, `2026-09-22T09-00-00-000Z_${targetSid}.jsonl`), "utf8").split("\n").filter((l) => l.trim()).length, 1, "目标会话文件未被触碰");

		// 同键幂等重放：replayed:true、单文件、queued 不重复
		const rReplay = exec(sm("sm-ok", piSessionAddress(targetSid), msg("你好，远程会话")), { stateDir: SM, journalPath: J11, sessionsDir });
		assert.ok(rReplay.status === "accepted" && rReplay.replayed, "同键重放幂等");
		assert.equal(listOutboxItems(obDir).filter((it) => it.commandKey === "sm-ok").length, 1, "单 outbox 文件");
		assert.equal(listRuntimeEnvelopes({ path: J11 }).envelopes.filter((e) => e.type === "message.queued" && (e.payload as any)?.commandKey === "sm-ok").length, 1, "queued 不重复");
	}

	// ── G9 冒烟（续）：consumer 命令信接线（0920 backlog A：master_default 域 → executor）──
	{
		setCutover(true, "test");
		const att = readAttachment(master)!;
		const sid = att.sessionId;
		const runsDir = join(ROOT, "tab-runs");
		mkdirSync(runsDir, { recursive: true });

		// 命令信（issuedAt ≥ cutover）：master_default 域 → executor 确定性执行；
		// agent.wake 不在白名单 → rejected(not-implemented) → 纯报告回执 → ack 终态不重投
		deliverCommand(newCommandFrame({
			type: "agent.wake", to: master, issuedBy: "agent://agent_worker_1",
			commandKey: "wake:smoke", issuedAt: iso(),
		}), { mailboxDir: ROOT });
		const sent: string[] = [];
		const r = consumeMailboxOnce({ sessionId: sid, mailboxDir: ROOT, runsDir, sendUserMessage: (b) => { sent.push(b); } });
		const cmdEntry = r.consumed.find((c) => c.action === "executed");
		assert.ok(cmdEntry && cmdEntry.reason === "command-rejected:not-implemented", "命令信进 executor：白名单外 rejected(not-implemented)");
		assert.equal(sent.length, 1, "恰一条回执 followUp（纯报告）");
		assert.ok(sent[0]!.includes("命令回执") && sent[0]!.includes("rejected") && !sent[0]!.includes("待执行"), "回执是纯报告非指令（红线：命令不进 LLM 注入）");
		const letters = listLetters(master, undefined, ROOT);
		const smoke = letters.find((l) => l.frame.frame === "command" && l.frame.commandKey === "wake:smoke");
		assert.ok(smoke && smoke.status === "acked", "rejected 终态 ack（不重投，防毒信循环）");

		// message 帧链路零回归：REPORT 照常注入 + ack
		deliverLetter(newMessageFrame({
			id: newEnvelopeId("msg"), kind: "REPORT",
			from: "agent://agent_worker_1", to: master, subject: "run://tab/tab_smoke",
			sentAt: iso(), summary: "smoke report", details: { tabRunId: "tab_smoke", status: "completed" },
		}), { mailboxDir: ROOT });
		const sent2: string[] = [];
		const r2 = consumeMailboxOnce({ sessionId: sid, mailboxDir: ROOT, runsDir, sendUserMessage: (b) => { sent2.push(b); } });
		assert.equal(r2.consumed.filter((c) => c.action === "injected").length, 1, "message 帧照常注入");
		assert.equal(sent2.length, 1);
		assert.ok(!listLetters(master, undefined, ROOT).some((l) => l.frame.frame === "message" && l.frame.body.summary === "smoke report" && l.status === "pending"), "message 信已 ack");
	}
} finally {
	rmSync(ROOT, { recursive: true, force: true });
}

console.log("_test_runtime_commands: all assertions passed");
