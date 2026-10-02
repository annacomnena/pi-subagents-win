/**
 * runtime/autonomy/action/classes/notify.ts — notify-local-master 动作类（阶段二：只发信不写文件）。
 *
 * 任务结论（主会话来信）：「新增 notify-local-master 动作类（主动发信给 scope master，
 * 只发信不写文件）」。本类把 autonomy 的可回滚动作面从「写自有 namespace 报告」扩到
 * 「**恰好投递一个信件文件**到该 trigger project 仓库的 scope master 信箱」。
 *
 * 效应面 = 恰一个新信件文件（`mailboxDirFor(目标地址)/<messageId>.json`，deliverLetter 落盘）：
 *  - `requiresAck: false` + `expectReply: false` + **不传 dedupeId**
 *    ⇒ deliverLetter 不写 expectation 账本（shouldDeclareExpectation 对 false 短路，
 *      expectations.ts:336）、不写 claims slot（dedupeId 缺省）——「只发信」= 除信件本身
 *      与自有 harness（ledger/breaker/snaps）外零额外写入；
 *  - `subject` **不得**以 `run://tab/` 开头（否则 report-shape 会被 scope wake 链认领 ⇒
 *    信永远无人看 / 触发派活）；本类 subject 恒 `autonomy-notify/<rule>`；
 *  - `from` = `agent://autonomy-actions`（标明动作来源）；`to` = 该 trigger project 仓库
 *    的 scope master：`localMasterAddress(localMasterScope(projectPath))`；
 *  - **project 非路径 / scope 解析失败 ⇒ fail-closed**（targetPath 返回哨兵 "" ⇒
 *    withinSurface false ⇒ closure=false ⇒ DENY(surface-open)）；
 *  - 目标 scope **无 owner 不可投递**（方案 A：发信前查 scope owner，无主/死主 → DENY）；
 *    **绝不消费/ack 他人 mailbox**（红线不变，只 deliver）。
 *
 * 「可回滚」定位（详见 impl 报告论证节）：messageId 全新 ⇒ 快照 = 不存在；回退 = 删除自创
 * 信件 + 复验不存在（report 类同款「撤销自身效应不计 deletedFiles」先例）；**回滚窗口 =
 * status 仍 pending**；消费端 claim 后状态改写/信息已可达 ⇒ 不可撤，按 D1 裁定列为
 * **显式不可回退例外**（本地通知/GUI 呈现），如实记账不冻结。
 *
 * 本模块只做单信件事务原语；预算/熔断/账本/编排由 run.ts 承担。全部 IO never-throw。
 */
import { chmodSync, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { ObjectAddress } from "../../../address.ts";
import { defaultMailboxDir, deliverLetter, mailboxDirFor } from "../../../mailbox.ts";
import type { MessageFrame } from "../../../protocol.ts";
import { judgeScopeOwnerStale, localMasterAddress, localMasterScope } from "../../../scope.ts";
import { readAttachment } from "../../../registry.ts";
import { readScopeLiveness } from "../../../liveness.ts";
import type { BuildContentArgs, EffectResult, FileSnapshot, ActionClass } from "./types.ts";

/** 发件地址（标明动作来源；agent:// 单段，非 run://tab/，scope wake 链不认领）。 */
const NOTIFY_FROM = "agent://autonomy-actions" as ObjectAddress;

/** project 必须是文件系统路径（Windows 盘符 / UNC / POSIX 绝对）；否则 fail-closed。 */
function isRepoProjectPath(project: string): boolean {
	if (/^[A-Za-z]:[\\/]/.test(project)) return true; // Windows 绝对：C:/…  C:\…
	if (project.startsWith("\\\\")) return true; // UNC：\\server\share
	if (project.startsWith("/")) return true; // POSIX 绝对
	return false;
}

/**
 * 确定性 messageId（同 project×ts 幂等）：`msg_autonomy<safe>_<base36ts>`，
 * 通过 isMessageId（`^msg_[A-Za-z0-9]+_[A-Za-z0-9]+$` = msg_ 后**恰两组** alnum，故
 * 「autonomy」与 safe 合并为一组、不与 safe 之间加下划线）。targetPath 与 buildContent/effect
 * 用同一 (project, ts) ⇒ 三处 messageId 一致 ⇒ effect 落盘路径 = targetPath。
 */
function notifyMessageId(project: string, now: number): string {
	const safe = project.replace(/[^A-Za-z0-9]/g, "").slice(0, 48) || "p";
	const ts = new Date(now).getTime().toString(36);
	return `msg_autonomy${safe}_${ts}`;
}

export interface NotifyTarget {
	to: ObjectAddress;
	scope: string;
	messageId: string;
	path: string;
}

/**
 * scope 解析（fail-closed）：project 非路径 / scope 空 → { ok:false }（不猜）。
 * 纯判定，never-throw。
 */
export function resolveNotifyTarget(project: string, now: number):
	| { ok: true; target: NotifyTarget }
	| { ok: false; reason: string } {
	if (!isRepoProjectPath(project)) return { ok: false, reason: "notify-project-not-a-path" };
	const scope = localMasterScope(project);
	if (!scope) return { ok: false, reason: "notify-scope-empty" };
	const to = localMasterAddress(scope);
	const messageId = notifyMessageId(project, now);
	const path = join(mailboxDirFor(to, defaultMailboxDir()), `${messageId}.json`);
	return { ok: true, target: { to, scope, messageId, path } };
}

export const notifyLocalMasterClass: ActionClass = {
	name: "notify-local-master" as const,

	/**
	 * 效应面注册（§A ① 文件夹分好）：目标 scope master 的 mailbox spool 基目录。
	 * **授权扩域**：效应面离开 `<stateDir>/autonomy/`，进入 mailbox spool——边界 = 恰一个
	 * 信件文件 + 只 deliver 不消费（阶段二结论 ② 的显式扩域，详见 impl 报告论证节）。
	 */
	allowedPrefixes: (_stateDir: string): string[] => [defaultMailboxDir()],

	/**
	 * 目标信件路径（mailboxDirFor(to)/<messageId>.json）。
	 * scope 解析失败 → 返回哨兵 ""（withinSurface 必 false ⇒ closure=false ⇒ DENY(surface-open)）。
	 */
	targetPath: (_stateDir: string, project: string, ts: number): string => {
		const r = resolveNotifyTarget(project, ts);
		return r.ok ? r.target.path : "";
	},

	/**
	 * 效应路径是否越出声明前缀（mailbox spool 基目录）。
	 * 空/哨兵（scope 未解析）= 越界 = false（fail-closed）。
	 */
	withinSurface: (_stateDir: string, path: string): boolean => {
		if (!path) return false;
		const base = defaultMailboxDir();
		const rel = relative(base, path);
		if (rel === "") return false;
		if (rel.startsWith("..") || rel.startsWith("/") || rel.startsWith("\\")) return false;
		return true;
	},

	/**
	 * 组装 MessageFrame（只发信）：requiresAck:false + subject 非 run://tab/ + from=autonomy-actions。
	 * scope 未解析 → 返回 ""（防御性；closure 已在前面拦截）。
	 */
	buildContent: (args: BuildContentArgs): string => {
		const { project, trigger, now } = args;
		const r = resolveNotifyTarget(project, now);
		if (!r.ok) return "";
		const summary = `[autonomy] ${trigger.rule} @ ${project}`.slice(0, 500); // ≤512B 保险
		const frame: MessageFrame = {
			frame: "message",
			id: r.target.messageId,
			kind: "REPORT",
			from: NOTIFY_FROM,
			to: r.target.to,
			subject: `autonomy-notify/${trigger.rule}`, // 不以 run://tab/ 开头
			requiresAck: false, // 只发信，不要求回执
			sentAt: new Date(now).toISOString(),
			body: {
				summary,
				details: { rule: trigger.rule, project, evidence: trigger.evidence, approximate: trigger.approximate },
			},
		};
		return JSON.stringify(frame);
	},

	/**
	 * 方案 A：发信前查目标 scope owner（fail-closed）。
	 * ① readAttachment 读不到（无 owner，含读失败不可区分）→ "ownerless"（DENY scope-ownerless）
	 * ② attachment 在位 + judgeScopeOwnerStale verdict === "stale"（liveness 匹配 + pid 死）→ "stale"（DENY scope-owner-stale）
	 * ③ liveness 缺失 / 身份不匹配（verdict skip）/ pid 活（verdict alive）→ "ok"（放行；保守度与现状一致）
	 * ④ IO 异常 → "ownerless"（fail-closed，DENY 投递；与读不到 owner 同处理）
	 */
	ownerCheck: (project: string, opts: { stateDir?: string }): "ok" | "ownerless" | "stale" | "unknown" => {
		try {
			const scope = localMasterScope(project);
			if (!scope) return "ownerless";
			const addr = localMasterAddress(scope);
			const att = readAttachment(addr);
			if (!att) return "ownerless";
			const liveness = readScopeLiveness(scope, opts.stateDir);
			const verdict = judgeScopeOwnerStale(att, liveness);
			if (verdict.verdict === "stale") return "stale";
			return "ok"; // alive / skip（liveness 缺失/身份不匹配）→ 放行
		} catch {
			return "ownerless"; // fail-closed：读取异常按读不到 owner 处理，禁止投递
		}
	},

	/** 快照（原字节/权限/存在性；信件为新文件 ⇒ existed:false）。never-throw。 */
	snapshot: (path: string): FileSnapshot | null => {
		try {
			if (!existsSync(path)) return { path, existed: false, mode: null, bytes: null };
			const st = statSync(path);
			return { path, existed: true, mode: st.mode, bytes: readFileSync(path) };
		} catch {
			return null;
		}
	},

	/**
	 * 投递一封信（deliverLetter 落盘到 mailboxDirFor(frame.to)/<frame.id>.json = path）。
	 * **只发信不写文件**：不传 dedupeId（不写 claims slot）+ expectReply:false（不写
	 * expectation 账本）。返回 { bytes, deletedFiles: [] }（effect 不删任何既有文件）。
	 * 非法帧 / IO 失败 → null（fail-closed；deliverLetter 抛错由本 try 收敛）。
	 */
	effect: (path: string, content: string): EffectResult | null => {
		try {
			const frame = JSON.parse(content) as MessageFrame;
			// 在任何写入前验证实际目标与预检路径一致，避免创建后因路径失配留下未记账信件。
			const actualPath = join(mailboxDirFor(frame.to, defaultMailboxDir()), `${frame.id}.json`);
			if (actualPath !== path) return null;
			const { letter, created } = deliverLetter(frame, { mailboxDir: defaultMailboxDir(), expectReply: false });
			// 只允许登记本动作新建的文件。已存在的 messageId（含并发赢家）绝不认领，
			// 避免把他人信件纳入快照/回滚句柄后误删。
			if (!created) return null;
			return { bytes: Buffer.byteLength(JSON.stringify(letter), "utf8"), deletedFiles: [] };
		} catch {
			return null;
		}
	},

	/**
	 * 后置验证（结构校验，非逐字节）：读回信件 = 有效 Letter 且 frame.id/to 与预期一致、
	 * status=pending。读失败 = unknown（不猜）。
	 */
	postverify: (path: string, expected: string): "match" | "mismatch" | "unknown" => {
		try {
			const raw = readFileSync(path, "utf8");
			const letter = JSON.parse(raw) as { frame?: MessageFrame; status?: string };
			const frame = JSON.parse(expected) as MessageFrame;
			if (letter.frame?.id === frame.id && letter.frame?.to === frame.to && letter.status === "pending") {
				return "match";
			}
			return "mismatch";
		} catch {
			return "unknown";
		}
	},

	/**
	 * 回退（never-throw）：信件为本动作自创（新 messageId）⇒ 快照 existed:false ⇒
	 * 恢复 = 删除自创信件（撤销自身效应，**非**「删除原有文件」违规 ⇒ deletedFiles 恒 []）。
	 * 若快照 existed:true（理论不发生）则按原字节恢复。ok=false = 回退失败（→ 熔断 + 冻结）。
	 */
	rollback: (snap: FileSnapshot): { ok: boolean; deletedFiles: string[]; reason?: string } => {
		try {
			if (snap.existed) {
				if (snap.bytes === null) return { ok: false, deletedFiles: [], reason: "snapshot-bytes-missing" };
				const tmp = `${snap.path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.rollback.tmp`;
				writeFileSync(tmp, snap.bytes);
				renameSync(tmp, snap.path);
				try { unlinkSync(tmp); } catch { /* rename 后临时文件已不存在 */ }
				if (snap.mode !== null) chmodSync(snap.path, snap.mode);
				return { ok: true, deletedFiles: [] };
			}
			if (existsSync(snap.path)) unlinkSync(snap.path);
			if (existsSync(snap.path)) return { ok: false, deletedFiles: [], reason: "rollback-reverify-still-exists" };
			return { ok: true, deletedFiles: [] };
		} catch (e) {
			return { ok: false, deletedFiles: [], reason: String((e as Error)?.message ?? e).slice(0, 120) };
		}
	},
};

export type NotifyLocalMasterClass = typeof notifyLocalMasterClass;
