/**
 * _test_incident_visibility.ts — 交付失败账本的「可见面 + 显式 ack」回归门（2026-10-21，Item 53 未决项）
 *
 * ## 为什么需要这道门
 * 实测取证（2026-10-21）：`ackIncident` / `listOpenIncidents` **全仓零调用**，106 条 incident
 * 积压至今（ack 数 0，最旧 4.8 天，91/106 > 1 天）。设计声称「incident 是 durable 可见出口，
 * 显式 ack 才清」，但**既无可见面也无 ack 入口** ⇒ 有状态、无出口 = AGENTS R-2 静默失效。
 *
 * 这道门钉住三件事：
 *   V1 只读可见面：`buildIncidentsView` / health `delivery` 段有读数，且**带年龄**（R-2.2）
 *   V2 显式 ack 语义：ack 后消失、幂等、**不自动 ack**
 *   V3 缓存正确性：缓存命中时年龄**不得变年轻**（这是最容易写错的一处）
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIncidentsView, buildHealthView, DELIVERY_INCIDENT_STALE_MS } from "./runtime-host/server.ts";
import { ackIncident, publishIncident, ensureEvent, deliveryDir } from "./delivery-ledger.ts";

let n = 0;
const ok = (m: string): void => {
	n++;
	console.log(`ok ${n} - ${m}`);
};

const HOST = { pid: 1, port: 1, startedAt: "2026-01-01T00:00:00.000Z", instanceId: "test" } as never;
const mk = (): string => mkdtempSync(join(tmpdir(), "inc-vis-"));

/** 造一个 incident 文件（形状与 `publishIncident` 一致 —— 含文件名 key 规则）。
 *
 * R-4 教训：首版用了扁平文件名 `ev.incident.<id>.json`，而真实形状是
 * `${encodeURIComponent(eventId)}.incident.${incidentId}.json`（`delivery-ledger.ts:450`）；
 * ackIncident 按 eventId 拼路径 ⇒ 夹具不真实会误判实现有 bug。
 */
function seedIncident(runtimeDir: string, id: string, createdAtMs: number, acked = false): void {
	const dir = deliveryDir(runtimeDir);
	mkdirSync(dir, { recursive: true });
	const eventId = `async:${id}`;
	const inc = {
		incidentId: id,
		eventId,
		runId: `run_${id}`,
		reason: "deadline-exceeded(deadline=x,stage=attempted)",
		createdAt: new Date(createdAtMs).toISOString(),
		...(acked ? { ackedAt: new Date(createdAtMs + 1000).toISOString(), ackedBy: "t" } : {}),
	};
	writeFileSync(join(dir, `${encodeURIComponent(eventId)}.incident.${id}.json`), JSON.stringify(inc));
}

// ── V1 只读可见面：带年龄（R-2.2）────────────────────────────────
{
	const rt = mk();
	const now = Date.now();
	seedIncident(rt, "inc_old", now - 5 * 3600_000); // 5 小时前
	seedIncident(rt, "inc_new", now - 60_000); // 1 分钟前
	seedIncident(rt, "inc_acked", now - 9 * 3600_000, true); // 已 ack，不应计入

	const v = buildIncidentsView(new Date(now), rt);
	assert.equal(v.openCount, 2, "只计未 ack（已 ack 的必须排除）");
	assert.ok(!v.items.some((i) => i.incidentId === "inc_acked"), "已 ack 不出现在列表");
	// 按年龄降序：最旧在前
	assert.equal(v.items[0]!.incidentId, "inc_old", "最旧排最前");
	assert.ok(v.items[0]!.ageMs >= 5 * 3600_000 - 5000, `最旧年龄 ≈5h（实际 ${v.items[0]!.ageMs}）`);
	assert.ok(v.items.every((i) => typeof i.ageMs === "number" && i.ageMs >= 0), "每条都给年龄（不是只给绝对时间）");

	const h = buildHealthView({ host: HOST, runtimeDir: rt } as never);
	assert.equal(h.delivery.openIncidents, 2, "health.delivery.openIncidents 与列表同源");
	assert.equal(h.delivery.stale, true, "最旧 5h > 1h 阈值 ⇒ stale=true");
	assert.equal(h.delivery.byReason["deadline-exceeded"], 2, "byReason 分组");
	assert.ok(h.delivery.sampledAt.length > 0, "sampledAt 必给（读的人要知道读数年龄）");
	ok("V1 可见面：只读 + 排除已 ack + 带年龄 + stale 判据 + byReason");
}

// ── V2 显式 ack：ack 后消失、幂等、不自动清除 ────────────────────
{
	const rt = mk();
	const now = Date.now();
	seedIncident(rt, "inc_a", now - 3600_000);
	const dir = deliveryDir(rt);
	assert.equal(buildIncidentsView(new Date(now), rt).openCount, 1, "ack 前 1 条");

	// 幂等：第一次 true，第二次 false（不报错）
	assert.equal(ackIncident(dir, "inc_a", "t", now), true, "首次 ack 生效");
	assert.equal(ackIncident(dir, "inc_a", "t", now), false, "重复 ack 幂等（false 而非抛错）");
	assert.equal(ackIncident(dir, "inc_nope", "t", now), false, "ack 不存在的 id ⇒ false 不抛");

	assert.equal(buildIncidentsView(new Date(now), rt).openCount, 0, "ack 后从列表消失");
	assert.equal(buildHealthView({ host: HOST, runtimeDir: rt } as never).delivery.openIncidents, 0, "health 计数同步 -1");

	// durable：重新读盘（模拟重启）仍是已 ack
	const raw = JSON.parse(readFileSync(join(dir, `${encodeURIComponent("async:inc_a")}.incident.inc_a.json`), "utf8")) as { ackedAt?: string };
	assert.ok(typeof raw.ackedAt === "string", "ackedAt 落盘（跨重启保留）");
	ok("V2 显式 ack：生效 + 幂等 + durable + 不误删文件");
}

// ── V3 年龄单调性：读数年龄必须随 now 增长（R-2.2）──────────────
// 注：本实现在**无缓存**直扫路径上（实测 7.1ms/106 条，低于 health 基线 17ms），
// 所以年龄天然按 now 计算。本组钉住这一点：若将来有人加了缓存「忘了补偿 now」，
// 年龄会停在写入时刻（读数变年轻）⇒ 本组必红。
{
	const rt = mk();
	const base = Date.now() - 2 * 3600_000;
	seedIncident(rt, "inc_c", base);

	const t0 = new Date(base + 2 * 3600_000); // 造出时：年龄 2h
	const v0 = buildIncidentsView(t0, rt);
	assert.equal(v0.openCount, 1);

	const h1 = buildHealthView({ host: HOST, runtimeDir: rt, now: t0 } as never);
	const h2 = buildHealthView({ host: HOST, runtimeDir: rt, now: new Date(t0.getTime() + 10 * 60_000) } as never);
	assert.ok(
		h2.delivery.oldestAgeMs! > h1.delivery.oldestAgeMs!,
		`年龄必须随 now 增长（h1=${h1.delivery.oldestAgeMs} h2=${h2.delivery.oldestAgeMs}）— 若有人加缓存不补偿 now，此处会红`,
	);
	const grew = h2.delivery.oldestAgeMs! - h1.delivery.oldestAgeMs!;
	assert.ok(grew >= 9.9 * 60_000, `增量应 ≈10min（实际 ${(grew / 60000).toFixed(1)}min）`);

	// 反向断言（首版真 bug）：**同一目录连续两次读，中间发生 ack，第二次必须看到变化**
	// 首版缓存把「TTL 未到」当成「可复用」⇒ ack 后计数不降（实测 2 !== 0）
	const before = buildHealthView({ host: HOST, runtimeDir: rt, now: t0 } as never).delivery.openIncidents;
	ackIncident(deliveryDir(rt), "inc_c", "t", t0.getTime() + 1000);
	try {
		const after = buildHealthView({ host: HOST, runtimeDir: rt, now: t0 } as never).delivery.openIncidents;
		assert.equal(after, before - 1, "ack 后紧接一次 health 读必须看到计数下降（不得被陈旧缓存遮住）");
	} finally {
		/* ack 已落盘，该临时目录不重用 */
	}
	ok("V3 年龄单调性 + ack 后立即可见（陈旧缓存回归门）");
}

// ── V4 阈值边界：stale 判据用常量而非硬编码 ─────────────────────
{
	const rt = mk();
	const now = Date.now();
	seedIncident(rt, "inc_edge", now - DELIVERY_INCIDENT_STALE_MS - 60_000); // 刚超阈值
	assert.equal(buildHealthView({ host: HOST, runtimeDir: rt, now: new Date(now) } as never).delivery.stale, true, "超阈值 ⇒ stale");

	const rt2 = mk();
	seedIncident(rt2, "inc_young", now - 60_000); // 1 分钟
	assert.equal(buildHealthView({ host: HOST, runtimeDir: rt2, now: new Date(now) } as never).delivery.stale, false, "未超阈值 ⇒ 不误报");
	ok("V4 阈值边界：超阈值 stale=true / 未超不误报");
}

// ── V5 空目录 / 不存在目录 ⇒ never-throw ────────────────────────
{
	const empty = mk();
	const h = buildHealthView({ host: HOST, runtimeDir: empty } as never);
	assert.equal(h.delivery.openIncidents, 0);
	assert.equal(h.delivery.oldestAgeMs, null, "无 incident ⇒ oldestAgeMs=null（不编造 0）");
	assert.equal(h.delivery.stale, false, "无 incident ⇒ 不误报 stale");
	assert.equal(buildIncidentsView(new Date(), empty).openCount, 0);
	// 完全不存在 delivery 目录
	const missing = join(mk(), "nope");
	assert.equal(buildIncidentsView(new Date(), missing).openCount, 0, "目录不存在 ⇒ 0，不抛");
	ok("V5 never-throw：空目录/不存在目录均安全（null 不编造 0）");
}

// ── V6 真实性：publishIncident 产出的真实形状能被读到 ──────────────
{
	const rt = mk();
	const dir = deliveryDir(rt);
	mkdirSync(dir, { recursive: true });
	const now = Date.now();
	// 走真实 ensureEvent + publishIncident（不是手工造 JSON）
	const ev = ensureEvent(dir, {
		runId: "run_real",
		terminalRevision: "abc123",
		terminalSnapshotPath: "/tmp/x.json",
		dispatcherSessionId: "sess_1",
		observedAt: new Date(now - 7200_000).toISOString(),
	});
	const inc = publishIncident(dir, ev.event, "deadline-exceeded(stage=attempted)", now);
	const v = buildIncidentsView(new Date(now), rt);
	assert.equal(v.openCount, 1, "真实 publishIncident 产出可被可见面读到");
	assert.equal(v.items[0]!.incidentId, inc.incidentId, "id 一致");
	assert.equal(v.items[0]!.runId, "run_real", "runId 来自真实事件");
	// L4 NIT（2026-10-21）：首版写的是 `existsSync(join(dir, incidentId)) || true` ——
	// 恒真、什么也没测（而且路径本身就是错的，文件名不是裸 incidentId）。
	// 改成：按**真实文件名规则**断言落盘文件存在，且能被 ack 成功。
	const realFile = join(dir, `${encodeURIComponent(inc.eventId)}.incident.${inc.incidentId}.json`);
	assert.equal(existsSync(realFile), true, `incident 按真实命名规则落盘（${inc.eventId} → ${inc.incidentId}）`);
	assert.equal(ackIncident(dir, inc.incidentId, "t", now), true, "真实产出的 incident 可被 ack（接线双向通）");
	assert.equal(buildIncidentsView(new Date(now), rt).openCount, 0, "ack 后真实 incident 从可见面消失");
	ok("V6 真实入口：ensureEvent→publishIncident 产出的 incident 能被 buildIncidentsView 读到");
}

console.log(`\n_test_incident_visibility: all assertions passed (${n} groups)`);
