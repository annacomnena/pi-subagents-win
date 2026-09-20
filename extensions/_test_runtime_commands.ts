/**
 * _test_runtime_commands.ts — G4 测试：deterministic command executor
 * （plans/0920_G4_cmdexec_plan.md §6 测试清单，9 组）
 *
 *   G1 白名单：COMMAND_TYPES +3 过 validateCommandFrame；未知 type 仍拒
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

import { masterAddress, workstreamAddress } from "./runtime/address.ts";
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

async function postJson(base: string, path: string, body: unknown): Promise<{ status: number; body: any }> {
	const res = await fetch(`${base}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
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
			["agent.wake", "task.cancel", "workstream.pause", "workstream.resume", "master.handoff.accept", "master.auto-handoff.set", "master.handoff.prepare"],
			"词表 additive（G4 +3 / G5.2 +prepare，只加不改）",
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
	}

	// ── G9 冒烟（续）：consumer 命令信 command-deferred（零行为变化）──
	{
		setCutover(true, "test");
		const att = readAttachment(master)!;
		const sid = att.sessionId;
		const runsDir = join(ROOT, "tab-runs");
		mkdirSync(runsDir, { recursive: true });

		// 命令信（issuedAt ≥ cutover）：显式 deferred、保持 pending、零注入
		deliverCommand(newCommandFrame({
			type: "agent.wake", to: master, issuedBy: "agent://agent_worker_1",
			commandKey: "wake:smoke", issuedAt: iso(),
		}), { mailboxDir: ROOT });
		const sent: string[] = [];
		const r = consumeMailboxOnce({ sessionId: sid, mailboxDir: ROOT, runsDir, sendUserMessage: (b) => { sent.push(b); } });
		const cmdEntry = r.consumed.find((c) => c.reason === "command-deferred");
		assert.ok(cmdEntry && cmdEntry.action === "skipped", "命令信显式 command-deferred（替换误导性 claim-missed）");
		assert.equal(sent.length, 0, "零注入");
		const letters = listLetters(master, undefined, ROOT);
		assert.ok(letters.some((l) => l.frame.frame === "command" && l.frame.commandKey === "wake:smoke" && l.status === "pending"), "命令信保持 pending 可审计");

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
