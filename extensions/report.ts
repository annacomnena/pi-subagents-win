/**
 * report — tab → 主会话 的主动回报通道
 *
 * 与「主会话 → tab 邮箱注入」（timers/mail/）反向对称：
 * tab 在工作完成（或任何需要主会话关注时）调用 tab-report 写一份回报文件，
 * 主会话 fs.watch（+ tick 兜底）感知后注入一条用户消息，模型被唤醒处理。
 *
 * 文件：~/.pi/agent/reports/<ts>_<rand>.json（原子写，追加式目录，崩溃安全）
 * 回报内容：{ from(会话身份), message, taskId?, summary?, at, pid }
 *
 * 只主会话注册监听（标签页/子 agent 不注册，避免重复注入）；
 * 去重：启动时快照已有报告视为已处理，只对启动后新出现的注入。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, renameSync, unlinkSync, watch, writeFileSync, writeSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { sendWindowsToast } from "./notify-windows.ts";
import { getCurrentSessionId, isMainSession, isSubagent, sessionScopeKey, setCurrentSessionId } from "./identity.ts";
import { masterAddress } from "./runtime/address.ts";
import { readAttachment, readCutover, findAttachmentBySession } from "./runtime/registry.ts";
import { postInject, preInject, type InjectionContext } from "./injection-gate.ts";
import { NO_POLL_HINT } from "./no-poll.ts";
import { defaultLinksPath, listLinks } from "./links.ts";

export interface ReportRecord {
	/**
	 * 记录自己的 id（= 文件名去扩展名）。
	 *
	 * **2026-11-26 新增**（global master 指出）：此前 id 只存于**文件名**。
	 * ⇒ 后果：一份 report 的**正文无法标识自己** —— 谁引用它、转发它、在文档里贴它，
	 * id 就丢了；而 `.unroutable` 侧车里**有** `id`，两个文件字段集不一致，且缺的正是主文件那个。
	 *
	 * 判据：**任何落盘的记录，其正文必须含自己的标识；只靠文件名标识的记录，
	 * 一旦被复制出去就失去身份。**
	 *
	 * 可选是为了兼容 2026-11-26 之前的存量记录（它们确实没有），不是给新写入留口子 ——
	 * `sendReportToMain` **总是**写。
	 */
	id?: string;
	/** 回报方身份：tab_<runId> 或 sessionId（或 agent:// 地址）。 */
	from: string;
	/**
	 * 【2026-11-25 新增】**显式接收方**。
	 *
	 * 为什么需要：旧实现只从 `from` 推导接收方（`from` 是 tab ⇒ 查 links 拿**派发方**），
	 * 这个语义只回答了「谁派我去的」，**无法表达横向汇报**（local master → global master）。
	 * 若强行把 `from = agent://master_local_X` 解析成它自己的 sessionId，
	 * 结果是**自环**（report 被注入回发送方自己）。
	 *
	 * ⇒ 横向汇报必须**显式**给出 `to`，不从 `from` 猜。
	 * 支持：`agent://master_*`（读 registry/attachments 拿 sessionId）、UUID、`tab_*`。
	 */
	to?: string;
	/** 回报消息（注入主会话的用户消息内容）。 */
	message: string;
	taskId?: string;
	summary?: string;
	at: string;
	pid: number;
	/**
	 * 发送进程的工作目录（2026-11-26）。
	 *
	 * 为什么加：`from` 是**纯字符串参数**，零成本就能写别人的地址。实测事故：我在
	 * `G:/code/GreenCAD` 的 cwd 里跑脚本、`from` 写 `agent://master_local_GreenCAD` ⇒
	 * global master 收到的报带着 `from=GreenCAD` 但 `pid=117808`（**我的**脚本进程，不是
	 * GreenCAD 的 30212）。它当场指出「这条不能证明 GreenCAD 能发」—— 完全正确。
	 *
	 * ⚠ 强度限定：`cwd` 也不是不可伪造的（脚本可 `process.chdir()`），它只是把伪造成本
	 * 从「传个字符串」抬到「主动 chdir」。真正的不可伪造身份是 OS 层的 pid+命令行。
	 *
	 * ⚠ 类型补登（L4 B3，2026-11-26）：本字段早已在写入/`Pick`/读三处使用，但 interface 当时
	 * **漏声明**（本仓无 tsc 脚本 ⇒ 静默）。现在补上。
	 */
	cwd?: string;
	/**
	 * 发送方声称/继承的会话 id，用于与 `from` 的 attachment `sessionId` 比对（`detectFromMismatch`）。
	 *
	 * 两种来源（优先级从高到低）：
	 *  ① `sendReportToMain({ sessionId })` —— **调用方显式提供**（`work-report` 传 `getCurrentSessionId()`）；
	 *  ② `process.env.PI_SESSION_ID` —— 仅当调用方没传时回退（脚本入口靠它，子进程从会话继承）。
	 *
	 * ⚠ 为什么必须有"显式提供"这条路（L4 §5.2，2026-11-26 实测确认）：
	 * `scripts/boot-resume-master.ps1:93` 在启动 master 时**主动清掉** `PI_SESSION_ID`
	 * ⇒ boot 出来的 master 宿主进程**很可能没有这个环境变量**。若只读 env，
	 * `work-report`（旗舰入口）写出的报就永远没有 `envSessionId` ⇒ 冒充检测永不触发。
	 *
	 * ⚠ 强度限定：`envSessionId` 也能人为设置（`PI_SESSION_ID=x node …`）⇒ 抬高成本，不是不可伪造。
	 */
	envSessionId?: string;
}

export function defaultReportsDir(agentDir: string = join(homedir(), ".pi", "agent")): string {
	return join(agentDir, "reports");
}

/** 写一份回报（原子：tmp + rename）。由 tab 侧调用。 */
export function sendReportToMain(
	opts: { from: string; message: string; taskId?: string; summary?: string; to?: string; sessionId?: string },
	reportsDir: string = defaultReportsDir(),
): string {
	const id = `report_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
	const record: ReportRecord = {
		id,
		from: opts.from,
		...(opts.to ? { to: opts.to } : {}),
		message: opts.message,
		taskId: opts.taskId,
		summary: opts.summary,
		at: new Date().toISOString(),
		pid: process.pid,
		cwd: process.cwd(),
		...((): { envSessionId?: string } => {
			// 显式 sessionId 优先（`work-report` 的旗舰路径：宿主进程可能没有 PI_SESSION_ID，
			// 见 interface 注释与 L4 §5.2）；否则回退继承的 env（脚本路径）。
			const sid = opts.sessionId?.trim() || process.env.PI_SESSION_ID?.trim();
			return sid ? { envSessionId: sid } : {};
		})(),
	};
	if (!existsSync(reportsDir)) mkdirSync(reportsDir, { recursive: true });
	const file = join(reportsDir, `${id}.json`);
	writeFileSync(`${file}.tmp`, JSON.stringify(record, null, 2) + "\n", "utf8");
	renameSync(`${file}.tmp`, file);
	return id;
}

/** UUID 形态（会话 id）判定：小写十六进制 + 连字符，≥ 8 位。 */
function isUuidLike(s: string): boolean {
	return /^[0-9a-f-]{8,}$/i.test(s);
}

/** tab runId 形态 ⇒ 查 links.jsonl 拿**派发方**（= 子→父汇报的接收方）。 */
function dispatchSessionForTab(tabRunId: string, linksPath: string): string | undefined {
	for (const link of listLinks(linksPath)) {
		if (link.kind === "tab" && link.targetId === tabRunId && link.sessionId && link.sessionId !== "unknown") {
			return link.sessionId;
		}
	}
	return undefined;
}

/**
 * `agent://*` 地址 ⇒ 会话 sessionId（读 `registry/attachments/<addr>.json`）。
 *
 * **fail closed**：无 attachment / 读失败 / sessionId 不合法 ⇒ `undefined`（不猜）。
 * 这是 Item 66 第 2 层（2026-11-25）：此前 `recipientSessionIdFor` 不认 `agent://`，
 * 导致 `report_mwucgcad_r1a0`（from=`agent://master_local_GreenCAD`）永不消费。
 */
function sessionIdForAgentAddress(addr: string): string | undefined {
	try {
		const att = readAttachment(addr as Parameters<typeof readAttachment>[0]);
		if (!att || typeof att.sessionId !== "string" || !isUuidLike(att.sessionId)) return undefined;
		return att.sessionId;
	} catch {
		return undefined;
	}
}

/**
 * 回报的预期接收会话 UUID：
 *   - **有 `to` ⇒ 按 `to` 解析**（2026-11-25 新增；横向汇报唯一正确入口）；
 *   - 无 `to` ⇒ 旧逻辑**逐字节不变**：`from` 是 tab runId ⇒ 查 links 拿派发方；
 *     `from` 本身是 sessionId ⇒ 直接视为接收方；解析不到 ⇒ undefined。
 *
 * 修复 2026-08-11：此前任何 identityless 进程都能抢回报（.notified 只去重不定位），
 * 导致 task 238 的回报落到无关目录的会话。
 */
export function recipientSessionIdFor(record: Pick<ReportRecord, "from" | "to">, linksPath: string = defaultLinksPath()): string | undefined {
	// ① 显式 to 优先：不从 from 推导（避免 `agent://` 自环）
	if (record.to) {
		const t = record.to;
		if (t.startsWith("agent://")) return sessionIdForAgentAddress(t);
		if (t.startsWith("tab_")) return dispatchSessionForTab(t, linksPath);
		return isUuidLike(t) ? t : undefined;
	}
	// ② 旧逻辑逐字保留
	const from = record.from;
	if (!from) return undefined;
	if (!from.startsWith("tab_")) {
		// sessionId 形态：直接作为接收方
		return isUuidLike(from) ? from : undefined;
	}
	return dispatchSessionForTab(from, linksPath);
}

/**
 * **独立**可疑信号（2026-11-26，把 global master 的三步判据变成可跑的代码）。
 *
 * 为什么需要：`detectFromMismatch` 对自家脚本恒 null（tautology，已在那里登记）。
 * 真正的**独立**证据只有两条：
 *   ① `envSessionId` 不在任何 master attachment 里 ⇒ 这个会话根本没登记过（`unknown-session`）
 *   ② `from` 是 `agent://master_local_<scope>` 而 `cwd` 里**不含 scope** ⇒ 它在别的目录里替该 scope 发
 *      （`cwd-scope-mismatch`）
 *
 * 注意它**不管**的事（否则会误报）：
 *  - `agent://master_default`（global）没有 scope ⇒ 跳过 ②。
 *  - 无 `cwd` / 无 `envSessionId` 的存量报 ⇒ 不报。
 *  - **只标不拒**：替别的仓发是合法场景（global master 实测就这么干）。
 *
 * 强度限定：两条都靠 `envSessionId`/`cwd`，而它们都是进程序可写的 ⇒ 抬高了「随手发错」的
 * 门槛，但**挡不住有意伪造**。不可伪造的仍是 OS 层 pid + 命令行。
 */
export interface Suspicion {
	reasons: Array<"unknown-session" | "cwd-scope-mismatch">;
	detail: Record<string, unknown>;
}

export function detectSuspicion(record: Pick<ReportRecord, "from" | "cwd" | "envSessionId">): Suspicion | null {
	const reasons: Suspicion["reasons"] = [];
	const detail: Record<string, unknown> = {};

	// ① 会话未登记
	if (record.envSessionId) {
		if (!findAttachmentBySession(record.envSessionId)) {
			reasons.push("unknown-session");
			detail.envSessionId = record.envSessionId;
		}
	}

	// ② cwd 不含它自报的 local scope
	const from = record.from;
	if (from && from.startsWith("agent://master_local_") && record.cwd) {
		const scope = from.slice("agent://master_local_".length);
		if (scope && !record.cwd.toLowerCase().includes(scope.toLowerCase())) {
			reasons.push("cwd-scope-mismatch");
			detail.declaredScope = scope;
			detail.cwd = record.cwd;
		}
	}

	return reasons.length ? { reasons, detail } : null;
}

/**
 * `from` 冒充检测（2026-11-26，由 global master 的现场核查触发）。
 *
 * 事故：我在 `G:/code/GreenCAD` 的 cwd 里跑脚本、`from` 写 `agent://master_local_GreenCAD`，
 * global 收到的报带 `pid=117808`（**我的**脚本进程，不是 GreenCAD 的 30212）⇒ 它指出：
 * 「这条不能证明 GreenCAD 能发」——正确。**`from` 是自报，什么都不证明。**
 *
 * 判据（三者一致性）：
 *   ① `from` 的 attachment `sessionId`（权威，由 attach 流程写入）
 *   ② 报里继承的 `envSessionId`（`PI_SESSION_ID`，由子进程从会话进程继承）
 *   ③ `from` 自己声明的地址
 * ①≠② ⇒ 这份报不是「②那个会话」能合法represent的 ⇒ **拒收**。
 *
 * 强度限定（不得超额声称）：
 *  - `envSessionId` 也能人为设置（`PI_SESSION_ID=x node script.mjs`）⇒ 它抬高伪造成本（需主动设 env），
 *    但**不是不可伪造**。真正不可伪造的是 OS 层 pid+命令行，且必须在 pid 存活时核。
 *  - 只对 `agent://` 形态检查：`tab_*` 没有 attachment（tab 不是 agent 地址），不能误拒。
 *  - 缺 `envSessionId`（2026-11-26 之前的存量报）⇒ 跳过（向后兼容，不是拒收）。
 */
export interface FromMismatch {
	declared: string;
	attachmentSessionId: string;
	envSessionId: string;
}

export function detectFromMismatch(record: Pick<ReportRecord, "from" | "envSessionId" | "at">): FromMismatch | null {
	// ⚠ 判别力登记（R-22 第 4 条，2026-11-26 实测）：本函数对**自家脚本路径恒为 null**。
	// `scripts/report_to_master.mjs` 的 `from` 就是 `findAttachmentBySession(PI_SESSION_ID)`
	// 反查出来的 ⇒ `from` 是 `envSessionId` 的**函数**，两者构造上必然一致。
	// 实测：`findAttachmentBySession(01a1d371…)` 得 `agent://master_local_GreenCAD`，再送进本函数
	// ⇒ 恒 null。⇒ 「from 与 envSessionId 所属仓不符」这一判据**在新脚本路径下是 tautology**。
	//
	// 它仍有判别力的场景（不要删）：① 手工写 JSON / 旧脚本 / 其它工具；② 有人显式传 from。
	// 真正的**独立**信号是 `detectSuspicion()`（envSessionId 是否在白名单 + cwd 是否含 scope）。
	const from = record.from;
	if (!from || !from.startsWith("agent://")) return null;
	if (!record.envSessionId) return null;
	const att = readAttachment(from);
	if (!att || typeof att.sessionId !== "string") return null;
	if (att.sessionId === record.envSessionId) return null;
	// ── 时间锚（L4 B1，2026-11-26）：**没有它就是一个会永久拒收合法报的缺陷** ──
	// `attachment.sessionId` 会被**正规交接**改变：`registry.ts` 的 `attachMaster` 在 token 交接 /
	// `forceStale` 接管时写新 sessionId 并 bump generation。
	// ⇒ 一份在**交接前**发出、尚未被消费的报（无 `.notified`），其 `envSessionId` 是**旧 owner**；
	//   不带上时间锚就会把它判成「冒充」—— **错误归因 + 永久不投递**，
	//   而在汇报报表上表现为「没人汇报」（与「懒得报」同形，无法区分）。
	// ⇒ 判据：只有报的发出时刻 **不早于**当前 attachment 的 attach 时刻，两者不一致才说明
	//   「它发的时候已经不是该地址的 owner」。时间不可解析时**不入罪**（fail open，宁可放过）。
	const recAt = Date.parse(record.at);
	const attAt = Date.parse(att.attachedAt);
	// 时间不可解析 ⇒ **无法证明它是在交接后发的** ⇒ 不入罪（fail open）。
	// 取舍理由：拒收是**永久终态**（误拒 = 合法报永久不投递 + 错误归因），
	// 而放过的代价只是「一份可能过期的报被投递」——后者可恢复，前者不可。
	if (!Number.isFinite(recAt) || !Number.isFinite(attAt)) return null;
	if (recAt < attAt) return null;
	return { declared: from, attachmentSessionId: att.sessionId, envSessionId: record.envSessionId };
}

/**
 * 冒充标记：<id>.from-mismatch（与 .unroutable 分开 —— 两者语义不同：
 * unroutable = 「不知道怎么送」可重试；from-mismatch = 「送了你也不该信」永久终态）。
 */
function markFromMismatch(reportsDir: string, id: string, record: ReportRecord, mm: FromMismatch): void {
	const path = join(reportsDir, `${id}.from-mismatch`);
	if (existsSync(path)) return;
	// `.notified` 守卫（L4 N3，2026-11-26）：已送达的报不得被后来的进程写成「永久拒收」。
	// 不守卫就会在已送达的报上造出「已送达 + 已拒收」并存 —— 正是本项 ⑦a 要消灭的那个形状，
	// 只不过换了一对文件（`.from-mismatch` 而不是 `.unroutable`）。
	if (existsSync(join(reportsDir, `${id}.notified`))) return;
	try {
		const fd = openSync(path, "wx");
		try {
			writeSync(fd, JSON.stringify({
				id,
				declaredFrom: mm.declared,
				attachmentSessionId: mm.attachmentSessionId,
				envSessionId: mm.envSessionId,
				pid: record.pid,
				cwd: record.cwd,
				at: new Date().toISOString(),
				reason: "from-mismatch",
				hint: "`from` 声明的地址与该进程继承的 PI_SESSION_ID（=附件里的 sessionId）不一致 ⇒ 发送者不是它声称的那个会话。本文件是**拒收**证据（不是重试队列）：冒充不会自愈，不要写重投器处理它。",
			}, null, 2) + "\n", "utf8");
		} catch { /* 诊断写入失败不影响主流程 */ } finally { closeSync(fd); }
	} catch { /* EEXIST / 其它：best-effort */ }
}

/**
 * 可疑标记：<id>.suspicious（**只标记不拒收**，与 from-mismatch 的区别在第三节）。
 */
function markSuspicious(reportsDir: string, id: string, record: ReportRecord, s: Suspicion): void {
	const path = join(reportsDir, `${id}.suspicious`);
	if (existsSync(path)) return;
	// 同 N3：已送达的报不再补写辅助标记（否则会在「已送达」旁边长期挂一个「可疑」）。
	if (existsSync(join(reportsDir, `${id}.notified`))) return;
	try {
		const fd = openSync(path, "wx");
		try {
			writeSync(fd, JSON.stringify({
				id,
				from: record.from,
				cwd: record.cwd,
				envSessionId: record.envSessionId,
				pid: record.pid,
				at: new Date().toISOString(),
				reasons: s.reasons,
				detail: s.detail,
				hint: "辅助信号，**不代表伪造**：「替别的仓发」是合法场景。本文件只回答「这条报里各个字段彼此对不上」，不回答「谁有权限」。不要拿它自动拒收。",
			}, null, 2) + "\n", "utf8");
		} catch { /* 诊断写入失败不影响主流程 */ } finally { closeSync(fd); }
	} catch { /* EEXIST / 其它：best-effort */ }
}

/**
 * 内容陈旧检测（global master 2026-11-26 要求，并给了删除性判据）。
 *
 * 定位（不得超额声称）：
 *   这是**否定式判据的自动化** —— 只报「它说的和现在不一样」，
 *   **不报「它是对的」**。一致时什么都不输出，因为「一致」只证明有人读过那个仓，
 *   不证明是谁发的（实测：在别的仓里 `git -C <某仓> rev-parse` 也能读到同一个值）。
 *
 * 「一致也打一行 OK」会制造**假证据** —— global master 明确要求不要那么做。
 *
 * 输入：报正文首行的 `[auto] at=… repo=… head=…`（由 `scripts/report_to_master.mjs` 注入）。
 * 无 auto 行的报（tab 报、手工写 JSON、旧脚本）⇒ 不检查。
 */
export interface StaleContext {
	reportedHead: string;
	actualHead: string;
	repo: string;
}

export function detectStaleContext(record: Pick<ReportRecord, "message">): StaleContext | null {
	const first = (record.message ?? "").split("\n")[0] ?? "";
	if (!first.startsWith("[auto] ")) return null;
	const head = /\bhead=([0-9a-f]{4,40})\b/.exec(first)?.[1];
	const repo = /\brepo=([^\s]+)/.exec(first)?.[1];
	if (!head || !repo || repo.startsWith("(")) return null;
	try {
		const actual = execFileSync("git", ["-C", repo, "rev-parse", "--short", "HEAD"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
		}).trim();
		if (!actual || actual === head) return null; // 一致 ⇒ 什么都不说
		return { reportedHead: head, actualHead: actual, repo };
	} catch {
		return null; // 读不到 ⇒ 不知道（不制造假信号）
	}
}

/** `<id>.stale`：只在**不一致**时写（一致时不写任何东西）。 */
function markStale(reportsDir: string, id: string, record: ReportRecord, s: StaleContext): void {
	const path = join(reportsDir, `${id}.stale`);
	if (existsSync(path)) return;
	try {
		const fd = openSync(path, "wx");
		try {
			writeSync(fd, JSON.stringify({
				id,
				repo: s.repo,
				reportedHead: s.reportedHead,
				actualHead: s.actualHead,
				at: new Date().toISOString(),
				reason: "stale-context",
				hint: "报里声明的 HEAD 与当前仓的 HEAD 不一致 ⇒ **这条报的内容已过时**（不是「是伪造」）。注意这是**否定式判据**：本文件**存在**有意义，**不存在不代表内容正确**（一致时本模块不写任何东西，以免制造假证据）。",
			}, null, 2) + "\n", "utf8");
		} catch { /* 诊断写入失败不影响主流程 */ } finally { closeSync(fd); }
	} catch { /* EEXIST / 其它：best-effort */ }
}

/** 读取一份回报；缺失/损坏返回 null。 */
export function readReportFile(reportsDir: string, id: string): ReportRecord | null {
	const file = join(reportsDir, `${id}.json`);
	if (!existsSync(file)) return null;
	try {
		const raw = JSON.parse(readFileSync(file, "utf8"));
		return raw && typeof raw === "object" && typeof raw.message === "string" && typeof raw.from === "string"
			? (raw as ReportRecord)
			: null;
	} catch {
		return null;
	}
}

/** 列出目录下全部回报 id（按文件名）。 */
export function listReportIds(reportsDir: string): string[] {
	if (!existsSync(reportsDir)) return [];
	return readdirSync(reportsDir)
		.filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"))
		.map((f) => f.slice(0, -".json".length));
}

// ── 主会话监听 ───────────────────────────────────────────────────

const MAX_SEEN_REPORTS = 500;
let seenReports = new Set<string>();
let watcher: FSWatcher | null = null;
let selfDisabled = false; // 旧实例 stale 后停止注入

function markReportSeen(id: string): void {
	seenReports.add(id);
	if (seenReports.size > MAX_SEEN_REPORTS) {
		const first = seenReports.values().next().value;
		if (first) seenReports.delete(first);
	}
}

/** 启动时快照：**只有已被领取（有 .notified）的才算已处理**。
 *
 * 2026-11-24 修正（Item 66 缺陷 3）：旧实现把目录里**所有**已存在文件都标 seen ⇒
 * 一份从未被领取（无 .notified）的回报，重启后也永远进不了 onNewReport ⇒ **第二判决**。
 * seenReports 只是本进程的读缓存，`.notified` 才是跨进程事实。
 * 代价（如实登记）：重启后会把存量「未被领取」的回报重新投递（生产当前 1 份）。
 *
 * ⚠ 语义边界（L4 第三轮 A2，**未闭合**）：`.notified` 由 `claimReportNotified`（wx）在
 * **send 之前**写出 ⇒ 它是「**已有人领取投递权**」= claim，**不是**「已送达」。
 * 后果：claim 成功但 send 失败（同步抛已覆盖；异步 reject 不可见，见下方未闭合），
 * 重启后这份会被 snapshotExisting 当已处理，不再重投。本项只修「从未被领取」的黑洞，
 * 不声称解决「已领取但未送达」。
 * 取舍方向同 R-5：宁可重发（可见、可忽略），不可漏发（静默丢失）。
 */
function snapshotExisting(reportsDir: string): void {
	seenReports = new Set<string>();
	for (const id of listReportIds(reportsDir)) {
		if (existsSync(join(reportsDir, `${id}.notified`))) markReportSeen(id);
	}
}

/**
 * 「解析不到接收方」的**永久可见标记**（可重试态，不写 .notified）。
 *
 * 为什么需要：缺陷 3 的根因是"解析失败后既没标记也没重试"，通道静默成功、接收端零痕迹。
 * 这里落一份 `<id>.unroutable`（扩展名故意不用 .json，避免被 listReportIds 当成回报枚举）：
 *  - **不写 .notified** ⇒ 仍可重试（recipient 解析能力若在后续版本修好，存量会自动复苏）；
 *  - 文件本身是**人可见的证据** ⇒ 排查时看得见"谁往这里写了东西但路由不到"。
 * 用 wx 原子创建 ⇒ 每个 id 只写一次，不随 tick 刷屏。
 */
function markUnroutable(reportsDir: string, id: string, record: ReportRecord): void {
	const path = join(reportsDir, `${id}.unroutable`);
	// 2026-11-26（多 master 并存实测事故）：`.notified` 是「已被某个会话领取」的事实。
	// 它存在时，「解析不出接收方」就不再是「未被消费」的证据 —— 写 `.unroutable` 会制造
	// `.notified` + `.unroutable` **并存**，把「已送达」与「待重试」两个互斥状态同时写进磁盘。
	//
	// 现场读数（report_mwwtqazm_jo06）：08:38:18 新码进程解析成功 → 领 `.notified` + 清标记；
	// 08:38:26 一个**仍跑旧码**的 master 进程 tick 又写回 `.unroutable`（旧码不认 to ⇒ 判 undefined）。
	// ⇒ 并存不是「同一进程写序错」，而是**多进程版本不一致**；但无论哪种成因，
	//    「两个互斥状态用两个文件表达」都必须从**源头**阻止，不能只靠事后清（clearUnroutable）。
	if (existsSync(join(reportsDir, `${id}.notified`))) return;
	if (existsSync(path)) return;
	try {
		const fd = openSync(path, "wx");
		try {
			writeSync(fd, JSON.stringify({
				id,
				from: record.from,
				at: new Date().toISOString(),
				reason: "recipient-unresolved",
				hint: "本回报的 from/to 形态解析不出接收会话（recipientSessionIdFor 返回 undefined）。注意：**本文件存在不代表未送达** —— 仍在跑旧码的进程会把它写回**已送达**的报（实测 8 个 master 进程启动时间全部早于修复，且不会自己停）。⇒ **重投前必须自己再查一次同名 `.notified`，不能只信本文件存在**。关于自愈时机（L4 B4，2026-11-26 实测校正）：**仅当存在一个跑新码、且通过 owner 门的消费者进程时**，并存才在它的一个节流窗口（60s 量级）内被清；若没有这样的进程（旧码进程不会自愈），**并存会一直留着** —— 实测 7 份并存持续 20 分钟以上，不是「60 秒后自动消失」。**将来若实现「扫描 .unroutable 自动重投」，必须先跳过已存在同名 `.notified` 的 id。** 本文件当前无自动读取方。见 AGENTS.md §10。",
			}, null, 2) + "\n", "utf8");
		} catch { /* 诊断信息写入失败不影响主流程 */ } finally { closeSync(fd); }
	} catch { /* EEXIST：已标记过；其它失败：best-effort */ }
}

/**
 * 存量自愈：`.notified` 与 `.unroutable` **并存**时删掉 `.unroutable`。
 *
 * 为什么需要（不只是「多一个文件」）：`markUnroutable` 的守卫只管**新写入**，已经并存的文件仍在
 * 磁盘上，而它会骗两类读者：
 *  - 人工排查（看到 `.unroutable` 以为没送达，实际 `.notified` 在 —— 我 2026-11-26 就因此
 *    连续两次差点误判「修复无效」）；
 *  - 将来任何「扫 `.unroutable` 重投」的实现（会把已送达的回报再投一次）。
 * ⇒ `.notified` 是**更强**的证据（跨进程原子领取 `wx`），并存时它赢。never-throw。
 */
export function healContradictoryMarkers(reportsDir: string): string[] {
	const healed: string[] = [];
	let names: string[];
	try { names = readdirSync(reportsDir); } catch { return healed; }
	for (const n of names) {
		if (!n.endsWith(".unroutable")) continue;
		const id = n.slice(0, -`.unroutable`.length);
		if (!existsSync(join(reportsDir, `${id}.notified`))) continue;
		try {
			unlinkSync(join(reportsDir, n));
			healed.push(id);
		} catch { /* best-effort：下轮再试 */ }
	}
	return healed;
}

/**
 * 送达后收尾 `.unroutable`：否则「先解析失败、后解析成功并写 .notified」时，两份文件
 * 在磁盘上**直接矛盾**（一个说「未被任何会话消费」，一个说「已消费」）—— 会骗人的证据
 * 比没有证据更坏（L4 A3）。never-throw。
 */
function clearUnroutable(reportsDir: string, id: string): void {
	try { unlinkSync(join(reportsDir, `${id}.unroutable`)); } catch { /* 本来就没有 / 已被清：都算正常 */ }
}

// ── 「解析不到」的重试节流（L4 A2：否则每 5s tick × 每份无界增长的存量各付一次 listLinks）──
//
// 为什么需要：`recipientSessionIdFor` 对 tab_ 形态要 `listLinks()` 全扫 —— 实测 3740 行/934KB 时
// **热 3.6ms、冷 9.8ms/次**（不是任务书里估的 0.01ms）。而 reports/*.json 无 GC，未解析集合只增不减。
// 不节流就是「有界输入无界成本」。
// **但绝不设最大次数**：设上限 = 又造一个静默黑洞（该重试却放弃）。只做指数退避 + 上限封顶。
const UNROUTABLE_BACKOFF_BASE_MS = 5_000;      // 与 tick 周期同量级起步
const UNROUTABLE_BACKOFF_CAP_MS = 5 * 60_000;  // 封顶 5 分钟（仍保证「迟早会再试」）
const unroutableAttempts = new Map<string, { attempts: number; nextAt: number; delayMs: number }>();

/** 该 id 现在该不该把「解析不到」重试一次？命中退避窗口 ⇒ false（跳过一次，省一次 listLinks）。 */
function unroutableRetryDue(id: string): boolean {
	const s = unroutableAttempts.get(id);
	return s === undefined || Date.now() >= s.nextAt;
}

/** 记一次失败并按指数退避推到下一次。 */
function noteUnroutableAttempt(id: string): void {
	const prev = unroutableAttempts.get(id);
	const attempts = (prev?.attempts ?? 0) + 1;
	const delayMs = Math.min(UNROUTABLE_BACKOFF_BASE_MS * 2 ** (attempts - 1), UNROUTABLE_BACKOFF_CAP_MS);
	unroutableAttempts.set(id, { attempts, nextAt: Date.now() + delayMs, delayMs });
	// 上界：防这份 Map 本身变成无界内存（按 MAX_SEEN_REPORTS 同口径）。
	if (unroutableAttempts.size > MAX_SEEN_REPORTS) {
		const first = unroutableAttempts.keys().next().value;
		if (first !== undefined) unroutableAttempts.delete(first);
	}
}

/** 送达后清掉退避状态（该 id 已不是「解析不到」）。 */
function clearUnroutableAttempt(id: string): void { unroutableAttempts.delete(id); }

/**
 * 测试专用只读快照 + 退避窗口开关（与 `_resetReportListener` 同性质，生产不调用）。
 * `_forceUnroutableRetryDue` 只是把 nextAt 推到过去（等价于「等到了」），不重置 attempts
 * —— 这样才能验证「次数只增不减、延迟指数增长且封顶、但永不放弃」这三条同时成立。
 */
export function _unroutableAttemptState(id: string): { attempts: number; delayMs: number } | undefined {
	const s = unroutableAttempts.get(id);
	return s === undefined ? undefined : { attempts: s.attempts, delayMs: s.delayMs };
}
export function _forceUnroutableRetryDue(id: string): void {
	const s = unroutableAttempts.get(id);
	if (s !== undefined) s.nextAt = 0;
}
/**
 * 测试专用：该 id 是否已进本进程的 seenReports。
 *
 * 为什么需要这个导出：**「已收工」在外部可观测面上是不可见的** ——
 * `pollNewReports` 只对 `!seenReports.has(id)` 的 id 调 `onNewReport`，已 seen 的 id
 * 一次 IO 都不产生、一行审计都不写（L4 实测 `already-injected` 分支 suppressions +0）。
 * 于是「测 onNewReport(...)===false」对「有没有 markSeen」**没有判别力**（两者都返回 false），
 * 变异「删掉 markSeen」会**假绿**（实测：M5 第一轮未变红）。
 * 所以把 seenReports 状态本身作为可断言面暴露给测试专用。
 */
export function _isReportSeen(id: string): boolean {
	return seenReports.has(id);
}

export interface ReportListenerOptions {
	reportsDir?: string;
	/** 会话定位用的 links 路径（测试注入；缺省 ~/.pi/agent/links.jsonl）。 */
	linksPath?: string;
	/** 注入用户消息的实现（由 registerReportListener 绑定 pi.sendUserMessage）。 */
	sendUserMessage?: (content: string, opts?: { deliverAs?: string }) => void;
	/** 供测试注入的钩子：新回报出现时回调（替代 sendUserMessage/toast）。 */
	onReport?: (record: ReportRecord, id: string) => void;
	/** 完成时 toast（默认 true）。 */
	toast?: boolean;
	/**
	 * tick 兜底周期（ms，缺省 5000）。**只给测试用**：生产下 fs.watch 能即时唤醒，
	 * 5s tick 只是兼容 Windows 偶发丢事件。测试要验证 tick 链路时不能等 5s（会拖慢套件），
	 * 但**必须**能调到看得到——否则只能证明「onNewReport 直接调用可用」，
	 * 不能证明「注册→tick→poll」这条真实接线通（R-21 的缺陷恰恰在注册层）。
	 */
	pollIntervalMs?: number;
}

/** 原子领取「已消费」标记（跨进程/跨实例幂等，根治双 watcher 双注入）。 */
export function claimReportNotified(reportsDir: string, id: string): boolean {
	try {
		const fd = openSync(join(reportsDir, `${id}.notified`), "wx");
		try { closeSync(fd); } catch { /* ignore */ }
		return true;
	} catch {
		return false;
	}
}

/** 处理一份新回报（幂等 + 跨实例去重 + 会话定位）。返回是否已注入。 */
export function onNewReport(reportsDir: string, id: string, opts: ReportListenerOptions): boolean {
	if (selfDisabled) return false; // 旧实例已失效
	if (seenReports.has(id)) return false;
	const record = readReportFile(reportsDir, id);
	if (!record) return false; // 被删/未写完/损坏：不标 seen（下个事件/tick 可重试），与 event-bus 空结果守卫同理

	if (opts.onReport) {
		markReportSeen(id);
		opts.onReport(record, id);
		return true;
	}

	// 会话定位：只消费派发给「当前会话」的回报（不同目录的 identityless 进程不得抢）
	// links 记录的是派发时身份（sessionIdentity：tab runId 优先）；重启后本进程 scope 可能
	// 变回 UUID（TUI 重开丢 flag）——双域任一匹配即视为本会话的回报（DOG2 根因，与 event-bus 同族）。
	//
	// 2026-11-24 修正（Item 66 缺陷 3）：**`markReportSeen` 必须放在这之后**。
	// 旧顺序（先 markSeen 再判 recipient）导致解析失败时：不写 .notified、却已进 seenReports
	// ⇒ tick 兜底的 `!seenReports.has(id)` 守卫跳过 ⇒ 重启时 snapshotExisting 又把它标成已处理
	// ⇒ **不报错、不打日志、无 toast、无标记的永久静默黑洞**（实测 GreenCAD local master 那份
	// report_mwucgcad_r1a0：3351B 落盘成功、.notified 永远不存在、global 从未收到）。
	// 退避前置（L4 A2/S2）：**成本点是解析本身**（tab_ 形态要全扫 links.jsonl，实测 3745 行/957KB
	// 时热 ~2.8-5.2ms），不是写标记（那里已有 `existsSync` 早退）。所以当这份 id 上次
	// 解析失败且仍在退避窗口内时，**先直接返回**，不付解析钱（实测 2.81ms → 0.05ms）。
	// 这是唯一一处「提前 return」：只在「已知解析不出 + 窗口内」时命中，不会遮蔽正常送达。
	// 窗口到期后完整重走下面全部判定 ⇒ 解析能力恢复时仍能自动复苏（**无次数上限**）。
	//
	// 已知代价（L4 第三轮 B4，**刻意接受**）：本函数是 `fs.watch` 回调与 tick 的**同一入口**，
	// 所以「links 刚补上」这种即时信号也会被窗口挡掉，最坏等一个窗口（封顶 5min）才送达。
	// 取舍：挡掉的是「短时间内重复做一次 3-5ms 全扫」，换到的是「不会被无界存量把 tick 拖死」；
	// 且本通道是 best-effort 旁路（不是控制面），分钟级延迟可接受。
	if (!unroutableRetryDue(id)) return false;

	// 冒充检测**必须先于路由**（2026-11-26）：否则一份「from 写别人、内容却进了真接收方」的报
	// 会被当正常度过 —— 路由成功恰恰是冒充的目的。且它是**永久终态**（冒充不会自愈）⇒
	// markSeen 是正确处置（与 unroutable 的可重试态相反）。
	{
		const mm = detectFromMismatch(record);
		if (mm) {
			markFromMismatch(reportsDir, id, record, mm);
			markReportSeen(id);
			return false;
		}
	}

	// 内容陈旧检测（global master 2026-11-26）：**只标记不拒收**，且**一致时什么都不写**。
	// 定位是否定式判据 —— 存在的 .stale 说明「内容过时」，不存在的 .stale **什么都不说明**。
	// 节流：标记已存在就不再跑 git（它是幂等的，但 git 调用有成本）。
	if (!existsSync(join(reportsDir, `${id}.stale`))) {
		const stale = detectStaleContext(record);
		if (stale) markStale(reportsDir, id, record, stale);
	}

	// 辅助可疑信号：**只标记不拒收**（2026-11-26）。与上面 from-mismatch 的区别：
	// mismatch = 自相矛盾（同一个会话既说是 X 又是 Y）⇒ 拒收；
	// suspicion = 字段彼此对不上但**有合法解释**（替别的仓发）⇒ 标记后照常投递。
	{
		const sus = detectSuspicion(record);
		if (sus) markSuspicious(reportsDir, id, record, sus);
	}

	const recipient = recipientSessionIdFor(record, opts.linksPath);
	const mySession = sessionScopeKey();

	if (!recipient) {
		// ① 解析不到 ⇒ **可重试态**：不 markSeen（下 tick / 重启都会再试），并落人可见标记。
		//    这就是"一个会报错的通道 agent 会重试；一个静默的假通道 agent 会停下来等"的正解。
		markUnroutable(reportsDir, id, record);
		noteUnroutableAttempt(id);
		return false;
	}
	if (!mySession || (recipient !== mySession && recipient !== getCurrentSessionId())) {
		// ② 解析成功但**不是本会话** ⇒ 正常分流，本进程永不负责这个 id。
		//    这里必须 markSeen，否则会每 5s tick 空转重扫同一份别人的邮件（无谓 IO，且永远等不到）。
		//    重启后新进程若正是该会话，seenReports 已重置 ⇒ 仍能消费（不是第二判决）。
		//
		//    已知边界（L4 A1-3，**未闭合**）：若 recipient 恰好是 `tab_*`（tab 进程不注册本监听器）
		//    或一个永不存在的会话，本进程 markSeen 后该回报在本进程内永久不再尝试，且无标记。
		//    生产实测这类形状存在（AGENTS.md B 类：565/1197 async link 是 tab 形态）。修它需要
		//    「谁是活监听者」的外部事实，不在本项（P0）范围内 —— 登记为未闭合，不假装已解决。
		markReportSeen(id);
		return false; // 不 claim、不注入（留给真正的编排会话）
	}

	// Phase 4d 统一注入门（A5 F2/F15/F16）：cutover 未启用时恒 inject:true，零行为变化。
	//
	// 2026-11-24（L4 阻断项 2）：`markReportSeen` **不得**放在这道门之前。
	// 这道门有**瞬时**拒绝理由（`suppressed-not-owner` = cutover 已开但 attach 还没到，正是
	// R-21 实测的 26 秒竞争窗口；`claimed-by-other` = stale claim 未回收）。瞬时拒绝若被当成
	// 「永久已处理」（markSeen），tick 守卫就永久跳过 ⇒ **与本项要消灭的缺陷完全同形**。
	// 所以：gate 返回 inject:false 时**不 markSeen**，下一 tick 还能再试（attach 到达后自动复苏）。
	let gateCtx: InjectionContext | null = null;
	{
		const gate = preInject({ key: `report-${id}`, sessionId: getCurrentSessionId() ?? mySession, path: "legacy-reports" }); // 持久 UUID 域（ownership 同侧）
		if (!gate.inject) {
			// 瞬时拒绝 vs 永久终态（L4 S1 + 第三轮 B1）：
			//  - `suppressed-not-owner` / `claimed-by-other` 都是**瞬时**（后者上界 = receipts staleAfterMs
			//    10min，到期 CAS 接管）⇒ 不 markSeen，下一 tick 重试（这正是 R-21「attach 晚 26 秒」的正解）。
			//  - `already-injected` 是**永久终态**（另一实例已写 delivered 收据 = 确实已投递）⇒ 必须收工，
			//    否则每 5s tick 白试一个无出口分支（实测 5 次 poll 全 0、零审计痕迹）。
			//    ⚠ 这里**不**附加 `existsSync(.notified)` 条件：本模块的写序是
			//    markSeen → claimReportNotified(.notified) → send → postInject(delivered 收据)，
			//    所以正常路径下收据意味着 `.notified` 也在；`.notified` 缺失只可能是被外部删除/
			//    别的写入方 —— 那种状态下把「有 delivered 收据」当已投递是**更强**的证据，
			//    而附加该条件反而制造「每 tick 无限重扫」（L4 第三轮实测 5/5 seen=false）。
			if (gate.reason === "already-injected") markReportSeen(id);
			return false;
		}
		gateCtx = { key: `report-${id}`, sessionId: getCurrentSessionId() ?? mySession, path: "legacy-reports" };
	}
	markReportSeen(id);
	// 跨实例幂等：原子领取消费权（双 watcher/双实例只有第一个注入）
	if (!claimReportNotified(reportsDir, id)) {
		if (gateCtx) postInject(gateCtx, true); // legacy 已注证明，回填收据
		return false; // 已被其他实例消费 → 静默跳过
	}
	// 收尾时机（L4 R-3a/A1）：`.unroutable` 是「未被消费」的**唯一反证据**。若在 send **之前**就删，
	// send 失败时磁盘只剩 `.notified` ⇒ 反向矛盾证据。所以清到 send **未同步抛**之后。
	//
	// ⚠ 证据限度（L4 第三轮 A1，**未闭合**）：`pi.sendUserMessage` 生产 wrapper **不 return**
	// 底层 Promise（injection-gate.ts:190-215 已登记）⇒ 「不抛」**不等于**「已送达」，
	// 底层异步 reject（如 `already processing`）在这里不可见。要把它变成可见真值必须走
	// `injectFollowUpQuietly(strict)`，而那会把**所有**通知降级为 unconfirmed（仓库级裁定，
	// 不属本项）。所以本处只声称「send 未同步抛」，不声称已送达。

	if (opts.toast !== false) {
		sendWindowsToast({
			title: `📨 ${record.from} 回报`,
			body: `${record.message.slice(0, 100)}${record.summary ? ` — ${record.summary.slice(0, 60)}` : ""}`,
			duration: "long",
		});
	}

	try {
		opts.sendUserMessage?.(
			`📨 ${record.from} 主动回报：${record.message}${record.taskId ? `\ntask=${record.taskId}` : ""}${record.summary ? `\n摘要: ${record.summary}` : ""}\n请处理这份回报并决定下一步。\n${NO_POLL_HINT}`,
			{ deliverAs: "followUp" },
		);
		if (gateCtx) postInject(gateCtx, true);
		// 清「未消费」反证据与退避状态。**只在 send 未同步抛时**（不声称已送达，见上方证据限度）。
		clearUnroutable(reportsDir, id);
		clearUnroutableAttempt(id);
	} catch {
		selfDisabled = true; // 旧实例 stale → 停止注入
	}
	return true;
}

/** 自愈节流：并存是罕见状态，没必要每 5s tick 都扫一次目录两次（readdir 是 O(文件数)）。 */
let lastHealAt = 0;
const HEAL_INTERVAL_MS = 60_000;

/** 仅供测试：重置自愈节流，否则同一进程内第二次 pollNewReports 会被 60s 窗口挡掉。 */
export function _resetHealThrottle(): void {
	lastHealAt = 0;
}

/** 扫描目录里所有新回报（tick 兜底）。返回处理的 id 列表。 */
export function pollNewReports(reportsDir: string, opts: ReportListenerOptions): string[] {
	// 存量自愈（2026-11-26）：`.notified` + `.unroutable` 并存时清掉后者。
	// 放在 listReportIds **之前**：否则并存的 `.unroutable` 会先骗过人工排查（我是第二个被骗的）。
	// 节流 60s —— 这个状态只为「修好路由能力之前的历史存量」而存在，不是热路径。
	const now = Date.now();
	if (now - lastHealAt >= HEAL_INTERVAL_MS) {
		lastHealAt = now;
		healContradictoryMarkers(reportsDir);
	}
	const fired: string[] = [];
	for (const id of listReportIds(reportsDir)) {
		if (!seenReports.has(id) && onNewReport(reportsDir, id, opts)) fired.push(id);
	}
	return fired;
}

/** 注册主会话监听：fs.watch + tick 兜底。返回清理函数。 */
export function registerReportListener(pi: ExtensionAPI, opts: ReportListenerOptions = {}): () => void {
	// 工厂入口重置模块状态（P1：reload 重跑工厂时不继承旧实例的 selfDisabled/seen*）
	_resetReportListener();
	const reportsDir = opts.reportsDir ?? defaultReportsDir();

	// 延迟到 session_start 再判定身份并启动监听：
	// CLI flag 在扩展加载完成后才就绪；消费注册 ownership-gated（M1，与 event-bus watcher 同
	// 不变量）：cutover 启用时「owner 是谁谁消费」（UUID 域），否则 legacy 回退主会话；子 agent 恒不消费。
	let interval: ReturnType<typeof setInterval> | null = null;
	let sessionGen = 0; // gen token：过期周期的排队回调 no-op，绝不用旧 pi
	pi.on("session_start", (_event, ctx) => {
		// R-21（2026-11-05）：注册层**只排除子 agent**，不看 owner。
		// 旧写法在此判 `eligible` 然后 `return` —— 而 session_start 与 attach 是**时序竞争**
		//（实测 gen14：session_start 15:57:35 / global attach 15:58:01，晚 26s）⇒ watcher/tick
		// 永不启动 ⇒ 晚到的 attach 永远没机会。owner 判据下沉到 watcher 回调与 tick 内。
		// L4 F5 指出的既存同类遗漏（`extensions/report.ts:230-239`）。
		try {
			if (isSubagent()) return;
		} catch { /* ctx 不可用 → 不消费（宁可静默） */ }
		// 捕获当前会话 UUID（回报会话定位的依据）
		try {
			setCurrentSessionId((ctx as { sessionManager?: { sessionId?: string } } | undefined)?.sessionManager?.sessionId);
		} catch { /* ctx 不可用则保持 undefined */ }
		const sid = (ctx as { sessionManager?: { sessionId?: string } } | undefined)?.sessionManager?.sessionId;
		/** tick/watcher 内部用的 owner 精判（与 mailbox-consumer 同一语义，不共享实现以免耦合） */
		const ownerEligible = (): boolean => {
			try {
				const cut = readCutover();
				const att = readAttachment(masterAddress());
				if (!(cut?.enabled && att)) return isMainSession();
				return Boolean(sid && sid === att.sessionId);
			} catch {
				return false;
			}
		};

		const myGen = ++sessionGen;
		const closed = (): boolean => myGen !== sessionGen;
		if (interval) clearInterval(interval); // 上次周期的 interval 引用不可再依赖

		snapshotExisting(reportsDir);
		const fullOpts: ReportListenerOptions = {
			...opts,
			reportsDir,
			sendUserMessage: pi.sendUserMessage?.bind(pi),
		};

		if (existsSync(reportsDir)) {
			try {
				watcher = watch(reportsDir, (_event, fileName) => {
					if (closed()) return;
					if (!ownerEligible()) return; // R-21：owner 门下沉到回调内
					if (typeof fileName === "string") {
						const id = fileName.endsWith(".json") ? fileName.slice(0, - ".json".length) : fileName;
						onNewReport(reportsDir, id, fullOpts);
					}
				});
			} catch {
				watcher = null;
			}
		}

		// tick 兜底（Windows fs.watch 偶发丢事件）
		interval = setInterval(() => {
			if (closed()) return;
			if (!ownerEligible()) return; // R-21：owner 门下沉到 tick 内
			pollNewReports(reportsDir, fullOpts);
		}, opts.pollIntervalMs ?? 5000);
		interval.unref?.();
	});

	return () => {
		sessionGen++; // 使当前周期 closed → 排队回调 no-op
		try {
			watcher?.close();
		} catch { /* ignore */ }
		watcher = null;
		if (interval) clearInterval(interval);
	};
}

/** 供测试重置内部状态。 */
export function _resetReportListener(): void {
	seenReports = new Set<string>();
	unroutableAttempts.clear();
	selfDisabled = false;
	try {
		watcher?.close();
	} catch { /* ignore */ }
	watcher = null;
}

/** 清理已读缓存集合（GC 时调用）。 */
export function clearReportCache(): void {
	seenReports.clear();
}
