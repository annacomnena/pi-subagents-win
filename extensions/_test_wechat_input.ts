/**
 * W2 微信输入注入 · 离线单测（临时目录，绝不碰真实 ~/.pi/agent/runtime）
 *
 * 覆盖（规格 plans/0924_wechat_input_w2_spec.md §4 + L4 复核 4 项 must-fix）：
 *   T1 缺省零行为（disabled → 无 state 目录/无 outbox/无审计）
 *   T2 MF2：白名单外 → denied + 记录标 rejected（终态，不重复审计/不重复选中）
 *   T3 白名单内 + master 活 → 注入成功（outbox 一条、记录 injected、审计 accepted）
 *   T4 幂等：同 msgId 重放不再注入
 *   T5 MF1：非 BMP msgId（emoji）→ 状态更新必须落到 store 读取的同一文件（恰好一条且 injected）
 *   T6 master-offline → 不注入且记录仍 pending（可恢复）
 *   T7 owner generation 变化 → 放弃且记录仍 pending
 *   T8 单条一次批：3 条 pending 一次调用只注入 1 条（取最早）
 *   T9 MF3：注入正文不含不可信昵称，只含脱敏 id
 *   T10 MF4：自定义 timersDir 仍能判活；自定义 stateDir 时 outbox 落在该根
 *   T11 秘密卫生：审计/outbox 不含正文哨兵、完整 openid、token 哨兵
 *
 * 硬看门狗（EB-004）：超时即非零退出，绝不让进程挂住。
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WechatStore, type InboundRecord } from "./channel-wechat/store.ts";
import { tryInjectPending } from "./runtime-host/wechat-input.ts";
import { listOutboxItems } from "./runtime/message-outbox.ts";
import { touchSessionHeartbeat, sessionAlive } from "./timers.ts";

const WATCHDOG_MS = 180_000;
const watchdog = setTimeout(() => {
	console.error(`\n[watchdog] 超过 ${WATCHDOG_MS}ms 未结束 —— 判定卡死并强制退出（exit 3）`);
	process.exit(3);
}, WATCHDOG_MS);
watchdog.unref?.();

const ALLOWED = "openid-allowed-sentinel";
const OTHER = "openid-other-sentinel";
const BODY = "BODY_SENTINEL";
const NICK = "NICKNAME_UNTRUSTED";
const TOKEN = "token-sentinel";

let passed = 0;
const failures: string[] = [];
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
	try {
		await fn();
		passed += 1;
		console.log(`  ok  ${name}`);
	} catch (e) {
		failures.push(name);
		console.error(`  FAIL ${name}\n       ${e instanceof Error ? e.message : String(e)}`);
	}
}

interface Ctx {
	root: string;
	rt: string;
	timers: string;
	cfg: string;
	store: WechatStore;
	add: (msgId: string, fromId?: string, receivedAt?: string) => void;
	base: Parameters<typeof tryInjectPending>[0];
	outboxDirPath: string;
	auditPath: string;
	auditLines: () => string[];
	outbox: () => { text: string }[];
	owner: { agentAddress: `pi://${string}`; sessionId: string; generation: number; attachedAt: string; lastHeartbeatAt: string; attemptId: string };
}

function makeCtx(tag: string): Ctx {
	const root = mkdtempSync(join(tmpdir(), `wechat-w2-${tag}-`));
	const rt = join(root, "runtime");
	const timers = join(root, "timers");
	const cfg = join(root, "config.json");
	const store = new WechatStore(WechatStore.resolveDir(rt));
	const add = (msgId: string, fromId = ALLOWED, receivedAt = msgId): void => {
		store.putInbox({ msgId, fromId, fromNickname: NICK, text: BODY, receivedAt, state: "pending" });
	};
	const owner = {
		agentAddress: "pi://master" as `pi://${string}`,
		sessionId: "owner-session-123",
		generation: 1,
		attachedAt: "",
		lastHeartbeatAt: "",
		attemptId: "",
	};
	const outboxDirPath = join(rt, "state", "message-outbox");
	const auditPath = join(rt, "state", "wechat-input-audit.jsonl");
	return {
		root,
		rt,
		timers,
		cfg,
		store,
		add,
		owner,
		outboxDirPath,
		auditPath,
		auditLines: () => {
			try {
				return readFileSync(auditPath, "utf8").split("\n").filter((l) => l.trim() !== "");
			} catch {
				return [];
			}
		},
		outbox: () => listOutboxItems(outboxDirPath) as unknown as { text: string }[],
		base: { runtimeDir: rt, configPath: cfg, timersDir: timers, stateDir: join(rt, "state"), readOwner: () => owner, alive: () => true },
	};
}

function setConfig(cfg: string, enabled: boolean, allowFrom: string[]): void {
	writeFileSync(cfg, JSON.stringify({ channels: { wechat: { input: { enabled, allowFrom } } } }));
}

const contexts: Ctx[] = [];
function ctx(tag: string): Ctx {
	const c = makeCtx(tag);
	contexts.push(c);
	return c;
}

const t0 = Date.now();
console.log("wechat-input W2 离线单测（临时 runtimeDir；规格 §4 + L4 四项 must-fix）：");
try {
	await check("T1 缺省零行为：disabled → 不注入/不建 state 目录/无 outbox", () => {
		const c = ctx("t1");
		c.add("m1");
		writeFileSync(c.cfg, JSON.stringify({}));
		const r = tryInjectPending(c.base);
		assert.equal(r.injected, false);
		assert.equal(r.reason, "disabled");
		assert.equal(c.outbox().length, 0, "无 outbox 条目");
		assert.equal(existsSync(join(c.rt, "state")), false, "未创建 state 目录");
		assert.equal(c.auditLines().length, 0, "无审计行");
	});

	await check("T2 MF2：白名单外 → denied + 记录终态 rejected（不重复审计/不重复选中）", () => {
		const c = ctx("t2");
		c.add("m1", OTHER, "2020-01-01T00:00:01.000Z");
		setConfig(c.cfg, true, [ALLOWED]);
		const r1 = tryInjectPending(c.base);
		assert.equal(r1.reason, "not-allowlisted");
		assert.equal(c.store.readInbox(0).find((x: InboundRecord) => x.msgId === "m1")?.state, "rejected", "denied 记录标 rejected");
		const n1 = c.auditLines().length;
		const r2 = tryInjectPending(c.base);
		assert.equal(r2.reason, "empty", "终态记录不再被选中");
		assert.equal(c.auditLines().length, n1, "审计不再增长");
		assert.equal(c.outbox().length, 0);
	});

	await check("T3 白名单内 + master 活 → 注入成功（outbox 一条 / 记录 injected / 审计 accepted）", () => {
		const c = ctx("t3");
		c.add("m1", ALLOWED, "2020-01-01T00:00:01.000Z");
		setConfig(c.cfg, true, [ALLOWED]);
		touchSessionHeartbeat(c.timers, c.owner.sessionId);
		const r = tryInjectPending(c.base);
		assert.equal(r.injected, true);
		const items = c.outbox();
		assert.equal(items.length, 1);
		assert.equal(c.store.readInbox(0).find((x: InboundRecord) => x.msgId === "m1")?.state, "injected");
		const last = c.auditLines().at(-1) ?? "";
		assert.ok(last.includes('"accepted"'), `审计末行应为 accepted：${last}`);
	});

	await check("T4 幂等：同 msgId 重放不再注入", () => {
		const c = ctx("t4");
		c.add("m1", ALLOWED, "2020-01-01T00:00:01.000Z");
		setConfig(c.cfg, true, [ALLOWED]);
		touchSessionHeartbeat(c.timers, c.owner.sessionId);
		assert.equal(tryInjectPending(c.base).injected, true);
		assert.equal(tryInjectPending(c.base).injected, false, "第二次不再注入");
		assert.equal(c.outbox().length, 1, "outbox 仍 1 条");
	});

	await check("T5 MF1：非 BMP msgId（emoji）→ 状态落到 store 读取的同一文件（恰好一条且 injected）", () => {
		const c = ctx("t5");
		const emojiId = "msg😀1";
		c.add(emojiId, ALLOWED, "2020-01-01T00:00:01.000Z");
		setConfig(c.cfg, true, [ALLOWED]);
		touchSessionHeartbeat(c.timers, c.owner.sessionId);
		assert.equal(tryInjectPending(c.base).injected, true);
		const hit = c.store.readInbox(0).filter((x: InboundRecord) => x.msgId === emojiId);
		assert.equal(hit.length, 1, `emoji msgId 必须恰好一条 inbox 记录（实测 ${hit.length}，>1 即命名分歧导致重复注入）`);
		assert.equal(hit[0]?.state, "injected", "emoji msgId 的状态更新必须可见（否则每 tick 重复注入）");
		assert.equal(tryInjectPending(c.base).injected, false, "重放不再注入");
	});

	await check("T6 master-offline → 不注入且记录仍 pending（可恢复）", () => {
		const c = ctx("t6");
		c.add("m1", ALLOWED, "2020-01-01T00:00:01.000Z");
		setConfig(c.cfg, true, [ALLOWED]);
		const r = tryInjectPending({ ...c.base, alive: () => false });
		assert.equal(r.reason, "master-offline");
		assert.equal(c.store.readInbox(0)[0]?.state, "pending", "离线不改变记录状态");
		assert.equal(c.outbox().length, 0);
	});

	await check("T7 owner generation 变化 → 放弃且记录仍 pending", () => {
		const c = ctx("t7");
		c.add("m1", ALLOWED, "2020-01-01T00:00:01.000Z");
		setConfig(c.cfg, true, [ALLOWED]);
		touchSessionHeartbeat(c.timers, c.owner.sessionId);
		let n = 0;
		const readOwner = (): Ctx["owner"] => {
			n += 1;
			return n === 1 ? c.owner : { ...c.owner, generation: 2 };
		};
		const r = tryInjectPending({ ...c.base, readOwner });
		assert.equal(r.reason, "owner-changed");
		assert.equal(c.store.readInbox(0)[0]?.state, "pending");
		assert.equal(c.outbox().length, 0);
	});

	await check("T8 单条一次批：3 条 pending 一次调用只注入 1 条（取最早）", () => {
		const c = ctx("t8");
		c.add("late", ALLOWED, "2020-01-01T00:00:03.000Z");
		c.add("early", ALLOWED, "2020-01-01T00:00:01.000Z");
		c.add("mid", ALLOWED, "2020-01-01T00:00:02.000Z");
		setConfig(c.cfg, true, [ALLOWED]);
		touchSessionHeartbeat(c.timers, c.owner.sessionId);
		assert.equal(tryInjectPending(c.base).injected, true);
		assert.equal(c.outbox().length, 1, "一次调用只注入一条");
		assert.equal(c.store.readInbox(0).find((x: InboundRecord) => x.msgId === "early")?.state, "injected", "注入的是最早那条");
		assert.equal(c.store.readInbox(0).filter((x: InboundRecord) => x.state === "pending").length, 2);
	});

	await check("T9 MF3：注入正文不含不可信昵称，只含脱敏 id", () => {
		const c = ctx("t9");
		c.add("m1", ALLOWED, "2020-01-01T00:00:01.000Z");
		setConfig(c.cfg, true, [ALLOWED]);
		touchSessionHeartbeat(c.timers, c.owner.sessionId);
		assert.equal(tryInjectPending(c.base).injected, true);
		const text = c.outbox()[0]?.text ?? "";
		// L4 收敛轮：原断言偏弱（`!includes(NICK)` + 形态推断）。改为**精确等值**：
		// 规格要求正文 = `[微信 <脱敏 id>] <原文>`，mask 口径 = 前6…后4（长度>10）。
		assert.equal(text, `[微信 openid…inel] ${BODY}`, "正文必须精确等于 `[微信 <脱敏 id>] <原文>`");
		assert.ok(!text.includes(NICK), `注入正文不得含原始昵称：${text}`);
		assert.ok(text.includes(BODY), "正文必须保留消息原文");
	});

	await check("T10 MF4：自定义 timersDir 仍能判活；自定义 stateDir 时 outbox 落在该根", () => {
		const c = ctx("t10");
		const customTimers = join(c.root, "custom-timers");
		const customState = join(c.root, "custom-state");
		c.add("m1", ALLOWED, "2020-01-01T00:00:01.000Z");
		setConfig(c.cfg, true, [ALLOWED]);
		touchSessionHeartbeat(customTimers, c.owner.sessionId);
		// L4 收敛轮：原用 `alive: () => true` 恒真桩 —— 是**自证式**断言（根本不证明 timersDir 被消费）。
		// 改为传入**真实 sessionAlive**：心跳只写入 customTimers，能注入才证明 timersDir 确被使用。
		const r = tryInjectPending({ ...c.base, timersDir: customTimers, stateDir: customState, alive: sessionAlive });
		assert.equal(r.injected, true, "自定义 timersDir 下必须能判活（否则注入门静默失效）");
		assert.equal(listOutboxItems(join(customState, "message-outbox")).length, 1, "outbox 必须落在传入的 stateDir 根");
		// 反向：心跳不在传入的 timersDir 里 → 必须 fail-closed（证明上一行不是运气）
		c.add("m2", ALLOWED, "2020-01-01T00:00:02.000Z");
		const r2 = tryInjectPending({ ...c.base, timersDir: join(c.root, "empty-timers"), stateDir: customState, alive: sessionAlive });
		assert.equal(r2.reason, "master-offline", "心跳不在该 timersDir 时必须 fail-closed");
	});

	await check("T11 秘密卫生：审计/outbox 不含正文哨兵、完整 openid、token 哨兵", () => {
		const c = ctx("t11");
		c.add("m1", ALLOWED, "2020-01-01T00:00:01.000Z");
		c.add("m2", OTHER, "2020-01-01T00:00:02.000Z");
		setConfig(c.cfg, true, [ALLOWED]);
		touchSessionHeartbeat(c.timers, c.owner.sessionId);
		tryInjectPending(c.base);
		tryInjectPending(c.base);
		const audit = c.auditLines().join("\n");
		assert.ok(!audit.includes(BODY), "审计不得含正文");
		assert.ok(!audit.includes(ALLOWED), "审计不得含完整 openid");
		assert.ok(!audit.includes(TOKEN), "审计不得含 token");
		assert.ok(!audit.includes(NICK), "审计不得含原始昵称");
		const outboxText = c.outbox().map((i) => i.text).join("\n");
		assert.ok(!outboxText.includes(ALLOWED), "outbox 正文不得含完整 openid");
		assert.ok(!outboxText.includes(TOKEN));
	});

	await check("T13 写失败 → uncertain：记录标 rejected + 审计 uncertain（不自动重试）", () => {
		const c = ctx("t13");
		c.add("m1", ALLOWED, "2020-01-01T00:00:01.000Z");
		setConfig(c.cfg, true, [ALLOWED]);
		touchSessionHeartbeat(c.timers, c.owner.sessionId);
		// 让 outbox 落盘必失败：把传入的 stateDir 占位成一个**同名文件**（mkdirSync(join(stateDir,"message-outbox")) 必抛）
		// 注意：不能堵 `<rt>/state`——审计也写在那棵树（会连审计一起堵掉，断言就失去意义）。
		const blocked = join(c.rt, "blocked-state");
		writeFileSync(blocked, "occupied", "utf8");
		const r = tryInjectPending({ ...c.base, stateDir: blocked });
		assert.equal(r.reason, "uncertain", "落盘失败必须报 uncertain");
		assert.equal(r.injected, false);
		assert.equal(c.store.readInbox(0)[0]?.state, "rejected", "失败记录标 rejected（不自动重试）");
		const last = c.auditLines().at(-1) ?? "";
		assert.ok(last.includes('"uncertain"'), `审计末行应为 uncertain：${last}`);
	});

	// 目录内容整体卫生：临时根下不得出现任何含 token 哨兵的文件
	const walk = (dir: string, out: string[] = []): string[] => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, e.name);
			if (e.isDirectory()) walk(p, out);
			else out.push(p);
		}
		return out;
	};
	await check("T12 秘密卫生（文件面）：所有临时产物不含 token 哨兵", () => {
		for (const c of contexts) {
			for (const f of walk(c.root)) {
				let raw = "";
				try {
					raw = readFileSync(f, "utf8");
				} catch {
					continue;
				}
				assert.ok(!raw.includes(TOKEN), `${f} 含 token 哨兵`);
			}
		}
	});
} catch (e) {
	console.error(`主流程异常: ${e instanceof Error ? e.stack : String(e)}`);
	process.exitCode = 1;
} finally {
	for (const c of contexts) {
		try {
			rmSync(c.root, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
}

if (failures.length > 0) {
	console.error(`\n${failures.length} 项失败: ${failures.join(" | ")}`);
	process.exitCode = 1;
} else {
	console.log(`\n全部通过（${passed} 组断言块，${Date.now() - t0}ms）`);
}
