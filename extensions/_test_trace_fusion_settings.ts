/**
 * _test_trace_fusion_settings.ts — trace-fusion 设置面（2026-11-02）
 *
 * 核心是 **R-1 安全性质**（config.json 事故条款）：
 *   ① 只改 traceFusionLoop 单键，其余顶层键原样保留
 *   ② 写前必须有备份
 *   ③ 原子写 + 回读校验：顶层键数变化必须报错而不是静默
 *   ④ 坏 JSON / 备份失败 ⇒ 中止，不做半套写入
 *   ⑤ 归一化：非法值回落默认，不猜
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	readTfBlock,
	normalizeUserSettings,
	readLaneModels,
	readFusionModels,
	writeTfBlock,
	renderSettingsSummary,
	DEFAULT_USER_SETTINGS,
} from "./trace-fusion/tf-settings.ts";

const root = mkdtempSync(join(tmpdir(), "tf-settings-"));
const CFG = join(root, "config.json");

/** 真实形状：10 个顶层键（含 traceFusionLoop 之外的 9 个） */
function writeRealisticConfig() {
	writeFileSync(
		CFG,
		JSON.stringify(
			{
				models: { searcher: "x/y" },
				fallbackModels: {},
				thinking: {},
				notifications: true,
				searcherMode: "serial",
				liteMode: "on",
				masterSuccession: { auto: true },
				gui: { autoStart: true },
				channels: { wechat: {} },
				autonomy: { enabled: true },
			},
			null,
			2,
		) + "\n",
		"utf8",
	);
}

try {
	// ── ① 只改单键 + 顶层键不丢 ──
	{
		writeRealisticConfig();
		const before = Object.keys(JSON.parse(readFileSync(CFG, "utf8"))).sort();
		const r = writeTfBlock(CFG, { laneConcurrency: 1, maxWallClockPerLaneMin: 30 });
		assert.equal(r.ok, true, `写入应成功：${r.error ?? ""}`);
		assert.equal(r.keysBefore, 10);
		// 首次写入会**新增** traceFusionLoop 顶层键（10→11）——这是正常行为；
		// R-1 防的是**丢键**，所以断言方向是「原有 10 个键一个不少」而不是「总数不变」。
		assert.equal(r.keysAfter, 11, "首次写入新增 traceFusionLoop（10→11）");

		const after = JSON.parse(readFileSync(CFG, "utf8")) as Record<string, unknown>;
		// 原有 10 个键必须全在（allow 新增 traceFusionLoop，但不允许丢任何一个）
		for (const k of before) assert.ok(k in after, `顶层键 ${k} 必须保留`);
		assert.deepEqual(after["gui"], { autoStart: true }, "gui 内容不得被改动");
		assert.deepEqual(after["autonomy"], { enabled: true }, "autonomy 内容不得被改动");

		const tf = readTfBlock(after);
		assert.equal(tf["laneConcurrency"], 1);
		assert.equal(tf["maxWallClockPerLaneMin"], 30);
		console.log("  ✓ ① 只改 traceFusionLoop 单键；10 个顶层键一个不丢（gui/channels/autonomy 原样）");
	}

	// ── ② 备份存在且内容 = 写前 ──
	{
		writeRealisticConfig();
		const original = readFileSync(CFG, "utf8");
		const r = writeTfBlock(CFG, { laneConcurrency: 2 });
		assert.equal(r.ok, true);
		assert.ok(r.backupPath && existsSync(r.backupPath), "必须留下备份");
		assert.equal(readFileSync(r.backupPath!, "utf8"), original, "备份必须是写前原文");
		assert.ok(r.backupPath!.includes("bak-tfsettings-"), "备份命名要可辨识用途");
		console.log("  ✓ ② 写前备份，内容 = 写前原文");
	}

	// ── ③ 反复写入不累积垃圾键；undefined = 删除该键 ──
	{
		writeRealisticConfig();
		writeTfBlock(CFG, { laneConcurrency: 1 });
		writeTfBlock(CFG, { maxRounds: 5 });
		const tf = readTfBlock(JSON.parse(readFileSync(CFG, "utf8")));
		assert.equal(tf["laneConcurrency"], 1, "前一次写入必须保留");
		assert.equal(tf["maxRounds"], 5, "后一次写入生效");
		writeTfBlock(CFG, { maxRounds: undefined });
		const tf2 = readTfBlock(JSON.parse(readFileSync(CFG, "utf8")));
		assert.equal("maxRounds" in tf2, false, "undefined 必须删除该键而不是写 null");
		console.log("  ✓ ③ 增量合并；undefined 删除键（不写 null）");
	}

	// ── ④ 坏 JSON ⇒ 中止，文件不被破坏 ──
	{
		writeFileSync(CFG, "{ not json", "utf8");
		const r = writeTfBlock(CFG, { laneConcurrency: 1 });
		assert.equal(r.ok, false, "坏 JSON 必须中止");
		assert.ok(r.error!.includes("解析失败"));
		assert.equal(readFileSync(CFG, "utf8"), "{ not json", "坏文件必须原样保留（不覆盖）");
		console.log("  ✓ ④ 坏 JSON 中止写入，原文件不被破坏");
	}

	// ── ⑤ 归一化：非法值回落默认 ──
	{
		for (const bad of [0, 4, -1, 2.5, "2", null]) {
			const s = normalizeUserSettings({ laneConcurrency: bad });
			assert.equal(s.laneConcurrency, DEFAULT_USER_SETTINGS.laneConcurrency, `laneConcurrency=${String(bad)} 必须回默认`);
		}
		assert.equal(normalizeUserSettings({ laneConcurrency: 1 }).laneConcurrency, 1);
		assert.equal(normalizeUserSettings({ laneConcurrency: 2 }).laneConcurrency, 2);

		// 数值类：0/负数/NaN 回默认
		assert.equal(normalizeUserSettings({ maxRounds: 0 }).maxRounds, DEFAULT_USER_SETTINGS.maxRounds);
		assert.equal(normalizeUserSettings({ maxRounds: Number.NaN }).maxRounds, DEFAULT_USER_SETTINGS.maxRounds);
		// mode 只认 implement，其它一律 diagnose
		assert.equal(normalizeUserSettings({ mode: "garbage" }).mode, "diagnose");
		assert.equal(normalizeUserSettings({ mode: "implement" }).mode, "implement");
		console.log("  ✓ ⑤ 归一化：非法 laneConcurrency/数值/mode 一律回默认");
	}

	// ── ⑥ per-lane / 融合模型读取：只收非空字符串，丢垃圾 ──
	{
		const lanes = readLaneModels({ workerModelByLane: { A: "p/a", B: "  ", C: 42, D: "p/d" } });
		assert.deepEqual(lanes, { A: "p/a" }, "只收 A/B/C 的非空字符串（B 空白/C 非串/D 越界一律丢）");
		assert.deepEqual(readLaneModels({ workerModelByLane: "nope" }), {}, "非对象 ⇒ 空");
		const f = readFusionModels({ fusionModel: " p/f ", consultModel: "" });
		assert.equal(f.fusionModel, "p/f", "trim 后保留");
		assert.equal(f.consultModel, undefined, "空串视同未设");
		console.log("  ✓ ⑥ 模型读取：只收合法值，垃圾静默丢弃（不抛）");
	}

	// ── ⑦ 摘要可读（三个命令里「参数」一项的展示面）──
	{
		writeRealisticConfig();
		writeTfBlock(CFG, { laneConcurrency: 1, workerModelByLane: { A: "lan/bonsai", B: "prov/strong" } });
		const lines = renderSettingsSummary(CFG);
		const text = lines.join("\n");
		assert.ok(text.includes("严格串行"), "并发度 1 必须显式标注串行");
		assert.ok(text.includes("lan/bonsai"), "必须显示 A 的模型");
		assert.ok(text.includes("prov/strong"), "必须显示 B 的模型");
		assert.ok(text.includes("未设") && text.includes("融合模型"), "必须显示融合模型未设（避免用户以为已生效）");
		console.log("  ✓ ⑦ 设置摘要：并发度/模型/融合模型未实现均如实展示");
	}

	console.log("trace-fusion settings tests passed");
} finally {
	try { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* 尽力 */ }
}
