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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFusionPrompt, dispatchFusion, FUSION_EXCLUDE_TOOLS, parseFusionTermination } from "./trace-fusion/fusion-dispatch.ts";

const root = mkdtempSync(join(tmpdir(), "tf-fuse-"));

type FakeChild = EventEmitter & { kill: (sig?: string) => void };
const allCalls: { argv: string[]; opts: object }[] = [];
const calls: { argv: string[]; opts: object }[] = [];
const fakeSpawn = (cmd: string, argv: string[], opts: object) => {
	const child = new EventEmitter() as FakeChild;
	child.kill = () => {};
	void cmd;
	allCalls.push({ argv, opts });
	calls.push({ argv, opts });
	return child;
};
const SECTIONS = [
	"## 1. 采纳结论",
	"## 2. 分歧与裁决",
	"## 3. 证据核验",
	"## 4. 不可采信项",
	"## 5. 后续行动",
	"## 6. 可复跑附录",
];
// 每节正文必须 ≥ FUSION_SECTION_MIN_CHARS（40）：小模型交「标题齐全、内容为空」的报告
// 是实测过的形状（2026-11-03 第 5 次：§4/§5 各只写了 280/281 字符表格壳），判据已加长度门。
const SECTION_TEXT = [
	"## 1. 采纳结论\n采纳 B/C 收敛根因：collect 侧缺 lane 产物白名单校验；证据 artifacts.ts:163 与 worker-prompt.ts:85-100。",
	"## 2. 分歧与裁决\n不投票：B 主张结构、C 主张白名单，取 C（更具体且可立即核验），裁决理由写入本节。",
	"## 3. 证据核验\n实跑：git show 125b735:extensions/trace-fusion/artifacts.ts | sed -n '175,205p' ⇒ 只有 2 项存在性检查，无枚举。",
	"## 4. 不可采信项\nA 路无 trajectory.md（cross-test-report 行 16：A✗）⇒ 其全部主张不可采信；越界引用 3 条不得原样引用。",
	"## 5. 后续行动\n1) artifacts.ts 的 collectLaneArtifacts 内引入 readdirSync(laneDir) + 白名单比对；2) 补 stray 夹具测试。",
	"## 6. 可复跑附录\n命令：git show 125b735:extensions/trace-fusion/artifacts.ts | grep -n readdirSync ⇒ 期望 0 命中（修法前提）。",
].join("\n\n");
/** 空壳六节（实测形状）：标题齐全、正文只有套话 ⇒ 必须判不齐（长度门）。 */
const SHELL_TEXT = SECTIONS.map((h) => `${h}\n暂无，待补充。`).join("\n\n");
/** 首跑真实形状：「File written: …」是包在 message_end 的 assistant 正文里的（不是裸文本）。 */
const fakeWriteClaimEvent = (): string => JSON.stringify({
	type: "message_end",
	message: { role: "assistant", content: [{ type: "text", text: 'File written: "C:/Users/Annacomnena/pi/agent/trace-fusion-runs/t1/fusion/fusion.md" (80 lines, 19KB).' }] },
}) + "\n";
const sectionEvent = (marker: string): string => JSON.stringify({
	type: "message_end",
	message: { role: "assistant", content: [{ type: "text", text: `${marker}\n${SECTION_TEXT}` }] },
}) + "\n";

/**
 * 融合者交报告的真实形状（2026-11-03 首跑实测）：write/edit 被运行时排除 ⇒
 * 报告正文从 stdout 的 assistant 消息里交回，由 harness 落盘。
 * 首跑形状 = 回复只有「File written: …」（123 字符，路径还写丢了个点）⇒ 必须判 failed。
 */
const fakeSpawnThatFinishes = (produce: boolean, targetDir?: string) => (cmd: string, argv: string[], opts: object) => {
	const child = fakeSpawn(cmd, argv, opts);
	setImmediate(() => {
		const runDir = targetDir ?? join(root, "run");
		if (produce) {
			// 2026-11-03 形状改造：融合者没有 write/edit 工具，报告正文从 stdout 交回、
			// 由 harness 落盘 ⇒ 夹具不得再伪造「模型自己写了 fusion.md」。
			void runDir;
			const fd = (opts as { stdio: [unknown, number, number] }).stdio[1] as number;
			writeFileSync(fd, sectionEvent("融合完成"), { fd });
		}
		child.emit("exit", 0);
	});
	return child;
};
/** exit=0，stdout 带 usage + 六节报告正文 ⇒ harness 应落盘。 */
const fakeSpawnSections = (dir: string, withSections = true) => (cmd: string, argv: string[], opts: object) => {
	const child = fakeSpawn(cmd, argv, opts);
	const fd = (opts as { stdio: [unknown, number, number] }).stdio[1] as number;
	writeFileSync(fd, JSON.stringify({ type: "message_end", message: { role: "assistant", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } } }) + "\n", { fd });
	writeFileSync(fd, withSections ? sectionEvent("融合完成") : fakeWriteClaimEvent(), { fd });
	setImmediate(() => child.emit("exit", 0));
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

	// ── 2026-11-03 首跑实测：完成判据 = exit 0 + 回复正文含六节（harness 落盘） ──
	{
		// 本块用独立 runsDir：后面的「未配置 ⇒ 零 spawn」断言数的是全局 calls，
		// 夹具不能往共享账本里加 spawn 记录。
		const dirCap = join(root, "runCapture");
		const capRunsDir = join(root, "runs-capture");
		const capCalls: Array<{ argv: string[]; opts: object }> = [];
		const capSpawn = (inner: (c: string, a: string[], o: object) => FakeChild) => (c: string, a: string[], o: object) => {
			const child = inner(c, a, o);
			// 局部记账：本块额外记录，同时把写进全局 calls 的条目撤掉
			//（后面的「未配置 ⇒ 零 spawn」断言数的是全局 calls）。
			capCalls.push({ argv: a, opts: o });
			calls.length = 0;
			return child;
		};
		const r = await dispatchFusion({ ...base, runDir: dirCap, runsDir: capRunsDir, fusionModel: "m", spawnFn: capSpawn(fakeSpawnSections(dirCap, true)) as never });
		assert.equal(r.status, "completed", `六节齐全必须 completed，实得 ${r.status} / ${r.reason}`);
		const out = join(dirCap, "fusion", "fusion.md");
		assert.ok(existsSync(out), "fusion.md 必须由 harness 落盘（融合者没有写工具）");
		const body = readFileSync(out, "utf8");
		for (const h of SECTIONS) assert.ok(body.includes(h), `落盘正文必须含「${h}」`);
		const spawnedEnv = (capCalls[capCalls.length - 1] as { opts?: { env?: Record<string, string> } }).opts?.env ?? {};
		assert.equal(spawnedEnv.PI_TRACE_FUSION_FUSION_DIR, join(dirCap, "fusion"), "spawn 必须把合法产物目录透传给融合子会话（守卫的合法落点）");
	}
	// 2026-11-03 第四次实测后的交付主通道：融合者自己用 write 写产物（落点由机械门锁死）
	{
		const dirW = join(root, "runWriteOwn");
		const runsW = join(root, "runs-write-own");
		const spawnWrite = (cmd: string, argv: string[], opts: object) => {
			const child = fakeSpawn(cmd, argv, opts);
			setImmediate(() => {
				// 融合者真的调用了 write ⇒ 产物出现在盘上（正文也从 stdout 给出）
				mkdirSync(join(dirW, "fusion"), { recursive: true });
				writeFileSync(join(dirW, "fusion", "fusion.md"), SECTION_TEXT + "\n", "utf8");
				child.emit("exit", 0);
			});
			return child;
		};
		const r = await dispatchFusion({ ...base, runDir: dirW, runsDir: runsW, fusionModel: "m", spawnFn: spawnWrite as never });
		assert.equal(r.status, "completed", `融合者自己写盘且六节齐全必须 completed，实得 ${r.status} / ${r.reason}`);
		assert.ok(/融合者写入/.test(r.reason), `理由要写明是谁写的，实得 ${r.reason}`);
	}
	// 第四次实测真实形状：exit=0 + 回复「报告已完成」+ 盘上零产物 ⇒ 谎报，必须 failed
	{
		const dirLie = join(root, "runLie");
		const runsLie = join(root, "runs-lie");
		const spawnLie = (cmd: string, argv: string[], opts: object) => {
			const child = fakeSpawn(cmd, argv, opts);
			const fd = (opts as { stdio: [unknown, number, number] }).stdio[1] as number;
			writeFileSync(fd, JSON.stringify({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "融合报告已完成。六节结构完全符合规格（185 行）。" }] },
			}) + "\n", { fd });
			setImmediate(() => child.emit("exit", 0));
			return child;
		};
		const r = await dispatchFusion({ ...base, runDir: dirLie, runsDir: runsLie, fusionModel: "m", spawnFn: spawnLie as never });
		assert.equal(r.status, "failed", `口头报告不得计为结果，实得 ${r.status}`);
		assert.ok(r.reason.includes("未产出产物"), `理由要写明盘上无产物，实得 ${r.reason}`);
		assert.ok(r.reason.includes("回复 25 字符") || /缺 \d 节/.test(r.reason), `理由要带回复形状（R-2），实得 ${r.reason}`);
		assert.ok(!existsSync(join(dirLie, "fusion", "fusion.md")), "不得凭空落盘");
	}
	// 跨尝试污染（append 日志）：上一次尝试的合格正文不得被当成本次结果
	{
		const dirX = join(root, "runCrossAttempt");
		const runsX = join(root, "runs-cross-attempt");
		mkdirSync(join(dirX, "fusion"), { recursive: true });
		// 上一轮留下的日志：内含一份**六节齐全**的正文
		writeFileSync(
			join(dirX, "fusion", "fusion.stdout.log"),
			JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: SECTION_TEXT }] } }) + String.fromCharCode(10),
			"utf8",
		);
		const spawnNoBody = (cmd: string, argv: string[], opts: object) => {
			const child = fakeSpawn(cmd, argv, opts);
			setImmediate(() => child.emit("exit", 0)); // 本次零正文
			return child;
		};
		const r = await dispatchFusion({ ...base, runDir: dirX, runsDir: runsX, fusionModel: "m", spawnFn: spawnNoBody as never });
		assert.equal(r.status, "failed", `本次没有正文，不得继承上一轮的正文判成功，实得 ${r.status}`);
		assert.ok(!existsSync(join(dirX, "fusion", "fusion.md")), "不得把上一轮正文落盘成本轮产物");
		assert.ok(/无 assistant 正文/.test(r.reason), `理由要写明本次无正文，实得 ${r.reason}`);
	}
	// 首跑真实失败形状：exit=0，回复只有「File written: …」（路径还写丢了个点）⇒ failed
	{
		const dirFake = join(root, "runClaimOnly");
		const capRunsDir2 = join(root, "runs-claim-only");
		const capCalls2: Array<{ argv: string[]; opts: object }> = [];
		const capSpawn2 = (inner: (c: string, a: string[], o: object) => FakeChild) => (c: string, a: string[], o: object) => {
			const child = inner(c, a, o);
			capCalls2.push({ argv: a, opts: o });
			calls.length = 0;
			return child;
		};
		// 夹具：模型自称「File written: …」并补写了一节标题 ⇒ 缺 5 节，仍不得落盘/判成功
		mkdirSync(join(dirFake, "fusion"), { recursive: true });
		writeFileSync(join(dirFake, "fusion", "fusion.md"), "## 1. 采纳结论" + "\n" + "半截内容" + "\n", "utf8");
		const r = await dispatchFusion({ ...base, runDir: dirFake, runsDir: capRunsDir2, fusionModel: "m", spawnFn: capSpawn2(fakeSpawnSections(dirFake, false)) as never });
		assert.equal(r.status, "failed", `自称写了文件但没有报告正文，不得判成功，实得 ${r.status}`);
		assert.equal(readFileSync(join(dirFake, "fusion", "fusion.md"), "utf8"), "## 1. 采纳结论" + "\n" + "半截内容" + "\n", "不合格正文不得覆盖已有文件（capture 必须整体拒写）");
		assert.ok(/六节不齐/.test(r.reason) && /## 2\./.test(r.reason), `失败理由必须写明缺哪几节（R-2 不得静默），实得 ${r.reason}`);
		const before = capCalls2.length;
		const again = await dispatchFusion({ ...base, runDir: dirFake, runsDir: capRunsDir2, fusionModel: "m", spawnFn: capSpawn2(fakeSpawnSections(dirFake, false)) as never });
		assert.equal(again.status, "skipped", "失败后认领必须留在盘上（不得一失败就自动重烧模型）");
		assert.equal(capCalls2.length, before, "跳过 ⇒ 零 spawn");
	}

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
		assert.ok(p.includes("lane 契约外文件必须逐条判定"), "必须把 lane 契约外文件写成硬纪律（2026-11-04：检测结果传达到融合者）");
		assert.ok(p.includes("引用必须可复跑"), "必须有「引用可复跑」硬纪律标题（M52 变异特异性断言）");
		assert.ok(p.includes("真实 sha"), "必须要求引用写真实 sha（两次实测均写占位符/上一跑 runId）");
		assert.ok(p.includes("实跑过的"), "必须要求行号来自实跑输出");
		assert.ok(p.includes("「三路都这么说」不是判据"), "必须封掉「共识即成立」的口径（实测融合写过 Consensus: all correct）");
		assert.ok(p.includes("禁止派发 subagent"), "必须禁止递归派发");
		assert.ok(p.includes("禁止 push"), "必须禁止 push");
		assert.ok(p.includes("## 6. 可复跑附录"), "输出必须含可复跑附录");
		// 2026-11-03 四次实测后的交付形状（第四次是口头谎报：「报告已完成，185 行六节齐全」而盘上零产物）：
		// 禁写拦不住交付 ⇒ 给 write，并把落点锁到本 run 产物目录（机械门）。
		assert.ok(p.includes("用 write 工具写入"), "必须明令用 write 写产物（口头报告不算交付）");
		assert.ok(p.includes("写盘只允许一个路径"), "必须把可写路径收敛到一个");
		assert.ok(p.includes("报告已完成"), "必须点名『不得声称已完成而没真的写盘』（第四次实测形状）");
		assert.ok(!p.includes("不要自己写文件"), "不得再要求它不写文件（旧形状拦不住交付，只造成幻觉）");
	}

	// ── ②③ 派发形状 + 终态账本 + links 归属 ──
	{
		const r = await dispatchFusion({ ...base, fusionModel: "local-qwen38/medium", laneModel: "bonsai-9b", spawnFn: fakeSpawnThatFinishes(true) as never });
		assert.equal(calls.length, 1, `应 spawn 一次，实得 ${calls.length}`);
		const argv = calls[0].argv.join(" ");
		// 2026-11-03 首跑实测缺口：spawn 的 argv[0] 必须是 **pi CLI 脚本路径**。
		// 旧写法 `["--experimental-strip-types", ...argv.slice(1)]` 把它丢了 ⇒
		// node.exe 把 `--mode` 当自己的旗标 ⇒ `bad option: --mode` 退出 9，融合全白跑
		// （真实读数：tfl-20261103-192444-c7e2 fusion.stdout.log）。
		assert.equal(calls[0].argv[0], join(root, "cli.js"), `spawn argv[0] 必须是 pi CLI 脚本路径，实得 ${calls[0].argv[0]}`);
		// ② 实测缺口：给已编译的 cli.js 追加 node 的 --experimental-strip-types ⇒
		// pi 立刻 `Unknown option: --experimental-strip-types`（exit=1）。argv 必须与
		// buildPiArgv 输出逐字一致，不掺 node 旗标。
		assert.ok(!calls[0].argv.some((a: string) => a.startsWith("--experimental-")),
			`spawn argv 不得掺 node 旗标（cli.js 是已编译 JS），实得 ${calls[0].argv.slice(0, 3).join(" ")}`);
		assert.ok(argv.includes("--mode json"), "pi 的 --mode json 必须保留在 argv 里");
		// argv 里的工具集是 `--exclude-tools` 后的**单个逗号串**，所以下面均从该串取。
		const exclTok = calls[0].argv[calls[0].argv.indexOf("--exclude-tools") + 1] ?? "";
		const excl = new Set(exclTok.split(","));
		for (const t of FUSION_EXCLUDE_TOOLS) {
			assert.ok(excl.has(t), `argv 的 --exclude-tools 必须含 ${t}（融合者不得拥有该能力）`);
		}
		// 2026-11-02 #1 安全边界：**运行时**强制，不靠提示词。
		// 2026-11-03 四次实测后的边界重划：edit 仍禁（能改仓内已有文件）；
		// write 放行但落点由 lane-bash-guard 锁到本 run 产物目录（禁 write 实测拦不住交付：
		// 第 3 次用 bash 野写，第 4 次直接谎报「报告已完成」）。
		assert.ok(FUSION_EXCLUDE_TOOLS.includes("edit"), "edit 必须排除（可改仓内已有文件）");
		assert.ok(!FUSION_EXCLUDE_TOOLS.includes("write"), "write 必须放行（交付物要落盘），安全靠落点机械门");
		assert.ok(excl.has("edit") && !excl.has("write"), `argv 必须排 edit 不排 write，实得 edit=${excl.has("edit")} write=${excl.has("write")}`);
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

		assert.equal(r.status, "completed", `reason=${r.reason}`);
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
		const r = await dispatchFusion({ ...base, runDir: dir2, fusionModel: "m", spawnFn: fakeSpawnThatFinishes(false, dir2) as never });
		assert.equal(r.status, "failed", "退出但无产物必须判 failed");
		const files = (await import("node:fs")).readdirSync(runsDir).filter((f) => f.startsWith("run_"));
		const statuses = files.map((f) => (JSON.parse(readFileSync(join(runsDir, f), "utf8")) as { status: string }).status);
		assert.ok(!statuses.includes("running"), "任何终局都不得留下 running 账本");
		assert.ok(statuses.includes("failed"), "无产物要落 failed");
	}

	// ── #3 判据 a：exit != 0 ⇒ failed（旧版只看文件存在 ⇒ 崩了也算成功） ──
	{
		const dirE = join(root, "runExit");
		mkdirSync(join(dirE, "fusion"), { recursive: true });
		const spawnExit1 = (cmd: string, argv: string[], opts: object) => {
			const child = fakeSpawn(cmd, argv, opts);
			setImmediate(() => {
				writeFileSync(join(dirE, "fusion", "fusion.md"), "# 半截\n", "utf8"); // 产物写了
				child.emit("exit", 1); // 但进程非零退出（典型：中途崩）
			});
			return child;
		};
		const before = (await import("node:fs")).readdirSync(runsDir).filter((f) => f.startsWith("run_")).length;
		const r = await dispatchFusion({ ...base, runDir: dirE, fusionModel: "m", spawnFn: spawnExit1 as never });
		assert.equal(r.status, "failed", "非零退出不得计为 completed（旧版：文件在就 completed）");
		assert.equal(r.exitCode, 1, "退出码要带出来");
		assert.ok(r.reason.includes("exit=1"), `理由要写明退出码，实得 ${r.reason}`);
		const newRecs = (await import("node:fs")).readdirSync(runsDir).filter((f) => f.startsWith("run_")).slice(before);
		assert.equal(newRecs.length, 1, "本次应新增一条账本");
		const rec = JSON.parse(readFileSync(join(runsDir, newRecs[0]), "utf8")) as { exitCode?: number };
		assert.equal(rec.exitCode, 1, "账本必须记退出码（事后可审）");
	}

	// ── #3 判据 b：产物陈旧（mtime 早于启动）⇒ failed，不得拿上次产物当本次结果 ──
	{
		const dirS = join(root, "runStale");
		mkdirSync(join(dirS, "fusion"), { recursive: true });
		const stalePath = join(dirS, "fusion", "fusion.md");
		writeFileSync(stalePath, "# 上一次的融合产物\n", "utf8");
		const old = new Date(Date.now() - 60 * 60_000); // 1h 前
		utimesSync(stalePath, old, old);
		const r = await dispatchFusion({ ...base, runDir: dirS, fusionModel: "m", spawnFn: fakeSpawnThatFinishes(false, dirS) as never });
		assert.equal(r.status, "failed", "exit=0 且文件存在但是旧产物 ⇒ 不得计 completed");
		assert.ok(r.reason.includes("陈旧"), `理由要写明陈旧，实得 ${r.reason}`);
	}

	// ── #3 判据 c：usage 从 json 流解析（旧版写死 cost=0 ⇒ 成本不可知） ──
	{
		const dirU = join(root, "runUsage");
		mkdirSync(join(dirU, "fusion"), { recursive: true });
		const spawnWithLog = (cmd: string, argv: string[], opts: object) => {
			const child = fakeSpawn(cmd, argv, opts);
			const o = opts as { stdio: [unknown, number, number] };
			const fd = o.stdio[1] as number;
			writeFileSync(fd, JSON.stringify({ type: "message_end", message: { role: "assistant", usage: { input: 1000, output: 20, cacheRead: 500, cacheWrite: 0, cost: { total: 0.125 } } } }) + "\n", { fd });
			writeFileSync(fd, JSON.stringify({ type: "message_end", message: { role: "assistant", usage: { input: 900, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.075 } } } }) + "\n", { fd });
			// usage 夹具也必须带六节正文：完成判据 = exit 0 + 正文结构（由 harness 落盘）
			writeFileSync(fd, sectionEvent("融合完成"), { fd });
			setImmediate(() => child.emit("exit", 0));
			return child;
		};
		const r = await dispatchFusion({ ...base, runDir: dirU, fusionModel: "m", spawnFn: spawnWithLog as never });
		assert.equal(r.status, "completed", `reason=${r.reason}`);
		assert.ok(r.usage, "必须解析出 usage（不得为 null/0）");
		assert.equal(r.usage!.turns, 2, "两条 assistant 消息 ⇒ 2 turns");
		assert.ok(Math.abs(r.usage!.cost - 0.2) < 1e-9, `成本应累加为 0.2，实得 ${r.usage!.cost}`);
		assert.equal(r.usage!.cacheRead, 500);
	}

	// ── #3 判据 d：解析不出 usage ⇒ null（不得写 0 冒充「本次未花钱」） ──
	{
		const dirN = join(root, "runNoUsage");
		const r = await dispatchFusion({ ...base, runDir: dirN, fusionModel: "m", spawnFn: fakeSpawnThatFinishes(true, dirN) as never });
		assert.equal(r.status, "completed", `reason=${r.reason}`);
		assert.equal(r.usage, null, "无 json 用量行 ⇒ null（写 0 = 静默失效，AGENTS.md R-2）");
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

	// ── 2026-11-03 第 5 次实测：空壳六节不得通过 + 缺节有界补写一轮 ──
	{
		const { fusionFileSections, fusionSectionGaps, FUSION_SECTION_MIN_CHARS, runFusionStep } = await import("./trace-fusion/fusion-dispatch.ts");
		// 单元：齐全且每节达标
		const goodPath = join(root, "sec-good.md");
		writeFileSync(goodPath, "# 融合报告\n\n" + SECTION_TEXT, "utf8");
		assert.equal(fusionFileSections(goodPath).ok, true, "六节齐全且正文达标 ⇒ ok");
		// 单元：空壳六节（标题齐全、正文套话）⇒ 必须判不齐，缺口带长度读数
		const shellPath = join(root, "sec-shell.md");
		writeFileSync(shellPath, "# 融合报告\n\n" + SHELL_TEXT, "utf8");
		const shellRes = fusionFileSections(shellPath);
		assert.equal(shellRes.ok, false, "空壳六节不得通过（只数标题会被套话凑数）");
		assert.ok(
			!shellRes.ok && shellRes.missing.some((m) => m.includes("正文仅") && m.includes(String(FUSION_SECTION_MIN_CHARS))),
			"缺口必须写明是哪节空壳与实测长度",
		);
		assert.equal(fusionSectionGaps(SECTION_TEXT).length, 0);
		assert.equal(fusionSectionGaps(SHELL_TEXT).length, 6, "六节全空壳 ⇒ 六个缺口");

		// 接线：融合者写了盘但写的是空壳 ⇒ dispatchFusion 判 failed 并给出 gaps
		const dirShell = join(root, "runShell");
		const runsShell = join(root, "runs-shell");
		const spawnShell = (cmd: string, argv: string[], opts: object) => {
			const child = fakeSpawn(cmd, argv, opts);
			setImmediate(() => {
				mkdirSync(join(dirShell, "fusion"), { recursive: true });
				writeFileSync(join(dirShell, "fusion", "fusion.md"), "# 融合报告\n\n" + SHELL_TEXT, "utf8");
				child.emit("exit", 0);
			});
			return child;
		};
		const rShell = await dispatchFusion({ ...base, runDir: dirShell, runsDir: runsShell, fusionModel: "m", spawnFn: spawnShell as never });
		assert.equal(rShell.status, "failed", "空壳产物不得计为融合成功");
		assert.ok((rShell.gaps?.length ?? 0) === 6, "failed 结果必须带 gaps 清单供补写轮使用");

		// 接线：runFusionStep 必须在同认领内**只补派一轮**，补写成功则终态 completed
		const dirRep = join(root, "runRepair");
		mkdirSync(dirRep, { recursive: true });
		writeFileSync(join(dirRep, "meta.json"), JSON.stringify({ runId: "tfl-rep", status: "completed" }), "utf8");
		const repInputs: Array<Record<string, unknown>> = [];
		const repLogs: string[] = [];
		const resRep = await runFusionStep({
			meta: { runId: "tfl-rep", runDir: dirRep, repoRoot: root },
			reportPath,
			fusionModel: "m",
			log: (m) => repLogs.push(m),
			dispatch: async (i) => {
				repInputs.push(i as unknown as Record<string, unknown>);
				if (!i.repair) return { status: "failed", reason: "产物已写但六节不齐", zeroModelCall: false, gaps: ["## 4. 不可采信项"] };
				return { status: "completed", reason: "补写后六节齐全", zeroModelCall: false };
			},
		});
		assert.equal(repInputs.length, 2, "缺口 ⇒ 必须补派且只补派一次");
		assert.deepEqual(repInputs[1].repair, { gaps: ["## 4. 不可采信项"] }, "补写轮必须把缺口清单交给提示词");
		assert.equal(resRep.status, "completed", "补写成功 ⇒ 终态取补写结果");
		assert.ok(repLogs.some((l) => l.startsWith("fusion-repair:")), "补写轮必须日志可见");
		const metaRep = JSON.parse(readFileSync(join(dirRep, "meta.json"), "utf8")) as {
			fusion?: { status: string; repair?: { status: string; gapsRequested?: string[] | null } };
		};
		assert.equal(metaRep.fusion?.status, "completed", "meta 记终态");
		assert.equal(metaRep.fusion?.repair?.status, "completed", "meta 必须记录补写轮（不得静默）");
		assert.deepEqual(metaRep.fusion?.repair?.gapsRequested, ["## 4. 不可采信项"], "补写请求的缺口要落盘可审计");

		// 无产物的失败（gaps 为空）⇒ 不得自动补派（没有补写基础，重烧整轮是编排层的决定）
		const dirNoGap = join(root, "runNoGap");
		mkdirSync(dirNoGap, { recursive: true });
		const gapInputs: Array<Record<string, unknown>> = [];
		const resNoGap = await runFusionStep({
			meta: { runId: "tfl-ng", runDir: dirNoGap, repoRoot: root },
			reportPath,
			fusionModel: "m",
			log: () => {},
			dispatch: async (i) => {
				gapInputs.push(i as unknown as Record<string, unknown>);
				return { status: "failed", reason: "盘上无产物且回复不合格", zeroModelCall: false };
			},
		});
		assert.equal(gapInputs.length, 1, "无缺口清单 ⇒ 不得自动补派（禁止连环重发）");
		assert.equal(resNoGap.status, "failed");

		// 补写轮自己失败 ⇒ 终态仍是 failed（不得拿首轮半截结果当成功）
		const resRep2 = await runFusionStep({
			meta: { runId: "tfl-rep2", runDir: dirNoGap, repoRoot: root },
			reportPath,
			fusionModel: "m",
			log: () => {},
			dispatch: async (i) =>
				i.repair
					? { status: "failed", reason: "补写后仍缺 ## 5. 后续行动", zeroModelCall: false, gaps: ["## 5. 后续行动"] }
					: { status: "failed", reason: "六节不齐", zeroModelCall: false, gaps: ["## 5. 后续行动"] },
		});
		assert.equal(resRep2.status, "failed", "补写失败 ⇒ 终态 failed");
		assert.deepEqual(resRep2.gaps, ["## 5. 后续行动"], "残余缺口要留在结果里（给人看的下一步依据）");

		// 真实接线（不走 seam）：走完整 dispatchFusion 两轮 ⇒ 补写轮**必须能跑起来**。
		// 首轮写空壳 ⇒ failed(gaps)；第二轮提示词带「补写轮」标记 ⇒ 写齐全 ⇒ 终态 completed。
		// 本夹具同时钉住一个坑：补写轮不得去重抢 fusion.claim（claim 已存在 ⇒ 会被幂等门 skip）。
		const dirR2 = join(root, "runRepairReal");
		const runsR2 = join(root, "runs-repair-real");
		mkdirSync(join(dirR2, "fusion"), { recursive: true });
		writeFileSync(join(dirR2, "meta.json"), JSON.stringify({ runId: "tfl-r2", status: "completed" }), "utf8");
		const r2Prompts: string[] = [];
		const spawnR2 = (cmd: string, argv: string[], opts: object) => {
			const child = fakeSpawn(cmd, argv, opts);
			const prompt = argv.join(" ");
			r2Prompts.push(prompt);
			setImmediate(() => {
				const body = prompt.includes("本轮是补写轮") ? SECTION_TEXT : SHELL_TEXT;
				writeFileSync(join(dirR2, "fusion", "fusion.md"), "# 融合报告\n\n" + body + "\n", "utf8");
				child.emit("exit", 0);
			});
			return child;
		};
		const resR2 = await runFusionStep({
			meta: { runId: "tfl-r2", runDir: dirR2, repoRoot: root },
			reportPath,
			fusionModel: "m",
			runsDir: runsR2,
			piCli: join(root, "cli.js"),
			spawnFn: spawnR2 as never,
			log: () => {},
		});
		assert.equal(r2Prompts.length, 2, "真实派发链必须真的跑两轮");
		assert.ok(r2Prompts[1].includes("本轮是补写轮"), "补写轮提示词必须带补写模式说明");
		assert.ok(r2Prompts[1].includes("正文仅"), "补写轮提示词必须列出具体缺口与实测长度（基座提示词本身含六节标题，不得拿它当断言）");
		assert.ok(!r2Prompts[0].includes("本轮是补写轮"), "首轮不得带补写模式");
		assert.equal(resR2.status, "completed", "补写轮写齐 ⇒ 终态 completed（claim 已存在时补写轮不得被幂等门 skip）");
		const metaR2 = JSON.parse(readFileSync(join(dirR2, "meta.json"), "utf8")) as { fusion?: { status: string; repair?: { status: string } } };
		assert.equal(metaR2.fusion?.repair?.status, "completed", "meta 记录真实补写轮结果");
	}

	// ── 第 3 项（2026-11-05）：headless 通道必须挂 agents/fusion.md 的 body ──
	// 缺陷：buildPiArgv 的 systemPrompt 参数在 headless 分支**从未传**
	// ⇒ 与 makeSubagentFusionRunner（runWithFallback 自动取 agent.body）系统提示不一致。
	{
		const dirS = join(root, "runSysPrompt");
		const runsS = join(root, "runs-sys");
		mkdirSync(join(dirS, "fusion"), { recursive: true });
		writeFileSync(join(dirS, "meta.json"), JSON.stringify({ runId: "tfl-sp", status: "completed" }), "utf8");
		const spyArgv: string[][] = [];
		const spawnS = (cmd: string, argv: string[], opts: object) => {
			const child = fakeSpawn(cmd, argv, opts);
			spyArgv.push(argv.slice());
			setImmediate(() => {
				writeFileSync(join(dirS, "fusion", "fusion.md"), "# 融合报告" + String.fromCharCode(10,10) + SECTION_TEXT + String.fromCharCode(10), "utf8");
				child.emit("exit", 0);
			});
			return child;
		};
		// ① 传 systemPrompt ⇒ 必须出现在 argv 的 --append-system-prompt 之后
		await dispatchFusion({
			runId: "tfl-sp", runDir: dirS, repoRoot: root, reportPath,
			fusionModel: "m", runsDir: runsS, piCli: join(root, "cli.js"),
			spawnFn: spawnS as never,
			systemPrompt: "FUSION_AGENT_BODY_MARKER",
		});
		const argvWith = spyArgv[0];
		const iFlag = argvWith.indexOf("--append-system-prompt");
		assert.ok(iFlag >= 0, "传了 systemPrompt ⇒ argv 必须含 --append-system-prompt");
		assert.equal(argvWith[iFlag + 1], "FUSION_AGENT_BODY_MARKER", "body 必须原样进值位");

		// ② 不传 ⇒ 行为与旧版一致（argv 里**不得**出现该旗标）
		const dirS2 = join(root, "runSysPrompt2");
		mkdirSync(join(dirS2, "fusion"), { recursive: true });
		writeFileSync(join(dirS2, "meta.json"), JSON.stringify({ runId: "tfl-sp2", status: "completed" }), "utf8");
		const spyArgv2: string[][] = [];
		const spawnS2 = (cmd: string, argv: string[], opts: object) => {
			const child = fakeSpawn(cmd, argv, opts);
			spyArgv2.push(argv.slice());
			setImmediate(() => {
				writeFileSync(join(dirS, "fusion", "fusion.md"), "# 融合报告" + String.fromCharCode(10,10) + SECTION_TEXT + String.fromCharCode(10), "utf8");
				child.emit("exit", 0);
			});
			return child;
		};
		await dispatchFusion({
			runId: "tfl-sp2", runDir: dirS2, repoRoot: root, reportPath,
			fusionModel: "m", runsDir: runsS, piCli: join(root, "cli.js"),
			spawnFn: spawnS2 as never,
		});
		assert.equal(spyArgv2[0].includes("--append-system-prompt"), false, "未传 systemPrompt ⇒ 旧行为逐字节不变（无该旗标）");
	}

	// ── 第 3 项（2026-11-05）：产物守卫 —— 分清「预算烧在思考上」与「报告写得不好」──
	// gen14 实测：local-bonsai 在 prompt 3028 tok / max_tokens 512 时
	// finish=length、content 完全为空、reasoning_content 2119 字符 ⇒ 空产物但 exit=0。
	// 旧代码只说「六节不齐」，把归因错成「报告写得不好」。
	{
		const NL = String.fromCharCode(10);
		const mkLog = (name: string, rows: Array<{ stop: string; text: string; thinking?: string }>): string => {
			const p = join(root, `${name}.jsonl`);
			const lines = rows.map((r) => JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					stopReason: r.stop,
					content: [
						...(r.thinking ? [{ type: "thinking", thinking: r.thinking }] : []),
						...(r.text ? [{ type: "text", text: r.text }] : []),
					],
				},
			}));
			writeFileSync(p, lines.join(NL) + NL, "utf8");
			return p;
		};

		// ① 预算耗尽（length + 正文空）⇒ truncated=true（这是「空产物」的代表）
		const p1 = mkLog("term-length-empty", [
			{ stop: "toolUse", text: "" },
			{ stop: "length", text: "", thinking: "思考吃满了全部预算" },
		]);
		const t1 = parseFusionTermination(p1);
		assert.ok(t1, "必须解析出 termination");
		assert.equal(t1!.stopReason, "length", "stopReason=length");
		assert.equal(t1!.textChars, 0, "正文 0 字符");
		assert.equal(t1!.truncated, true, "预算耗尽必须标 truncated（这就是空产物的判据）");

		// ② 正常收尾（stop + 有正文）⇒ truncated=false
		const p2 = mkLog("term-stop", [{ stop: "toolUse", text: "" }, { stop: "stop", text: "六节齐全的报告" }]);
		const t2 = parseFusionTermination(p2);
		assert.equal(t2!.truncated, false, "stop ⇒ 不算截断");
		assert.equal(t2!.textChars, 7, "只数 text block（不含 thinking）");

		// ③ thinking 不计入 textChars（否则空产物会被误判成有内容）
		const p3 = mkLog("term-thinking-only", [{ stop: "length", text: "", thinking: "很长的思考".repeat(200) }]);
		const t3 = parseFusionTermination(p3);
		assert.equal(t3!.textChars, 0, "thinking 不得计入正文长度");

		// ④ 空流 / 无 assistant ⇒ null（不猜，交给六节门）
		const p4 = join(root, "term-empty.jsonl");
		writeFileSync(p4, "", "utf8");
		assert.equal(parseFusionTermination(p4), null, "空流 ⇒ null");

		// ⑤ 只看**最后一轮**：前面 toolUse、最后一轮 stop ⇒ 不截断
		//    （融合是多轮工具调用后出正文，拿第一轮判会全员误报）
		const p5 = mkLog("term-nulti", [
			{ stop: "toolUse", text: "" },
			{ stop: "toolUse", text: "" },
			{ stop: "length", text: "" },
			{ stop: "stop", text: "最终正文" },
		]);
		const t5 = parseFusionTermination(p5);
		assert.equal(t5!.truncated, false, "必须只看最后一轮（前面的 length 不算）");
	}

	console.log("trace-fusion fusion-dispatch tests passed");
} finally {
	try {
		rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
	} catch {
		/* 尽力 */
	}
}
