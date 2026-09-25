#!/usr/bin/env node
/**
 * local-master-loop-acceptance.mjs — 0926 P1「故障闭环」验收 harness（astra 第 4/5 条载体）。
 *
 * 目标链：主会话 → ensure 测试仓 local master → mailbox 指令 → local 派发低风险 worker
 *         → RESULT 回原信 → 主会话收口。**先纯本地**（微信只是后续入口）。
 *
 * 设计红线：
 *   - 本脚本**自身不 spawn 任何进程**、不开 tab、不杀进程；只做盘面观测 + 生产投信（deliverLetter）。
 *   - ensure 必须由**真实 Interface** 发起（主会话 slash `/local-master-ensure <repo> --timeout 90000`
 *     或主会话真实工具调用）——本脚本不 import ensureLocalMaster 直调，不以内部 helper 成功替代生产接线。
 *   - 邮箱指令用**生产 deliverLetter**（与 wake recipe 同一入口），不伪造 claimed/pending 文件。
 *   - 判定源 = 盘面/账本/信箱/本验收 jsonl；`check` 只读回放式复核，可重复执行。
 *   - 验收记录只落 `state/local-master-acceptance/<runId>.jsonl`（仅此验收命名空间，不建通用事件平台，
 *     不写 graph、不写 attention）。验收结束可归档/删除。
 *
 * Runbook（8 步主链；真进程/可见 tab/可中断测试会话 → 只在隔离环境按此执行，不进 npm test）：
 *   ① node scripts/local-master-loop-acceptance.mjs init <test-repo> --scenario cold
 *   ② 主会话真实 slash：/local-master-ensure <test-repo> --timeout 90000（**真实 UI，不代打**）
 *   ③ node scripts/local-master-loop-acceptance.mjs wait --what evidence --timeout 120000
 *   ④ node scripts/local-master-loop-acceptance.mjs inject [--body "..."]
 *   ⑤ node scripts/local-master-loop-acceptance.mjs wait --what claimed --timeout 90000
 *   ⑥ node scripts/local-master-loop-acceptance.mjs wait --what spawned --timeout 90000
 *   ⑦ node scripts/local-master-loop-acceptance.mjs wait --what result --timeout 300000
 *   ⑧ node scripts/local-master-loop-acceptance.mjs check && ... report
 *   中断场景：在 ⑤ 前/后只 kill **测试会话**（禁止杀用户工作中的 master），恢复后从 ③ 续跑；
 *   中断落账：node scripts/local-master-loop-acceptance.mjs mark --phase interrupted-before-claim
 *             --disposition interrupted-before-claim（或 interrupted-after-claim）
 *
 * 预算（astra 建议首版，**可配置**，非硬编码）：健康态接单 ≤90s；小任务 5min 内结果或明确超期。
 *
 * 用法：node scripts/local-master-loop-acceptance.mjs <init|inject|wait|check|report|mark|runbook|help>
 * 退出码：0 = 通过；1 = 未通过/超时（可追踪失败，不伪造成功）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// ── 路径（与生产同语义：PI_RUNTIME_DIR 覆盖，否则 ~/.pi/agent/runtime）──
const runtimeDir = () => process.env.PI_RUNTIME_DIR?.trim() || join(homedir(), ".pi", "agent", "runtime");
const stateDir = () => join(runtimeDir(), "state");
const accDir = () => join(stateDir(), "local-master-acceptance");
const runsLedgerDir = () => process.env.PI_TAB_RUNS_DIR?.trim() || join(homedir(), ".pi", "agent", "tab-runs");
const currentPath = () => join(accDir(), ".current.json");
const jsonlPath = (runId) => join(accDir(), `${runId}.jsonl`);

/** 处置受控枚举（计划 §4.4；无法证明完成时必须落 unknown，不伪造成功）。 */
const DISPOSITIONS = [
	"result-received",
	"no-result-timeout",
	"interrupted-before-claim",
	"interrupted-after-claim",
	"blocked",
	"consume-unverified",
	"spawn-failed",
	"stale-claimed-recovered",
	"unknown",
];

/** 首版验收预算（可配置：CLI flag 覆盖，勿硬编码不可调）。 */
const BUDGET_DEFAULTS = {
	claimBudgetMs: 90_000, // 健康态接单（astra 建议，待批准为门槛）
	resultBudgetMs: 300_000, // 小任务闭环 5min（超期 = 明确可追踪失败，挂死 = 不合格）
	pendingBudgetMs: 300_000, // pending 信龄上限（超过 → 「貌似健康却永久 pending」）
	blockBudgetMs: 180_000, // 受阻暴露：可 claim 信龄 > 该值仍未 claim → blocked
};

function parseFlags(argv) {
	const flags = {};
	const positional = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith("--")) {
			const key = a.slice(2);
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				flags[key] = next;
				i++;
			} else {
				flags[key] = true;
			}
		} else {
			positional.push(a);
		}
	}
	return { flags, positional };
}

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

function readRecords(runId) {
	try {
		return readFileSync(jsonlPath(runId), "utf8")
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => {
				try {
					return JSON.parse(l);
				} catch {
					return null;
				}
			})
			.filter(Boolean);
	} catch {
		return [];
	}
}

function loadCurrent(flags) {
	const path = currentPath();
	if (flags.run) {
		const p2 = jsonlPath(String(flags.run));
		if (!existsSync(p2)) fail(`找不到 runId=${flags.run} 的验收记录（${p2}）`);
		return { runId: String(flags.run), ...(readRecords(String(flags.run)).find((r) => r.phase === "init") ?? {}), ...loadRunMeta(String(flags.run)) };
	}
	const cur = readJson(path);
	if (!cur) fail(`缺少 ${path}（先跑 init）`);
	return cur;
}

/** init 时除基线外的元数据（scenario/repo/scope/addr）另存 .<runId>.meta.json，避免污染 jsonl 字段面。 */
const metaPath = (runId) => join(accDir(), `.${runId}.meta.json`);
const loadRunMeta = (runId) => readJson(metaPath(runId)) ?? {};

function record(entry) {
	const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
	mkdirSync(accDir(), { recursive: true });
	appendFileSync(jsonlPath(entry.runId), `${line}\n`, "utf8");
}

function fail(msg) {
	console.error(`FAIL: ${msg}`);
	process.exit(1);
}

// ── 盘面观测（只读；全部走生产读手）──────────────────────────────

let cachedProd = null;
async function prod() {
	if (cachedProd) return cachedProd;
	const [mailbox, registry, scope, consume, address] = await Promise.all([
		import(new URL("../extensions/runtime/mailbox.ts", import.meta.url).href),
		import(new URL("../extensions/runtime/registry.ts", import.meta.url).href),
		import(new URL("../extensions/runtime/scope.ts", import.meta.url).href),
		import(new URL("../extensions/runtime/scope-consume.ts", import.meta.url).href),
		import(new URL("../extensions/runtime/address.ts", import.meta.url).href),
	]);
	cachedProd = { mailbox, registry, scope, consume, address };
	return cachedProd;
}

/** 账本计数：lms-<scope>（ensure dispatch）与 l2-<scope.slice(0,14)>（wake tab dispatch）。 */
function ledgerCounts(scope) {
	const dir = runsLedgerDir();
	const out = { lms: 0, l2: 0, ids: [] };
	if (!existsSync(dir)) return out;
	const l2Key = `l2-${scope.slice(0, 14)}`;
	for (const f of readdirSync(dir)) {
		if (!f.endsWith(".json")) continue;
		const rec = readJson(join(dir, f));
		if (!rec || typeof rec.taskId !== "string") continue;
		if (rec.taskId === `lms-${scope}` || rec.taskId.startsWith(`lms-${scope}`)) out.lms++;
		else if (rec.taskId === l2Key || rec.taskId.startsWith(l2Key)) out.l2++;
		else continue;
		out.ids.push(rec.id);
	}
	return out;
}

function findResultLetter(mailbox, addr, messageId) {
	const letters = mailbox.listLetters(addr);
	for (const l of letters) {
		const f = l.frame;
		if (f.frame !== "message") continue;
		if (f.kind !== "RESULT") continue;
		if (f.inReplyTo !== messageId) continue;
		return { letter: l, path: null };
	}
	return null;
}

function ageOf(path) {
	try {
		return Date.now() - statSync(path).mtimeMs;
	} catch {
		return null;
	}
}

// ── 子命令 ───────────────────────────────────────────────────────

async function cmdInit(flags, positional) {
	const repo = positional[0];
	if (!repo) fail("用法：init <repo> --scenario <name>");
	const scenario = String(flags.scenario ?? "cold");
	const { scope, address, registry, consume } = await prod();
	const addr = scope.localMasterAddress(scope.localMasterScope(repo));
	const att = registry.readAttachment(addr);
	const ev = consume.readConsumeEvidence(scope.localMasterScope(repo));
	const cut = registry.readCutover();
	const ledger = ledgerCounts(scope.localMasterScope(repo));
	const runId = String(flags.run ?? `acc-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`);
	const sc = scope.localMasterScope(repo);
	const baseline = {
		cutoverEnabled: Boolean(cut?.enabled),
		sessionId: att?.sessionId ?? null,
		generation: att?.generation ?? null,
		evidence: ev ? { sessionId: ev.sessionId, generation: ev.generation, lastTickAt: ev.lastTickAt, tickCount: ev.tickCount } : null,
		lmsDispatch: ledger.lms,
		l2Dispatch: ledger.l2,
	};
	const meta = { runId, scenario, repo, scope: sc, addr, startedAt: new Date().toISOString() };
	mkdirSync(accDir(), { recursive: true });
	writeFileSync(currentPath(), `${JSON.stringify({ ...meta, baseline }, null, 2)}\n`, "utf8");
	writeFileSync(metaPath(runId), `${JSON.stringify({ ...meta, baseline }, null, 2)}\n`, "utf8");
	record({
		runId,
		scenario,
		scope: sc,
		generation: baseline.generation,
		phase: "init",
		disposition: "unknown",
		baseline,
	});
	console.log(`runId=${runId}`);
	console.log(`scenario=${scenario} scope=${sc} addr=${addr}`);
	console.log(`baseline: cutover=${baseline.cutoverEnabled} owner=${baseline.sessionId ?? "-"} gen=${baseline.generation ?? "-"} evidence=${baseline.evidence ? `${baseline.evidence.sessionId.slice(0, 8)}/gen${baseline.evidence.generation}/ticks${baseline.evidence.tickCount}` : "none"} ledger(lms=${baseline.lmsDispatch},l2=${baseline.l2Dispatch})`);
}

async function cmdInject(flags) {
	const cur = loadCurrent(flags);
	const { mailbox, address, scope, registry } = await prod();
	const sc = cur.scope;
	const to = scope.localMasterAddress(sc);
	const from = typeof flags.from === "string" ? flags.from : address.masterAddress();
	const bodyText =
		typeof flags.body === "string" && flags.body.trim()
			? flags.body.trim()
			: `运行 node -e "console.log('p1-ok')" 并把输出用 deliverLetter 回 RESULT`;
	const messageId = mailbox.newMessageId();
	const frame = {
		frame: "message",
		id: messageId,
		kind: "ESCALATION",
		from,
		to,
		subject: `task://local-master-acceptance/${cur.runId}`,
		requiresAck: true,
		sentAt: new Date().toISOString(),
		body: { summary: bodyText.slice(0, 500), details: { runId: cur.runId, scenario: cur.scenario } },
	};
	mailbox.deliverLetter(frame);
	const att = registry.readAttachment(to);
	const tDelivered = Date.now();
	record({
		runId: cur.runId,
		scenario: cur.scenario,
		scope: sc,
		generation: att?.generation ?? null,
		phase: "inject",
		messageId,
		tLetterDelivered: tDelivered,
		disposition: "unknown",
	});
	console.log(`messageId=${messageId}`);
	console.log(`to=${to} from=${from} scope=${sc}`);
	console.log(`body=${bodyText}`);
	console.log(`tLetterDelivered=${new Date(tDelivered).toISOString()}`);
}

function lastInject(records) {
	const injects = records.filter((r) => r.phase === "inject");
	return injects.length ? injects[injects.length - 1] : null;
}

async function cmdWait(flags) {
	const cur = loadCurrent(flags);
	const what = String(flags.what ?? "");
	const timeout = Number(flags.timeout ?? 60_000);
	if (!["evidence", "claimed", "result", "spawned"].includes(what)) fail("--what 必须是 evidence|claimed|result|spawned");
	if (!Number.isFinite(timeout) || timeout <= 0) fail("--timeout 必须是正数毫秒");
	const records = readRecords(cur.runId);
	const inject = lastInject(records);
	const { mailbox, address, scope, registry, consume } = await prod();
	const sc = cur.scope;
	const addr = scope.localMasterAddress(sc);
	const deadline = Date.now() + timeout;
	const startedAt = Date.now();
	let found = false;
	let detail = "";
	for (;;) {
		if (what === "evidence") {
			const att = registry.readAttachment(addr);
			const ev = consume.readConsumeEvidence(sc);
			if (att && ev) {
				const j = consume.judgeConsumeFresh(ev, { sessionId: att.sessionId, generation: att.generation, nowMs: Date.now() });
				if (j.fresh) {
					found = true;
					detail = `lastTickAt=${ev.lastTickAt} reason=${ev.lastTickReason} ticks=${ev.tickCount} gen=${ev.generation}`;
					record({
						runId: cur.runId, scenario: cur.scenario, scope: sc, generation: ev.generation,
						phase: "wait-evidence", evidenceLastTickAt: ev.lastTickAt, tEvidenceFresh: Date.now(),
						disposition: "unknown",
					});
				} else {
					detail = `evidence-not-fresh reason=${j.reason} lastTickAt=${ev.lastTickAt}`;
				}
			} else {
				detail = `evidence-missing attachment=${att ? "yes" : "no"}`;
			}
		} else if (what === "claimed") {
			if (!inject) detail = "no-inject-record（先 inject）";
			else {
				const letters = mailbox.listLetters(addr);
				const l = letters.find((x) => x.frame.frame === "message" && x.frame.id === inject.messageId);
				if (!l) detail = "letter-absent";
				else if (l.status !== "pending") {
					found = true;
					detail = `status=${l.status}`;
					record({
						runId: cur.runId, scenario: cur.scenario, scope: sc, generation: registry.readAttachment(addr)?.generation ?? null,
						phase: "wait-claimed", messageId: inject.messageId, tClaimed: Date.now(), disposition: "unknown",
					});
				} else detail = `status=pending ageMs=${ageOf(mailboxLetterPath(addr, inject.messageId)) ?? "?"}`;
			}
		} else if (what === "result") {
			if (!inject) detail = "no-inject-record（先 inject）";
			else {
				const hit = findResultLetter(mailbox, address.masterAddress(), inject.messageId);
				if (hit) {
					found = true;
					const f = hit.letter.frame;
					detail = `kind=${f.kind} inReplyTo=${f.inReplyTo} to=${f.to} status=${hit.letter.status}`;
					record({
						runId: cur.runId, scenario: cur.scenario, scope: sc, generation: registry.readAttachment(addr)?.generation ?? null,
						phase: "wait-result", messageId: inject.messageId, inReplyTo: f.inReplyTo, tResult: Date.now(),
						disposition: "result-received",
					});
				} else detail = "result-absent";
			}
		} else if (what === "spawned") {
			const cur2 = ledgerCounts(sc);
			const base = cur.baseline?.l2Dispatch ?? 0;
			if (cur2.l2 > base) {
				found = true;
				detail = `l2 ${base} → ${cur2.l2}`;
				record({
					runId: cur.runId, scenario: cur.scenario, scope: sc, generation: registry.readAttachment(addr)?.generation ?? null,
					phase: "wait-spawned", ledgerTaskId: `l2-${sc.slice(0, 14)}`, tSpawned: Date.now(), disposition: "unknown",
				});
			} else detail = `l2=${cur2.l2} baseline=${base}`;
		}
		if (found) {
			console.log(`OK ${what}: ${detail}（等了 ${Date.now() - startedAt}ms）`);
			return;
		}
		if (Date.now() >= deadline) {
			const disposition = what === "result" ? "no-result-timeout" : what === "evidence" ? "consume-unverified" : "blocked";
			record({
				runId: cur.runId, scenario: cur.scenario, scope: sc,
				generation: registry.readAttachment(addr)?.generation ?? null,
				phase: `wait-${what}`, disposition, reason: `wait-timeout:${what}`, evidenceLastTickAt: consume.readConsumeEvidence(sc)?.lastTickAt,
			});
			console.error(`TIMEOUT ${what}: ${detail}（timeout=${timeout}ms）→ disposition=${disposition}`);
			process.exit(1);
		}
		await new Promise((r) => setTimeout(r, 1_000));
	}
}

/** 信件磁盘路径（观测 age；mailbox API 不回文件名，这里按 mailboxDirFor 同规则拼）。 */
function mailboxLetterPath(addr, messageId) {
	const { mailbox } = cachedProd;
	return join(mailbox.mailboxDirFor(addr), `${messageId}.json`);
}

async function cmdCheck(flags) {
	const cur = loadCurrent(flags);
	const records = readRecords(cur.runId);
	const { mailbox, address, scope, registry, consume } = await prod();
	const sc = cur.scope;
	const addr = scope.localMasterAddress(sc);
	const att = registry.readAttachment(addr);
	const ev = consume.readConsumeEvidence(sc);
	const budget = {
		claimBudgetMs: Number(flags["claim-budget-ms"] ?? BUDGET_DEFAULTS.claimBudgetMs),
		resultBudgetMs: Number(flags["result-budget-ms"] ?? BUDGET_DEFAULTS.resultBudgetMs),
		pendingBudgetMs: Number(flags["pending-budget-ms"] ?? BUDGET_DEFAULTS.pendingBudgetMs),
		blockBudgetMs: Number(flags["block-budget-ms"] ?? BUDGET_DEFAULTS.blockBudgetMs),
	};
	const injects = records.filter((r) => r.phase === "inject");
	const checks = [];
	const add = (id, pass, detail) => checks.push({ id, pass, detail });

	const fresh =
		att && ev
			? consume.judgeConsumeFresh(ev, { sessionId: att.sessionId, generation: att.generation, nowMs: Date.now() })
			: { fresh: false, reason: "missing" };
	add("evidence-fresh", fresh.fresh, `reason=${fresh.reason}${ev ? ` lastTickAt=${ev.lastTickAt} reason=${ev.lastTickReason} ticks=${ev.tickCount}` : ""}`);

	const gen = att?.generation ?? null;
	const sameOwner = cur.baseline?.sessionId ? att?.sessionId === cur.baseline.sessionId && gen === cur.baseline.generation : true;
	add("attachment-stable", sameOwner, `baseline=${cur.baseline?.sessionId ?? "-"}/gen${cur.baseline?.generation ?? "-"} now=${att?.sessionId ?? "-"}/gen${gen ?? "-"}`);

	const ledger = ledgerCounts(sc);
	if (cur.scenario === "existing-owner") {
		add("zero-spawn", ledger.lms === (cur.baseline?.lmsDispatch ?? 0), `lms ${cur.baseline?.lmsDispatch} → ${ledger.lms}`);
	} else if (cur.scenario === "cold") {
		add("one-dispatch", ledger.lms >= (cur.baseline?.lmsDispatch ?? 0) && ledger.lms <= (cur.baseline?.lmsDispatch ?? 0) + 1, `lms ${cur.baseline?.lmsDispatch} → ${ledger.lms}`);
	}

	let finalDisposition = injects.length ? "unknown" : "unknown";
	const rows = [];
	for (const inj of injects) {
		const hit = findResultLetter(mailbox, address.masterAddress(), inj.messageId);
		const claimedRec = records.filter((r) => r.messageId === inj.messageId && r.tClaimed).pop();
		const resultRec = records.filter((r) => r.messageId === inj.messageId && r.tResult).pop();
		const tResult = resultRec?.tResult ?? (hit ? Date.parse(hit.letter.frame.sentAt) : null);
		const tClaimed = claimedRec?.tClaimed ?? null;
		const letters = mailbox.listLetters(addr);
		const l = letters.find((x) => x.frame.frame === "message" && x.frame.id === inj.messageId);
		const letterStatus = l?.status ?? "absent";
		const pendingMs = letterStatus === "pending" ? ageOf(mailboxLetterPath(addr, inj.messageId)) : null;
		const row = {
			messageId: inj.messageId,
			inReplyTo: hit?.letter.frame.inReplyTo ?? null,
			status: letterStatus,
			result: Boolean(hit),
			tLetterDelivered: inj.tLetterDelivered ?? null,
			tClaimed,
			tResult,
			claimMs: inj.tLetterDelivered && tClaimed ? tClaimed - inj.tLetterDelivered : null,
			resultMs: inj.tLetterDelivered && tResult ? tResult - inj.tLetterDelivered : null,
			pendingMs,
		};
		rows.push(row);
		// A1：唯一关联结果（messageId 唯一 + inReplyTo 对齐 + 收件人 = 主会话地址）
		if (hit) {
			add(`result-correlated:${inj.messageId.slice(0, 12)}`, hit.letter.frame.inReplyTo === inj.messageId && hit.letter.frame.to === address.masterAddress(),
				`inReplyTo=${hit.letter.frame.inReplyTo} to=${hit.letter.frame.to}`);
		}
		// 预算断言（可配置）
		if (row.claimMs !== null) add(`claim-budget:${inj.messageId.slice(0, 12)}`, row.claimMs <= budget.claimBudgetMs, `${row.claimMs}ms ≤ ${budget.claimBudgetMs}ms`);
		if (row.resultMs !== null) add(`result-budget:${inj.messageId.slice(0, 12)}`, row.resultMs <= budget.resultBudgetMs, `${row.resultMs}ms ≤ ${budget.resultBudgetMs}ms`);
		if (pendingMs !== null) add(`not-permanently-pending:${inj.messageId.slice(0, 12)}`, pendingMs <= budget.pendingBudgetMs, `pending ${pendingMs}ms ≤ ${budget.pendingBudgetMs}ms`);
	}

	const interrupted = records.find((r) => r.phase === "interrupt");
	if (interrupted?.disposition && interrupted.disposition !== "unknown") finalDisposition = interrupted.disposition;
	else if (rows.length === 0) finalDisposition = "unknown";
	else if (rows.every((r) => r.result)) finalDisposition = "result-received";
	else if (!fresh.fresh && fresh.reason !== "ok") finalDisposition = "consume-unverified";
	else if (rows.some((r) => r.status === "pending" && (r.pendingMs ?? 0) > budget.blockBudgetMs)) finalDisposition = "blocked";
	else finalDisposition = "unknown"; // 无法证明完成 → unknown，不伪造成功

	// F1 受阻暴露：lastTickReason 直接给出原因（不靠人工巡视 PID）
	const blockedReason = ev && ["cutover-off", "in-flight", "no-mail", "tick-error"].includes(ev.lastTickReason) ? ev.lastTickReason : null;
	if (finalDisposition === "blocked") add("blocked-explained", Boolean(blockedReason), `lastTickReason=${blockedReason ?? "n/a"}`);

	const failed = checks.filter((c) => !c.pass);
	for (const c of checks) console.log(`${c.pass ? "ok  " : "FAIL"} ${c.id}: ${c.detail}`);
	console.log(`\ndisposition=${finalDisposition}（受控枚举；无法证明完成时 = unknown，不伪造成功）`);
	console.log(`correlation: 请求 ${rows.length} / 结果 ${rows.filter((r) => r.result).length} / pending ${rows.filter((r) => r.status === "pending").length} / claimed ${rows.filter((r) => r.status === "claimed").length}`);
	console.log(`budgets: claim≤${budget.claimBudgetMs}ms result≤${budget.resultBudgetMs}ms pending≤${budget.pendingBudgetMs}ms block>${budget.blockBudgetMs}ms`);
	record({
		runId: cur.runId, scenario: cur.scenario, scope: sc, generation: gen, phase: "check",
		disposition: finalDisposition, checks: checks.length, failed: failed.length, rows,
	});
	process.exit(failed.length === 0 ? 0 : 1);
}

function cmdReport(flags) {
	const cur = loadCurrent(flags);
	const records = readRecords(cur.runId);
	const cols = ["at", "phase", "messageId", "inReplyTo", "generation", "tLetterDelivered", "tEvidenceFresh", "tClaimed", "tSpawned", "tResult", "disposition"];
	console.log(cols.join("\t"));
	for (const r of records) {
		console.log(cols.map((c) => (r[c] === undefined || r[c] === null ? "-" : String(r[c]).slice(0, 40))).join("\t"));
	}
}

async function cmdMark(flags) {
	const cur = loadCurrent(flags);
	const phase = String(flags.phase ?? "interrupt");
	const disposition = String(flags.disposition ?? "unknown");
	if (!DISPOSITIONS.includes(disposition)) fail(`--disposition 必须是受控枚举之一：${DISPOSITIONS.join(" | ")}`);
	const { scope, registry } = await prod();
	const att = registry.readAttachment(scope.localMasterAddress(cur.scope));
	void scope;
	record({
		runId: cur.runId, scenario: cur.scenario, scope: cur.scope, generation: att?.generation ?? null,
		phase, disposition, ...(flags.reason ? { reason: String(flags.reason) } : {}),
	});
	console.log(`marked phase=${phase} disposition=${disposition}`);
}

function cmdRunbook() {
	console.log(`runbook（8 步主链；真进程/可见 tab/可中断测试会话只在隔离环境执行，不进 npm test）：`);
	console.log(`  1) init <test-repo> --scenario cold`);
	console.log(`  2) 主会话真实 slash：/local-master-ensure <test-repo> --timeout 90000（真实 UI，不代打）`);
	console.log(`  3) wait --what evidence --timeout 120000`);
	console.log(`  4) inject [--body "<低风险 worker 指令>"]`);
	console.log(`  5) wait --what claimed --timeout 90000`);
	console.log(`  6) wait --what spawned --timeout 90000`);
	console.log(`  7) wait --what result --timeout 300000`);
	console.log(`  8) check && report`);
	console.log(`中断场景：在 5) 前/后只 kill 测试会话（禁止杀用户工作中的 master），恢复后从 3) 续跑，并 mark --phase interrupt --disposition interrupted-before-claim|interrupted-after-claim`);
	console.log(`\n预算（可配置）: claim≤${BUDGET_DEFAULTS.claimBudgetMs}ms result≤${BUDGET_DEFAULTS.resultBudgetMs}ms pending≤${BUDGET_DEFAULTS.pendingBudgetMs}ms`);
	console.log(`处置受控枚举: ${DISPOSITIONS.join(" | ")}`);
	console.log(`验收记录: ${accDir()}/<runId>.jsonl（仅此命名空间；结束可归档/删除）`);
}

function cmdHelp() {
	console.log(`local-master-loop-acceptance — 0926 P1 故障闭环验收入口（真实 Interface 进入；本脚本不 spawn 任何进程）

用法:
  init <repo> --scenario <cold|existing-owner|attach-no-restart|interrupt-before-claim|interrupt-after-claim|blocked|kill-vs-cutover> [--run <id>]
  inject [--from <addr>] [--body <text>] [--run <id>]
  wait --what evidence|claimed|spawned|result --timeout <ms> [--run <id>]
  mark --phase <phase> --disposition <enum> [--reason <text>]
  check [--claim-budget-ms N] [--result-budget-ms N] [--pending-budget-ms N] [--block-budget-ms N]
  report | runbook

红线: ensure 必须由主会话真实 slash / 工具发起；邮箱指令走生产 deliverLetter；本脚本只观测与投信。
处置枚举: ${DISPOSITIONS.join(" | ")}`);
}

// ── main ─────────────────────────────────────────────────────────
const [cmd, ...rest] = process.argv.slice(2);
const { flags, positional } = parseFlags(rest);
try {
	if (cmd === "init") await cmdInit(flags, positional);
	else if (cmd === "inject") await cmdInject(flags);
	else if (cmd === "wait") await cmdWait(flags);
	else if (cmd === "check") await cmdCheck(flags);
	else if (cmd === "report") cmdReport(flags);
	else if (cmd === "mark") await cmdMark(flags);
	else if (cmd === "runbook") cmdRunbook();
	else cmdHelp();
} catch (e) {
	console.error(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
	process.exit(1);
}
