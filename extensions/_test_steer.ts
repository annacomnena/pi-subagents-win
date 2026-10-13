/**
 * _test_steer.ts — steer.ts（立即插入消息核心纯函数 + IO）单元测试
 *
 * 覆盖（plan §7 / F4）：
 *   1. id / 路径注入守卫（../../evil 一律抛）
 *   2. validateSteerRecord：mode 白名单（M2 缺省放行 steer|abort；M1_STEER_MODES 反向收窄）/ 长度 / status / 半截字段
 *   3. validateSteerRequest：A9 入参安全 + scope（标签页只能给自己）
 *   4. 原子写读（tmp 消失、roundtrip、只收 *.json）
 *   5. 半截 JSON 容错（读到 null，但调用方不得据此写终态）
 *   6. claimSteerAtomic 幂等（同/跨 sidecar）
 *   7. withSteerStatus / withClaim 不改原对象
 *   8. sweepTerminalSteerRecords：TTL + 孤儿 .claimed + 空目录
 *   9. expirePendingSteerRecords：「目标存活则不置 undelivered」反例
 *  10. sendSteerQuietly 四分类（fake send）
 *
 * 全部 IO 落 mkdtempSync 隔离目录；绝不触碰真实 ~/.pi/agent/**。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	M1_STEER_MODES,
	M2_STEER_MODES,
	MAX_STEER_MESSAGE,
	STEER_CLAIM_LEASE_MS,
	claimSteerAtomic,
	claimSteerAtomicDetailed,
	defaultSteerDir,
	expirePendingSteerRecords,
	isSafeSteerComponent,
	isSteerTerminal,
	listSteerIds,
	newSteerId,
	readAllSteerRecords,
	readSteerRecord,
	releaseSteerClaim,
	sendSteerDetailed,
	sendSteerQuietly,
	steerClaimPath,
	steerDirForTab,
	steerFilePath,
	steerHasFreshClaim,
	steerTakeoverPath,
	sweepTerminalSteerRecords,
	validateSteerRecord,
	validateSteerRequest,
	withClaim,
	withSteerStatus,
	writeSteerAtomic,
} from "./steer.ts";

// 隔离账本目录（绝不碰真实 ~/.pi/agent/steer）
const dir = mkdtempSync(join(tmpdir(), "steer-test-"));
const TAB = "tab_test_abc1";

function sample(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "steer_abc123_x1",
		version: 1,
		tabRunId: TAB,
		mode: "steer",
		body: "立即插入：把当前进度写成一行小结",
		status: "pending",
		createdAt: new Date().toISOString(),
		source: "tab-steer",
		...overrides,
	};
}

function sampleValid(overrides: Record<string, unknown> = {}) {
	const check = validateSteerRecord(sample(overrides));
	assert.ok(check.ok && check.value, `sample 必须合法: ${check.errors?.join("; ")}`);
	return check.value!;
}

// ── 1. id / 路径 ──────────────────────────────────────────────────
{
	const a = newSteerId(new Date(1786000000000));
	const b = newSteerId(new Date(1786000000000));
	assert.ok(a.startsWith("steer_"), `steer id prefix: ${a}`);
	assert.notEqual(a, b, "steer ids must be unique");

	assert.equal(defaultSteerDir("C:\\x\\agent"), join("C:\\x\\agent", "steer"));
	assert.equal(steerDirForTab(dir, TAB), join(dir, TAB));
	assert.equal(steerFilePath(dir, TAB, "steer_ok_1"), join(dir, TAB, "steer_ok_1.json"));
	assert.equal(steerClaimPath(dir, TAB, "steer_ok_1"), join(dir, TAB, "steer_ok_1.claimed"));

	// 路径注入守卫
	assert.throws(() => steerDirForTab(dir, "../../evil"), /unsafe tabRunId/);
	assert.throws(() => steerFilePath(dir, TAB, "../../evil"), /unsafe steer id/);
	assert.throws(() => steerClaimPath(dir, TAB, "a/b"), /unsafe steer id/);
	assert.throws(() => steerFilePath(dir, "tab with space", "steer_ok_1"), /unsafe tabRunId/);
	assert.equal(readSteerRecord(dir, "../../evil", "x"), null, "不安全的 tabRunId 读 → null（不抛）");
	assert.deepEqual(listSteerIds(dir, "../../evil"), [], "不安全的 tabRunId 列举 → 空");

	// SF-2：纯点号组件必须显式拒绝（SAFE_ID_PART 自身放行 "."/".."）
	assert.equal(isSafeSteerComponent(""), false, "空组件不安全");
	assert.equal(isSafeSteerComponent("."), false, ". 不安全");
	assert.equal(isSafeSteerComponent(".."), false, ".. 不安全");
	assert.equal(isSafeSteerComponent(TAB), true, "正常 tabRunId 安全");
	assert.throws(() => steerDirForTab(dir, ".."), /unsafe tabRunId/, "steerDirForTab('..') 必须抛");
	assert.throws(() => steerFilePath(dir, "..", "steer_ok_1"), /unsafe tabRunId/, "steerFilePath('..') 必须抛");
	assert.equal(readSteerRecord(dir, "..", "steer_ok_1"), null, "tabRunId='..' 读 → null");
	assert.deepEqual(listSteerIds(dir, ".."), [], "tabRunId='..' 列举 → 空");
	assert.equal(steerHasFreshClaim(dir, ".."), false, "tabRunId='..' 不作活性证据");
}

// ── 2. validateSteerRecord ────────────────────────────────────────
{
	assert.ok(validateSteerRecord(sample()).ok, "完整 pending 记录合法");

	// M2：mode 白名单缺省放行 steer + abort（M1 白名单常量仍可收窄，供反向用例）
	assert.deepEqual([...M2_STEER_MODES], ["steer", "abort"], "M2 白名单 = steer|abort");
	assert.deepEqual([...M1_STEER_MODES], ["steer"], "M1 白名单 = steer");
	assert.ok(validateSteerRecord(sample({ mode: "abort" })).ok, "M2 默认放行 mode=abort");
	const abortNarrow = validateSteerRecord(sample({ mode: "abort" }), { modes: M1_STEER_MODES });
	assert.equal(abortNarrow.ok, false, "收窄为 M1 白名单时拒绝 mode=abort");
	assert.ok(abortNarrow.errors.some((e) => e.includes("mode must be steer")), `错误文案: ${abortNarrow.errors}`);
	assert.equal(validateSteerRecord(sample({ mode: "bogus" })).ok, false, "未知 mode 拒绝");

	// 长度 / 空串
	assert.equal(validateSteerRecord(sample({ body: "x".repeat(MAX_STEER_MESSAGE) })).ok, true, "恰好上限通过");
	assert.equal(validateSteerRecord(sample({ body: "x".repeat(MAX_STEER_MESSAGE + 1) })).ok, false, "超长拒绝");
	assert.equal(validateSteerRecord(sample({ body: "" })).ok, false, "steer 空 body 拒绝（空 steer = 假投递）");
	assert.ok(
		validateSteerRecord(sample({ mode: "abort", body: "" })).ok,
		"abort 档允许空 body（纯打断，M2）",
	);
	// abort 记录的时间戳字段可读（M2 回执）
	const abortedRec = validateSteerRecord(sample({
		mode: "abort", body: "打断改做 X", status: "aborted",
		abortedAt: new Date().toISOString(), idleAt: new Date().toISOString(),
	}));
	assert.ok(abortedRec.ok && abortedRec.value, "aborted 记录合法");
	assert.ok(abortedRec.value!.abortedAt, "abortedAt 保留");
	assert.ok(abortedRec.value!.idleAt, "idleAt 保留");

	// status / 必填字段
	assert.equal(validateSteerRecord(sample({ status: "bogus" })).ok, false, "未知 status 拒绝");
	assert.ok(validateSteerRecord(sample({ status: "delivered", deliveredAt: new Date().toISOString() })).ok);
	assert.equal(validateSteerRecord(sample({ source: "" })).ok, false, "source 必填");
	assert.equal(validateSteerRecord(sample({ version: 2 })).ok, false, "version 必须为 1");
	assert.equal(validateSteerRecord(sample({ createdAt: "not-a-date" })).ok, false, "createdAt 必须 ISO");
	assert.equal(validateSteerRecord(sample({ tabRunId: "../evil" })).ok, false, "tabRunId 过安全守卫");
	assert.equal(validateSteerRecord(sample({ tabRunId: ".." })).ok, false, "SF-2: tabRunId='..' 过安全守卫");
	assert.equal(validateSteerRecord(sample({ id: "a b" })).ok, false, "id 过安全守卫");
	assert.equal(validateSteerRecord("nope").ok, false, "非对象拒绝");
}

// ── 3. validateSteerRequest（A9 入参安全 + scope）───────────────────
{
	const ok = validateSteerRequest({ tabRunId: ` ${TAB} `, message: "hi" });
	assert.ok(ok.ok && ok.value, "合法请求通过");
	assert.equal(ok.value!.tabRunId, TAB, "tabRunId 应 trim");
	assert.equal(ok.value!.mode, "steer", "mode 缺省 steer");

	assert.equal(validateSteerRequest({ tabRunId: "../../evil", message: "hi" }).ok, false, "路径注入 tabRunId 拒绝");
	assert.equal(validateSteerRequest({ message: "hi" }).ok, false, "缺 tabRunId 拒绝");
	assert.equal(validateSteerRequest({ tabRunId: TAB, message: "x".repeat(MAX_STEER_MESSAGE + 1) }).ok, false, "超长 message 拒绝");
	assert.equal(validateSteerRequest({ tabRunId: TAB, message: "" }).ok, false, "空 message 拒绝");
	assert.equal(validateSteerRequest({ tabRunId: TAB }).ok, false, "缺 message 拒绝");
	assert.equal(validateSteerRequest({ tabRunId: TAB, message: "hi", mode: "bogus" }).ok, false, "未知 mode 拒绝");
	// M2：abort 档放行；abort + 空 body = 纯打断允许；steer + 空 body 仍拒
	assert.ok(validateSteerRequest({ tabRunId: TAB, message: "hi", mode: "abort" }).ok, "mode=abort 通过（M2）");
	assert.ok(validateSteerRequest({ tabRunId: TAB, message: "", mode: "abort" }).ok, "abort 空 message = 纯打断，允许");
	assert.equal(validateSteerRequest({ tabRunId: TAB, message: "", mode: "steer" }).ok, false, "steer 空 message 拒绝");
	assert.equal(
		validateSteerRequest({ tabRunId: TAB, message: "hi", mode: "abort" }, { modes: M1_STEER_MODES }).ok,
		false,
		"收窄为 M1 白名单时 mode=abort 拒绝",
	);
	assert.equal(validateSteerRequest({ tabRunId: "..", message: "hi" }).ok, false, "SF-2: tabRunId='..' 拒绝");
	assert.equal(validateSteerRequest({ tabRunId: ".", message: "hi" }).ok, false, "SF-2: tabRunId='.' 拒绝");
	assert.ok(validateSteerRequest({ tabRunId: TAB, message: "hi", mode: "steer" }).ok, "mode=steer 通过");
	assert.equal(
		validateSteerRequest({ tabRunId: "tab_other", message: "hi" }, { myRunId: TAB }).ok,
		false,
		"标签页不能给别的 tab 投递",
	);
	assert.ok(validateSteerRequest({ tabRunId: TAB, message: "hi" }, { myRunId: TAB }).ok, "标签页给自己投递通过");
}

// ── 4. 原子写读 ───────────────────────────────────────────────────
{
	const rec = sampleValid();
	writeSteerAtomic(dir, rec);
	assert.ok(existsSync(steerFilePath(dir, TAB, rec.id)), "记录文件应存在");
	assert.equal(existsSync(`${steerFilePath(dir, TAB, rec.id)}.tmp`), false, "tmp 应已被 rename");
	assert.deepEqual(readSteerRecord(dir, TAB, rec.id), rec, "roundtrip 逐字段一致");
	assert.deepEqual(listSteerIds(dir, TAB), [rec.id], "listSteerIds 只收本条");

	// .tmp / .claimed 不算记录
	const strayDir = steerDirForTab(dir, "tab_stray_1");
	mkdirSync(strayDir, { recursive: true });
	writeFileSync(join(strayDir, "a.tmp"), "{}", "utf8");
	writeFileSync(join(strayDir, "b.json.tmp"), "{}", "utf8");
	writeFileSync(join(strayDir, "c.claimed"), "", "utf8");
	assert.deepEqual(listSteerIds(dir, "tab_stray_1"), [], "只收 *.json（排除 .tmp/.claimed）");
	assert.deepEqual(readAllSteerRecords(dir, "tab_stray_1"), [], "无记录时返回空数组");
}

// ── 5. 半截 JSON 容错 ─────────────────────────────────────────────
{
	const okRec = sampleValid({ id: "steer_half_ok" });
	writeSteerAtomic(dir, okRec);
	const brokenPath = steerFilePath(dir, TAB, "steer_half_broken");
	writeFileSync(brokenPath, '{"id":"steer_half_broken","version":1,', "utf8"); // 半截
	assert.equal(readSteerRecord(dir, TAB, "steer_half_broken"), null, "半截 JSON → null（不抛）");
	const listed = listSteerIds(dir, TAB);
	assert.ok(listed.includes("steer_half_broken"), "半截文件仍被列出（由消费者判空跳过，不标 seen）");
	assert.ok(listed.includes("steer_half_ok"), "正常记录同时被列出");
	// 补全后即可读
	writeFileSync(brokenPath, JSON.stringify(sample({ id: "steer_half_broken" })), "utf8");
	assert.ok(readSteerRecord(dir, TAB, "steer_half_broken"), "补全后读成功");
	// 字段非法的 JSON 也返回 null
	writeFileSync(brokenPath, JSON.stringify({ id: "steer_half_broken", version: 2 }), "utf8");
	assert.equal(readSteerRecord(dir, TAB, "steer_half_broken"), null, "字段非法 → null");
}

// ── 6. claimSteerAtomic 幂等 ──────────────────────────────────────
{
	const id = "steer_claim_1";
	writeSteerAtomic(dir, sampleValid({ id }));
	assert.equal(claimSteerAtomic(dir, TAB, id), true, "首次认领成功");
	assert.equal(claimSteerAtomic(dir, TAB, id), false, "重复认领失败（跨实例去重）");
	assert.ok(existsSync(steerClaimPath(dir, TAB, id)), "sidecar 存在");
	// 另一条记录互不影响
	writeSteerAtomic(dir, sampleValid({ id: "steer_claim_2" }));
	assert.equal(claimSteerAtomic(dir, TAB, "steer_claim_2"), true, "不同 id 独立认领");
	// 释放后可再认领
	releaseSteerClaim(dir, TAB, id);
	assert.equal(claimSteerAtomic(dir, TAB, id), true, "释放后可重新认领");
	assert.doesNotThrow(() => releaseSteerClaim(dir, TAB, "steer_never_existed"), "释放不存在的认领不抛");
}

// ── 6b. claimSteerAtomicDetailed：租约接管（MF-1）+ IO 错误区分（SF-1）──
{
	const id = "steer_claim_lease";
	writeSteerAtomic(dir, sampleValid({ id }));
	assert.equal(claimSteerAtomicDetailed(dir, TAB, id), "claimed", "首次认领 → claimed");
	assert.equal(claimSteerAtomicDetailed(dir, TAB, id), "held", "新鲜租约重复认领 → held");
	// 时间前进超过租约 → 接管（不动 mtime，用注入 now 模拟）
	const staleNow = Date.now() + STEER_CLAIM_LEASE_MS + 60_000;
	assert.equal(
		claimSteerAtomicDetailed(dir, TAB, id, { now: staleNow, staleMs: STEER_CLAIM_LEASE_MS }),
		"claimed",
		"stale 租约 → 接管（MF-1）",
	);
	// N-2：接管令牌是独占锁，正常路径 finally 释放（不留孤儿）；新鲜令牌 → 让位
	assert.equal(existsSync(steerTakeoverPath(dir, TAB, id)), false, "接管后令牌已释放（无孤儿）");
	writeFileSync(steerTakeoverPath(dir, TAB, id), "", "utf8");
	assert.equal(
		claimSteerAtomicDetailed(dir, TAB, id, { now: staleNow + 30_000, staleMs: STEER_CLAIM_LEASE_MS }),
		"held",
		"他人持新鲜接管令牌 → held（CAS 让位）",
	);
	rmSync(steerTakeoverPath(dir, TAB, id), { force: true });
	// N-2：孤儿令牌（超租约）→ 本轮只回收不接管；下一轮无令牌才接管
	writeFileSync(steerTakeoverPath(dir, TAB, id), "", "utf8");
	const orphanTok = new Date(Date.now() - 120_000);
	utimesSync(steerTakeoverPath(dir, TAB, id), orphanTok, orphanTok);
	assert.equal(
		claimSteerAtomicDetailed(dir, TAB, id, { now: staleNow + 60_000, staleMs: STEER_CLAIM_LEASE_MS }),
		"held",
		"孤儿令牌：本轮只回收不接管",
	);
	assert.equal(existsSync(steerTakeoverPath(dir, TAB, id)), false, "陈旧孤儿令牌被回收");
	assert.equal(
		claimSteerAtomicDetailed(dir, TAB, id, { now: staleNow + 60_000, staleMs: STEER_CLAIM_LEASE_MS }),
		"claimed",
		"回收后下一轮接管成功",
	);
	// 记录已终态 → 不得接管（终态 sidecar 是残留，交 sweep GC）
	writeSteerAtomic(dir, sampleValid({ id, status: "delivered", deliveredAt: new Date().toISOString() }));
	assert.equal(
		claimSteerAtomicDetailed(dir, TAB, id, { now: staleNow + 90_000 }),
		"held",
		"终态记录不接管",
	);
	// SF-1：非 EEXIST 的创建失败 → io-error（目录不存在）
	assert.equal(
		claimSteerAtomicDetailed(join(dir, "no-such-tab-dir-x"), TAB, "steer_claim_io"),
		"io-error",
		"目录缺失 → io-error（不得当作 held）",
	);

	// SF-3：steerHasFreshClaim = 「目标有消费者」的活性证据（新鲜 .claimed）
	const sf3Dir = join(dir, "sf3");
	const freshId = "steer_claim_fresh_evidence";
	writeSteerAtomic(sf3Dir, sampleValid({ id: freshId }));
	assert.equal(claimSteerAtomic(sf3Dir, TAB, freshId), true, "建立新鲜认领");
	assert.equal(steerHasFreshClaim(sf3Dir, TAB, { staleMs: STEER_CLAIM_LEASE_MS }), true, "新鲜 .claimed → 活性证据");
	const stale = new Date(Date.now() - 2 * STEER_CLAIM_LEASE_MS);
	utimesSync(steerClaimPath(sf3Dir, TAB, freshId), stale, stale);
	assert.equal(steerHasFreshClaim(sf3Dir, TAB, { staleMs: STEER_CLAIM_LEASE_MS }), false, "stale .claimed → 不作活性证据");
}

// ── 7. 状态机不改原对象 ───────────────────────────────────────────
{
	const rec = sampleValid({ id: "steer_state_1" });
	const before = JSON.stringify(rec);
	const delivered = withSteerStatus(rec, "delivered", { deliveredAt: "2026-10-12T00:00:00.000Z" });
	assert.notEqual(delivered, rec, "withSteerStatus 返回新对象");
	assert.equal(JSON.stringify(rec), before, "原对象不被修改");
	assert.equal(delivered.status, "delivered");
	assert.equal(delivered.deliveredAt, "2026-10-12T00:00:00.000Z");

	const claimed = withClaim(rec, { claimedBy: "sess-1", now: new Date("2026-10-12T00:00:01.000Z") });
	assert.equal(claimed.status, "pending", "认领不改变 status（不引入中间态）");
	assert.equal(claimed.claimedAt, "2026-10-12T00:00:01.000Z");
	assert.equal(claimed.claimedBy, "sess-1");
	assert.equal(JSON.stringify(rec), before, "withClaim 不改原对象");

	assert.equal(isSteerTerminal(rec), false, "pending 非终态");
	for (const s of ["delivered", "aborted", "failed", "undelivered"] as const) {
		assert.equal(isSteerTerminal({ status: s }), true, `${s} 是终态`);
	}
}

// ── 8. sweepTerminalSteerRecords ──────────────────────────────────
{
	const gcDir = join(dir, "gc");
	const now = new Date("2026-10-12T12:00:00.000Z");
	writeSteerAtomic(gcDir, sampleValid({
		id: "steer_old_delivered", status: "delivered", deliveredAt: "2026-10-11T00:00:00.000Z",
	}));
	writeSteerAtomic(gcDir, sampleValid({
		id: "steer_new_delivered", status: "delivered", deliveredAt: "2026-10-12T11:00:00.000Z",
	}));
	writeSteerAtomic(gcDir, sampleValid({ id: "steer_still_pending", createdAt: "2026-10-01T00:00:00.000Z" }));
	// 孤儿 .claimed（对应 json 不存在）
	writeFileSync(steerClaimPath(gcDir, TAB, "steer_orphan_claim"), "", "utf8");

	const swept = sweepTerminalSteerRecords(gcDir, TAB, { now, maxAgeMs: 24 * 60 * 60 * 1000 });
	assert.equal(swept, 1, "仅删除超 TTL 的终态记录");
	assert.equal(existsSync(steerFilePath(gcDir, TAB, "steer_old_delivered")), false, "超龄终态被删");
	assert.equal(existsSync(steerFilePath(gcDir, TAB, "steer_new_delivered")), true, "新鲜终态保留");
	assert.equal(existsSync(steerFilePath(gcDir, TAB, "steer_still_pending")), true, "pending 永不在此清理");
	assert.equal(existsSync(steerClaimPath(gcDir, TAB, "steer_orphan_claim")), false, "孤儿 .claimed 清理");

	// 清空后目录被回收（empty dir cleanup）
	const emptyBase = join(dir, "gc-empty");
	const EMPTY_TAB = "tab_gc_empty";
	writeSteerAtomic(emptyBase, sampleValid({
		id: "steer_gone", tabRunId: EMPTY_TAB, status: "failed", failedAt: "2026-10-10T00:00:00.000Z",
	}));
	assert.ok(existsSync(join(emptyBase, EMPTY_TAB)), "清理前 tab 目录存在");
	sweepTerminalSteerRecords(emptyBase, EMPTY_TAB, { now, maxAgeMs: 60_000 });
	assert.equal(readAllSteerRecords(emptyBase, EMPTY_TAB).length, 0, "超龄终态记录已清");
	assert.equal(existsSync(join(emptyBase, EMPTY_TAB)), false, "空目录被回收（无目录堆积）");
}

// ── 9. expirePendingSteerRecords（含目标存活反例）────────────────────
{
	const expDir = join(dir, "expire");
	const now = new Date("2026-10-12T12:00:00.000Z");
	writeSteerAtomic(expDir, sampleValid({ id: "steer_dead_old", createdAt: "2026-10-12T10:00:00.000Z" }));
	writeSteerAtomic(expDir, sampleValid({ id: "steer_dead_old2", createdAt: "2026-10-12T10:00:00.000Z" }));
	writeSteerAtomic(expDir, sampleValid({ id: "steer_dead_fresh", createdAt: "2026-10-12T11:59:00.000Z" }));
	writeSteerAtomic(expDir, sampleValid({
		id: "steer_dead_terminal", status: "delivered", deliveredAt: "2026-10-12T10:00:00.000Z", createdAt: "2026-10-12T08:00:00.000Z",
	}));

	// 反例：目标存活 → 即便超 TTL 也不置 undelivered（长 tool 批期间 pending 是正常态）
	assert.equal(
		expirePendingSteerRecords(expDir, TAB, { now, maxAgeMs: 30 * 60 * 1000, targetAlive: () => true }),
		0,
		"目标存活时不置 undelivered",
	);
	assert.equal(readSteerRecord(expDir, TAB, "steer_dead_old")!.status, "pending", "仍为 pending");

	// 目标不活 + 超 TTL → undelivered（两条超龄都置终态，新鲜/终态不动）
	assert.equal(
		expirePendingSteerRecords(expDir, TAB, { now, maxAgeMs: 30 * 60 * 1000, targetAlive: () => false }),
		2,
		"仅超龄 pending 置 undelivered",
	);
	const done = readSteerRecord(expDir, TAB, "steer_dead_old")!;
	assert.equal(done.status, "undelivered");
	assert.equal(done.undeliveredReason, "ttl-expired");
	assert.ok(done.undeliveredAt, "undeliveredAt 必写");
	assert.equal(readSteerRecord(expDir, TAB, "steer_dead_old2")!.status, "undelivered", "第二条超龄 pending 也置终态");
	assert.equal(readSteerRecord(expDir, TAB, "steer_dead_fresh")!.status, "pending", "新鲜 pending 不动");
	assert.equal(readSteerRecord(expDir, TAB, "steer_dead_terminal")!.status, "delivered", "终态不被改写");

	// targetAlive 抛错 → 保守视为活（不误报）
	assert.equal(
		expirePendingSteerRecords(expDir, TAB, {
			now, maxAgeMs: 1, targetAlive: () => { throw new Error("probe failed"); },
		}),
		0,
		"活性探测异常 → 不置 undelivered",
	);
}

// ── 10. sendSteerQuietly 四分类 ───────────────────────────────────
{
	let captured: { body: string; opts?: { deliverAs?: string } } | undefined;
	assert.equal(await sendSteerQuietly((body, opts) => { captured = { body, opts }; }, "hi"), "sent", "resolve → sent");
	assert.equal(captured!.body, "hi");
	assert.equal(captured!.opts?.deliverAs, "steer", "deliverAs 必须固定为 steer");

	assert.equal(
		await sendSteerQuietly(() => Promise.reject(new Error("compaction in progress")), "hi"),
		"retryable",
		"compaction reject → retryable",
	);
	assert.equal(
		await sendSteerQuietly(() => Promise.reject(new Error("Connection error.")), "hi"),
		"failed",
		"其他 reject → failed",
	);
	assert.equal(await sendSteerQuietly(undefined, "hi"), "no-injector", "无 send → no-injector");
	assert.equal(
		await sendSteerQuietly(() => { throw new Error("sync boom"); }, "hi"),
		"failed",
		"同步 throw → failed",
	);
	// 防御性：deliverAs 路径理论不可达的 already processing 按 retryable 处理（沿用 injectFollowUpQuietly busy 口径）
	assert.equal(
		await sendSteerQuietly(() => Promise.reject(new Error("Agent is already processing a prompt")), "hi"),
		"retryable",
		"already processing → retryable（防御性）",
	);

	const detail = await sendSteerDetailed(() => Promise.reject(new Error("Connection error.")), "hi");
	assert.equal(detail.status, "failed");
	assert.equal(detail.error, "Connection error.", "failed 附 error 文本（写回执用）");
}

console.log("✓ _test_steer: all assertions passed");
