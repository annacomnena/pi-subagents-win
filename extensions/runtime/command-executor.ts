/**
 * runtime/command-executor.ts — G4：Deterministic Command Executor（总计划 §29）。
 *
 * 链路契约（§29 反模式防线）：「用户点击 → CommandFrame → 本执行器」三段确定性执行，
 * **禁止**把命令注入一句话给 LLM 希望模型执行。**POST /v1/commands 是唯一命令入口**
 * （mailbox 命令信 G4 不消费，见 mailbox-consumer.ts command-deferred；未来 agent 发起
 * 命令属独立任务，复用本执行器作为双消费者核心）。
 *
 * 形状：executeCommand(frame, opts) → CommandOutcome 三态（accepted / rejected / failed）。
 *   - never-throw 面向上层：内部一切异常收敛为 failed，绝不向外抛（HTTP 层 1:1 映射回执）；
 *   - 拒绝不写任何目标状态（workstream / proposal / config 均不动）；
 *   - commandKey 幂等：执行前 `<state/commands>/<sha256(dedupeKey)>.claim` wx 排他 claim
 *     （claimRuntimeEmission 同款，journal.ts#L45）；赢家执行后写 outcome（tmp+rename
 *     原子）；输家读 outcome 原样回放（outcome 内严格比对原始 dedupeKey），不二次执行；
 *     outcome 缺失（claim 后崩溃的极窄窗口）→ `replay-unknown-outcome` 拒绝；
 *     文件名用 SHA-256 摘要而非 sanitizeKey——旧方案把非 `[A-Za-z0-9._-]` 折叠为 `_`，
 *     同 type 的 `a/b` 与 `a?b` 互吞 claim/outcome，破坏 commandKey 级幂等（L4 必修 1）；
 *   - master-only 钉死（L4 必修 2）：master.handoff.accept / master.auto-handoff.set
 *     要求 `frame.to === masterAddress()`（agent://master_default）精确相等，否则 invalid-payload；
 *   - payload 白名单（L4 必修 3）：pause/resume/accept 仅空或 {reason?:string}；
 *     auto 仅 {auto:boolean, reason?:string}；多余/非法字段 → invalid-payload（结构级，
 *     claim 之前拒绝，不占幂等键不写盘面）；
 *   - journal 入账：command.accepted|rejected|failed 各一事件（kind=event，subject=frame.to，
 *     dedupeKey=<type>:<commandKey>），经 appendRuntimeEnvelopeSafe（写失败仅吞掉，不影响回执）。
 *
 * 首批四命令（拍板见 plans/0920_G4_cmdexec_plan.md §0-2）：
 *   - workstream.pause/resume：目标放 to（workstream://<id>）；executor 层最小迁移校验
 *     （严于 updateWorkstream，不改库）；pause 回执沿 slash 口径「只封未来 wake，不杀在飞 tab」；
 *   - master.handoff.accept：= decideProposal(accepted)（S2 proposal 批准，纯状态迁移）；
 *     sessionId 由 readAttachment(to) 解析；实际 transfer 仍由 owner 会话 master-transfer 执行；
 *   - master.auto-handoff.set：JSON 原文 read-modify-write 仅 patch .masterSuccession.auto
 *     （不复用 index.ts readConfig——重建式读法会丢未知顶层键）；原子写 tmp+rename +
 *     EPERM×3 重试（Windows 并发 reader 持句柄短暂 EPERM）；写前 fresh read 收窄窗口。
 *     残余风险：极小概率 lost update（人工频率开关切换），后果=开关回退一次重按自愈；
 *     原子写保证无 JSON 损坏面。
 *
 * 白名单外 / 无 handler 的 type（agent.wake / task.cancel）→ not-implemented 拒绝。
 * task.cancel 等 agent 发起类命令留待后续批次（白名单 additive 不删）。
 *
 * 纯库：stateDir/configPath/journalPath/commandsDir 全可注入，无 Pi API 依赖（同
 * master-control 纪律：禁止触碰 pi ctx）。
 */

import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { masterAddress, parseObjectAddress, type ObjectAddress } from "./address.ts";
import { newEventEnvelope } from "./envelope.ts";
import { appendRuntimeEnvelopeSafe, defaultJournalPath, defaultRuntimeDir } from "./journal.ts";
import { readLiveness } from "./liveness.ts";
import { DEFAULT_MASTER_SUCCESSION, normalizeMasterSuccession } from "./master-auto.ts";
import { decideProposal, maybePropose, readProposal } from "./master-succession.ts";
import { readAttachment } from "./registry.ts";
import { validateCommandFrame, type CommandFrame } from "./protocol.ts";
import { readWorkstream, updateWorkstream } from "./workstreams.ts";

// ── 词表 ───────────────────────────────────────────────────────────

/** 本执行器已实现 handler 的 type（白名单内但无 handler 的 → not-implemented）。 */
export const IMPLEMENTED_COMMAND_TYPES = [
	"workstream.pause",
	"workstream.resume",
	"master.handoff.accept",
	"master.auto-handoff.set",
	"master.handoff.prepare",
] as const;

export type ImplementedCommandType = (typeof IMPLEMENTED_COMMAND_TYPES)[number];

/** master-only 命令：to 必须精确 === masterAddress()（agent://master_default），否则 invalid-payload。 */
const MASTER_ONLY_TYPES: readonly string[] = [
	"master.handoff.accept",
	"master.auto-handoff.set",
	"master.handoff.prepare",
];

/** 拒绝 reason 词表（HTTP 映射：400 invalid-payload·unknown-command·not-implemented /
 *  404 no-workstream·no-proposal / 409 bad-state·not-owner·not-attached·replay-unknown-outcome）。 */
export type CommandRejectReason =
	| "invalid-payload"
	| "unknown-command"
	| "not-implemented"
	| "no-workstream"
	| "no-proposal"
	| "bad-state"
	| "not-owner"
	| "not-attached"
	| "replay-unknown-outcome";

export type CommandOutcome =
	| { status: "accepted"; summary: string; replayed: boolean }
	/** detail（G5.2 additive，可选）：拒绝的面向用户的补充说明（如 prepare 无心跳提示），HTTP 面原样透传。 */
	| { status: "rejected"; reason: CommandRejectReason; detail?: string; replayed: boolean }
	| { status: "failed"; reason: "io-error" | "failed"; error?: string; replayed: boolean };

// ── 选项与路径 ─────────────────────────────────────────────────────

export interface ExecuteCommandOptions {
	/** runtime state 根（缺省 <runtime>/state）；workstream/commands 派生自它。 */
	stateDir?: string;
	/** config.json 路径（auto-handoff.set 用；缺省包根 config.json——S3 真相在 config 切片，
	 *  跟随现状不新造第二位置，迁移属未决）。 */
	configPath?: string;
	journalPath?: string;
	/** 幂等 claim/outcome 目录（缺省 <stateDir>/commands；不做 compaction，§23 纪律同 journal）。 */
	commandsDir?: string;
	now?: Date;
}

function stateRoot(opts: ExecuteCommandOptions): string {
	return opts.stateDir ?? join(defaultRuntimeDir(), "state");
}

function commandsRoot(opts: ExecuteCommandOptions): string {
	return opts.commandsDir ?? join(stateRoot(opts), "commands");
}

/** 缺省 config：包根 config.json（本文件位于 <pkg>/extensions/runtime/，上跳两级）。 */
function defaultPkgConfigPath(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "config.json");
}

/** 服务端注入惯例（拍板 2）：客户端可不传 issuedBy，HTTP 层以此补齐。 */
export const RUNTIME_HOST_ISSUER: ObjectAddress = "agent://runtime-host";

// ── 主入口 ─────────────────────────────────────────────────────────

/**
 * 执行一条 CommandFrame，返回三态回执。never-throw：任何异常收敛为 failed。
 * 幂等：同 <type>:<commandKey> 重放返回首次 outcome（replayed:true），零二次副作用。
 */
export function executeCommand(frame: CommandFrame, opts: ExecuteCommandOptions = {}): CommandOutcome {
	try {
		return executeCommandInner(frame, opts);
	} catch (e) {
		return { status: "failed", reason: "failed", error: e instanceof Error ? e.message : String(e), replayed: false };
	}
}

function executeCommandInner(frame: CommandFrame, opts: ExecuteCommandOptions): CommandOutcome {
	// 结构校验（claim 之前：结构性拒绝不占幂等键、不写任何盘面）
	if (!validateCommandFrame(frame)) return reject("invalid-payload");
	if (!(IMPLEMENTED_COMMAND_TYPES as readonly string[]).includes(frame.type)) {
		return reject("not-implemented");
	}
	// master-only 钉死：accept / auto-handoff.set 只认精确 master 地址（字符串全等）
	if (MASTER_ONLY_TYPES.includes(frame.type) && frame.to !== masterAddress()) return reject("invalid-payload");
	// payload 白名单：多余/非法字段一律拒绝（封闭字段集）
	if (!commandPayloadOk(frame)) return reject("invalid-payload");

	// commandKey 幂等 claim（wx 排他；同键重放/并发双请求只有赢家执行）
	const dedupeKey = `${frame.type}:${frame.commandKey}`;
	const commandsDir = commandsRoot(opts);
	mkdirSync(commandsDir, { recursive: true });
	if (!claimCommandExecution(dedupeKey, commandsDir)) {
		// 输家：读赢家 outcome 原样回放
		const prev = readCommandOutcome(dedupeKey, commandsDir);
		if (!prev) return reject("replay-unknown-outcome");
		return { ...prev.outcome, replayed: true };
	}

	// 赢家：执行 + 落 outcome + journal 入账（safe，不影响回执）
	const outcome = dispatchHandler(frame, opts);
	writeCommandOutcome(dedupeKey, commandsDir, outcome, opts.now ?? new Date());
	appendCommandJournalEvent(frame, outcome, opts);
	return outcome;
}

function reject(reason: CommandRejectReason): CommandOutcome {
	return { status: "rejected", reason, replayed: false };
}

// ── payload 白名单（封闭字段集；pause/resume/accept 空或 {reason?}，auto {auto, reason?}）──

type PayloadFieldType = "string" | "boolean";

function commandPayloadOk(frame: CommandFrame): boolean {
	switch (frame.type) {
		case "workstream.pause":
		case "workstream.resume":
		case "master.handoff.accept":
		case "master.handoff.prepare":
			return payloadShapeOk(frame.payload, {}, { reason: "string" });
		case "master.auto-handoff.set":
			return payloadShapeOk(frame.payload, { auto: "boolean" }, { reason: "string" });
		default:
			return true; // not-implemented 层已拒，无 handler type 的 payload 留待对应批次
	}
}

/** 封闭校验：字段名必须在 required/optional 内且类型匹配；缺 required → false。 */
function payloadShapeOk(
	payload: unknown,
	required: Record<string, PayloadFieldType>,
	optional: Record<string, PayloadFieldType>,
): boolean {
	if (payload === undefined) return Object.keys(required).length === 0;
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
	const rec = payload as Record<string, unknown>;
	for (const [key, value] of Object.entries(rec)) {
		const want = required[key] ?? optional[key];
		if (want === undefined) return false; // 多余字段拒绝
		if (value !== undefined && typeof value !== want) return false; // 类型非法（显式 undefined 视同缺省）
	}
	return Object.keys(required).every((key) => rec[key] !== undefined);
}

// ── handler 分发（每 type 一个小函数，master-control 风格）─────────

function dispatchHandler(frame: CommandFrame, opts: ExecuteCommandOptions): CommandOutcome {
	switch (frame.type) {
		case "workstream.pause":
			return runWorkstreamStatus(frame, "paused", opts);
		case "workstream.resume":
			return runWorkstreamStatus(frame, "active", opts);
		case "master.handoff.accept":
			return runHandoffAccept(frame, opts);
		case "master.auto-handoff.set":
			return runAutoHandoffSet(frame, opts);
		case "master.handoff.prepare":
			return runHandoffPrepare(opts);
		default:
			return reject("not-implemented");
	}
}

// ── 2.1/2.2 workstream.pause / resume ─────────────────────────────

/** pause 合法源状态集（保守拍板：未决 4 复核点）；resume 仅 paused。 */
const PAUSE_FROM: readonly string[] = ["active", "waiting", "blocked"];
const RESUME_FROM: readonly string[] = ["paused"];

const PAUSE_NOTE = "未来 wake 已封；在飞 tab 不受影响，需手动 reclaim";

function runWorkstreamStatus(frame: CommandFrame, target: "paused" | "active", opts: ExecuteCommandOptions): CommandOutcome {
	const parsed = parseObjectAddress(frame.to);
	if (!parsed || parsed.scheme !== "workstream" || !parsed.value) return reject("invalid-payload");
	const wsId = parsed.value;
	const stateDir = stateRoot(opts);

	const ws = readWorkstream(wsId, stateDir);
	if (!ws) return reject("no-workstream");

	// 幂等 no-op：已在目标态 → 成功回执、不写状态（不产生 audit 尾迹）
	if (ws.status === target) {
		const note = target === "paused" ? `（no-op，已是 paused；${PAUSE_NOTE}）` : "（no-op，已是 active）";
		return { status: "accepted", summary: `workstream ${wsId} → ${target}${note}`, replayed: false };
	}

	// executor 层最小迁移校验（严于 updateWorkstream 的六态直写，不改库）
	const allowed = target === "paused" ? PAUSE_FROM : RESUME_FROM;
	if (!allowed.includes(ws.status)) return reject("bad-state");

	const updated = updateWorkstream(wsId, { status: target, stateDir, session: frame.issuedBy });
	if (!updated) return reject("no-workstream"); // 读后被删的极窄竞态
	const summary =
		target === "paused"
			? `workstream ${wsId} → paused（${PAUSE_NOTE}）`
			: `workstream ${wsId} → active`;
	return { status: "accepted", summary, replayed: false };
}

// ── 2.3 master.handoff.accept ─────────────────────────────────────

function runHandoffAccept(frame: CommandFrame, opts: ExecuteCommandOptions): CommandOutcome {
	// master-only 已在入口钉死（to === masterAddress()）；sessionId 由 attachment 解析（拍板 1）
	const att = readAttachment(frame.to);
	if (!att) return reject("not-attached");
	const r = decideProposal(
		{ sessionId: att.sessionId, decision: "accepted" },
		{ stateDir: stateRoot(opts), journalPath: opts.journalPath },
	);
	if (!r.ok) return reject(r.reason);
	return {
		status: "accepted",
		summary: `handoff proposal ${r.proposal.proposalId} accepted（gen ${r.proposal.generation}；实际 transfer 由 owner 会话 master-transfer 执行）`,
		replayed: false,
	};
}

// ── 2.4 master.auto-handoff.set ───────────────────────────────────

function runAutoHandoffSet(frame: CommandFrame, opts: ExecuteCommandOptions): CommandOutcome {
	// to 与 payload 形状已由入口校验钉死（master-only + 白名单），此处只做业务
	const payload = frame.payload as { auto: boolean; reason?: string };
	const configPath = opts.configPath ?? defaultPkgConfigPath();
	const want = payload.auto;

	// 全文 JSON 透传 read-modify-write：仅 patch .masterSuccession.auto，models 等全部
	// 切片与未知顶层键逐字保留（不复用 index.ts readConfig 重建式读法）。
	// 写前即时 fresh read：窗口收窄至亚毫秒（§2.4 并发竞争方案②）。
	let raw: Record<string, unknown>;
	try {
		raw = readConfigRaw(configPath);
	} catch (e) {
		return { status: "failed", reason: "io-error", error: `read config: ${msg(e)}`, replayed: false };
	}
	const slice =
		typeof raw.masterSuccession === "object" && raw.masterSuccession !== null && !Array.isArray(raw.masterSuccession)
			? (raw.masterSuccession as Record<string, unknown>)
			: {};
	const nextSlice = { ...slice, auto: want };
	// normalizeMasterSuccession 校验：严格 ===true 才 ON，OFF 零行为（写入值必须归一化自洽）
	if (normalizeMasterSuccession(nextSlice).auto !== want) {
		return { status: "failed", reason: "failed", error: "normalizeMasterSuccession rejected written auto value", replayed: false };
	}
	const next = { ...raw, masterSuccession: nextSlice };
	try {
		writeJsonAtomic(configPath, next);
	} catch (e) {
		return { status: "failed", reason: "io-error", error: `write config: ${msg(e)}`, replayed: false };
	}
	return {
		status: "accepted",
		summary: `masterSuccession.auto = ${want}（S3 自动交接${want ? "开启" : "关闭"}${payload.reason ? `；reason: ${payload.reason}` : ""}）`,
		replayed: false,
	};
}

// ── 2.5 master.handoff.prepare（G5.2：GUI Prepare 按钮的确定性提案路径）──

/**
 * 立即生成交接提案（S2 maybePropose 确定性路径）。
 *
 * 压力语义（G5.2 拍板：Host 侧不伪造压力）：读当前真实压力不可得 → pressure 只能用
 * `readLiveness` 最新心跳值（owner 会话 agent_end 写手落盘）；无心跳/无有效读数 →
 * 拒绝 invalid-payload + detail 提示先由值守会话产生心跳。
 *
 * 确定性：proposalPercent=0（无视达线判定——prepare 语义就是「立即生成」，与 S2 自动
 * 提议线正交）；enabled 尊重 config.masterSuccession 总开关；同代已有 proposal → 幂等
 * 返回 accepted 不重复建（maybePropose already-proposed + readProposal 回读）。
 */
function runHandoffPrepare(opts: ExecuteCommandOptions): CommandOutcome {
	const stateDir = stateRoot(opts);
	const live = readLiveness(stateDir);
	if (!live || live.pressure === null) {
		return {
			status: "rejected",
			reason: "invalid-payload",
			detail: "无可用的 liveness 心跳压力值：请先由值守 Master 会话跑完一轮（agent_end 心跳写手落盘 master-liveness.json 后重试）",
			replayed: false,
		};
	}
	const att = readAttachment(masterAddress());
	if (!att) return { status: "rejected", reason: "not-attached", replayed: false };

	// config 切片只读（缺失/坏 → 归一化默认；prepare 不写 config，坏盘面不升 io-error）
	let enabled = DEFAULT_MASTER_SUCCESSION.enabled;
	try {
		enabled = normalizeMasterSuccession(readConfigRaw(opts.configPath ?? defaultPkgConfigPath()).masterSuccession).enabled;
	} catch {
		/* 缺失/坏 JSON → 默认切片 */
	}
	if (!enabled) {
		return { status: "rejected", reason: "bad-state", detail: "master-succession 总开关已关闭，提案通道停用", replayed: false };
	}

	// tokens 不可得（liveness 不存 tokens）→ 阈值判定走 percent 兆底分支；proposalPercent=0 恒达线
	const r = maybePropose(
		{
			sessionId: att.sessionId,
			generation: att.generation,
			reading: { tokens: null, contextWindow: live.windowTokens ?? null, percent: live.pressure },
			proposalPercent: 0,
			enabled,
		},
		{ stateDir, journalPath: opts.journalPath },
	);
	if (r === null) {
		return { status: "rejected", reason: "bad-state", detail: "master-succession 已停用", replayed: false };
	}
	if (r.proposed) {
		return {
			status: "accepted",
			summary: `handoff proposal ${r.proposal.proposalId} 已生成（gen ${r.proposal.generation}，pressure ${r.proposal.pressure}%，来自 liveness 心跳 ${live.updatedAt}）；实际交接由 owner 会话 master-transfer 执行`,
			replayed: false,
		};
	}
	switch (r.reason) {
		case "already-proposed": {
			// 幂等：同代已有 proposal（任意状态）→ 原样返回不重复建
			const p = readProposal(stateDir);
			return {
				status: "accepted",
				summary: `已有同代提案 ${p?.proposalId ?? "?"}（status=${p?.status ?? "?"}），幂等返回不重复创建`,
				replayed: false,
			};
		}
		case "not-owner":
			return { status: "rejected", reason: "not-owner", replayed: false };
		default:
			// no-decision / below-threshold：pressure 已非空 + 阈值 0 下不可达；防御性拒绝
			return { status: "rejected", reason: "bad-state", detail: `maybePropose: ${r.reason}`, replayed: false };
	}
}

function readConfigRaw(configPath: string): Record<string, unknown> {
	let text: string;
	try {
		text = readFileSync(configPath, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return {}; // 首次无 config = 空对象起步
		throw e;
	}
	const parsed = JSON.parse(text) as unknown; // 坏 JSON 抛出 → io-error（不静默重建，防覆盖）
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("config root must be a JSON object");
	}
	return parsed as Record<string, unknown>;
}

// ── 幂等盘面（state/commands/）────────────────────────────────────

interface StoredOutcome {
	version: 1;
	dedupeKey: string;
	executedAt: string;
	outcome: CommandOutcome;
}

/**
 * 幂等盘面文件名 = dedupeKey 的 SHA-256 hex 摘要 + 后缀（定长 64，跨平台文件名安全，无碰撞面）。
 * 旧 sanitizeKey 把非 `[A-Za-z0-9._-]` 折叠为 `_`，同 type 的 `a/b` 与 `a?b` 映射同名文件互吞
 * claim/outcome（不同 commandKey 被当作同一重放）——改摘要编码后映射可逆性由 outcome 内
 * dedupeKey 严格比对兜底（readCommandOutcome），非同键文件永不互认。
 */
export function commandArtifactName(dedupeKey: string, suffix: ".claim" | ".outcome.json"): string {
	return createHash("sha256").update(dedupeKey, "utf8").digest("hex") + suffix;
}

/** wx 排他领取执行权（claimRuntimeEmission 同款）；false = 已有赢家。IO 异常向上抛（→failed）。 */
function claimCommandExecution(dedupeKey: string, commandsDir: string): boolean {
	const fileName = commandArtifactName(dedupeKey, ".claim");
	let fd: number;
	try {
		fd = openSync(join(commandsDir, fileName), "wx");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw e;
	}
	try {
		closeSync(fd);
	} catch {
		/* ignore */
	}
	return true;
}

function readCommandOutcome(dedupeKey: string, commandsDir: string): StoredOutcome | null {
	try {
		const raw = JSON.parse(readFileSync(join(commandsDir, commandArtifactName(dedupeKey, ".outcome.json")), "utf8")) as StoredOutcome;
		// 严格比对原始 dedupeKey：非同键文件（理论上仅摘要碰撞）永不互认
		return raw?.version === 1 && raw.outcome && raw.dedupeKey === dedupeKey ? raw : null;
	} catch {
		return null;
	}
}

function writeCommandOutcome(dedupeKey: string, commandsDir: string, outcome: CommandOutcome, now: Date): void {
	const record: StoredOutcome = { version: 1, dedupeKey, executedAt: now.toISOString(), outcome };
	writeJsonAtomic(join(commandsDir, commandArtifactName(dedupeKey, ".outcome.json")), record);
}

// ── journal 入账（safe wrapper：写失败不影响命令回执）──────────────

function appendCommandJournalEvent(frame: CommandFrame, outcome: CommandOutcome, opts: ExecuteCommandOptions): void {
	const at = (opts.now ?? new Date()).toISOString();
	const envelope = newEventEnvelope({
		type: `command.${outcome.status}`,
		source: frame.issuedBy,
		subject: frame.to,
		at,
		recordedAt: at,
		payload: {
			commandType: frame.type,
			commandKey: frame.commandKey,
			...(outcome.status === "accepted" ? { summary: outcome.summary } : { reason: outcome.reason }),
		},
		dedupeKey: `${frame.type}:${frame.commandKey}`,
	});
	appendRuntimeEnvelopeSafe(envelope, opts.journalPath ?? defaultJournalPath());
}

// ── 原子写（index.ts writeConfig 同款模式）────────────────────────

function writeJsonAtomic(path: string, value: unknown): void {
	const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	renameWithEpermRetry(tmp, path);
}

/**
 * tmp+rename 原子落盘 + EPERM×3 重试（10ms backoff）：
 * Windows 下并发 reader 持句柄时 rename 会短暂 EPERM（§2.4 并发竞争方案①）。
 */
export function renameWithEpermRetry(tmp: string, target: string): void {
	const EPERM_RETRIES = 3;
	const EPERM_BACKOFF_MS = 10;
	for (let attempt = 0; ; attempt++) {
		try {
			renameSync(tmp, target);
			return;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "EPERM" && attempt < EPERM_RETRIES) {
				sleepSync(EPERM_BACKOFF_MS);
				continue;
			}
			try {
				unlinkSync(tmp);
			} catch {
				/* ignore */
			}
			throw e;
		}
	}
}

/** 同步 sleep（rename 重试 backoff 用；Atomics.wait 主线程可用）。 */
function sleepSync(ms: number): void {
	try {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
	} catch {
		/* 极端宿主不支持时退化为忙等一步（backoff 尽力而为） */
	}
}

function msg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
