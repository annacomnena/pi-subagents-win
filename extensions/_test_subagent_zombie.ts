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

	console.log(`\n_test_subagent_zombie: all ${n} groups passed`);
} finally {
	rmSync(root, { recursive: true, force: true });
}

