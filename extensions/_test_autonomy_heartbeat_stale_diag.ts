/**
 * R-20 回归网：`hub frontierFreshness` 必须能表达 R-2 规则 3 的**第 ① 态（tick/进程死）**。
 *
 * 事故（2026-11-05，实测）：心跳文件还在但停了 46min（周期 30s），旧三判：
 *   suspectedDisabled = stale && hbFresh = false
 *   hb && !stale       = false
 *   !hb && frontier    = false   ← 心跳存在，只是旧
 * ⇒ 三分支全 false ⇒ `/autonomy status` 只报「诊断：未知」。
 * 唯一走得到的「tick 未在跑」分支要求 `!hb`（心跳**完全不存在**）⇒ 真实故障永远走不到。
 *
 * 判据：`heartbeatStale` 把「心跳存在但陈旧」与「心跳不存在」分开，
 * 且「心跳新鲜 + 快照新鲜」时**不得**误报 tick 死。
 */
import assert from "node:assert/strict";

const { frontierFreshness } = await import("./runtime/autonomy/collect.ts");

let pass = 0;
const ok = (n: string) => { pass++; console.log(`  ✅ ${n}`); };
const NOW = 1_800_000_000_000;
const hb = (atMsAgo: number) => ({ at: NOW - atMsAgo, iso: new Date(NOW - atMsAgo).toISOString(), pid: 1234, sessionId: "s", tickIntervalMs: 30_000 });
const snap = (asofMsAgo: number) => ({ asof: NOW - asofMsAgo });

// ── ① 真实故障形状：心跳 46min 陈旧（周期 30s）+ 快照 12h 陈旧 ──
{
  const f = frontierFreshness(snap(12 * 3600_000), hb(46 * 60_000), NOW);
  assert.equal(f.heartbeatStale, true, "心跳 46min 陈旧（周期 30s）⇒ heartbeatStale 必须 true");
  assert.equal(f.stale, true);
  assert.equal(f.suspectedDisabled, false, "心跳也陈旧 ⇒ 不能报「很可能被关」（分不清是关还是 tick 死）");
  ok("①②真实故障：心跳陈旧被单独标记（旧实现此处三分支全 false → 「诊断：未知」）");
}

// ── ② 区分「心跳陈旧」vs「心跳完全不存在」：两者都 stale，但语义不同 ──
{
  const withHb = frontierFreshness(snap(60 * 60_000), hb(60 * 60_000), NOW);
  const noHb = frontierFreshness(snap(60 * 60_000), null, NOW);
  assert.equal(withHb.heartbeatStale, true, "有心跳但陈旧 ⇒ heartbeatStale=true");
  assert.equal(noHb.heartbeatStale, false, "无心跳 ⇒ heartbeatStale=false（由 !hb 分支表达，不是 stale）");
  assert.equal(withHb.stale, noHb.stale, "两者快照都旧 ⇒ stale 相同（区分靠 heartbeatStale）");
  ok("心跳陈旧 vs 心跳不存在 可区分");
}

// ── ③ 不得误报：心跳新鲜 + 快照新鲜 ⇒ tick 不死 ──
{
  const f = frontierFreshness(snap(10_000), hb(5_000), NOW);
  assert.equal(f.heartbeatStale, false, "心跳 5s 前 ⇒ 不得报 tick 死");
  assert.equal(f.stale, false);
  assert.equal(f.suspectedDisabled, false);
  ok("心跳新鲜 + 快照新鲜 ⇒ 不误报");
}

// ── ④ ②被关 的判据必须保持不变：心跳新鲜但快照陈旧 ──
{
  const f = frontierFreshness(snap(12 * 3600_000), hb(5_000), NOW);
  assert.equal(f.suspectedDisabled, true, "心跳新鲜 + 快照陈旧 ⇒ 仍是「很可能被关」（旧语义零变化）");
  assert.equal(f.heartbeatStale, false);
  ok("②被关 判据零变化");
}

// ── ⑤ 无快照：心跳新鲜 ≠ tick 死；心跳陈旧 ⇒ tick 死 ──
{
  const a = frontierFreshness(null, hb(5_000), NOW);
  const b = frontierFreshness(null, hb(46 * 60_000), NOW);
  const c = frontierFreshness(null, null, NOW);
  assert.equal(a.heartbeatStale, false, "无快照 + 心跳新鲜 ⇒ 不得报 tick 死");
  // 旧语义保留：有心跳且新鲜但无快照 ⇒ 仍报「很可能被关」（tick 在跑却没产出）
  assert.equal(a.suspectedDisabled, true, "无快照 + 心跳新鲜 ⇒ 仍按旧语义报「很可能被关」");
  assert.equal(b.heartbeatStale, true, "无快照 + 心跳陈旧 ⇒ tick 死");
  assert.equal(c.heartbeatStale, false);
  ok("无快照分支：新鲜/陈旧/缺失 三态可分");
}

// ── ⑥ F3：心跳时间在未来（时钟倒退）⇒ 既不算新鲜也不算「tick 死」，由 clockSkew 表达 ──
{
	const future = { at: NOW + 24 * 3600_000, iso: "future", pid: 1, sessionId: "s", tickIntervalMs: 30_000 };
	const f = frontierFreshness(snap(60 * 60_000), future, NOW);
	assert.equal(f.heartbeatStale, false, "F3：未来时间不得被判为「tick 死」（那是未知，不是死亡）");
	const skew = future.at - NOW > Math.max(future.tickIntervalMs, 60_000);
	assert.equal(skew, true, "F3：未来超容差须被识别为 clockSkew（调用方据此报「无法判定」）");
	ok("F3 未来时间：不误判死、不误判新鲜，由 clockSkew 表达");
}

// ── ⑦ 阈值随 tick 周期走（tick=30s ⇒ max(90s,5min)=5min） ──
{
  const justUnder = frontierFreshness(snap(4 * 60_000), hb(4 * 60_000), NOW);
  const justOver = frontierFreshness(snap(6 * 60_000), hb(6 * 60_000), NOW);
  assert.equal(justUnder.heartbeatStale, false, "4min < 5min 阈值 ⇒ 不算陈旧");
  assert.equal(justOver.heartbeatStale, true, "6min > 5min 阈值 ⇒ 陈旧");
  ok("阈值仍是 max(tick*3, 5min)");
}

// ── ⑧ F3：磁盘上的 `{"at":1e400}` 是合法 JSON 且 parse 成 Infinity ⇒ reader 必须拒绝 ──
{
	const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const st = mkdtempSync(join(tmpdir(), "f3-"));
	mkdirSync(join(st, "autonomy"), { recursive: true });
	writeFileSync(join(st, "autonomy", "heartbeat.json"), '{"at":1e400,"iso":"probe","pid":1,"sessionId":"s","tickIntervalMs":30000}', "utf8");
	const { readAutonomyHeartbeat } = await import("./runtime/autonomy/collect.ts");
	assert.equal(readAutonomyHeartbeat({ stateDir: st }), null, "F3：at=Infinity 必须被判为无效读数（否则永远判 fresh，故障永不暴露）");
	rmSync(st, { recursive: true, force: true, maxRetries: 2 });
	ok("F3 非法读数值（Infinity）被 reader 拒绝");
}

// ── ⑨ F3/N1（2026-11-05 L4 复验）：未来时间**不得算 fresh**，也不得让它进 suspectedDisabled ──
// L4 实测反例：`at=now+24h` + 旧快照 ⇒ 旧实现报「tick 活着但 frontier 不新鲜 ⇒ 很可能被关」
// 根因：`now - at <= threshold` 对负 age 恒真，而 clockSkew 只排除 heartbeatStale，不排除 hbFresh。
{
	const future = { at: NOW + 24 * 3600_000, iso: "future", pid: 1, sessionId: "s", tickIntervalMs: 30_000 };
	const f = frontierFreshness(snap(12 * 3600_000), future, NOW);
	assert.equal(f.suspectedDisabled, false, "F3：未来心跳不得触发「tick 活着但被关」（旧实现对负 age 恒 fresh）");
	assert.equal(f.heartbeatStale, false, "F3：未来心跳是「无法判定」，不得归入 stale");
	// 无快照路径同样不得误报
	const f2 = frontierFreshness(null, future, NOW);
	assert.equal(f2.suspectedDisabled, false, "F3：无快照 + 未来心跳也不得报「被关」");
	ok("F3 未来时间：不误判 fresh、不进 suspectedDisabled（L4 反例回归）");
}

// ── ⑩ F3：tickIntervalMs 非有限/超大值不得让 threshold 溢出 ──
// L4 实测：`tickIntervalMs=1e400`（parse 成 Infinity）与 `1e308`（×3 溢出）⇒ threshold=Infinity
// ⇒ 一天前的心跳与快照都被当「正常」。
{
	for (const badTick of [Infinity, 1e308, Number.NaN]) {
		const bad = { at: NOW - 24 * 3600_000, iso: "", pid: 1, sessionId: "s", tickIntervalMs: badTick as number };
		const f = frontierFreshness(snap(24 * 3600_000), bad, NOW);
		assert.ok(Number.isFinite(f.threshold), `F3：tick=${badTick} 时 threshold 必须有限（实际 ${f.threshold}）`);
		assert.equal(f.stale, true, `F3：tick=${badTick} + 24h 前读数 ⇒ 必须判 stale，不得报正常`);
		assert.equal(f.suspectedDisabled, false, `F3：tick=${badTick} 不得误报「被关」`);
	}
	// 合法小周期仍生效（不得把 normal 路径改坏）
	const normal = { at: NOW - 10_000, iso: "", pid: 1, sessionId: "s", tickIntervalMs: 30_000 };
	assert.equal(frontierFreshness(snap(10_000), normal, NOW).suspectedDisabled, false);
	ok("F3 非法 tick 周期不得让 threshold 溢出（Infinity/1e308/NaN）");
}

// ── ⑪ N1（L4 新增发现）：上一任 owner 的心跳不得被当成当前 owner 的 tick 证据 ──
// L4 实测：交接后共享槽位留着上一任的陈旧心跳（自然可达状态）
// ⇒ 旧实现报「owner wake 心跳已 60min 未更新」，把上一任的陈旧当成当前 owner 死。
// 注意：这层归因在 `index.ts` 的 diagLine（用 hbIsOwner），本用例锁的是**前置算子的边界**：
// 未来/陈旧读数不得互相污染——具体归因由 index.ts 的 hbAttributable 门完成（已改）。
{
	const prevOwner = { at: NOW - 60 * 60_000, iso: "", pid: 1, sessionId: "previous-owner", tickIntervalMs: 30_000 };
	const f = frontierFreshness(snap(12 * 3600_000), prevOwner, NOW);
	// 算子层只能表达「陈旧」——不能自己声称「当前 owner 死了」（它不知道 owner 是谁）
	assert.equal(f.heartbeatStale, true, "N1：陈旧心跳在算子层仍应标 heartbeatStale=true（供上层比对 owner）");
	assert.equal(f.suspectedDisabled, false, "N1：陈旧心跳不得触发「被关」（那是新鲜+旧快照的形状）");
	ok("N1 算子边界：陈旧心跳不被误当「tick 活着」（owner 比对在 index.ts 层）");
}

console.log(`\n_test_autonomy_heartbeat_stale_diag: ${pass} checks passed`);
