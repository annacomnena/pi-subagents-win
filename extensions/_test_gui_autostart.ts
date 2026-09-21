/**
 * _test_gui_autostart.ts — G6 L3 GUI 自动拉起测试（plans/0920_g6_webconsole_plan.md L3）
 *
 *   T1 config gui 段开关读写：roundtrip；read-modify-write 保留其余字段；坏/缺 config 拒绝覆盖写。
 *   T2 vite GET / 探针：真监听 → true；关闭端口 → false（never-throw）。
 *   T3 ensureGuiRuntime 幂等：vite 活 → reuse 不重 spawn；死 → spawn 恰一次（带 port/token）；
 *      viteBin 缺失 → skipped；startHost 抛错 → never-throw 兜底。
 *   T4 session_start 门：subagent / tab → 零动作；OFF → 零动作；ON 主会话 → ensure 恰一次，
 *      30s 节流内重入跳过，节流归零后再触发。
 *   T5 /gui 命令面：on（写 true + ensure）/ off（写 false 不杀）/ status（config+host+vite）/
 *      open（开浏览器恰一次、URL 正确）/ 空参 usage / 写失败 warning。
 *
 * 运行：npm run test:gui-autostart
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 隔离（同既有测试纪律：env 先于 import）
const ENV_DIR = mkdtempSync(join(tmpdir(), "gui-autostart-env-"));
process.env.PI_RUNTIME_DIR = ENV_DIR;
delete process.env.PI_SUBAGENT;
delete process.env.PI_TAB_RUN_ID;

import {
	GUI_AUTOSTART_THROTTLE_MS,
	ensureGuiRuntime,
	guiAutoStartState,
	guiAutoStartTick,
	probeViteAlive,
	readGuiAutoStart,
	registerGuiAutoStart,
	setGuiAutoStart,
	vitePortFromEnv,
	type GuiEnsureResult,
	type HostStartLike,
} from "./gui-autostart.ts";
import { writeHostInfo } from "./runtime-host/discovery.ts";

const TMP = mkdtempSync(join(tmpdir(), "gui-autostart-"));
const cleanupDirs = (): void => {
	try {
		rmSync(ENV_DIR, { recursive: true, force: true });
		rmSync(TMP, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
};

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 25));

const okHost = (overrides: Partial<Extract<HostStartLike["info"], object>> = {}): HostStartLike => ({
	started: false,
	already: true,
	info: {
		instanceId: "host_test",
		pid: 1,
		port: 4317,
		startedAt: "2026-09-22T00:00:00.000Z",
		protocolVersion: 1,
		...overrides,
	},
});

interface NotifyCall {
	body: string;
	level?: string;
}

interface FakePi {
	ons: Array<{ event: string; cb: (event: unknown, ctx?: unknown) => void }>;
	commands: Record<string, { description?: string; handler: (args: string | undefined, ctx: never) => void | Promise<void> }>;
	on(event: string, cb: (event: unknown, ctx?: unknown) => void): void;
	registerCommand(name: string, cmd: { description?: string; handler: (args: string | undefined, ctx: never) => void | Promise<void> }): void;
}

function fakePi(): FakePi {
	const pi: FakePi = { ons: [], commands: {}, on() {}, registerCommand() {} };
	pi.on = (event, cb) => {
		pi.ons.push({ event, cb });
	};
	pi.registerCommand = (name, cmd) => {
		pi.commands[name] = cmd;
	};
	return pi;
}

const fakeCtx = (calls: NotifyCall[]): never =>
	({ ui: { notify: (body: string, level?: string) => void calls.push({ body, level }) } }) as never;

try {
	// ── T1 config gui 段开关读写 ─────────────────────────────────────
	{
		const p = join(TMP, "t1-config.json");
		writeFileSync(
			p,
			JSON.stringify({ models: { searcher: "a/b" }, notifications: false, masterSuccession: { enabled: true } }, null, 2) + "\n",
		);
		assert.equal(readGuiAutoStart(p), false, "T1① 无 gui 段 → false（默认 OFF）");
		assert.equal(vitePortFromEnv() === 5173 || vitePortFromEnv() > 0, true, "T1② 端口解析可用");

		assert.deepEqual(setGuiAutoStart(true, p), { ok: true }, "T1③ on 写入 ok");
		assert.equal(readGuiAutoStart(p), true, "T1④ 读回 true");
		const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
		assert.deepEqual(
			raw,
			{
				models: { searcher: "a/b" },
				notifications: false,
				masterSuccession: { enabled: true },
				gui: { autoStart: true },
			},
			"T1⑤ read-modify-write 保留其余字段",
		);

		assert.deepEqual(setGuiAutoStart(false, p), { ok: true }, "T1⑥ off 写入 ok");
		assert.equal(readGuiAutoStart(p), false, "T1⑦ 读回 false");

		// 坏 config：拒绝覆盖写，原文件不动
		const bad = join(TMP, "t1-bad.json");
		writeFileSync(bad, "{broken json");
		const w = setGuiAutoStart(true, bad);
		assert.equal(w.ok, false, "T1⑧ 坏 config 拒绝写");
		assert.equal(readFileSync(bad, "utf8"), "{broken json", "T1⑨ 坏 config 原样保留");
		// 缺失文件：拒绝静默创建整份 config（防覆盖丢失）
		assert.equal(setGuiAutoStart(true, join(TMP, "t1-missing.json")).ok, false, "T1⑩ 缺失文件拒绝写");
		// 非 JSON 对象（数组）：拒绝
		const arr = join(TMP, "t1-arr.json");
		writeFileSync(arr, "[]");
		assert.equal(setGuiAutoStart(true, arr).ok, false, "T1⑪ 数组 config 拒绝写");
		// readGuiAutoStart never-throw
		assert.equal(readGuiAutoStart(join(TMP, "nope.json")), false, "T1⑫ 缺失文件读 → false");
	}

	// ── T2 vite GET / 探针 ───────────────────────────────────────────
	{
		const server: Server = createServer((_req, res) => {
			res.statusCode = 200;
			res.end("ok");
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const addr = server.address();
		assert.ok(addr && typeof addr === "object", "T2 前置：listen 成功");
		assert.equal(await probeViteAlive(addr.port), true, "T2① HTTP 响应 → alive");
		server.close();
		await new Promise((r) => setTimeout(r, 30));
		assert.equal(await probeViteAlive(addr.port), false, "T2② 关闭端口 → down");
		assert.equal(await probeViteAlive(1, { timeoutMs: 300 }), false, "T2③ never-throw（拒绝连接 → false）");
	}

	// ── T3 ensureGuiRuntime 幂等 / spawn / 兜底 ─────────────────────
	{
		let hostCalls = 0;
		let spawnCalls = 0;
		let spawnArg: { port: number; token: string | null; guiDir: string; viteBin: string } | null = null;
		const deps = {
			startHost: (): Promise<HostStartLike> => {
				hostCalls++;
				return Promise.resolve(okHost({ token: "tok-xyz" }));
			},
			probeVite: () => Promise.resolve(true),
			spawnVite: (o: { port: number; token: string | null; guiDir: string; viteBin: string }) => {
				spawnCalls++;
				spawnArg = o;
				return { spawned: true, pid: 4242 };
			},
			vitePort: 5173,
			guiDir: join(TMP, "guidir"),
			viteBin: join(TMP, "vite-bin-stub.js"),
		};
		writeFileSync(deps.viteBin, "// stub");

		const r1: GuiEnsureResult = await ensureGuiRuntime(deps);
		assert.equal(r1.host.ok, true, "T3① host ok");
		assert.equal(r1.host.already, true, "T3② already 透传");
		assert.equal(r1.vite.action, "reuse", "T3③ vite 活 → reuse（幂等：不重 spawn）");
		assert.equal(spawnCalls, 0, "T3④ 活则 spawn 未被调用");

		const r2 = await ensureGuiRuntime({ ...deps, probeVite: () => Promise.resolve(false) });
		assert.equal(r2.vite.action, "spawned", "T3⑤ vite 死 → spawned");
		assert.equal(spawnCalls, 1, "T3⑥ spawn 恰一次");
		assert.ok(spawnArg && spawnArg.port === 5173, "T3⑦ spawn 端口正确");
		assert.ok(spawnArg && spawnArg.token === "tok-xyz", "T3⑧ spawn 携带 host token（GUI_HOST_TOKEN 链路）");
		assert.ok(spawnArg && spawnArg.viteBin === deps.viteBin && spawnArg.guiDir === deps.guiDir, "T3⑨ cwd/viteBin 注入生效");

		// viteBin 缺失 → skipped（不 spawn）
		const r3 = await ensureGuiRuntime({
			...deps,
			probeVite: () => Promise.resolve(false),
			viteBin: join(TMP, "no-such-vite.js"),
		});
		assert.equal(r3.vite.action, "skipped", "T3⑩ viteBin 缺失 → skipped");
		assert.ok((r3.vite.detail ?? "").includes("npm install"), "T3⑪ skipped 带安装提示");

		// startHost 抛错 → never-throw 兜底
		const r4 = await ensureGuiRuntime({
			startHost: (): Promise<HostStartLike> => Promise.reject(new Error("boom")),
			probeVite: () => Promise.resolve(true),
		});
		assert.equal(r4.host.ok, false, "T3⑫ 抛错收敛 ok:false");
		assert.ok((r4.host.error ?? "").includes("boom"), "T3⑬ 错误信息透传");
		assert.equal(hostCalls, 3, "T3⑭ 每次 ensure 恰一次 host 调用（r1+r2+r3）");
	}

	// ── T4 session_start 门：subagent / tab / OFF / 节流 ─────────────
	{
		let ensureCount = 0;
		const deps = {
			startHost: (): Promise<HostStartLike> => {
				ensureCount++;
				return Promise.resolve(okHost());
			},
			probeVite: () => Promise.resolve(true),
			readAutoStart: (): boolean => true,
			now: (): number => 1_000_000,
		};
		const pi = fakePi();
		registerGuiAutoStart(pi as never, deps);
		const start = pi.ons.find((h) => h.event === "session_start");
		assert.ok(start, "T4 前置：session_start 已注册");
		assert.ok(pi.commands.gui, "T4 前置：/gui 已注册");

		// subagent → 零动作
		process.env.PI_SUBAGENT = "1";
		start.cb({}, undefined);
		await settle();
		assert.equal(ensureCount, 0, "T4① subagent 跳过（零动作）");
		delete process.env.PI_SUBAGENT;

		// tab（PI_TAB_RUN_ID）→ 零动作
		process.env.PI_TAB_RUN_ID = "tab-t4";
		start.cb({}, undefined);
		await settle();
		assert.equal(ensureCount, 0, "T4② tab 跳过（零动作）");
		delete process.env.PI_TAB_RUN_ID;

		// OFF → 零动作（config 门）
		const piOff = fakePi();
		registerGuiAutoStart(piOff as never, { ...deps, readAutoStart: () => false });
		piOff.ons[0]!.cb({}, undefined);
		await settle();
		assert.equal(ensureCount, 0, "T4③ OFF 零动作");

		// ON 主会话 → ensure 恰一次；30s 节流内重入跳过
		guiAutoStartState.lastAt = 0;
		start.cb({}, undefined);
		await settle();
		assert.equal(ensureCount, 1, "T4④ ON 主会话 → ensure 触发");
		start.cb({}, undefined);
		await settle();
		assert.equal(ensureCount, 1, "T4⑤ 节流内重入跳过");
		assert.equal(GUI_AUTOSTART_THROTTLE_MS, 30_000, "T4⑥ 节流窗口 = 30s");
		guiAutoStartState.lastAt = 0; // 归零后再触发
		start.cb({}, undefined);
		await settle();
		assert.equal(ensureCount, 2, "T4⑦ 节流过期后再次触发");
		guiAutoStartState.lastAt = 0;
	}

	// ── T5 /gui 命令面 ──────────────────────────────────────────────
	{
		const cfg = join(TMP, "t5-config.json");
		writeFileSync(cfg, JSON.stringify({ models: {}, notifications: true }, null, 2) + "\n");
		let hostCalls = 0;
		let openCalls = 0;
		let openedUrl = "";
		const deps = {
			configPath: cfg,
			startHost: (): Promise<HostStartLike> => {
				hostCalls++;
				return Promise.resolve(okHost({ token: "t5" }));
			},
			probeVite: () => Promise.resolve(true),
			vitePort: 5173,
			openBrowser: (url: string): { ok: boolean } => {
				openCalls++;
				openedUrl = url;
				return { ok: true };
			},
		};
		const pi = fakePi();
		registerGuiAutoStart(pi as never, deps);
		const gui = pi.commands.gui!;

		const calls: NotifyCall[] = [];
		await gui.handler(undefined, fakeCtx(calls));
		assert.ok((calls[0]?.body ?? "").includes("on|off|status|open"), "T5① 空参 → usage");
		assert.equal(calls[0]?.level, "warning", "T5② usage 为 warning");

		calls.length = 0;
		await gui.handler("on", fakeCtx(calls));
		assert.equal(readGuiAutoStart(cfg), true, "T5③ /gui on 写入 true");
		assert.equal(hostCalls, 1, "T5④ /gui on 立即 ensure");
		assert.ok((calls[0]?.body ?? "").includes("host:"), "T5⑤ on 回显 host/vite");
		assert.ok((calls[0]?.body ?? "").includes("复用"), "T5⑥ ensure 复用（活则不重 spawn）");

		calls.length = 0;
		await gui.handler("off", fakeCtx(calls));
		assert.equal(readGuiAutoStart(cfg), false, "T5⑦ /gui off 写入 false");
		assert.ok((calls[0]?.body ?? "").includes("不停止"), "T5⑧ off 明示不杀已起服务");
		assert.equal(hostCalls, 1, "T5⑨ off 不触发 ensure");

		// status：config + host（真实 classify：活 pid + 死端口 → stale）+ vite 探针（注入 alive）
		writeHostInfo(
			{
				instanceId: "host_t5",
				pid: process.pid,
				port: 1, // 几乎必然无监听 → health 探活失败 → stale
				startedAt: "2026-09-22T00:00:00.000Z",
				protocolVersion: 1,
				token: "t5",
			},
			join(ENV_DIR, "host.json"),
		);
		calls.length = 0;
		await gui.handler("status", fakeCtx(calls));
		const status = calls[0]?.body ?? "";
		assert.ok(status.includes("autoStart=off"), "T5⑩ status 含 config 态");
		assert.ok(/host: (missing|stale|alive|dead)/.test(status), "T5⑪ status 含 host 四态");
		assert.ok(status.includes("vite: alive"), "T5⑫ status 含 vite 探针结果");
		assert.ok(status.includes("dev"), "T5⑬ status 注明 dev 形态");

		// open：先 ensure + 浏览器恰一次 + URL 正确（probeVite=true → 不重 spawn）
		calls.length = 0;
		await gui.handler("open", fakeCtx(calls));
		assert.equal(openCalls, 1, "T5⑭ open 恰开一次浏览器");
		assert.equal(openedUrl, "http://localhost:5173", "T5⑮ open URL 正确");
		assert.equal(hostCalls, 2, "T5⑯ open 先 ensure");
		assert.ok((calls[0]?.body ?? "").includes("localhost:5173"), "T5⑰ open 回显 URL");

		// 写失败路径：configPath 指向目录 → warning
		calls.length = 0;
		const piBad = fakePi();
		registerGuiAutoStart(piBad as never, { ...deps, configPath: TMP });
		await piBad.commands.gui!.handler("on", fakeCtx(calls));
		assert.equal(calls[0]?.level, "warning", "T5⑱ 写失败 → warning");
		assert.ok((calls[0]?.body ?? "").includes("拒绝"), "T5⑲ 写失败带原因");
	}

	console.log("gui-autostart tests: all passed");
	cleanupDirs();
} catch (e) {
	cleanupDirs();
	console.error("gui-autostart tests FAILED:", e);
	process.exit(1);
}
