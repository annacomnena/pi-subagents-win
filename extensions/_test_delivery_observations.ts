/**
 * P0-c 回归网（2026-11-10 gen14：「D3 落地前先把两类观测接进 `/autonomy status`，
 * 零风险，先做拿基线」）—— `runtime/delivery-observations.ts` + `status-body.ts` 接线。
 *
 * ## 这套测试要防的具体错误
 *
 * ① **口径错**：`pending` 数必须只数 `status==="pending"`，不能把 `delivered` 算进去
 *   （存量实测 delivered 409 / expired 36 / failed 5 —— 数错会让读数看起来「严重 400 倍」）。
 * ② **B 类指标漏判**：`to=pi://tab_*` 必须**单独**计数，不能混进「非 UUID」总数
 *   （兼容 `test-parallel-async` 这类假 id 也在「非 UUID」里，两者处置不同）。
 * ③ **性能退化为读 JSON**：`observeDelivery` 只读**文件名**。实测读 682 个 attempt JSON
 *   = 103.7ms，只 readdir + 切名 = 5.7ms。⇒ 测试断言**不读正文**：放一个内容损坏的
 *   attempt 文件，读数必须仍然正确（若实现改成读 JSON，坏文件会被跳过/报错 ⇒ 数量变）。
 * ④ **接线没上**：只测函数不测 `buildAutonomyStatusBody()` = 假绿（R-4 教训：
 *   测试直接调内部函数会绕开真实注册线）。⇒ ①-③ 测纯函数，⑤⑥ 走**真实 status body**。
 * ⑤ **never-throw**：目录不存在 / 是文件 / 权限不可读 ⇒ 必须给 `readable:false`，不得抛。
 * ⑥ **「不证明」的文案必须真的写在输出里**（R-23：只给数字会让人自己编归因）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "deliv-obs-"));
const runtimeDir = join(root, "runtime");
const stateDir = join(runtimeDir, "state");
const outboxDirPath = join(stateDir, "message-outbox");
const deliveryDirPath = join(runtimeDir, "delivery");
const autonomyDir = join(stateDir, "autonomy");
for (const d of [outboxDirPath, deliveryDirPath, autonomyDir, join(runtimeDir, "registry", "attachments")]) {
	mkdirSync(d, { recursive: true });
}
process.env.PI_RUNTIME_DIR = runtimeDir;

const obs = await import("./runtime/delivery-observations.ts");
const { buildAutonomyStatusBody } = await import("./runtime/autonomy/status-body.ts");

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void) => {
	try {
		fn();
		pass++;
		console.log(`  ok ${pass} - ${name}`);
	} catch (e) {
		fail++;
		console.log(`  NOT OK ${pass + fail} - ${name}`);
		console.log(`    ${e instanceof Error ? e.message : String(e)}`);
	}
};

// ── 夹具：写一条 outbox 项（形状对齐真实盘面）──────────────────────
const UUID_A = "01a1aaaa-0000-7000-8000-000000000001";
const writeOutbox = (id: string, status: string, to: string, createdAtMsAgo: number) => {
	const at = new Date(Date.now() - createdAtMsAgo).toISOString();
	writeFileSync(
		join(outboxDirPath, `${id}.json`),
		JSON.stringify({
			id,
			version: 1,
			dedupeKey: `k-${id}`,
			type: "session.message",
			to,
			sessionId: "src",
			commandKey: `c-${id}`,
			text: "body",
			status,
			createdAt: at,
			updatedAt: at,
		}),
		"utf8",
	);
};

const cleanOutbox = () => {
	for (const f of ["cleanup-a", "cleanup-b", "cleanup-c", "cleanup-d", "cleanup-e"]) {
		rmSync(join(outboxDirPath, `${f}.json`), { force: true });
	}
};

// ── ① 只数 pending；终态不计入 ────────────────────────────────────
check("① pending 只数 status==='pending'，delivered/expired/failed 不计入", () => {
	cleanOutbox();
	writeOutbox("cleanup-a", "pending", `pi://${UUID_A}`, 5 * 60_000);
	writeOutbox("cleanup-b", "delivered", `pi://${UUID_A}`, 60 * 60_000);
	writeOutbox("cleanup-c", "expired", `pi://tab_mwxxx_yyyy`, 120 * 60_000);
	writeOutbox("cleanup-d", "failed", `pi://tab_mwxxx_yyyy`, 90 * 60_000);
	const o = obs.observeOutbox(stateDir);
	assert.equal(o.readable, true);
	assert.equal(o.total, 4, `total 应为 4（含终态），实际 ${o.total}`);
	assert.equal(o.pending, 1, `pending 应为 1（只有 cleanup-a），实际 ${o.pending}`);
	// ① 的关键：终态里的 tab_ 地址**不得**被算进 B 类指标
	assert.equal(o.pendingTabAddress, 0, `pendingTabAddress 应为 0（tab_ 只出现在终态项），实际 ${o.pendingTabAddress}`);
	assert.equal(o.pendingNonUuidAddress, 0, `pendingNonUuidAddress 应为 0，实际 ${o.pendingNonUuidAddress}`);
});

// ── ② B 类指标单独计数，不与「非 UUID」混同 ──────────────────────
check("② to=pi://tab_* 单独计数；假 id（test-parallel-async）只进 nonUuid 不进 tab", () => {
	cleanOutbox();
	writeOutbox("cleanup-a", "pending", `pi://${UUID_A}`, 2 * 60_000); // 可达
	writeOutbox("cleanup-b", "pending", "pi://tab_mwaaa_bbbb", 30 * 60_000); // B 类
	writeOutbox("cleanup-c", "pending", "pi://test-parallel-async", 15 * 60_000); // 假 id
	writeOutbox("cleanup-d", "pending", "pi://unknown", 10 * 60_000); // 不可达
	const o = obs.observeOutbox(stateDir);
	assert.equal(o.pending, 4);
	assert.equal(o.pendingTabAddress, 1, `只有 1 条 tab_，实际 ${o.pendingTabAddress}`);
	assert.equal(o.pendingNonUuidAddress, 3, `tab_+假id+unknown = 3，实际 ${o.pendingNonUuidAddress}`);
	assert.equal(o.pending - o.pendingNonUuidAddress, 1, "可达项应恰为 1");
	// 两指标必须**独立**（不是包含关系）
	assert.notEqual(o.pendingTabAddress, o.pendingNonUuidAddress, "tab_ 与 nonUuid 是两个独立口径，不得相同");
});

// ── ③ 只读文件名，不读 JSON 正文（性能与健壮性同一件事）─────────
check("③ observeDelivery 不读文件正文：放内容损坏的 attempt/ack 也必须照常计数", () => {
	const D = deliveryDirPath;
	// 2 个 event（无派生后缀）
	writeFileSync(join(D, "e1.json"), "{}", "utf8");
	writeFileSync(join(D, "e2.json"), "{}", "utf8");
	// k1：1 attempt + 1 ack（内容**故意写坏**）
	writeFileSync(join(D, "k1.attempt.a1.json"), "{not json", "utf8");
	writeFileSync(join(D, "k1.ack.consumed.a1.json"), "also not json", "utf8");
	// k2：2 attempt + 0 ack ⇒ attemptWithoutAnyAck 应为 1（k2）
	writeFileSync(join(D, "k2.attempt.a2.json"), "{broken", "utf8");
	writeFileSync(join(D, "k2.attempt.a3.json"), "", "utf8");
	// k3：0 attempt + 1 ack（不得被算进 attemptWithoutAnyAck）
	writeFileSync(join(D, "k3.ack.received.a4.json"), "x", "utf8");
	// 1 incident
	writeFileSync(join(D, "k2.incident.i1.json"), "{}", "utf8");

	const d = obs.observeDelivery(runtimeDir);
	assert.equal(d.readable, true);
	assert.equal(d.events, 2, `events 应为 2，实际 ${d.events}`);
	assert.equal(d.attempts, 3, `attempts 应为 3（k1×1 + k2×2），实际 ${d.attempts}`);
	assert.equal(d.acks, 2, `acks 应为 2（k1 + k3），实际 ${d.acks}`);
	assert.equal(d.incidents, 1, `incidents 应为 1，实际 ${d.incidents}`);
	assert.equal(d.attemptWithoutAnyAck, 1, `应为 1（只有 k2 有 attempt 无 ack），实际 ${d.attemptWithoutAnyAck}`);
});

// ── ④ 目录缺失 / 不可读 ⇒ readable:false，never-throw ────────────
check("④ 目录不存在 ⇒ readable:true 且全 0（「从没有过」不是故障）；路径是文件 ⇒ readable:false 不抛", () => {
	rmSync(outboxDirPath, { recursive: true, force: true });
	const o1 = obs.observeOutbox(stateDir);
	assert.equal(o1.readable, true, "目录不存在应视为可读（全 0）");
	assert.equal(o1.pending, 0);

	// 把 outbox 路径变成**文件** ⇒ readdir 会 ENOTDIR ⇒ 必须被 catch 成 readable:false
	writeFileSync(outboxDirPath, "not a dir", "utf8");
	const o2 = obs.observeOutbox(stateDir);
	assert.equal(o2.readable, false, "路径是文件时应 readable:false");
	assert.equal(o2.pending, 0, "不可读时计数应为 0");

	rmSync(outboxDirPath, { force: true });
	mkdirSync(outboxDirPath, { recursive: true });

	// 空目录 ⇒ 0
	const o3 = obs.observeOutbox(stateDir);
	assert.equal(o3.readable, true);
	assert.equal(o3.total, 0);
	assert.equal(o3.oldestPendingAgeMs, null, "无 pending ⇒ oldestPendingAgeMs 为 null");
});

// ── ⑤ 真实接线：buildAutonomyStatusBody() 必须包含这两行 ─────────
check("⑤ status body 真实输出包含 outbox/delivery 两行（不是为测试另写一份）", () => {
	cleanOutbox();
	writeOutbox("cleanup-a", "pending", "pi://tab_mwzzz_qqqq", 45 * 60_000);
	const body = buildAutonomyStatusBody();
	assert.ok(body.includes("outbox: pending="), `body 必须含 outbox 行，实际:\n${body.slice(0, 900)}`);
	assert.ok(body.includes("delivery: events="), `body 必须含 delivery 行，实际:\n${body.slice(0, 900)}`);
	assert.ok(!body.includes("(状态不可读)"), "body 不应掉进 catch");
});

// ── ⑥ 「不证明」文案必须真的在输出里（R-23）───────────────────────
check("⑥ 输出含「不证明什么」的限定语：永不匹配 / 不等于 A 类死锁", () => {
	cleanOutbox();
	writeOutbox("cleanup-a", "pending", "pi://tab_mwzzz_qqqq", 45 * 60_000);
	const lines = obs.deliveryObservationLines({ outbox: obs.observeOutbox(stateDir), delivery: obs.observeDelivery(runtimeDir) });
	const text = lines.join("\n");
	// B 类存在时必须显式说「永不匹配」
	assert.ok(/永不匹配/.test(text), `有 tab_ 项时必须写「永不匹配」，实际:\n${text}`);
	// A 类入口数字必须显式否认它是判据
	assert.ok(/不等于 A 类|只是\*\*文件名级下界\*\*|文件名级下界/.test(text), `必须写明只是文件名级下界，实际:\n${text}`);
	// 年龄必须带「前」（R-2 规则 2：只给绝对时间读不出陈旧）
	assert.ok(/min 前|s 前|h 前/.test(text), `最老 pending 必须给年龄，实际:\n${text}`);
});

console.log(`delivery-observations: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
rmSync(root, { recursive: true, force: true });
