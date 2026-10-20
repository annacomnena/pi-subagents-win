/**
 * _test_wechat_stale_worker.ts — 微信通道「PID 复用导致永久卡死」回归门（2026-10-20）。
 *
 * ## 事故（本次实测）
 * 微信 worker（pid 7016）在 2026-10-19 23:44 死掉，Windows 在 23:45:36 把 7016 复用给
 * 系统进程 **"Memory Compression"**。supervisor 的 `waitStaleWorkerGone()` 只问
 * 「这个 pid 活着吗」→ 答「活着」→ 永远返回 `skipped-stale` → **拒绝 spawn** →
 * 通道静默死亡 **18.5 小时**（lastPollAt 停在 10-19T15:44:04Z），且：
 *   - supervisor 的 `log` 没接线 ⇒ **零日志**
 *   - /v1/health 里 **一个字都没有**
 *
 * ## 本测试钉住三件事
 *   W1 身份判定纯函数 `classifyStaleWorker`（六种组合全覆盖）
 *   W2 真实 PID 复用：pid 活着但映像名不是 node ⇒ 必须判 `reused`（放行 spawn）
 *   W3 health 有独立存活读数 + supervisor log 已接线（可观测性，R-2）
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyStaleWorker, probeProcessImageName, STALE_WORKER_HEARTBEAT_MS } from "./runtime/liveness.ts";

let n = 0;
const ok = (m: string): void => {
	n++;
	console.log(`ok ${n} - ${m}`);
};

// ── W1 身份判定（纯函数，六种组合）────────────────────────────────
{
	// 同代：可能是自己的子进程 ⇒ 保持 fail-closed 等待（不因映像名异常就杀）
	assert.equal(
		classifyStaleWorker({ epochMatches: true, imageName: "Memory Compression", heartbeatAgeMs: null }),
		"ours-alive",
		"同代一律按「可能是我们的」处理（不擅自 spawn，防双跑）",
	);

	// 跨代 + 非 node 映像 ⇒ 确定复用（这正是本次事故的形状）
	assert.equal(
		classifyStaleWorker({ epochMatches: false, imageName: "Memory Compression", heartbeatAgeMs: null }),
		"reused",
		"跨代 + 系统进程占用该 pid ⇒ 判定复用（必须放行 spawn，否则永久卡死）",
	);
	assert.equal(
		classifyStaleWorker({ epochMatches: false, imageName: "explorer.exe", heartbeatAgeMs: 0 }),
		"reused",
		"跨代 + 任意非 node 映像 ⇒ 复用（即使心跳参数新鲜也不认）",
	);

	// 跨代 + 查询不可用 ⇒ unknown（不猜，沿用原 fail-closed 行为）
	assert.equal(
		classifyStaleWorker({ epochMatches: false, imageName: undefined, heartbeatAgeMs: null }),
		"unknown",
		"探针不可用 ⇒ unknown（不猜）",
	);

	// 跨代 + node.exe + 心跳新鲜 ⇒ 可能真是老 worker 还没退
	assert.equal(
		classifyStaleWorker({ epochMatches: false, imageName: "node.exe", heartbeatAgeMs: 1000 }),
		"ours-alive",
		"跨代 + node + 心跳新鲜 ⇒ 保守等待（可能是老 worker 还没自退）",
	);

	// 跨代 + node.exe + 心跳陈旧 ⇒ 复用（父死亡看门狗早该退；18.5h 不动 = 不是它）
	assert.equal(
		classifyStaleWorker({ epochMatches: false, imageName: "node.exe", heartbeatAgeMs: STALE_WORKER_HEARTBEAT_MS + 1 }),
		"reused",
		"跨代 + node + 心跳陈旧 ⇒ 复用（本次事故的 lastPollAt 停了 18.5h）",
	);
	assert.equal(
		classifyStaleWorker({ epochMatches: false, imageName: "node.exe", heartbeatAgeMs: null }),
		"reused",
		"跨代 + node + 心跳未知 ⇒ 复用（无从证明是它）",
	);

	// 竞态：查得到但没有该进程
	assert.equal(
		classifyStaleWorker({ epochMatches: false, imageName: null, heartbeatAgeMs: null }),
		"reused",
		"pid 已不存在（竞态）⇒ 复用/可 spawn",
	);
	ok("W1 身份判定：同代让位 / 跨代非 node ⇒ reused / 不可用 ⇒ unknown / node+心跳细分");
}

// ── W2 真实探针形状（注入 run，不真调 tasklist）──────────────────
{
	// 本次事故的真实 tasklist 输出（pid 7016 = Memory Compression）
	const realOutput = '"Memory Compression","7016","Console","1","0 K"';
	assert.equal(
		probeProcessImageName(7016, { run: () => "Memory Compression" }),
		"Memory Compression",
		"探针返回映像名",
	);
	assert.equal(probeProcessImageName(7016, { run: () => "" }), null, "空输出（无匹配行）⇒ 进程不存在");
	assert.equal(probeProcessImageName(7016, { run: () => undefined }), undefined, "查询不可用 ⇒ undefined（不猜）");
	assert.equal(probeProcessImageName(0, { run: () => "x" }), null, "非法 pid ⇒ null");
	assert.ok(realOutput.includes("Memory Compression"), "（事故现场输出样例）");
	ok("W2 探针三态：映像名 / null(不存在) / undefined(不可用)");
}

// ── W3 接线与可观测性 ────────────────────────────────────────────
{
	const sup = readFileSync(new URL("./runtime-host/channel-supervisor.ts", import.meta.url), "utf8");

	// 反例守卫：不得退回「只看 pid 活不活」
	assert.ok(/classifyStale\(/.test(sup), "supervisor 用了身份判定（不只是 isProcessAlive）");
	assert.ok(/probeProcessImageName/.test(sup), "supervisor 用映像名探针");
	assert.ok(
		/epochMatches/.test(sup),
		"判定里带 daemonEpoch 同代/跨代区分（跨代才可能复用）",
	);
	assert.ok(
		/verdict === "reused"[\s\S]{0,200}removePidFile\(\)/.test(sup),
		"判定为 reused 时必须清理 pid 文件并放行 spawn（否则永久 skipped-stale）",
	);
	// 成本纪律：探针只在判定函数里调一次，不在 tick 主路径
	assert.ok(
		!/for \(;;\)[\s\S]{0,400}probeProcessImageName/.test(sup),
		"探针不得在 wait 循环内反复调用（tasklist ≈ 5s，会拖死 tick）",
	);

	// 可观测性（本次事故的第二个缺陷：零日志）
	const server = readFileSync(new URL("./runtime-host/server.ts", import.meta.url), "utf8");
	assert.ok(
		/new ChannelSupervisor\(\{[\s\S]{0,400}log:/.test(server),
		"ChannelSupervisor 必须传 log（否则 record() 是 no-op，事故期间零日志）",
	);

	// health 独立存活读数（R-2：静默失效不可接受）
	assert.ok(/function sampleWechatChannel/.test(server), "health 有 sampleWechatChannel");
	assert.ok(/lastPollAgeMs/.test(server), "health 给 lastPollAgeMs（真实活性，不是自己报告的 status）");
	assert.ok(/wechat: sampleWechatChannel\(/.test(server), "health 返回体里接了 wechat 段");
	assert.ok(
		/WECHAT_POLL_STALE_MS/.test(server) && /base\.stale =/.test(server),
		"有 stale 阈值与判定（GUI 可显式告警）",
	);
	ok("W3 接线：身份判定 + 清理放行 + 探针不循环 + log 已接 + health 有独立存活读数");
}

// ── W4 状态字段不得自相矛盾 ──────────────────────────────────────
{
	// 2026-10-20 自查发现：事故后 state.json 同时是「status=connected」+「lastError=getupdates 网络错误」，
	// 因为成功路径只 setStatus("connected") 没清 lastError。读 health 的人会以为通道还坏着。
	const worker = readFileSync(new URL("./channel-wechat/worker.ts", import.meta.url), "utf8");
	assert.ok(
		/store\.setStatus\("connected",\s*\{\s*lastError:\s*null\s*\}\)/.test(worker),
		"成功轮询必须清 lastError（否则 connected 与旧错误长期并存 = 误导）",
	);
	ok("W4 成功路径清 lastError（connected 不再与旧错误并存）");
}

console.log(`\n_test_wechat_stale_worker: all assertions passed (${n})`);
