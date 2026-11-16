/**
 * 投递面只读观测（`/autonomy status` 的 P0-c，2026-11-10 gen14 排序第 1 步）。
 *
 * ## 为什么必须先做这件事
 *
 * 两类「消息静默到不了」的故障，在加观测之前**只能靠手工挖盘**才能看见：
 *
 * - **B 类**（2026-11-10 修）：补投地址写成 `pi://tab_xxx` ⇒ outbox-bridge 的
 *   `it.to === myAddress` 永不成立 ⇒ 项永停 `pending`，`events=0/attempts=0/acks=0`
 *   零痕迹。用户界面只显示「已提交等待注入」。
 * - **A 类**（未修）：`attempt.status=unconfirmed` + `injected` 收据存在，正文却没进会话
 *   ⇒ `consumed` ACK 永不产生 ⇒ 同一条每次重投撞同一堵墙。
 *
 * 两者都满足 R-17 / R-2 的形状：**在工作，但产物写到了没人读的地方**。
 * 在动 A 类（D3 会 grep 会话正文，风险更高）之前，先把**当前基线**变成可读数，
 * 否则改完之后无法判断「是变好了还是本来就没有」。
 *
 * ## 判据设计（每条都写明它证明什么、不证明什么）
 *
 * | 读数 | 证明 | **不**证明 |
 * |---|---|---|
 * | `pending` / `tab_` | 队列里有 N 项 / 其中 M 项地址是 tab 形态 | 不能说「送达失败」——bridge 还没取到而已 |
 * | `attempt` / `ack` | 账本文件数 | 不能说「有 attempt 就是投出去了」 |
 * | `attempt 无 ack` | 有事件既拿不到任何回执 | **不等于 A 类**：可能是目标进程刚重启、lease 还在 |
 *
 * ⇒ 本模块**只报计数与年龄**，不产生任何终态判断、不写盘、不触发重投。
 * 归因留给读它的人（同 R-11：单样本不得断言「异常」）。
 *
 * ## 性能（实测，2026-11-10）
 *
 * **只读文件名，不读 JSON 正文**：
 *   - 读 682 个 attempt JSON = **103.7ms**（`status` 每次执行都要付，不可接受）
 *   - 只 `readdir` + 切文件名 = **5.7ms**（2380 个文件）
 * 文件名形状由 `delivery-ledger.ts` 固定：
 *   `<eventKey>.attempt.<attemptId>.json` / `<eventKey>.ack.<stage>.<attemptId>.json`
 *   ⇒ 前缀切分即可拿到 eventKey，无需解析内容。
 *
 * 代价：拿不到 `attempt.status`（`unconfirmed` 与否）。这是**刻意的取舍** ——
 * 本模块报的是「有没有 attempt / 有没有 ack」这两个**文件名级**事实，
 * 而 `unconfirmed` 这类**内容级**判据留给专门的 A 类诊断（读 JSON）。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OutboxItem } from "./message-outbox.ts";
import { outboxDir } from "./message-outbox.ts";
import { deliveryDir } from "../delivery-ledger.ts";

export interface OutboxObservation {
	/** 目录是否可读（false ⇒ 下面所有数字都无意义） */
	readable: boolean;
	/** 全部条目数（含终态） */
	total: number;
	/** `status === "pending"` 的条数 */
	pending: number;
	/** pending 里 `to` 以 `pi://tab_` 开头的条数 —— B 类的**直接**指标 */
	pendingTabAddress: number;
	/** pending 里 `to` 不是 `pi://<uuid>` 形态的条数（含 tab_ / 空 / unknown / 测试假 id） */
	pendingNonUuidAddress: number;
	/** 最老 pending 项的年龄（ms）；无 pending ⇒ null */
	oldestPendingAgeMs: number | null;
	/** 读取失败的条目数（坏文件不阻塞统计） */
	unreadableItems: number;
}

export interface DeliveryObservation {
	readable: boolean;
	/** 事件本体文件数（不含 attempt/ack/incident 派生） */
	events: number;
	/** `<key>.attempt.` 派生文件数 */
	attempts: number;
	/** `<key>.ack.` 派生文件数 */
	acks: number;
	/** `<key>.incident.` 派生文件数 */
	incidents: number;
	/**
	 * **有 attempt 但一个 ack 都没有**的 eventKey 数。
	 *
	 * 注意这是**文件名级下界**，不是 A 类判据（见模块头「不证明」列）。
	 * 它把「零痕迹」变成「有痕迹但没回执」，是 A 类诊断的入口数字。
	 */
	attemptWithoutAnyAck: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 从 `to` 里取出会话 id 部分（`pi://<sid>`）；形态不对 ⇒ null。 */
export function sessionIdOfAddress(to: string | undefined): string | null {
	if (typeof to !== "string") return null;
	if (!to.startsWith("pi://")) return null;
	const sid = to.slice("pi://".length);
	return sid.length > 0 ? sid : null;
}

/** 该 outbox 地址是否**可被 bridge 匹配**（bridge 只认 `pi://<自己的真 UUID>`）。 */
export function isReachableOutboxAddress(to: string | undefined): boolean {
	const sid = sessionIdOfAddress(to);
	return sid !== null && UUID_RE.test(sid);
}

/**
 * 扫 outbox 目录（never-throw）。
 *
 * @param stateRoot `<runtimeDir>/state`（与 `outbox-bridge` 的 `defaultStateDir()` 同源）
 */
export function observeOutbox(stateRoot: string, now: number = Date.now()): OutboxObservation {
	const empty: OutboxObservation = {
		readable: false,
		total: 0,
		pending: 0,
		pendingTabAddress: 0,
		pendingNonUuidAddress: 0,
		oldestPendingAgeMs: null,
		unreadableItems: 0,
	};
	const dir = outboxDir(stateRoot);
	try {
		if (!existsSync(dir)) {
			// 目录不存在 = 从没有过消息，不是故障
			return { ...empty, readable: true };
		}
		const names = readdirSync(dir).filter((f) => f.endsWith(".json"));
		let total = 0;
		let pending = 0;
		let pendingTabAddress = 0;
		let pendingNonUuidAddress = 0;
		let oldest: number | null = null;
		let unreadable = 0;
		for (const name of names) {
			let item: OutboxItem;
			try {
				item = JSON.parse(readFileSync(join(dir, name), "utf8")) as OutboxItem;
			} catch {
				unreadable++;
				continue;
			}
			if (!item || typeof item !== "object") {
				unreadable++;
				continue;
			}
			total++;
			if (item.status !== "pending") continue;
			pending++;
			const to = typeof item.to === "string" ? item.to : "";
			if (to.startsWith("pi://tab_")) pendingTabAddress++;
			if (!isReachableOutboxAddress(to)) pendingNonUuidAddress++;
			const createdMs = typeof item.createdAt === "string" ? Date.parse(item.createdAt) : Number.NaN;
			if (Number.isFinite(createdMs)) {
				const age = Math.max(0, now - createdMs);
				if (oldest === null || age > oldest) oldest = age;
			}
		}
		return { readable: true, total, pending, pendingTabAddress, pendingNonUuidAddress, oldestPendingAgeMs: oldest, unreadableItems: unreadable };
	} catch {
		return empty;
	}
}

/** 从派生文件名里切出 eventKey（`<key>.attempt.…` / `<key>.ack.…` / `<key>.incident.…`）。 */
export function eventKeyOfDerivedFile(name: string): { key: string; kind: "attempt" | "ack" | "incident" } | null {
	const markers: Array<{ token: string; kind: "attempt" | "ack" | "incident" }> = [
		{ token: ".attempt.", kind: "attempt" },
		{ token: ".ack.", kind: "ack" },
		{ token: ".incident.", kind: "incident" },
	];
	for (const m of markers) {
		const i = name.indexOf(m.token);
		if (i > 0) return { key: name.slice(0, i), kind: m.kind };
	}
	return null;
}

/**
 * 扫交付账本目录（never-throw，只读文件名）。
 *
 * @param runtimeDir 缺省 `defaultRuntimeDir()`（调用方传 `deliveryDir()` 的结果亦可）
 */
export function observeDelivery(runtimeDir?: string): DeliveryObservation {
	const empty: DeliveryObservation = { readable: false, events: 0, attempts: 0, acks: 0, incidents: 0, attemptWithoutAnyAck: 0 };
	try {
		const dir = runtimeDir === undefined ? deliveryDir() : join(runtimeDir, "delivery");
		if (!existsSync(dir)) return { ...empty, readable: true };
		const names = readdirSync(dir).filter((f) => f.endsWith(".json"));
		let events = 0;
		let attempts = 0;
		let acks = 0;
		let incidents = 0;
		const attemptKeys = new Set<string>();
		const ackKeys = new Set<string>();
		for (const name of names) {
			const derived = eventKeyOfDerivedFile(name);
			if (derived === null) {
				events++;
				continue;
			}
			if (derived.kind === "attempt") {
				attempts++;
				attemptKeys.add(derived.key);
			} else if (derived.kind === "ack") {
				acks++;
				ackKeys.add(derived.key);
			} else {
				incidents++;
			}
		}
		let withoutAck = 0;
		for (const k of attemptKeys) if (!ackKeys.has(k)) withoutAck++;
		return { readable: true, events, attempts, acks, incidents, attemptWithoutAnyAck: withoutAck };
	} catch {
		return empty;
	}
}

/** 人可读年龄（与 `/autonomy status` 的 `ageTxt` 同口径，避免两处文案漂移）。 */
export function humanAge(ms: number): string {
	if (ms < 60_000) return `${Math.round(ms / 1000)}s 前`;
	if (ms < 3_600_000) return `${Math.round(ms / 60_000)}min 前`;
	return `${(ms / 3_600_000).toFixed(1)}h 前`;
}

/**
 * 渲染成 `/autonomy status` 的两行（纯函数，never-throw）。
 *
 * 每行都**显式写清判据**，因为 R-23 的教训：只给数字不给分母，读的人会自己编归因。
 */
export function deliveryObservationLines(opts: {
	outbox: OutboxObservation;
	delivery: DeliveryObservation;
}): string[] {
	const { outbox: o, delivery: d } = opts;
	const outboxLine = !o.readable
		? "outbox: (目录不可读)"
		: [
			`outbox: pending=${o.pending}/${o.total}（全部条目；pending 是最老 ${o.oldestPendingAgeMs === null ? "(无)" : humanAge(o.oldestPendingAgeMs)} 的未送达项）`,
			`其中 to=pi://tab_* : ${o.pendingTabAddress}${o.pendingTabAddress > 0 ? `（⚠️ bridge 只认 pi://<真 sessionId> ⇒ 这些**永不匹配**，是 B 类形状）` : ""}`,
			`其中 to 非 UUID 形态: ${o.pendingNonUuidAddress}（判据 = \`isReachableOutboxAddress\`）`,
			...(o.unreadableItems > 0 ? [`⚠️ 坏文件 ${o.unreadableItems} 个（计数已跳过它们，仍可能低估）`] : []),
		].join(" | ");
	const deliveryLine = !d.readable
		? "delivery: (目录不可读)"
		: [
			`delivery: events=${d.events} attempt=${d.attempts} ack=${d.acks} incident=${d.incidents}（文件数，含历史累计，非活跃数）`,
			`attempt 但一个 ack 都没有: ${d.attemptWithoutAnyAck}（⚠️ 这只是**文件名级下界**，不等于 A 类死锁：可能 lease 在飞、目标刚重启）`,
		].join(" | ");
	return [outboxLine, deliveryLine];
}
