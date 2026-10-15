/**
 * _test_subagent_zombie.ts — 僵尸看门狗的独立验证（另起进程，不依赖真实 runs 目录）。
 *
 * 覆盖（对应计划 §6 / 审查 M1-M3）：
 *   Z1  pid 死亡 ⇒ zombie（硬证据）
 *   Z2  幂等（CAS）：同一 run 二次调 ⇒ 第二次 already-reaped
 *   Z3  **跨进程**恰好一次（真实两个 node 子进程争抢，非同事件循环）
 *   Z4  活 pid ⇒ 不判
 *   Z5  无 pid + 未超龄 ⇒ 不判
 *   Z6  无 pid + 超龄 ⇒ **观察模式默认只写 suspect 标记**（不改状态）
 *   Z7  已是终态 ⇒ 不覆盖（文件逐字节未变）
 *   Z8  无时间基准 ⇒ 不判
 *   Z9  原子写：终态文件始终是完整可解析 JSON
 *   Z10 迟到旧 finalize：赢下 CAS 后若已被别家写成终态 ⇒ 不覆盖
 *
 * 运行：npm run test:subagent-zombie
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
	__setClaimReapTestHook,
	claimReap,
	detectZombie,
	reapZombie,
	reapZombiesInDir,
	writeRecordAtomic,
	readRunRecord,
} from "./subagent-zombie.ts";

let n = 0;
const ok = (name: string): void => {
	n += 1;
	console.log(`ok ${n} - ${name}`);
};

const root = mkdtempSync(join(tmpdir(), "zombie-test-"));
const mk = (id: string, rec: Record<string, unknown>): void => {
	writeFileSync(join(root, `${id}.json`), JSON.stringify(rec));
};
const iso = (ms: number): string => new Date(ms).toISOString();
const NOW = Date.parse("2026-10-16T02:00:00Z");
const longAgo = iso(NOW - 12 * 60 * 60 * 1000); // 12h 前（事故样本量级）
const justNow = iso(NOW - 5_000);               // 5s 前（刚活动）

try {
	// ── Z1：pid 死亡 ⇒ zombie（硬证据）────────────────────────────────
	{
		const pid = 999_999_999; // 几乎必然不存在
		mk("run_z1", { id: "run_z1", status: "running", startedAt: longAgo, pidRecordedAt: longAgo, lastActivity: longAgo, pid });
		const v = detectZombie(readRunRecord(root, "run_z1")!, { now: () => NOW, isPidAlive: () => false });
		assert.equal(v.zombie, true, "pid 死 ⇒ 判 zombie");
		assert.equal(v.reason, "pid-dead");
		const r = reapZombie(root, "run_z1", { now: () => NOW, deps: { isPidAlive: () => false } });
		assert.equal(r.reaped, true);
		const after = readRunRecord(root, "run_z1")!;
		assert.equal(after.status, "failed", "落 failed");
		assert.equal((after.failure as { kind: string }).kind, "zombie", "failure.kind=zombie");
		assert.equal((after.failure as { source: string }).source, "watchdog");
		assert.ok(typeof after.endedAt === "string" && after.endedAt.length > 0, "endedAt 有值");
		assert.equal((after.result as { status: string }).status, "failed", "result.status=failed（不被当完成）");
		ok("Z1 pid 死亡 ⇒ failed(zombie) + endedAt + result=failed");
	}

	// ── Z2：幂等（同进程二次调）──────────────────────────────────────
	{
		const r2 = reapZombie(root, "run_z1", { now: () => NOW, deps: { isPidAlive: () => false } });
		assert.equal(r2.reaped, false, "第二次不再落终态");
		assert.equal(r2.reason, "not-running", "已是 failed ⇒ not-running（状态短路）");
		ok("Z2 幂等：二次调 reaped=false");
	}

	// ── Z3：跨进程恰好一次（真实 2 个 node 进程争抢 CAS）──────────────
	{
		const id = "run_z3";
		mk(id, { id, status: "running", startedAt: longAgo, pidRecordedAt: longAgo, lastActivity: longAgo, pid: 999_999_999 });
		const script = `
			import { reapZombie } from ${JSON.stringify(new URL("./subagent-zombie.ts", import.meta.url).href)};
			const r = reapZombie(${JSON.stringify(root)}, ${JSON.stringify(id)}, {
				now: () => ${NOW}, deps: { isPidAlive: () => false },
			});
			process.stdout.write(JSON.stringify(r));
		`;
		const runOne = (): Promise<string> =>
			new Promise((res, rej) => {
				const p = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
					stdio: ["ignore", "pipe", "pipe"],
				});
				let out = "";
				p.stdout.on("data", (d) => (out += String(d)));
				p.on("close", (code) => (code === 0 ? res(out) : rej(new Error(`exit ${code}: ${out}`))));
			});
		const [a, b] = await Promise.all([runOne(), runOne()]);
		const ra = JSON.parse(a) as { reaped: boolean };
		const rb = JSON.parse(b) as { reaped: boolean };
		const winners = [ra, rb].filter((r) => r.reaped).length;
		assert.equal(winners, 1, `两个进程恰有 1 个赢得 CAS（实得 ${winners}）`);
		assert.ok(existsSync(join(root, `${id}.reaped`)), ".reaped 标记存在");
		ok("Z3 跨进程 CAS：两个真实 node 进程恰好一个落终态");
	}

	// ── Z4：活 pid ⇒ 不判 ─────────────────────────────────────────────
	{
		// 身份匹配的正确夹具：进程启动时间必须落在 pidRecordedAt 的容差窗口内
		mk("run_z4", { id: "run_z4", status: "running", startedAt: longAgo, pidRecordedAt: longAgo, lastActivity: longAgo, pid: process.pid });
		const v = detectZombie(readRunRecord(root, "run_z4")!, {
			now: () => NOW,
			isPidAlive: () => true,
			// drift = NOW-30s − longAgo(12h前) = 约 +12h… ⇒ 不匹配。故把 startedAtMs 设成与登记同刻
			inspectLiveProcess: () => ({ pid: process.pid, startedAtMs: Date.parse(longAgo) + 1_000 }),
		});
		assert.equal(v.zombie, false, "活 pid 不判");
		ok("Z4 活 pid（身份匹配）⇒ 不判（误杀防护）");
	}

	// ── Z4b：pid 被重用（身份不匹配）⇒ 硬证据 zombie ───────────────────
	{
		mk("run_z4b", { id: "run_z4b", status: "running", startedAt: longAgo, pidRecordedAt: longAgo, lastActivity: longAgo, pid: 12345 });
		const v = detectZombie(readRunRecord(root, "run_z4b")!, {
			now: () => NOW,
			isPidAlive: () => true,
			// 启动时间比登记时刻晚 1h ⇒ 明显不是同一进程
			inspectLiveProcess: () => ({ pid: 12345, startedAtMs: NOW }),
		});
		assert.equal(v.zombie, true, "pid 重用 ⇒ 判 zombie");
		assert.equal(v.reason, "pid-reused");
		ok("Z4b pid 被 OS 重用 ⇒ zombie(pid-reused)");
	}

	// ── Z5：无 pid 未超龄 ⇒ 不判 ─────────────────────────────────────
	{
		mk("run_z5", { id: "run_z5", status: "running", startedAt: justNow, lastActivity: justNow });
		const v = detectZombie(readRunRecord(root, "run_z5")!, { now: () => NOW });
		assert.equal(v.zombie, false);
		ok("Z5 无 pid + 刚活动 ⇒ 不判");
	}

	// ── Z6：无 pid + 超龄 ⇒ 默认观察模式（只写 suspect，不改状态）──────
	{
		mk("run_z6", { id: "run_z6", status: "running", startedAt: longAgo, lastActivity: longAgo });
		delete process.env.PI_SUBAGENT_ZOMBIE_AUTO;
		const r = reapZombie(root, "run_z6", { now: () => NOW });
		assert.equal(r.reaped, false, "默认观察模式不落终态");
		assert.equal(r.reason, "observe-only");
		assert.equal(r.suspect, true, "写了观察标记");
		assert.equal(readRunRecord(root, "run_z6")!.status, "running", "状态未被改（保守）");
		assert.ok(existsSync(join(root, "run_z6.zombie-suspect")), ".zombie-suspect 标记存在");
		// 开 auto ⇒ 落终态
		process.env.PI_SUBAGENT_ZOMBIE_AUTO = "1";
		const r2 = reapZombie(root, "run_z6", { now: () => NOW });
		assert.equal(r2.reaped, true, "auto 模式下落终态");
		assert.equal(readRunRecord(root, "run_z6")!.status, "failed");
		delete process.env.PI_SUBAGENT_ZOMBIE_AUTO;
		ok("Z6 无 pid+超龄：默认只观察（suspect）；auto=1 才落终态");
	}

	// ── Z7：已是终态 ⇒ 不覆盖（逐字节未变）───────────────────────────
	{
		const rec = { id: "run_z7", status: "completed", startedAt: longAgo, lastActivity: longAgo, pid: 999_999_999, result: { status: "completed", text: "done" } };
		mk("run_z7", rec);
		const before = readFileSync(join(root, "run_z7.json"), "utf8");
		const r = reapZombie(root, "run_z7", { now: () => NOW, deps: { isPidAlive: () => false } });
		assert.equal(r.reaped, false, "completed 不被 zombie 覆盖");
		assert.equal(readFileSync(join(root, "run_z7.json"), "utf8"), before, "文件逐字节未变");
		ok("Z7 已终态（completed）⇒ 不覆盖且文件不变");
	}

	// ── Z8：无时间基准 ⇒ 不判 ────────────────────────────────────────
	{
		mk("run_z8", { id: "run_z8", status: "running" });
		const v = detectZombie(readRunRecord(root, "run_z8")!, { now: () => NOW });
		assert.equal(v.zombie, false);
		assert.equal(v.reason, "no-time-basis");
		ok("Z8 无 startedAt/pidRecordedAt ⇒ 不判（no-time-basis）");
	}

	// ── Z9：原子写 ⇒ 终态文件始终可解析 ──────────────────────────────
	{
		const id = "run_z9";
		mk(id, { id, status: "running", startedAt: longAgo, lastActivity: longAgo, pid: 999_999_999 });
		writeRecordAtomic(root, id, { id, status: "failed", note: "atomic" });
		const parsed = JSON.parse(readFileSync(join(root, `${id}.json`), "utf8"));
		assert.equal(parsed.status, "failed", "原子写内容正确");
		// 无残留 tmp 文件
		const leftovers = readdirSync(root).filter((f) => f.includes(".tmp-"));
		assert.deepEqual(leftovers, [], "无 tmp 残留");
		ok("Z9 原子写（tmp+rename）⇒ 无半截文件、无 tmp 残留");
	}

	// ── Z10：迟到旧 finalize ⇒ CAS 赢家发现已终态则不覆盖 ──────────────
	{
		const id = "run_z10";
		mk(id, { id, status: "running", startedAt: longAgo, lastActivity: longAgo, pid: 999_999_999 });
		// 先占掉 CAS 名额，再把它改成 completed（模拟真实 finalize 抢先）
		writeFileSync(join(root, `${id}.reaped`), "{}", { flag: "wx" });
		mk(id, { id, status: "completed", startedAt: longAgo, lastActivity: longAgo, result: { status: "completed" } });
		const r = reapZombie(root, id, { now: () => NOW, deps: { isPidAlive: () => false } });
		assert.equal(r.reaped, false, "不落终态");
		// 两层防护都可能先命中：状态短路（not-running）或 CAS（already-reaped）
		// 二者都正确——重点是「真完成未被覆盖」。此处因状态已 completed，短路更早生效。
		assert.ok(["not-running", "already-reaped"].includes(r.reason), `防护命中（实得 ${r.reason}）`);
		assert.equal(readRunRecord(root, id)!.status, "completed", "真完成未被覆盖");
		ok("Z10 已终态 ⇒ 双层防护（状态短路/CAS）阻止覆盖真完成");
	}

	// ── Z11：批量扫描 + limit + 只看 *.json ──────────────────────────
	{
		const r = reapZombiesInDir(root, { now: () => NOW, deps: { isPidAlive: () => false }, limit: 3 });
		assert.ok(r.scanned <= 3, `limit 生效（scanned=${r.scanned}）`);
		ok("Z11 批量扫描遵守 limit（不在 UI 读路径无界扫）");
	}

	// ── Z12：CAS 僵锁接管（L4 P1-3：赢家崩溃后不得永久卡死）──────────────
	{
		const id = "run_z12";
		mk(id, { id, status: "running", startedAt: longAgo, pidRecordedAt: longAgo, lastActivity: longAgo, pid: 999_999_999 });
		// 造一个「很旧」的锁（模拟赢家拿到锁后崩溃、run 仍 running）
		const staleAt = iso(NOW - 10 * 60 * 1000); // 10min 前 > TTL(5min)
		writeFileSync(join(root, `${id}.reaped`), JSON.stringify({ reason: "pid-dead", at: staleAt }), { flag: "wx" });
		const r = reapZombie(root, id, { now: () => NOW, deps: { isPidAlive: () => false } });
		assert.equal(r.reaped, true, "僵锁应被接管（否则永久卡死）");
		assert.equal(readRunRecord(root, id)!.status, "failed", "接管后落终态");
		ok("Z12 CAS 僵锁接管（TTL 超龄 ⇒ 可被接管，防永久卡死）");
	}

	// ── Z13：result.status 已是终态 ⇒ 不覆盖（L4 P1-5）─────────────────
	{
		const id = "run_z13";
		// 顶层仍 running，但 result 已 completed（真完成只写在了 result 上）
		mk(id, { id, status: "running", startedAt: longAgo, lastActivity: longAgo, pid: 999_999_999, result: { status: "completed", text: "done" } });
		const r = reapZombie(root, id, { now: () => NOW, deps: { isPidAlive: () => false } });
		assert.equal(r.reaped, false, "result=completed 不被 zombie 覆盖");
		assert.equal(readRunRecord(root, id)!.status, "running", "顶层 status 未被改写");
		ok("Z13 result.status=completed ⇒ 不覆盖（只查顶层 status 不够，已补）");
	}

	// ── Z14：runIds 白名单（L4 P1-4：不得回收他人会话的 run）────────────
	{
		mk("run_z14a", { id: "run_z14a", status: "running", startedAt: longAgo, lastActivity: longAgo, pid: 999_999_999 });
		mk("run_z14b", { id: "run_z14b", status: "running", startedAt: longAgo, lastActivity: longAgo, pid: 999_999_999 });
		const r = reapZombiesInDir(root, { now: () => NOW, deps: { isPidAlive: () => false }, runIds: ["run_z14a"] });
		assert.deepEqual(r.reaped, ["run_z14a"], "只回收白名单内的 run");
		assert.equal(readRunRecord(root, "run_z14b")!.status, "running", "白名单外的 run 未被触碰");
		ok("Z14 runIds 白名单：只回收本会话可见的 run（跨会话语义防护）");
	}


	// ── Z15：**跨进程**僵锁双接管竞态（L4 二轮 P1：旧实现可双赢家）────────
	{
		const id = "run_z15";
		mk(id, { id, status: "running", startedAt: longAgo, pidRecordedAt: longAgo, lastActivity: longAgo, pid: 999_999_999 });
		// 造僵锁（超 TTL）
		writeFileSync(join(root, `${id}.reaped`), JSON.stringify({ reason: "pid-dead", at: iso(NOW - 30 * 60 * 1000) }), { flag: "wx" });
		const script = `
			import { reapZombie } from ${JSON.stringify(new URL("./subagent-zombie.ts", import.meta.url).href)};
			const r = reapZombie(${JSON.stringify(root)}, ${JSON.stringify(id)}, {
				now: () => ${NOW}, deps: { isPidAlive: () => false },
			});
			process.stdout.write(JSON.stringify(r));
		`;
		const runOne = (): Promise<string> =>
			new Promise((res, rej) => {
				const p = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
				let out = "";
				p.stdout.on("data", (d) => (out += String(d)));
				p.on("close", (c) => (c === 0 ? res(out) : rej(new Error(`exit ${c}: ${out}`))));
			});
		const outs = await Promise.all([runOne(), runOne(), runOne()]);
		const winners = outs.map((o) => JSON.parse(o) as { reaped: boolean }).filter((r) => r.reaped).length;
		assert.equal(winners, 1, `僵锁接管必须恰好 1 个赢家（实得 ${winners}）`);
		assert.equal(readRunRecord(root, id)!.status, "failed", "恰好一次落终态");
		// ⚠️ 诚实声明：跨进程撞窄竞态窗口的概率低（实测 3 进程在旧实现下也常 1 赢家）
		// ⇒ 本用例是**烟雾测试**，不是竞态证明。真正的语义断言在 Z16。
		ok("Z15 跨进程僵锁接管（烟雾：3 进程恰 1 赢家）");
	}


	// ── Z16：僵锁**语义**验证（Z15 是弱烟雾；此处直接断言「只能接管一次」）──
	{
		const id = "run_z16";
		mk(id, { id, status: "running", startedAt: longAgo, pidRecordedAt: longAgo, lastActivity: longAgo, pid: 999_999_999 });
		// 造僵锁（超 TTL），然后连续 20 次调用 reapZombie：
		// 无论实现细节如何，**语义上**只允许 1 次成功落终态。
		let reapedCount = 0;
		for (let i = 0; i < 20; i++) {
			mk(id, { id, status: "running", startedAt: longAgo, pidRecordedAt: longAgo, lastActivity: longAgo, pid: 999_999_999 });
			if (i === 0) writeFileSync(join(root, `${id}.reaped`), JSON.stringify({ reason: "pid-dead", at: iso(NOW - 30 * 60 * 1000) }), { flag: "wx" });
			const r = reapZombie(root, id, { now: () => NOW, deps: { isPidAlive: () => false } });
			if (r.reaped) reapedCount++;
		}
		assert.equal(reapedCount, 1, `僵锁语义：20 次尝试只允许 1 次接管成功（实得 ${reapedCount}）`);
		ok("Z16 僵锁语义：N 次尝试只允许 1 次接管（不依赖撞窗口）");
	}


	// ── Z17：僵锁接管的**确定性**验证（Z15/Z16 都不能确定抓到旧实现）────────
	{
		const id = "run_z17";
		mk(id, { id, status: "running", startedAt: longAgo, lastActivity: longAgo, pid: 999_999_999 });
		// 造僵锁
		writeFileSync(join(root, `${id}.reaped`), JSON.stringify({ at: iso(NOW - 30 * 60 * 1000) }), { flag: "wx" });
		const meta = { reason: "pid-dead" as const, at: iso(NOW) };
		// 单元级：直接调 claimReap 两次（同 now ⇒ 都认为锁是僵的）。
		// 正确实现：第一次用 rename 移走僵锁⇒赢；第二次 rename 失败(ENOENT)⇒输。
		// 旧式 rmSync+wx：两次都能删+建 ⇒ **两次都赢**（双赢家）。
		const w1 = claimReap(root, id, meta, { now: () => NOW });
		const w2 = claimReap(root, id, meta, { now: () => NOW });
		assert.equal(w1, true, "第一次接管应成功");
		assert.equal(w2, false, `第二次必须失败（否则双赢家）——旧 rmSync+wx 会 true`);
		ok("Z17 僵锁接管确定性：同锁两次接管只能 1 次成功（能抓旧实现）");
	}


	// ── Z18：僵锁接管**确定性竞态**（用 seam 复现窄窗口；Z15-Z17 都抓不住）────
	{
		const id = "run_z18";
		const meta = { reason: "pid-dead" as const, at: iso(NOW) };
		mk(id, { id, status: "running", startedAt: longAgo, lastActivity: longAgo, pid: 999_999_999 });
		writeFileSync(join(root, `${id}.reaped`), JSON.stringify({ at: iso(NOW - 30 * 60 * 1000) }), { flag: "wx" });
		// 在「A 判定僵锁」之后、「A 实际接管」之前，让 B 完成整个接管流程。
		// 正确实现：A 的 rename 会因「僵锁已被 B 移走」而 ENOENT ⇒ A 输 ⇒ 单赢家。
		// 旧式 rmSync+wx：A 会把 B 的新锁删掉重建 ⇒ **双赢家**。
		let bWon: boolean | undefined;
		__setClaimReapTestHook(() => {
			__setClaimReapTestHook(undefined); // 防递归
			bWon = claimReap(root, id, meta, { now: () => NOW });
		});
		const aWon = claimReap(root, id, meta, { now: () => NOW });
		__setClaimReapTestHook(undefined);
		assert.equal(bWon, true, "B（插入者）应赢");
		assert.equal(aWon, false, `A 必须输（否则双赢家）——旧 rmSync+wx 会给 aWon=true`);
		ok("Z18 僵锁双接管确定性竞态（seam）：插入者赢、原接管者输 ⇒ 无双赢家");
	}


	console.log(`\n_test_subagent_zombie: all ${n} groups passed`);
} finally {
	rmSync(root, { recursive: true, force: true });
}

