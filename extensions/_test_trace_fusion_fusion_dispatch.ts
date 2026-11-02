/**
 * fusionModel 消费链测试（2026-11-02，④）
 *
 * 现场依据：`fusionModel` 在设置面存在已久（tf-settings.ts），摘要文案明写「当前未实现消费」
 * ——packet 三段 / 复跑 / 越界校验做出来之后一直**只有 cross-test-report.md 等人读**。
 * 本测试锁三件事：
 *   ① 未设置 fusionModel ⇒ **零 spawn 零模型调用**，且跳过理由可见；
 *   ② 派发形状：argv 必须带 excludeTools（融合者不得派 subagent/开 tab/设 timer），
 *      提示词必须带材料路径 + 「拼装非投票」+ 复跑降级 + 越界不得引用原文；
 *   ③ **完成通知接线**：subagent-runs 的账本必须落**终态**（停在 running ⇒ watcher 永不通知
 *      = 静默失效，AGENTS.md R-2），且 links 必须记到派发者会话。
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFusionPrompt, dispatchFusion, FUSION_EXCLUDE_TOOLS } from "./trace-fusion/fusion-dispatch.ts";

const root = mkdtempSync(join(tmpdir(), "tf-fuse-"));

type FakeChild = EventEmitter & { kill: (sig?: string) => void };
const calls: { argv: string[]; opts: object }[] = [];
const fakeSpawn = (cmd: string, argv: string[], opts: object) => {
	const child = new EventEmitter() as FakeChild;
	child.kill = () => {};
	void cmd;
	calls.push({ argv, opts });
	return child;
};
/** 在下一 tick 让子进程"退出"，并可先写融合产物。 */
const fakeSpawnThatFinishes = (produce: boolean) => (cmd: string, argv: string[], opts: object) => {
	const child = fakeSpawn(cmd, argv, opts);
	setImmediate(() => {
		const runDir = join(root, "run");
		const out = join(runDir, "fusion", "fusion.md");
		if (produce) writeFileSync(out, "# 融合\n", "utf8");
		child.emit("exit", 0);
	});
	return child;
};

try {
	const runDir = join(root, "run");
	mkdirSync(join(runDir, "lanes", "A"), { recursive: true });
	const reportPath = join(runDir, "cross-test-report.md");
	writeFileSync(reportPath, "# 报告\n", "utf8");
	const runsDir = join(root, "runs");
	const linksPath = join(root, "links.jsonl");
	const base = {
		runId: "tfl-x",
		runDir,
		repoRoot: root,
		reportPath,
		piCli: join(root, "cli.js"),
		runsDir,
		linksPath,
		dispatcherSessionId: "sid-dispatcher",
	};
	writeFileSync(join(root, "cli.js"), "", "utf8");

	// ── ① 未设置 fusionModel ⇒ 零动作 ──
	{
		const r = await dispatchFusion({ ...base, fusionModel: undefined });
		assert.equal(r.status, "skipped", "未设置 fusionModel 必须跳过");
		assert.equal(r.zeroModelCall, true, "跳过必须是零模型调用");
		assert.equal(calls.length, 0, `未配置时不得 spawn，实得 ${calls.length} 次`);
		assert.ok(r.reason.includes("fusionModel"), "理由必须写明是模型未配置（R-2：降级不得静默）");
		assert.ok(!existsSync(join(runDir, "fusion", "fusion.claim")), "跳过时不得留下认领（否则下次无法再融合）");
	}

	// ── 提示词内容与硬纪律 ──
	{
		const p = buildFusionPrompt({ runId: "tfl-x", reportPath, outputPath: join(runDir, "fusion", "fusion.md"), repoRoot: root, laneModel: "bonsai-9b" });
		assert.ok(p.includes(reportPath), "必须给主材料路径");
		assert.ok(p.includes("拼装，不是投票"), "必须写死「拼装非投票」（设计稿 §25）");
		assert.ok(p.includes("声称pass实测失败"), "必须要求按复跑读数降级自报");
		assert.ok(p.includes("越界"), "必须要求越界引用不得原样引用");
		assert.ok(p.includes("禁止派发 subagent"), "必须禁止递归派发");
		assert.ok(p.includes("禁止 push"), "必须禁止 push");
		assert.ok(p.includes("## 6. 可复跑附录"), "输出必须含可复跑附录");
		assert.ok(p.includes("回复只要文件路径"), "必须要求路径优先");
	}

	// ── ②③ 派发形状 + 终态账本 + links 归属 ──
	{
		const r = await dispatchFusion({ ...base, fusionModel: "local-qwen38/medium", laneModel: "bonsai-9b", spawnFn: fakeSpawnThatFinishes(true) as never });
		assert.equal(calls.length, 1, `应 spawn 一次，实得 ${calls.length}`);
		const argv = calls[0].argv.join(" ");
		for (const t of FUSION_EXCLUDE_TOOLS) {
			assert.ok(argv.includes(t), `argv 必须排除 ${t}（融合者不得拥有该能力）`);
		}
		assert.ok(argv.includes("local-qwen38/medium"), "argv 必须用用户设置的融合模型");
		assert.ok((calls[0].opts as { cwd?: string }).cwd === root, "cwd 必须是仓根");

		const files = (await import("node:fs")).readdirSync(runsDir).filter((f) => f.startsWith("run_"));
		assert.equal(files.length, 1, "账本必须落 subagent-runs");
		const rec = JSON.parse(readFileSync(join(runsDir, files[0]), "utf8")) as { status: string; agent: string };
		assert.notEqual(rec.status, "running", "账本必须落终态：停在 running ⇒ watcher 永不通知（静默失效）");
		assert.equal(rec.status, "completed", "产物存在应判 completed");
		assert.equal(rec.agent, "fusion", "账本要标明是融合者");

		const linksExist = existsSync(linksPath);
		assert.ok(linksExist, "links 必须落盘（派发者会话靠它归属完成通知）");
		const links = readFileSync(linksPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
		const mine = links.filter((l) => l.targetId === r.fusionRunId);
		assert.equal(mine.length, 1, "links 必须记一条归属");
		assert.equal(mine[0].sessionId, "sid-dispatcher", "完成通知必须归属派发者会话");
		assert.equal(mine[0].kind, "async", "必须走 async 账本形状（watcher 只认这个 kind）");

		assert.equal(r.status, "completed");
		assert.ok(existsSync(r.reportPath as string), "reportPath 要指向融合产物");
	}

	// ── 幂等认领：第二次派发必须被拒（不重复烧模型） ──
	{
		const r = await dispatchFusion({ ...base, fusionModel: "local-qwen38/medium", spawnFn: fakeSpawnThatFinishes(true) as never });
		assert.equal(r.status, "skipped", "同 run 二次派发必须跳过");
		assert.ok(r.reason.includes("认领"), "理由要写明是认领已存在");
		assert.equal(calls.length, 1, `二次派发不得再 spawn，实得累计 ${calls.length}`);
	}

	// ── 子进程退出但无产物 ⇒ failed（不得假完成） ──
	{
		const dir2 = join(root, "run2");
		mkdirSync(dir2, { recursive: true });
		const r = await dispatchFusion({ ...base, runDir: dir2, fusionModel: "m", spawnFn: fakeSpawnThatFinishes(false) as never });
		assert.equal(r.status, "failed", "退出但无产物必须判 failed");
		const files = (await import("node:fs")).readdirSync(runsDir).filter((f) => f.startsWith("run_"));
		const statuses = files.map((f) => (JSON.parse(readFileSync(join(runsDir, f), "utf8")) as { status: string }).status);
		assert.ok(!statuses.includes("running"), "任何终局都不得留下 running 账本");
		assert.ok(statuses.includes("failed"), "无产物要落 failed");
	}

	// ── 主材料缺失 ⇒ 零动作 ──
	{
		const r = await dispatchFusion({ ...base, reportPath: join(root, "nope.md"), fusionModel: "m" });
		assert.equal(r.status, "skipped", "材料缺失必须跳过而不是空跑模型");
		assert.equal(r.zeroModelCall, true);
	}

	// ── 接线：collect 侧 runFusionStep 必须把设置里的模型传下去，并把结果写进 meta ──
	{
		const { runFusionStep } = await import("./trace-fusion/fusion-dispatch.ts");
		const dir3 = join(root, "run3");
		mkdirSync(dir3, { recursive: true });
		writeFileSync(join(dir3, "meta.json"), JSON.stringify({ runId: "tfl-3", status: "completed" }), "utf8");
		const seen: Record<string, unknown>[] = [];
		const logs: string[] = [];
		const res = await runFusionStep({
			meta: { runId: "tfl-3", runDir: dir3, repoRoot: root, dispatcherSessionId: "sid-3" },
			reportPath,
			fusionModel: "configured/model",
			piCli: join(root, "cli.js"),
			log: (m) => logs.push(m),
			dispatch: async (i) => {
				seen.push(i as unknown as Record<string, unknown>);
				return { status: "completed", reason: "ok", fusionRunId: "run_x", reportPath: join(dir3, "fusion.md"), zeroModelCall: false };
			},
		});
		assert.equal(seen.length, 1, "runFusionStep 必须真的调 dispatch");
		assert.equal(seen[0].fusionModel, "configured/model", "模型必须取自设置值（接线：不得写死、不得自己挑）");
		assert.equal(seen[0].dispatcherSessionId, "sid-3", "派发者会话身份必须传下去（完成通知靠它）");
		assert.equal(res.status, "completed");
		const meta3 = JSON.parse(readFileSync(join(dir3, "meta.json"), "utf8")) as { status: string; fusion?: { status: string; model?: string } };
		assert.equal(meta3.status, "completed", "融合不得弄崩收集终态");
		assert.equal(meta3.fusion?.status, "completed", "meta 必须带 fusion 读数（不得静默）");
		assert.equal(meta3.fusion?.model, "configured/model", "meta 要记录用的哪个模型");
		assert.ok(logs.some((l) => l.startsWith("fusion:")), "必须有日志行");

		// dispatch 抛异常 ⇒ 步骤必须兼容并记录（不得弄崩收集链）
		const dir4 = join(root, "run4");
		mkdirSync(dir4, { recursive: true });
		const res4 = await runFusionStep({
			meta: { runId: "tfl-4", runDir: dir4, repoRoot: root },
			reportPath,
			fusionModel: "m",
			log: () => {},
			dispatch: async () => {
				throw new Error("boom");
			},
		});
		assert.equal(res4.status, "spawn-error", "dispatch 异常必须转成结构化失败");
		assert.ok(res4.reason.includes("boom"), "异常原因要可见");
	}

	// ── meta 写失败不得静默（日志必须说出写失败）──
	{
		const { runFusionStep } = await import("./trace-fusion/fusion-dispatch.ts");
		const dir5 = join(root, "run5");
		mkdirSync(join(dir5, "meta.json"), { recursive: true }); // 故意让 meta.json 不可写（目录）
		const logs5: string[] = [];
		const res5 = await runFusionStep({
			meta: { runId: "tfl-5", runDir: dir5, repoRoot: root },
			reportPath,
			fusionModel: "m",
			log: (m) => logs5.push(m),
			dispatch: async () => ({ status: "completed", reason: "ok", fusionRunId: "run_y", reportPath: join(root, "f.md"), zeroModelCall: false }),
		});
		assert.equal(res5.status, "completed", "meta 写失败不得弄崩融合结果");
		assert.ok(
			logs5.some((l) => l.includes("meta 写入失败")),
			"meta 写失败必须在日志里说出来（AGENTS.md R-2：静默失效不可接受）",
		);
	}

	console.log("trace-fusion fusion-dispatch tests passed");
} finally {
	try {
		rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
	} catch {
		/* 尽力 */
	}
}
