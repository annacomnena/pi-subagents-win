/**
 * _test_recent_scopes.ts — master 原生「最近活跃仓库」感知（recent-scopes.ts）
 *
 * 覆盖（纯函数 + tmp 账本隔离，零真实磁盘依赖）：
 *   R1 三账本归并：scope-liveness 心跳 + tab-runs 派发 + sessions 会话 mtime，同仓多证据合并一条
 *   R2 窗口过滤：7 天外（缺省）被排除；sinceMs 可调
 *   R3 去噪：Temp / tfl- / launch-prompts 等测试临时路径默认排除；includeNoise=true 召回
 *   R4 sessions 编码目录解码（--G--code-X-- → G:/code/X）；非法名原样
 *   R5 账本缺失/损坏：整目录不存在、坏 JSON、坏时间 → 跳过不抛，返回其余
 *   R6 formatRecentScopes：空 → "(none in window)"；TopN 截断 + MM-DD
 *
 * 运行：npm run test:recent-scopes
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	anyLedgerPresent,
	decodeSessionsDirName,
	formatRecentScopes,
	isNoisePath,
	listRecentScopes,
	normalizeExactPath,
	resolveDecodedPath,
} from "./runtime/recent-scopes.ts";

const NOW = Date.parse("2026-09-22T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function mkAgent(): string {
	const root = mkdtempSync(join(tmpdir(), "recent-scopes-test-"));
	mkdirSync(join(root, "runtime", "state", "scope-liveness"), { recursive: true });
	mkdirSync(join(root, "tab-runs"), { recursive: true });
	mkdirSync(join(root, "sessions", "--G--code-GreenCAD--"), { recursive: true });
	return root;
}

function write(p: string, obj: unknown): void {
	writeFileSync(p, JSON.stringify(obj), "utf8");
}

// R4：目录名解码（真实单连接形式）+ 精确路径键 + 段级噪音判定
{
	// 真实 pi 编码：盘符双 `--`，其余单 `-`（与 sessionBucketForCwd 的全单 `-` 不同，两者都兼容）
	assert.equal(decodeSessionsDirName("--G--code-GreenCAD--"), "G:/code/GreenCAD");
	assert.equal(decodeSessionsDirName("--C--Users-Annacomnena-pi-packages-subagent-win--"), "C:/Users/Annacomnena/pi/packages/subagent/win");
	assert.equal(decodeSessionsDirName("--G-code-GreenCAD--"), "G:/code/GreenCAD");
	assert.equal(decodeSessionsDirName("not-encoded"), "not-encoded");
	// 精确键：统一斜杠/盘符/尾部分隔，保留内部结构
	assert.equal(normalizeExactPath("G:\\code\\GreenCAD"), normalizeExactPath("G:/code/GreenCAD"));
	assert.equal(normalizeExactPath("G:/code/GreenCAD/"), "g:/code/greencad");
	// P0 回归：不同仓库永不互并
	assert.notEqual(normalizeExactPath("C:/a-b/c"), normalizeExactPath("C:/a/b-c"));
	assert.notEqual(normalizeExactPath("C:/ab/c"), normalizeExactPath("C:/a/bc"));
	// P0 回归：段级噪音判定（子串不误杀）
	assert.equal(isNoisePath("C:/code/TemplateEngine"), false, "TemplateEngine 合法");
	assert.equal(isNoisePath("C:/code/temporal"), false);
	assert.equal(isNoisePath("C:/code/my-tfl-tools"), false, "合法含 tfl- 名");
	assert.equal(isNoisePath("C:/Temp/tfl-x"), true, "Temp 段");
	assert.equal(isNoisePath("C:/Users/x/AppData/Local/Temp/tfl-c6-test-a/tfl-wt/1/a"), true, "测试命名");
	assert.equal(isNoisePath("C:/a/launch-prompts"), true);
	assert.equal(isNoisePath("C:/a/node_modules"), true);
	assert.equal(isNoisePath("C:/Users/x/.pi/agent/x"), true);
	assert.equal(isNoisePath("G:/code/GreenCAD"), false);
	// 回填：真实存在的目录拼回去；不存在的保留原样
	const tmpRoot = mkdtempSync(join(tmpdir(), "resolve-test-"));
	try {
		mkdirSync(join(tmpRoot, "my-repo"), { recursive: true });
		mkdirSync(join(tmpRoot, "pi-packages", "subagent-win"), { recursive: true });
		const slash = (s: string): string => s.replace(/\\/g, "/");
		// 尾部单 join
		assert.ok(slash(resolveDecodedPath(slash(join(tmpRoot, "my", "repo")))).endsWith("my-repo"));
		// 中间段 join（pi-packages 在中间）
		const mid = slash(resolveDecodedPath(slash(join(tmpRoot, "pi", "packages", "subagent", "win"))));
		assert.ok(mid.endsWith("pi-packages/subagent-win"), mid);
		// 全不存在 → 原样
		const nope = slash(join(tmpRoot, "no", "such"));
		assert.equal(slash(resolveDecodedPath(nope)), nope);
	} finally {
		rmSync(tmpRoot, { recursive: true, force: true });
	}
}

// R1+R2+R3：三账本归并 + 窗口 + 去噪（含 P0 回归：碰撞隔离、scope 命名空间、未来时间、空桶）
{
	const root = mkAgent();
	try {
		// liveness：GreenCAD 心跳（1 天前，窗口内）+ scope:Temp 心跳（永不过滤 scope 键）
		write(join(root, "runtime", "state", "scope-liveness", "GreenCAD.json"), {
			scopeKey: "GreenCAD",
			updatedAt: new Date(NOW - 1 * DAY).toISOString(),
		});
		write(join(root, "runtime", "state", "scope-liveness", "Temp.json"), {
			scopeKey: "Temp",
			updatedAt: new Date(NOW - 1 * DAY).toISOString(),
		});
		// liveness：old-repo 心跳（30 天前，窗口外）
		write(join(root, "runtime", "state", "scope-liveness", "old-repo.json"), {
			scopeKey: "old-repo",
			updatedAt: new Date(NOW - 30 * DAY).toISOString(),
		});
		// tab：G:/code/GreenCAD 派发（2 天前）+ Temp 噪音派发（1 天前，默认排除）
		write(join(root, "tab-runs", "tab_a.json"), {
			id: "tab_a", taskId: "101", cwd: "G:/code/GreenCAD",
			dispatchedAt: new Date(NOW - 2 * DAY).toISOString(),
		});
		write(join(root, "tab-runs", "tab_noise.json"), {
			id: "tab_noise", taskId: "102", cwd: "C:/Temp/tfl-x",
			dispatchedAt: new Date(NOW - 1 * DAY).toISOString(),
		});
		// session：GreenCAD 会话文件（3 天前，用 mtime；真实单连接编码）
		const sf = join(root, "sessions", "--G--code-GreenCAD--", "s1.jsonl");
		writeFileSync(sf, "{}\n", "utf8");
		utimesSync(sf, new Date(NOW - 3 * DAY), new Date(NOW - 3 * DAY));

		const items = listRecentScopes({ now: NOW, agentDir: root });
		const keys = items.map((i) => i.key);
		// scope: 与路径是两个独立命名空间（R1 注释修正：liveness 一条 + 路径一条，不压成一条）
		assert.ok(keys.includes("scope:GreenCAD"), "liveness 命中");
		assert.ok(keys.includes("scope:Temp"), "scope 键永不过滤（即使叫 Temp）");
		// tab 精确路径与 session 有损解码按精确键合并，展示用精确路径
		assert.ok(keys.includes("G:/code/GreenCAD") || keys.includes("G:\\code\\GreenCAD"), "tab+session 归并命中");
		const repo = items.find((i) => i.key === "G:/code/GreenCAD" || i.key === "G:\\code\\GreenCAD")!;
		assert.deepEqual(repo.sources.sort(), ["session", "tab:101"]);
		assert.equal(repo.lastActiveAt, new Date(NOW - 2 * DAY).toISOString(), "取最新证据时间");
		// 窗口外 + 路径噪音排除（scope:Temp 不受影响，上已断言）
		assert.ok(!keys.includes("scope:old-repo"), "30 天前排除");
		assert.ok(!keys.some((k) => !k.startsWith("scope:") && k.includes("Temp")), "Temp 路径噪音排除");

		// includeNoise=true 召回
		const noisy = listRecentScopes({ now: NOW, agentDir: root, includeNoise: true });
		assert.ok(noisy.some((i) => i.key.includes("Temp")), "includeNoise 召回");

		// sinceMs 可调（1 天窗口 → 只剩 1 天内的）
		const tiny = listRecentScopes({ now: NOW, agentDir: root, sinceMs: 1 * DAY });
		assert.ok(tiny.every((i) => Date.parse(i.lastActiveAt) >= NOW - 1 * DAY - 1000));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

// P0 回归：精确 cwd 不同 → 永不互并（旧归一化键曾把 C:/a-b/c 与 C:/a/b-c 压成一条）
{
	const root = mkAgent();
	try {
		write(join(root, "tab-runs", "tab_0.json"), {
			id: "tab_0", taskId: "0", cwd: "C:/a-b/c",
			dispatchedAt: new Date(NOW - 1 * DAY).toISOString(),
		});
		write(join(root, "tab-runs", "tab_1.json"), {
			id: "tab_1", taskId: "1", cwd: "C:/a/b-c",
			dispatchedAt: new Date(NOW - 1 * DAY).toISOString(),
		});
		// 合法含 Temp 子串的真实仓库不被排除
		write(join(root, "tab-runs", "tab_te.json"), {
			id: "tab_te", taskId: "2", cwd: "C:/code/TemplateEngine",
			dispatchedAt: new Date(NOW - 1 * DAY).toISOString(),
		});
		// 同 cwd 多 task 合并一条（同一仓库，证据累加）
		write(join(root, "tab-runs", "tab_0b.json"), {
			id: "tab_0b", taskId: "3", cwd: "C:/a-b/c",
			dispatchedAt: new Date(NOW - 2 * DAY).toISOString(),
		});
		const items = listRecentScopes({ now: NOW, agentDir: root });
		const keys = items.map((i) => i.key);
		assert.ok(keys.includes("C:/a-b/c"), "C:/a-b/c 独立");
		assert.ok(keys.includes("C:/a/b-c"), "C:/a/b-c 独立");
		assert.ok(keys.includes("C:/code/TemplateEngine"), "TemplateEngine 不误杀");
		const ab = items.find((i) => i.key === "C:/a-b/c")!;
		assert.deepEqual(ab.sources.sort(), ["tab:0", "tab:3"], "同 cwd 多 task 累加");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

// P0 回归：未来时间边界（now+60s 内宽容，之外丢弃）+ 空 sessions 子目录不产生条目
{
	const root = mkAgent();
	try {
		write(join(root, "tab-runs", "tab_fut_ok.json"), {
			id: "tab_fut_ok", taskId: "f1", cwd: "G:/fut-ok",
			dispatchedAt: new Date(NOW + 30_000).toISOString(),
		});
		write(join(root, "tab-runs", "tab_fut_bad.json"), {
			id: "tab_fut_bad", taskId: "f2", cwd: "G:/fut-bad",
			dispatchedAt: new Date(NOW + 3600_000).toISOString(),
		});
		mkdirSync(join(root, "sessions", "--G--empty--"), { recursive: true });
		const items = listRecentScopes({ now: NOW, agentDir: root });
		const keys = items.map((i) => i.key);
		assert.ok(keys.includes("G:/fut-ok"), "60s 内时钟偏差宽容");
		assert.ok(!keys.includes("G:/fut-bad"), "1h 未来时间丢弃");
		assert.ok(!keys.some((k) => k.includes("empty")), "空 sessions 子目录不产生条目");
		// 账本存在性区分：空目录仍算“有证据源”，全缺席才 unknown
		assert.equal(anyLedgerPresent(root), true);
		assert.equal(anyLedgerPresent(join(root, "nope")), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

// R5：坏账本不抛
{
	const root = mkAgent();
	try {
		writeFileSync(join(root, "runtime", "state", "scope-liveness", "bad.json"), "{not json", "utf8");
		write(join(root, "tab-runs", "bad.json"), { cwd: "G:/x", dispatchedAt: "not-a-time" });
		const items = listRecentScopes({ now: NOW, agentDir: root });
		assert.ok(Array.isArray(items), "坏账本不抛");
		// 整个 agentDir 不存在
		assert.deepEqual(listRecentScopes({ now: NOW, agentDir: join(root, "nope") }), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

// R6：展示格式
{
	assert.equal(formatRecentScopes([]), "(none in window)");
	const s = formatRecentScopes([
		{ key: "G:/code/GreenCAD", lastActiveAt: new Date(NOW - 1 * DAY).toISOString(), sources: ["session"] },
		{ key: "scope:zcode", lastActiveAt: new Date(NOW - 2 * DAY).toISOString(), sources: ["liveness"] },
	]);
	assert.ok(s.includes("G:/code/GreenCAD(09-21)"), s);
	assert.ok(s.includes("scope:zcode(09-20)"), s);
	const cut = formatRecentScopes(
		Array.from({ length: 10 }, (_, i) => ({
			key: `r${i}`,
			lastActiveAt: new Date(NOW - i * 3_600_000).toISOString(),
			sources: ["session"] as string[],
		})),
		3,
	);
	assert.equal(cut.split(",").length, 3, "TopN 截断");
}

console.log("_test_recent_scopes: all assertions passed");
