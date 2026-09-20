/**
 * _test_runtime_liveness.ts — G5.2 读侧补全测试（plans/0921_G5_gui_research.md 缺口①②③）
 *
 *   T1 liveness 读写/节流/never-throw：roundtrip 字段保真；30s 内同身份跳写、身份变化立即写；
 *      缺失/坏 JSON/坏版本 → readLiveness null；IO 异常收敛 false 不抛。
 *   T2 snapshot 新字段：master.liveness 直出 + master.autoHandoff config 切片
 *      （缺失 → 默认非 error / 坏 JSON → sectionError + 默认）+ workstream.wakeState /
 *      mailboxBacklog（per-ws spool 匹配，mailbox 缺失 → 0）。
 *   T3 timeline before= 排他上界翻页：严格前缀、limit 组合、未知 id → []（终止信号）。
 *   T4 /v1/timeline?before= HTTP 透传 + snapshot 端点新字段在 HTTP 面可见。
 *
 * 运行：npm run test:runtime-liveness
 */

import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// 隔离（同既有 runtime 测试纪律：env 先于 import）
process.env.PI_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "runtime-liveness-env-"));
const ROOT = process.env.PI_RUNTIME_DIR!;
const STATE = join(ROOT, "state");
const MAILBOX = join(ROOT, "mailbox");
const JOURNAL = join(ROOT, "events.jsonl");

import { masterAddress, workstreamAddress } from "./runtime/address.ts";
import { newEventEnvelope } from "./runtime/envelope.ts";
import { readLiveness, writeLiveness, LIVENESS_THROTTLE_MS } from "./runtime/liveness.ts";
import { deliverCommand } from "./runtime/mailbox.ts";
import { newCommandFrame } from "./runtime/protocol.ts";
import { createWorkstream } from "./runtime/workstreams.ts";
import { buildRuntimeSnapshot } from "./runtime-host/snapshot.ts";
import { buildTimelineItems } from "./runtime-host/timeline.ts";
import { createRuntimeHostServer, type RuntimeHostHandle } from "./runtime-host/server.ts";

const T0 = Date.parse("2026-09-21T10:00:00.000Z");
const atMs = (ms: number): Date => new Date(T0 + ms);

try {
	// ── T1 liveness 读写/节流/never-throw ─────────────────────────────
	{
		const dir = join(ROOT, "t1-state");
		assert.equal(readLiveness(dir), null, "缺失 → null");

		const t1 = writeLiveness(
			{ sessionId: "sess-A", generation: 3, pressure: 82.5, windowTokens: 200_000 },
			{ stateDir: dir, now: atMs(0) },
		);
		assert.equal(t1, true, "首写成功");
		const live = readLiveness(dir)!;
		assert.equal(live.version, 1);
		assert.equal(live.sessionId, "sess-A");
		assert.equal(live.generation, 3);
		assert.equal(live.pressure, 82.5);
		assert.equal(live.windowTokens, 200_000);
		assert.equal(live.updatedAt, atMs(0).toISOString());

		// 节流：30s 内同身份跳写（updatedAt 不变）
		const skipped = writeLiveness(
			{ sessionId: "sess-A", generation: 3, pressure: 90 },
			{ stateDir: dir, now: atMs(LIVENESS_THROTTLE_MS - 1000) },
		);
		assert.equal(skipped, false, "30s 内跳写");
		assert.equal(readLiveness(dir)!.pressure, 82.5, "跳写不覆盖旧值");
		assert.equal(readLiveness(dir)!.updatedAt, atMs(0).toISOString());

		// 节流窗口外 → 写入
		assert.equal(
			writeLiveness({ sessionId: "sess-A", generation: 3, pressure: 88 }, { stateDir: dir, now: atMs(LIVENESS_THROTTLE_MS + 1000) }),
			true,
			"窗口外写入",
		);
		assert.equal(readLiveness(dir)!.pressure, 88);

		// 身份变化（新 owner / 新代）→ 立即写不被节流吞
		assert.equal(
			writeLiveness({ sessionId: "sess-B", generation: 4, pressure: 12 }, { stateDir: dir, now: atMs(LIVENESS_THROTTLE_MS + 2000) }),
			true,
			"sessionId 变化立即写",
		);
		assert.equal(readLiveness(dir)!.sessionId, "sess-B");
		assert.equal(
			writeLiveness({ sessionId: "sess-B", generation: 5, pressure: 14 }, { stateDir: dir, now: atMs(LIVENESS_THROTTLE_MS + 3000) }),
			true,
			"generation 变化立即写",
		);
		assert.equal(readLiveness(dir)!.generation, 5);

		// 无 windowTokens → 字段缺席；pressure null（no decision）→ 原样落 null
		assert.equal(
			writeLiveness({ sessionId: "sess-B", generation: 6, pressure: null }, { stateDir: dir, now: atMs(LIVENESS_THROTTLE_MS + 4000) }),
			true,
		);
		const live6 = readLiveness(dir)!;
		assert.equal(live6.pressure, null);
		assert.equal(live6.windowTokens, undefined);
		assert.equal("windowTokens" in live6, false, "非法/缺席 windowTokens 不落字段");

		// 坏盘面：坏 JSON / 坏版本 → readLiveness null；随后可正常覆写
		const badDir = join(ROOT, "t1-bad");
		mkdirSync(badDir, { recursive: true });
		writeFileSync(join(badDir, "master-liveness.json"), "{not json");
		assert.equal(readLiveness(badDir), null, "坏 JSON → null");
		writeFileSync(
			join(badDir, "master-liveness.json"),
			JSON.stringify({ version: 2, sessionId: "x", generation: 1, pressure: 1, updatedAt: atMs(0).toISOString() }),
		);
		assert.equal(readLiveness(badDir), null, "坏版本 → null");
		assert.equal(writeLiveness({ sessionId: "sess-C", generation: 1, pressure: 5 }, { stateDir: badDir, now: atMs(0) }), true, "坏盘面覆写成功");

		// never-throw：stateDir 是普通文件 → 写失败收敛 false，不抛
		const fileAsDir = join(ROOT, "file-as-dir");
		writeFileSync(fileAsDir, "x");
		assert.doesNotThrow(() => writeLiveness({ sessionId: "s", generation: 1, pressure: 1 }, { stateDir: fileAsDir, now: atMs(0) }));
		assert.equal(
			writeLiveness({ sessionId: "s", generation: 1, pressure: 1 }, { stateDir: fileAsDir, now: atMs(0) }),
			false,
			"IO 异常 → false",
		);
	}

	// ── T2 snapshot 新字段 ────────────────────────────────────────────
	{
		const dir = join(ROOT, "t2");
		const stateDir = join(dir, "state");
		mkdirSync(stateDir, { recursive: true });
		const journalPath = join(dir, "events.jsonl");
		const cfgPath = join(dir, "config.json");
		writeFileSync(cfgPath, JSON.stringify({ keep: 1, masterSuccession: { enabled: true, auto: true, proposalPercent: 70, autoPercent: 85 } }));

		// master.liveness 直出 + autoHandoff 切片
		writeLiveness({ sessionId: "sess-L", generation: 2, pressure: 64, windowTokens: 128_000 }, { stateDir, now: atMs(0) });
		const s1 = buildRuntimeSnapshot({ stateDir, mailboxDir: MAILBOX, journalPath, configPath: cfgPath, now: atMs(1000) });
		assert.deepEqual(s1.sectionErrors, [], "正常时无段级错误");
		assert.equal(s1.master.liveness?.sessionId, "sess-L");
		assert.equal(s1.master.liveness?.pressure, 64);
		assert.deepEqual(s1.master.autoHandoff, { enabled: true, auto: true, proposalPercent: 70, autoPercent: 85 }, "config 切片归一化直出");

		// workstream：wakeState + mailboxBacklog
		const ws = createWorkstream({ stateDir, mission: "G5.2 wake/backlog 对象", session: "setup" });
		mkdirSync(join(stateDir, "wake-state"), { recursive: true });
		writeFileSync(
			join(stateDir, "wake-state", `${ws.id}.json`),
			JSON.stringify({ workstreamId: ws.id, lastSpawnAt: atMs(500).toISOString(), lastTabRunId: "tab_x1", spawnAt: [atMs(500).toISOString()], updatedAt: atMs(500).toISOString() }),
		);
		deliverCommand(
			newCommandFrame({ type: "agent.wake", to: workstreamAddress(ws.id), issuedBy: "agent://worker", commandKey: "wake-1", issuedAt: atMs(600).toISOString() }),
			{ mailboxDir: MAILBOX },
		);
		const s2 = buildRuntimeSnapshot({ stateDir, mailboxDir: MAILBOX, journalPath, configPath: cfgPath, now: atMs(2000) });
		const wsv = s2.workstreams[0];
		assert.equal(wsv.wakeState.lastTabRunId, "tab_x1", "wakeState 直出（readWakeState 同源）");
		assert.deepEqual(wsv.mailboxBacklog, { pending: 1, claimed: 0 }, "per-ws 信箱积压按 spool 目录匹配");
		// 无信工作流 → 0，不缺席
		const ws2 = createWorkstream({ stateDir, mission: "无信对象", session: "setup" });
		const s3 = buildRuntimeSnapshot({ stateDir, mailboxDir: MAILBOX, journalPath, configPath: cfgPath, now: atMs(3000) });
		const empty = s3.workstreams.find((w) => w.id === ws2.id)!;
		assert.deepEqual(empty.mailboxBacklog, { pending: 0, claimed: 0 }, "无信工作流 → 零计数");
		assert.deepEqual(
			empty.wakeState,
			{ workstreamId: ws2.id, spawnAt: [], updatedAt: atMs(3000).toISOString() },
			"wake 缺席 → 默认空态（updatedAt=注入 now，确定性）",
		);

		// mailbox 缺失 → 积压 0 + 无 sectionError（tolerant）
		const s4 = buildRuntimeSnapshot({ stateDir, mailboxDir: join(dir, "no-such-mbox"), journalPath, configPath: cfgPath, now: atMs(4000) });
		assert.deepEqual(s4.sectionErrors, [], "缺失 mailbox 不算 error");
		assert.ok(s4.workstreams.every((w) => w.mailboxBacklog.pending === 0 && w.mailboxBacklog.claimed === 0));

		// config 缺失 → 默认切片、非 error；config 坏 JSON → sectionError + 默认切片
		const s5 = buildRuntimeSnapshot({ stateDir, mailboxDir: MAILBOX, journalPath, configPath: join(dir, "nope.json"), now: atMs(5000) });
		assert.deepEqual(s5.master.autoHandoff, { enabled: true, auto: false, proposalPercent: 75, autoPercent: 90 }, "缺失 config → 默认切片");
		assert.deepEqual(s5.sectionErrors, [], "缺失 config 不算 error");
		const brokenCfg = join(dir, "config-broken.json");
		writeFileSync(brokenCfg, "{not json");
		const s6 = buildRuntimeSnapshot({ stateDir, mailboxDir: MAILBOX, journalPath, configPath: brokenCfg, now: atMs(6000) });
		assert.deepEqual(s6.master.autoHandoff, { enabled: true, auto: false, proposalPercent: 75, autoPercent: 90 }, "坏 config → 默认切片");
		assert.ok(s6.sectionErrors.some((e) => e.startsWith("master.autoHandoff")), `坏 config 记子段错误：${s6.sectionErrors.join("|")}`);
	}

	// ── T3 timeline before= 排他上界翻页 ──────────────────────────────
	{
		const dir = join(ROOT, "t3");
		const stateDir = join(dir, "state");
		mkdirSync(stateDir, { recursive: true });
		const journalPath = join(dir, "events.jsonl");
		const linksPath = join(dir, "links.jsonl");
		const ids: string[] = [];
		for (let i = 0; i < 5; i++) {
			const env = newEventEnvelope({
				type: "run.completed",
				source: masterAddress(),
				subject: `run://tab/tab_${i}`,
				at: new Date(T0 + i * 60_000).toISOString(),
				dedupeKey: `t3:${i}`,
				payload: { summary: `s${i}` },
			});
			mkdirSync(dirname(journalPath), { recursive: true });
			appendFileSync(journalPath, `${JSON.stringify(env)}\n`, "utf8");
			ids.push(env.id);
		}
		const all = buildTimelineItems({ stateDir, journalPath, linksPath });
		assert.deepEqual(all.map((x) => x.id), ids, "前置：5 条 at 升序");

		const page2 = buildTimelineItems({ stateDir, journalPath, linksPath, before: ids[2] });
		assert.deepEqual(page2.map((x) => x.id), [ids[0], ids[1]], "before=<id2> 只含严格更旧（排他上界）");
		const page1 = buildTimelineItems({ stateDir, journalPath, linksPath, before: ids[0] });
		assert.deepEqual(page1, [], "before=<最旧> → 空");
		const pageUnknown = buildTimelineItems({ stateDir, journalPath, linksPath, before: "evt_does_not_exist" });
		assert.deepEqual(pageUnknown, [], "未知 id → 空（翻页终止信号）");
		const paged = buildTimelineItems({ stateDir, journalPath, linksPath, before: ids[4], limit: 2 });
		assert.deepEqual(paged.map((x) => x.id), [ids[2], ids[3]], "before + limit 组合：前缀的尾部 N 条");
		const emptyBefore = buildTimelineItems({ stateDir, journalPath, linksPath, before: "" });
		assert.equal(emptyBefore.length, 5, "空串 before 视同未启用");
	}

	// ── T4 /v1/timeline?before= HTTP 透传 + snapshot 端点新字段 ────────
	{
		const dir = join(ROOT, "t4");
		const stateDir = join(dir, "state");
		mkdirSync(stateDir, { recursive: true });
		const journalPath = join(dir, "events.jsonl");
		const ids: string[] = [];
		for (let i = 0; i < 3; i++) {
			const env = newEventEnvelope({
				type: "run.dispatched",
				source: masterAddress(),
				subject: `run://tab/tab_h${i}`,
				at: new Date(T0 + i * 60_000).toISOString(),
				dedupeKey: `t4:${i}`,
			});
			mkdirSync(dirname(journalPath), { recursive: true });
			appendFileSync(journalPath, `${JSON.stringify(env)}\n`, "utf8");
			ids.push(env.id);
		}
		writeLiveness({ sessionId: "sess-H", generation: 1, pressure: 42 }, { stateDir, now: atMs(0) });

		const h: RuntimeHostHandle = await createRuntimeHostServer({
			hostPath: join(dir, "host.json"),
			journalPath,
			stateDir,
			mailboxDir: join(dir, "mbox"),
			timersDir: join(dir, "timers"),
			linksPath: join(dir, "links.jsonl"),
			configPath: join(dir, "config.json"),
		});
		const base = `http://127.0.0.1:${h.info.port}`;
		try {
			const getJson = async (path: string): Promise<{ status: number; body: any }> => {
				const res = await fetch(`${base}${path}`);
				return { status: res.status, body: await res.json() };
			};
			const full = await getJson("/v1/timeline");
			assert.equal(full.status, 200);
			assert.deepEqual(full.body.timeline.map((x: any) => x.id), ids, "无 before → 全量尾窗");

			const older = await getJson(`/v1/timeline?before=${ids[2]}`);
			assert.equal(older.status, 200);
			assert.deepEqual(older.body.timeline.map((x: any) => x.id), [ids[0], ids[1]], "HTTP before= 排他上界透传");

			const stop = await getJson("/v1/timeline?before=evt_missing");
			assert.deepEqual(stop.body.timeline, [], "HTTP 未知 id → count 0（客户端停用加载更早）");

			const snap = await getJson("/v1/snapshot");
			assert.equal(snap.status, 200);
			assert.equal(snap.body.master.liveness.pressure, 42, "master.liveness 经 HTTP 可见");
			assert.equal(typeof snap.body.master.autoHandoff.auto, "boolean", "master.autoHandoff 经 HTTP 可见");
			assert.deepEqual(snap.body.sectionErrors, [], "注入 config 缺失（未写）→ 无段级错误");
		} finally {
			await h.close();
		}
	}
} finally {
	rmSync(ROOT, { recursive: true, force: true });
}

console.log("_test_runtime_liveness: all assertions passed");
