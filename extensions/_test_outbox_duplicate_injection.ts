/**
 * _test_outbox_duplicate_injection.ts — 同一 outbox 消息**不会被注入两次**（端到端）
 *
 * ## 背景（2026-11-02 真机实测）
 *
 * 生产实测：同一封微信消息被注入会话**两次**。铁证（msg 30d8d06b）：
 * ```
 * 13:36:59.985  第一次注入（unconfirmed）
 * 13:47:05.301  claim 被重写（旧 claimedAt 已 stale，间隔 10min05s）
 * 13:47:05.306  第二次注入
 * ```
 * 根因：`outbox-bridge.ts` 的 `unconfirmed` 分支（生产形态恒落此分支，因为
 * `pi.sendUserMessage` 不返回值）**不调用 confirmInjection**，于是 `.claiming.json` 里
 * `claimedAt` 停在第一次注入时刻；`claimInjection` 的 `staleAfterMs` 恰好 10min，
 * 而 ACK 闭环的观察延迟实测 5～10min ⇒ 租约先过期 ⇒ 下一个 consumer 抢到 claim 再投一次。
 *
 * ## 判别力要求（重要：第一版写错了）
 *
 * **必须走 `consumeOutboxOnce()` 真实桥**。第一版直接调 `confirmInjection` 断言它有效 ——
 * 那把 `outbox-bridge.ts:375` 改成 `const confirmedUnconfirmed = true` 的变异打不红，
 * 因为测试根本没碰 bridge 的分支决策。测试要锁的是「**bridge 在 unconfirmed 时会 confirm**」，
 * 不是「confirm 函数本身有效」。
 *
 * 变异基准：`outbox-bridge.ts:375` 的 `confirmInjection(claimKey, holder)` → `true`
 * ⇒ A3 必须红。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "outbox-dup2-"));
process.env.PI_RUNTIME_DIR = ROOT;

import { consumeOutboxOnce } from "./outbox-bridge.ts";
import { defaultRuntimeDir } from "./runtime/journal.ts";
import {
	outboxDir,
	newOutboxItem,
	writeOutboxItem,
	readOutboxItem,
	outboxItemId,
} from "./runtime/message-outbox.ts";

let passed = 0;
const check = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
	try {
		await fn();
		passed += 1;
		console.log(`  ✓ ${name}`);
	} catch (e) {
		console.error(`  ✗ ${name}`);
		console.error(`    ${e instanceof Error ? e.message : String(e)}`);
		throw e;
	}
};

/** 冲刷微任务 + 一轮宏任务：让桥的 .then() 回写（含 confirmInjection）真正落盘。 */
const flush = async (): Promise<void> => {
	for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

const SID = "sess-dup-test";
const STATE = join(ROOT, "state");
const DIR = outboxDir(STATE);
const DELIVERY = join(ROOT, "delivery");
mkdirSync(DIR, { recursive: true });
mkdirSync(DELIVERY, { recursive: true });

/** 造一条 pending outbox 项，目标指向 SID。 */
function seed(key: string): string {
	const item = newOutboxItem({
		dedupeKey: `wechat:${key}`,
		commandKey: key,
		to: `pi://${SID}` as never,
		sessionId: SID,
		text: `msg-${key}`,
		now: new Date("2026-11-02T13:36:59.985Z"),
	});
	writeOutboxItem(DIR, item);
	return outboxItemId(`wechat:${key}`);
}

/**
 * 调一次真实桥。`sendUserMessage` 恒返 undefined —— 完全复刻生产形态
 * （两级 wrapper 均不 return）⇒ bridge 落 `unconfirmed` 分支。
 */
async function runBridge(atIso: string): Promise<{ injected: number }> {
	let injected = 0;
	consumeOutboxOnce({
		sessionId: SID,
		stateDir: STATE,
		deliveryDir: DELIVERY,
		sendUserMessage: (() => {
			injected += 1;
			// 生产形态：不 return ⇒ classifySendReturn 判 unconfirmed
		}) as never,
		now: new Date(atIso),
	});
	await flush(); // ← 关键：等 .then() 里的 confirmInjection 落盘
	return { injected };
}

try {
	console.log("\nA. unconfirmed 之后，桥不得再注入同一条");

	await check("A1 首轮：消息被注入恰好 1 次", async () => {
		seed("a1");
		const r = await runBridge("2026-11-02T13:36:59.985Z");
		assert.equal(r.injected, 1, `首轮应注入 1 次，实际 ${r.injected}`);
	});

	await check("A2 紧接着下一 tick：不得再注入", async () => {
		const r = await runBridge("2026-11-02T13:36:59.985Z");
		assert.equal(r.injected, 0, `次轮不应注入，实际 ${r.injected}`);
	});

	await check("A3 claim 被判 stale（真实 10min 过去）之后，仍不得重投", async () => {
		// 【关键】claimInjection 用的是**真实 Date.now()**，不读 opts.now。
		// 所以“模拟 10 分钟过去”必须篡改 .claiming.json 里的 claimedAt，
		// 单把 consumeOutboxOnce 的 now 往后推是无效的（我第一版就这么错）。
		//
		// 判别力：
		//   修复前：unconfirmed 不 confirm ⇒ claiming.json 残留 ⇒ 篡改 claimedAt 后必被判
		//           stale ⇒ 抢到 claim ⇒ 重投（injected=1）⇒ 红
		//   修复后：unconfirmed 已 confirm ⇒ 写 injected 收据 + 删 claiming
		//           ⇒ 这里根本找不到 claiming 文件；claimInjection 返回 injected-already
		//           ⇒ 不重投（injected=0）⇒ 绿
		const claimFile = join(defaultRuntimeDir(), "receipts", `outbox_${outboxItemId("wechat:a1")}.claiming.json`);
		let agedFile = false;
		try {
			const raw = JSON.parse(readFileSync(claimFile, "utf8")) as { claimedAt?: string };
			// 把 claimedAt 推到 20 分钟前 ⇒ 远超 staleAfterMs(10min)
			raw.claimedAt = new Date(Date.now() - 20 * 60_000).toISOString();
			writeFileSync(claimFile, JSON.stringify(raw), "utf8");
			agedFile = true;
		} catch {
			// 文件不存在 = 已被 confirmInjection 删除 = 修复生效的正常表现
		}
		const r = await runBridge("2026-11-02T13:56:59.985Z");
		assert.equal(
			r.injected,
			0,
			`claim stale 后不得重投（这是生产重复注入的直接机制）。` +
				`agedFile=${agedFile}（false = claiming 已被 confirm 删除，修复生效）`,
		);
	});

	console.log("\nB. 盘面核对（不只信计数值）");

	await check("B1 该项**仍是 pending**（delivered 只能由 ACK 写，不得伪造）", async () => {
		const it = readOutboxItem(DIR, outboxItemId("wechat:a1"));
		assert.ok(it !== null, "项应存在");
		assert.equal(
			it.status,
			"pending",
			`C-3 契约：unconfirmed 之后仍须 pending（delivered 归 ACK），实际 ${it.status}`,
		);
	});

	console.log("\nC. 与真实失败对照：unconfirmed 留 pending（可验收），failed 是终态（不重投）");

	await check("C1 抛异常走后，不得在同一 tick 重复注入", async () => {
		seed("c1");
		let calls = 0;
		const opts = {
			sessionId: SID,
			stateDir: STATE,
			deliveryDir: DELIVERY,
			sendUserMessage: (() => {
				calls += 1;
				throw new Error("inject-failed");
			}) as never,
			now: new Date("2026-11-02T14:00:00.000Z"),
		};
		consumeOutboxOnce(opts as never);
		assert.equal(calls, 1, `单次消费应只尝试注入 1 次，实际 ${calls}`);
		// 注：抛异常走 catch 分支，**不写终态**（有意的 fail-open：不因异常永久丢失消息，
		// 留给 TTL expired 或后续 tick 重试）。这里只锁「不在同一轮爆破多次」。
	});

	await check("C2 与 A 组对照：unconfirmed 留 pending（而不是被判已交付）", async () => {
		const a1 = readOutboxItem(DIR, outboxItemId("wechat:a1"));
		assert.equal(a1?.status, "pending", "unconfirmed 应留 pending 等 ACK");
		// C-3 契约的正面证据：delivered 只在 consumed ACK 闭环里写。
		// 本测试全程没有真 ACK ⇒ 永远不可能出现 delivered。
		assert.notEqual(a1?.status, "delivered", "无 ACK 时不得写 delivered（防伪造）");
	});

	console.log(`\n_test_outbox_duplicate_injection: ${passed} checks passed`);
} finally {
	rmSync(ROOT, { recursive: true, force: true });
}
