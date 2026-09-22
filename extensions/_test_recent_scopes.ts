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
	decodeSessionsDirName,
	formatRecentScopes,
	listRecentScopes,
} from "./runtime/recent-scopes.ts";

const NOW = Date.parse("2026-09-22T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function mkAgent(): string {
	const root = mkdtempSync(join(tmpdir(), "recent-scopes-test-"));
	mkdirSync(join(root, "runtime", "state", "scope-liveness"), { recursive: true });
	mkdirSync(join(root, "tab-runs"), { recursive: true });
	mkdirSync(join(root, "sessions", "--G--code--GreenCAD--"), { recursive: true });
	return root;
}

function write(p: string, obj: unknown): void {
	writeFileSync(p, JSON.stringify(obj), "utf8");
}

// R4：目录名解码
{
	assert.equal(decodeSessionsDirName("--G--code--GreenCAD--"), "G:/code/GreenCAD");
	assert.equal(decodeSessionsDirName("--C--Users--Annacomnena--"), "C:/Users/Annacomnena");
	assert.equal(decodeSessionsDirName("not-encoded"), "not-encoded");
	assert.equal(decodeSessionsDirName("--X--"), "X");
}

// R1+R2+R3：三账本归并 + 窗口 + 去噪
{
	const root = mkAgent();
	try {
		// liveness：GreenCAD 心跳（1 天前，窗口内）
		write(join(root, "runtime", "state", "scope-liveness", "GreenCAD.json"), {
			scopeKey: "GreenCAD",
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
		// session：GreenCAD 会话文件（3 天前，用 mtime）
		const sf = join(root, "sessions", "--G--code--GreenCAD--", "s1.jsonl");
		writeFileSync(sf, "{}\n", "utf8");
		utimesSync(sf, new Date(NOW - 3 * DAY), new Date(NOW - 3 * DAY));

		const items = listRecentScopes({ now: NOW, agentDir: root });
		const keys = items.map((i) => i.key);
		// GreenCAD 三证据归并一条（liveness 的 scope: 键与路径键是两条，属不同命名空间）
		assert.ok(keys.includes("scope:GreenCAD"), "liveness 命中");
		assert.ok(keys.includes("G:/code/GreenCAD"), "tab+session 归并命中");
		const repo = items.find((i) => i.key === "G:/code/GreenCAD")!;
		assert.deepEqual(repo.sources.sort(), ["session", "tab:101"]);
		assert.equal(repo.lastActiveAt, new Date(NOW - 2 * DAY).toISOString(), "取最新证据时间");
		// 窗口外 + 噪音排除
		assert.ok(!keys.includes("scope:old-repo"), "30 天前排除");
		assert.ok(!keys.some((k) => k.includes("Temp")), "Temp 噪音排除");

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
