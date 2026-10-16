/**
 * _test_delivery_host_contract.ts — R8「宿主实际契约」验收单测（唤醒必达 §8.3 R8）
 *
 * ## 为什么不能只写 fake
 * 咨询 §8.1：单测里 `sendUserMessage: () => Promise.resolve()` 的 fake **不等于宿主契约**。
 * 本机 Pi 0.99.1 的真实链是**两级 delegate 都不 return**：
 *   - 扩展拿到的 API：`dist/core/extensions/loader.js` 的
 *     `sendUserMessage(content, options) { assertActive(); runtime.sendUserMessage(content, options); }`
 *     —— 无 `return`；
 *   - bindCore 注入 runtime 的 wrapper：`dist/core/agent-session.js:2644`
 *     `sendUserMessage: (content, options) => { this.sendUserMessage(content, options).catch(err => runner.emitError(...)); }`
 *     —— 无 `return`，底层 reject 只进 `emitError`。
 * 所以底层 reject 时调用方**只看得到 `undefined`**（P3 假阳性）。本文件照
 * `scripts/_probe_p3_senduser_message.mjs` 的抽取方式，**从已安装包的源码里抽出这两段表达式**
 * 再求值组装成真链，而不是另写一个「同样有误的 fake」。
 *
 * ## 覆盖
 *   H1  真宿主 wrapper + 底层 reject ⇒ `injectFollowUpQuietly(..., {strict:true})` = `"unconfirmed"`；
 *       **绝不**写 `consumed` ACK（`ackConsumed` 的前置条件——账本里存在该事件——本就不成立）；
 *       `{strict:false}`（回滚档位）⇒ `"sent"`（**如实记录 P3 假阳性在回滚档位仍存在**）；
 *       对照：替换上下文的 `context.sendUserMessage`（agent-session.js:3479）**会** return 真 Promise
 *       ⇒ 它这一级能正确分类（这就是「本机普通 ExtensionContext 并不天然有可 await 的 seam」的证据）。
 *   H2  分类矩阵：底层 reject 且含 `already processing` ⇒ `"busy"`；其它 reject ⇒ `"failed"`；
 *       同步 throw ⇒ `"failed"`；`send` 非函数 ⇒ `"no-injector"`。
 *   H3  **P2 回归**（本文件重点）：同一批两个事件，事件 A 发送失败**不得**压制事件 B。
 *       两个公开入口各测一次：
 *         入口① `async-result-watcher.ts::onRunFile`（A 快通道；对照 _test_async_result_watcher.ts §15 的 P2 断言）；
 *         入口② `delivery-reconciler.ts::reconcileOnce`（B 对账通道，一次 pass 内 A 抛错、B 照投）。
 *       并断言 R8 行要求的「失败 ≤75s 可见」（terminalAt+75s 内 incident 已落盘）。
 *
 * ## 依据
 * plans/20261016_consult_scheduling_and_wake_reliability.md §8.3 R8、§6.2、§6.3.5。
 *
 * 运行：npm run test:delivery-host-contract
 */

import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 隔离在 import 之前（同 _test_message_outbox.ts:42 纪律）。
process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "delivery-host-env-"));
process.env.PI_SESSIONS_DIR = mkdtempSync(join(tmpdir(), "delivery-host-sessions-"));
// 本文件不是子 agent / 不是 tab（同 _test_async_result_watcher.ts:31 纪律）
delete process.env.PI_SUBAGENT;
delete process.env.PI_TAB_RUN_ID;

import { ackConsumed, extractEventIdsFromMessages, eventMarker } from "./delivery-ack.ts";
import { injectFollowUpQuietly, type InjectionSendStatus } from "./injection-gate.ts";
import { effectiveStage, ensureEvent, listAcks, listAttempts, listEvents, listOpenIncidents, terminalRevisionOf } from "./delivery-ledger.ts";
import { reconcileOnce } from "./delivery-reconciler.ts";
import { onRunFile, _resetAsyncResultWatcher } from "./async-result-watcher.ts";
import { setCurrentSessionId } from "./identity.ts";

let n = 0;
const ok = (name: string): void => { n += 1; console.log(`ok ${n} - ${name}`); };

const ROOT = process.env.PI_RUNTIME_DIR!;
const SESSIONS = process.env.PI_SESSIONS_DIR!;
const NOW = Date.parse("2026-10-16T14:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

// ── 从**已安装包**抽取真宿主表达式（照 scripts/_probe_p3_senduser_message.mjs 的方式）──

/** 定位已安装的 pi-coding-agent 包根（本仓库 node_modules junction → 真实安装树）。 */
const PI_PKG_DIR = join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent");
const AGENT_SESSION_JS = join(PI_PKG_DIR, "dist", "core", "agent-session.js");
const LOADER_JS = join(PI_PKG_DIR, "dist", "core", "extensions", "loader.js");
assert.ok(existsSync(AGENT_SESSION_JS), `必须找到已安装的宿主源码：${AGENT_SESSION_JS}`);
assert.ok(existsSync(LOADER_JS), `必须找到已安装的 loader 源码：${LOADER_JS}`);

const AS_SRC = readFileSync(AGENT_SESSION_JS, "utf8");
const LOADER_SRC = readFileSync(LOADER_JS, "utf8");

/** 从 `startIndex` 起第一个 `{` 开始做花括号配平，返回含两端的原文（不解析 AST，够用且可核验）。 */
function balancedFrom(src: string, startIndex: number): string {
	const open = src.indexOf("{", startIndex);
	assert.ok(open >= 0, "抽取点必须有花括号");
	let depth = 0;
	for (let i = open; i < src.length; i += 1) {
		const c = src[i];
		if (c === "{") depth += 1;
		else if (c === "}") {
			depth -= 1;
			if (depth === 0) return src.slice(open, i + 1);
		}
	}
	throw new Error("花括号未配平：宿主源码形状与预期不符");
}

/** ✅ 真宿主 wrapper 表达式（agent-session.js:2644，bindCore 注入 runtime 的那一级）。 */
const WRAPPER_NEEDLE = "sendUserMessage: (content, options) => {";
const WRAPPER_AT = AS_SRC.indexOf(WRAPPER_NEEDLE);
assert.ok(WRAPPER_AT >= 0, "agent-session.js 必须含 bindCore wrapper（本机 pi 0.99.1 契约）");
const WRAPPER_BODY = balancedFrom(AS_SRC, WRAPPER_AT + WRAPPER_NEEDLE.length - 1);
const WRAPPER_EXPR = `${WRAPPER_NEEDLE}${WRAPPER_BODY.slice(1)}`; // 拼回完整属性表达式
// 硬证据：wrapper **不含 return**（有 return 则 P3 不成立，本用例就该改）
assert.equal(/\breturn\b/.test(WRAPPER_BODY), false, "bindCore wrapper 必须无 return（否则 P3 假阳性前提不成立）");

/** ✅ 真 loader 方法体（loader.js:295；扩展实际拿到的 API，同样不 return）。 */
const LOADER_NEEDLE = "sendUserMessage(content, options) {";
const LOADER_AT = LOADER_SRC.indexOf(LOADER_NEEDLE);
assert.ok(LOADER_AT >= 0, "loader.js 必须含 sendUserMessage（本机 pi 0.99.1 契约）");
const LOADER_BODY = balancedFrom(LOADER_SRC, LOADER_AT + LOADER_NEEDLE.length - 1).slice(1, -1); // 去掉外层 { }
assert.equal(/\breturn\b/.test(LOADER_BODY), false, "loader 级 sendUserMessage 必须无 return（两级 delegate 都不 return = P3 根因）");

/** ✅ 对照：替换上下文的 `context.sendUserMessage`（agent-session.js:3479，**会** return 真 Promise）。 */
const CTX_NEEDLE = "context.sendUserMessage = (content, options) =>";
const CTX_AT = AS_SRC.indexOf(CTX_NEEDLE);
assert.ok(CTX_AT >= 0, "agent-session.js 必须含替换上下文的 sendUserMessage 赋值（对照级）");
const CTX_EXPR = AS_SRC.slice(CTX_AT + "context.sendUserMessage = ".length, AS_SRC.indexOf(";", CTX_AT));

/**
 * 组装**真宿主两级链**（求值上面抽出的源码片段，而不是手写等价 fake）。
 *
 * @param coreSend 底层 `this.sendUserMessage`（agent-session.js:1780）的实现；测试注入 reject/成功。
 * @returns `{ send, emitErrors }` — `send` 即扩展调用点看到的形态（loader 级）。
 */
function makeRealHostSend(coreSend: (content: string, options?: unknown) => unknown): {
	send: (content: string, options?: unknown) => unknown;
	emitErrors: Array<{ extensionPath?: string; event?: string; error?: string }>;
	runtimeRawReturns: unknown[];
} {
	const emitErrors: Array<{ extensionPath?: string; event?: string; error?: string }> = [];
	const runner = { emitError: (e: { extensionPath?: string; event?: string; error?: string }) => { emitErrors.push(e); } };
	const thisObj = { sendUserMessage: coreSend };
	// ① bindCore wrapper（源码求值；`this` = thisObj，`runner` = runner）
	const wrapper = new Function("runner", `return { ${WRAPPER_EXPR} };`).call(thisObj, runner) as {
		sendUserMessage: (content: string, options?: unknown) => unknown;
	};
	// ② loader 级（源码求值；无 return ⇒ 调用方拿到 undefined）
	const runtimeRawReturns: unknown[] = [];
	const runtime = {
		sendUserMessage: (content: string, options?: unknown) => { runtimeRawReturns.push(wrapper.sendUserMessage(content, options)); },
	};
	const loaderSend = (content: string, options?: unknown): unknown => {
		const fn = new Function("runtime", "assertActive", "content", "options", LOADER_BODY);
		return fn(runtime, () => { /* assertActive：扩展已激活 */ }, content, options) as unknown;
	};
	return { send: loaderSend, emitErrors, runtimeRawReturns };
}

/** 替换上下文级（对照）：真 Promise 会返回，故它这一级能正确分类。 */
function makeReplacedContextSend(coreSend: (content: string, options?: unknown) => unknown): {
	send: (content: string, options?: unknown) => unknown;
} {
	const thisObj = { sendUserMessage: coreSend };
	return { send: new Function(`return ${CTX_EXPR};`).call(thisObj) as (content: string, options?: unknown) => unknown };
}

const LINKS = join(ROOT, "links.jsonl");
const ME = "dddddddd-1111-4444-8888-dddddddddddd";
setCurrentSessionId(ME);

const linkAsync = (runId: string, sessionId: string = ME): void => {
	appendFileSync(LINKS, `${JSON.stringify({ sessionId, kind: "async", targetId: runId, detail: "host-contract", at: iso(NOW), pid: process.pid })}\n`, "utf8");
};

const mkRunsDir = (g: string): string => {
	const rd = join(ROOT, `runs-${g}`);
	mkdirSync(rd, { recursive: true });
	return rd;
};

const writeRun = (rd: string, runId: string, at: number): Buffer => {
	const buf = Buffer.from(JSON.stringify({
		id: runId, agent: "general", task: "host-contract", status: "completed",
		startedAt: iso(at - 60_000), endedAt: iso(at), pid: 4242,
		result: { status: "completed", text: "ok", error: null },
	}), "utf8");
	writeFileSync(join(rd, `${runId}.json`), buf);
	return buf;
};

const consumedAckCount = (d: string, eventId: string): number => listAcks(d, eventId).filter((a) => a.stage === "consumed").length;

try {
	assert.equal(PI_PKG_DIR.includes("@earendil-works"), true, "使用本机已安装的 pi 包（非仓库自带副本）");
	console.log(`# 抽取自本机已安装宿主：${AGENT_SESSION_JS}`);

	// ══ H1：真宿主 wrapper + 底层 reject ⇒ unconfirmed（strict）/ sent（回滚档），绝不写 consumed ══
	{
		const dir = join(ROOT, "h1-delivery");
		const bodyWithMarker = `⏱ async general run_h1 completed\n${eventMarker("async:run_h1:deadbeef")}`;

		// ① 真链：底层 = agent-session.js:1780 的 busy 拒绝形态
		const host = makeRealHostSend(() => Promise.reject(new Error("Agent is already processing a prompt.")));
		const raw = host.send(bodyWithMarker, { deliverAs: "followUp" });
		assert.equal(raw, undefined, "真两级链：底层 reject 时扩展调用点只看得到 undefined（P3 事实）");

		const strictStatus = await injectFollowUpQuietly(host.send, bodyWithMarker, { strict: true });
		assert.equal(strictStatus, "unconfirmed", "**strict ⇒ unconfirmed**（无可信确证，不得当 sent）");
		const rollbackStatus = await injectFollowUpQuietly(host.send, bodyWithMarker, { strict: false });
		assert.equal(rollbackStatus, "sent", "**回滚档位（strict:false）⇒ sent**：P3 假阳性在此档位仍存在（如实记录）");

		// ② **绝不**写 consumed ACK：账本里根本没有该事件 ⇒ ackConsumed 前置条件不成立
		const noEventId = "async:run_h1:deadbeef";
		const denied = ackConsumed(dir, [noEventId], { at: NOW });
		assert.equal(denied[0].created, false, "未进 context ⇒ 不得写 consumed ACK");
		assert.equal(denied[0].reason, "event-not-found", "拒绝理由：该 eventId 在账本中不存在（ackConsumed 前置条件不成立）");
		assert.equal(existsSync(dir) ? readdirSync(dir).filter((f) => f.includes(".ack.")).length : 0, 0, "账本里**没有任何 ACK 文件**（绝不写 consumed）");

		// ③ emitError 计数：真 wrapper 把底层错误吞进 emitError（扩展侧看不到）
		await flush();
		assert.equal(host.emitErrors.length, 3, "三次底层调用（raw + strict + rollback）各 emitError 一次（错误只进 emitError，扩展侧不可见）");
		assert.ok(String(host.emitErrors[0].error).includes("already processing"), "emitError 携带底层错误文本");
		assert.equal(host.emitErrors[0].extensionPath, "<runtime>", "emitError 的 extensionPath 是硬编码 <runtime>（并非某个扩展名）");

		// ④ 对照：替换上下文级**返回真 Promise** ⇒ 同一底层 reject 能被正确分类
		const ctx = makeReplacedContextSend(() => Promise.reject(new Error("Agent is already processing a prompt.")));
		const ctxRaw = ctx.send(bodyWithMarker, { deliverAs: "followUp" });
		assert.equal(typeof (ctxRaw as { then?: unknown }).then, "function", "替换上下文级的 sendUserMessage 返回真 Promise（:3479）");
		await (ctxRaw as Promise<unknown>).catch(() => { /* 吞掉本对照样本的 rejection（免 unhandled） */ });
		assert.equal(await injectFollowUpQuietly(ctx.send, bodyWithMarker), "busy", "真 Promise 级 ⇒ 正确分类为 busy（证明差异来自 seam 的 return 与否）");
		ok("H1 真宿主 wrapper：strict⇒unconfirmed / 回滚⇒sent / 零 consumed ACK / emitError 记录；对照级返真 Promise");
	}

	// ══ H2：分类矩阵（用真替换上下文级 send，故 reject 不被 wrapper 吞掉）══
	{
		const body = "matrix-body";
		const withCore = (core: (c: string, o?: unknown) => unknown): ((c: string, o?: unknown) => unknown) => makeReplacedContextSend(core).send;

		const cases: Array<[string, (c: string, o?: unknown) => unknown, InjectionSendStatus]> = [
			["底层 reject 含 already processing", withCore(() => Promise.reject(new Error("Agent is already processing a prompt…"))), "busy"],
			["bindCore 包装后的完整报错形状", withCore(() => Promise.reject(new Error('Extension "<runtime>" error: Agent is already processing a prompt…'))), "busy"],
			["其它 reject（连接错误）", withCore(() => Promise.reject(new Error("Connection error."))), "failed"],
			["reject 非 Error 值", withCore(() => Promise.reject("plain-string-failure")), "failed"],
			["同步 throw", () => { throw new Error("not initialized"); }, "failed"],
			["send 非函数（undefined）", undefined as never, "no-injector"],
		];
		for (const [label, send, expected] of cases) {
			assert.equal(await injectFollowUpQuietly(send, body), expected, `${label} ⇒ ${expected}`);
		}
		// 反面边界：含 "processing" 但非 "already processing" ⇒ failed（不误判为 busy）
		assert.equal(await injectFollowUpQuietly(withCore(() => Promise.reject(new Error("Still processing, retry later"))), body), "failed", "含 processing 但非 already processing ⇒ failed");
		ok(`H2 分类矩阵：${cases.length} 例 + 1 边界（busy/failed/failed/failed/failed/no-injector）`);
	}

	// ══ H3-P2①：A 快通道 —— 真 wrapper 下事件 A 失败/未确认，不得压制事件 B（长跑对照 §15）══
	{
		const rd = mkRunsDir("p2-fast");
		const dDir = join(rd, "delivery");
		const a = "run_p2_fast_a";
		const b = "run_p2_fast_b";
		linkAsync(a); linkAsync(b);
		const bytesA = writeRun(rd, a, NOW);
		const bytesB = writeRun(rd, b, NOW);

		// A：真宿主两级链（底层 reject ⇒ strict 档位下 unconfirmed，账本无 consumed）
		_resetAsyncResultWatcher();
		const hostA = makeRealHostSend(() => Promise.reject(new Error("Connection error.")));
		assert.equal(onRunFile(rd, `${a}.json`, { runsDir: rd, linksPath: LINKS, toast: false, autoInject: true, deliveryDir: dDir, sendUserMessage: hostA.send }), true, "A 被处理（派发者匹配）");
		await flush();

		// B：随后用正常通道 —— **必须仍被投递**（P2：A 的失败绝不全局压制）
		const sentB: string[] = [];
		assert.equal(onRunFile(rd, `${b}.json`, { runsDir: rd, linksPath: LINKS, toast: false, autoInject: true, deliveryDir: dDir, sendUserMessage: (c: string) => { sentB.push(c); return Promise.resolve(); } }), true, "B 必须仍被处理（P2 修复：无全局 selfDisabled）");
		await flush();
		assert.equal(sentB.length, 1, "**事件 B 仍被投递一次**（旧实现 selfDisabled ⇒ 此处 0）");
		assert.ok(sentB[0].includes(b), "B 的注入正文含 B 的 runId");
		assert.ok(!sentB[0].includes(a) || sentB[0].includes(b), "B 的正文属于 B");

		// A 侧如实：attempt 已记、consumed 为 0、trace 有 unconfirmed（strict）
		const evA = listEvents(dDir, 100).find((e) => e.runId === a);
		assert.ok(evA, "A 已建事件（可审计）");
		assert.equal(consumedAckCount(dDir, evA!.eventId), 0, "A **不得**写 consumed ACK（未进 context）");
		const trace = readFileSync(join(dDir, "trace.jsonl"), "utf8");
		assert.ok(trace.includes("C3-attempted-unconfirmed"), "A 路径记 attempted-unconfirmed（strict 档位如实留痕）");
		// ── 发现 2（R7/R8 实测发现，已修：`async-result-watcher.ts` 显式映射 `unconfirmed`）──
		// 修前生产形态落盘的 attempt.status 是 "no-injector"（三元链 else 吞掉 unconfirmed）
		// ⇒ 交付阶段退化为 retry_scheduled（而非 attempted）⇒ 租约 15s 后被 B 再投。
		const attemptA = listAttempts(dDir, evA!.eventId).at(-1)!;
		assert.equal(attemptA.status, "unconfirmed", "**发现 2 回归**：strict 未确认 ⇒ attempt.status=unconfirmed（不得写成 no-injector）");
		// 阶段证据必须含 `unconfirmed`（修前为 `no-injector`）—— 这是发现 2 的可观测回归点。
		// 注：阶段名 `retry_scheduled` 是账本的既有设计（非 sent 的 attempt 均可重投，重投由 B 通道
		// 按租约+阈值执行，见 `reconcileDecision`），本批**不改**阶段机；只修正 attempt.status 归因。
		const viewA = effectiveStage(evA!, [attemptA], [], Date.now());
		assert.ok(viewA.evidence.includes("unconfirmed"), `阶段证据含 unconfirmed（实得 ${viewA.evidence}）`);

		assert.ok(readFileSync(join(rd, `${a}.json`)).equals(bytesA), "① 原 run A 终态逐字节不变");
		assert.ok(readFileSync(join(rd, `${b}.json`)).equals(bytesB), "① 原 run B 终态逐字节不变");
		assert.equal(listEvents(dDir, 100).filter((e) => e.runId === a).length, 1, "② A 只有一个事件");
		assert.equal(listEvents(dDir, 100).filter((e) => e.runId === b).length, 1, "② B 只有一个事件");
		ok("H3-P2① 入口=onRunFile：真 wrapper 下 A 未确认，B 仍投递一次（无全局压制）");
	}

	// ══ H3-P2②：B 对账通道 —— 同一 pass 内 A 抛错，B 照投；A 失败 ≤75s 可见 ══
	{
		const rd = mkRunsDir("p2-b");
		const dDir = join(ROOT, "p2-b-delivery");
		const a = "run_p2_b_a";
		const b = "run_p2_b_b";
		const bytesA = writeRun(rd, a, NOW);
		const bytesB = writeRun(rd, b, NOW);
		const dispatcher = (r: string) => (r === a || r === b ? "sess_dispatch" : undefined);

		// 同一批：A 的 deliver 抛错（reject），B 正常 —— 一次 reconcileOnce 同时处理
		const delivered: string[] = [];
		const r1 = await reconcileOnce({
			runsDir: rd, deliverDir: dDir, now: NOW + 25_000, resolveDispatcher: dispatcher,
			deliver: (event: { runId: string }) => {
				if (event.runId === a) throw new Error("host injector exploded for A");
				delivered.push(event.runId);
				return "sent";
			},
		});
		assert.equal(r1.scanned >= 2, true, `一次 pass 扫到两个终态（实得 ${r1.scanned}）`);
		assert.deepEqual(delivered, [b], "**A 抛错不阻止 B 在同一 pass 内被投递**");
		assert.equal(r1.results.filter((x) => x.runId === a && x.action === "retry" && x.dispatched).length, 1, "A 记 retry（失败已被承接）");
		assert.equal(r1.results.filter((x) => x.runId === b && x.action === "retry").length, 1, "B 记 retry（正常）");

		// B 正常交付：接收端在 +26s 写 consumed（与 A 无关）。
		const evB = listEvents(dDir, 100).find((e) => e.runId === b)!;
		ackConsumed(dDir, [evB.eventId], { at: NOW + 26_000, evidence: "context-observed" });
		assert.equal(listAcks(dDir, evB.eventId).filter((x) => x.stage === "consumed").length, 1, "B 正常写 consumed（未被 A 压掉）");

		// A 的失败 ≤75s 可见：terminalAt+75s 内冻结为 failed_delivery + incident（不投递、不调模型）；B 已 consumed ⇒ 无 incident
		let modelsCalledAtFail = 0;
		const r2 = await reconcileOnce({
			runsDir: rd, deliverDir: dDir, now: NOW + 75_000, resolveDispatcher: dispatcher,
			deliver: () => { modelsCalledAtFail += 1; return "sent"; },
		});
		const failA = r2.results.filter((x) => x.runId === a && x.action === "fail_delivery");
		assert.equal(failA.length, 1, `A 在 terminalAt+75s 判 fail_delivery（≤75s 可见要求）`);
		assert.ok(failA[0].incidentId, "A 有 incidentId");
		assert.equal(modelsCalledAtFail, 0, "失败出口不调用模型（deliver 未被调）");
		assert.equal(r2.results.filter((x) => x.runId === b && x.action !== "none").length, 0, "**B 已 consumed ⇒ 无任何动作**");
		assert.equal(listOpenIncidents(dDir).filter((i) => i.runId === a).length, 1, "A 的 incident 恰好 1 条（未 ack ⇒ 可见）");
		assert.equal(listOpenIncidents(dDir).filter((i) => i.runId === b).length, 0, "**B 无 incident（未被 A 拖累）**");
		assert.equal(listAcks(dDir, evB.eventId).filter((x) => x.stage === "consumed").length, 1, "B 的 consumed 回执保持唯一");

		// 幂等重跑：不产生第二个 incident
		await reconcileOnce({ runsDir: rd, deliverDir: dDir, now: NOW + 80_000, resolveDispatcher: dispatcher });
		assert.equal(listOpenIncidents(dDir).filter((i) => i.runId === a).length, 1, "③ 重跑不产生第二个 incident");

		assert.ok(readFileSync(join(rd, `${a}.json`)).equals(bytesA), "① 原 run A 终态逐字节不变（failed_delivery 不改 run）");
		assert.ok(readFileSync(join(rd, `${b}.json`)).equals(bytesB), "① 原 run B 终态逐字节不变");
		assert.equal(listEvents(dDir, 100).filter((e) => e.runId === a).length, 1, "② A 只有一个事件");
		assert.equal(listEvents(dDir, 100).filter((e) => e.runId === b).length, 1, "② B 只有一个事件");
		ok("H3-P2② 入口=reconcileOnce：A 抛错不压制 B；A 在 +75s 内 incident 可见（不调模型）");
	}

	// ══ H4：接收端标记契约 —— 真链注入的正文可被 context 钩子提取（ACK 的唯一驱动）══
	{
		const ev = ensureEvent(join(ROOT, "h4-delivery"), {
			runId: "run_h4", terminalRevision: terminalRevisionOf({ id: "run_h4", status: "completed", endedAt: iso(NOW), result: { status: "completed", text: "ok" } }),
			terminalSnapshotPath: join(ROOT, "run_h4.json"), dispatcherSessionId: ME, observedAt: iso(NOW),
		}).event;
		const host = makeRealHostSend(() => Promise.resolve());
		const body = `⏱ async 完成\n${eventMarker(ev.eventId)}`;
		await injectFollowUpQuietly(host.send, body, { strict: true });
		assert.equal(consumedAckCount(join(ROOT, "h4-delivery"), ev.eventId), 0, "仅发送（返回值不可信）⇒ 无 consumed");
		// context 钩子看到的形态：消息文本含标记 ⇒ 才能写 consumed
		const ids = extractEventIdsFromMessages([{ role: "user", content: body }]);
		assert.deepEqual(ids, [ev.eventId], "正文标记可被 context 钩子检出（唯一 ACK 驱动）");
		ackConsumed(join(ROOT, "h4-delivery"), ids, { at: NOW + 1_000, evidence: "context-observed" });
		assert.equal(consumedAckCount(join(ROOT, "h4-delivery"), ev.eventId), 1, "进 context 后才写 consumed");
		ok("H4 标记契约：真链正文 → context 检出 → consumed（返回值不参与）");
	}

	console.log(`\n_test_delivery_host_contract: all ${n} groups passed`);
} finally {
	_resetAsyncResultWatcher();
	rmSync(ROOT, { recursive: true, force: true });
	rmSync(SESSIONS, { recursive: true, force: true });
}
