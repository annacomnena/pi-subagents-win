/**
 * model-presets — 子代理模型预设（5 个命名槽位）
 *
 * 用途：把 config.json 中模型相关的三张表（models / fallbackModels / thinking）
 * 整体存入命名槽位，随时整体恢复。典型场景：
 *   - 夜间切换便宜模型组合
 *   - 云端额度不足时整体切回本地模型组合
 *
 * 存储：~/.pi/agent/subagent-model-presets.json（用户数据，包更新不受影响）
 *
 * 命令：
 *   /sub-presets                          交互菜单（TUI）；无 UI 时等同 list
 *   /sub-presets list                     列出槽位 + 当前设置摘要
 *   /sub-presets save <1-5> [name]        当前设置 → 槽位（覆盖；省略名字沿用原名）
 *   /sub-presets load <1-5>               槽位 → 应用为当前设置（整体替换三张表）
 *   /sub-presets show <1-5>               查看槽位详情
 *   /sub-presets clear <1-5>              清空槽位
 *   /sub-presets rename <1-5> <name>      重命名
 *
 * 设计约束：index.ts 不再增长——本命令的全部逻辑独立在本模块，
 * 通过 deps 注入 config 读写（结构类型兼容 AgentConfig，保留其余字段）。
 * 并发约定：预设文件被主会话与标签页共享；save/clear/rename 一律
 * 「写前重读、只改目标槽位」，交互菜单停留期间其他会话的改动不会被旧快照覆盖。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// ── 数据模型 ────────────────────────────────────────────────────────

/** config.json 的模型相关切片（结构兼容 index.ts 的 AgentConfig）。 */
export interface PresetConfigLike {
	models: Record<string, string>;
	fallbackModels: Record<string, string[]>;
	thinking: Record<string, string>;
}

export interface ModelPreset extends PresetConfigLike {
	name: string;
	savedAt: string;
}

interface PresetStore {
	version: 1;
	slots: Record<string, ModelPreset>;
}

export const PRESETS_PATH = join(homedir(), ".pi", "agent", "subagent-model-presets.json");
const SLOT_COUNT = 5;

// ── 存储读写 ────────────────────────────────────────────────────────

function emptyStore(): PresetStore {
	return { version: 1, slots: {} };
}

function isPreset(value: unknown): value is ModelPreset {
	if (!value || typeof value !== "object") return false;
	const v = value as Partial<ModelPreset>;
	return typeof v.name === "string" && typeof v.savedAt === "string"
		&& !!v.models && typeof v.models === "object"
		&& !!v.fallbackModels && typeof v.fallbackModels === "object"
		&& !!v.thinking && typeof v.thinking === "object";
}

function readStore(): PresetStore {
	try {
		const parsed = JSON.parse(readFileSync(PRESETS_PATH, "utf8")) as Partial<PresetStore>;
		if (!parsed || typeof parsed !== "object" || !parsed.slots || typeof parsed.slots !== "object") return emptyStore();
		const slots: Record<string, ModelPreset> = {};
		for (const [key, value] of Object.entries(parsed.slots)) {
			const slot = Number(key);
			if (!Number.isInteger(slot) || slot < 1 || slot > SLOT_COUNT || !isPreset(value)) continue;
			slots[String(slot)] = value;
		}
		return { version: 1, slots };
	} catch {
		return emptyStore();
	}
}

function writeStore(store: PresetStore): void {
	writeFileSync(PRESETS_PATH, JSON.stringify(store, null, 2) + "\n");
}

// ── 纯函数 ──────────────────────────────────────────────────────────

function snapshotFrom(cfg: PresetConfigLike, name: string): ModelPreset {
	return {
		name,
		savedAt: new Date().toISOString(),
		models: { ...cfg.models },
		fallbackModels: Object.fromEntries(Object.entries(cfg.fallbackModels).map(([agent, chain]) => [agent, [...chain]])),
		thinking: { ...cfg.thinking },
	};
}

function presetAgents(preset: PresetConfigLike): string[] {
	return [...new Set([...Object.keys(preset.models), ...Object.keys(preset.fallbackModels), ...Object.keys(preset.thinking)])].sort();
}

function configLines(cfg: PresetConfigLike, indent = "  "): string {
	const lines = presetAgents(cfg).map((agent) =>
		`${indent}${agent.padEnd(16)} model=${cfg.models[agent] ?? "(default)"}  fallback=${(cfg.fallbackModels[agent] ?? []).join(",") || "(none)"}  thinking=${cfg.thinking[agent] ?? "(default)"}`);
	return lines.length > 0 ? lines.join("\n") : `${indent}(no per-agent model settings — all pi default)`;
}

function savedAtLabel(iso: string): string {
	const ms = Date.parse(iso);
	if (Number.isNaN(ms)) return iso;
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function slotListLines(store: PresetStore): string[] {
	const lines: string[] = [];
	for (let slot = 1; slot <= SLOT_COUNT; slot++) {
		const preset = store.slots[String(slot)];
		lines.push(preset
			? `[${slot}] ${preset.name}  — ${presetAgents(preset).length} agents, saved ${savedAtLabel(preset.savedAt)}`
			: `[${slot}] (empty)`);
	}
	return lines;
}

function parseSlot(value: string | undefined): number | null {
	if (!value || !new RegExp(`^[1-${SLOT_COUNT}]$`).test(value)) return null;
	return Number(value);
}

function listText(store: PresetStore, cfg: PresetConfigLike): string {
	return `Subagent model presets (${PRESETS_PATH}):\n${slotListLines(store).join("\n")}` +
		`\n\nCurrent settings:\n${configLines(cfg)}` +
		`\n用法: /sub-presets save|load|show|clear|rename <1-5> [name]`;
}

/** 从 "[N] ..." 形式的选择标签解析槽位号；无法解析返回 null。 */
function slotFromLabel(label: string): number | null {
	const slot = Number(label.match(/^\[(\d+)\]/)?.[1] ?? 0);
	return slot >= 1 && slot <= SLOT_COUNT ? slot : null;
}

// ── 槽位操作（文本/交互两条路径共用；写前重读防覆盖并发修改）────────

function saveSlot(ctx: ExtensionCommandContext, deps: CommandDeps, slot: number, name: string): void {
	const preset = snapshotFrom(deps.reloadConfig(), name);
	const fresh = readStore();
	const wasOccupied = !!fresh.slots[String(slot)];
	fresh.slots[String(slot)] = preset;
	writeStore(fresh);
	ctx.ui.notify(`💾 已${wasOccupied ? "覆盖" : "保存"}槽位 [${slot}] ${name}\n${configLines(preset)}`, "info");
}

function showSlot(ctx: ExtensionCommandContext, slot: number): void {
	const preset = readStore().slots[String(slot)];
	ctx.ui.notify(preset
		? `[${slot}] ${preset.name} (saved ${savedAtLabel(preset.savedAt)})\n${configLines(preset)}`
		: `槽位 [${slot}] 为空`, "info");
}

function clearSlot(ctx: ExtensionCommandContext, slot: number): void {
	const fresh = readStore();
	const preset = fresh.slots[String(slot)];
	if (!preset) {
		ctx.ui.notify(`槽位 [${slot}] 已经为空`, "info");
		return;
	}
	delete fresh.slots[String(slot)];
	writeStore(fresh);
	ctx.ui.notify(`🧹 已清空槽位 [${slot}] ${preset.name}`, "info");
}

function renameSlot(ctx: ExtensionCommandContext, slot: number, name: string): void {
	const fresh = readStore();
	const preset = fresh.slots[String(slot)];
	if (!preset) {
		ctx.ui.notify(`槽位 [${slot}] 为空，先保存再命名`, "error");
		return;
	}
	const oldName = preset.name;
	preset.name = name;
	writeStore(fresh);
	ctx.ui.notify(`✏️ 槽位 [${slot}] 已重命名: ${oldName} → ${name}`, "info");
}

function applyPreset(ctx: ExtensionCommandContext, deps: CommandDeps, slot: number, preset: ModelPreset): void {
	// 在 reloadConfig 返回的对象上整体替换三张表再写回，保留 notifications/searcherMode 等其余字段。
	const cfg = deps.reloadConfig();
	cfg.models = { ...preset.models };
	cfg.fallbackModels = Object.fromEntries(Object.entries(preset.fallbackModels).map(([agent, chain]) => [agent, [...chain]]));
	cfg.thinking = { ...preset.thinking };
	deps.writeConfig(cfg);
	deps.reloadConfig();
	ctx.ui.notify(`📥 已应用槽位 [${slot}] ${preset.name}（models/fallbacks/thinking 已整体替换）\n${configLines(preset)}`, "info");
}

// ── 交互流程（TUI）──────────────────────────────────────────────────

async function pickSlot(ctx: ExtensionCommandContext, title: string): Promise<number | null> {
	const picked = await ctx.ui.select(title, slotListLines(readStore()));
	return picked ? slotFromLabel(picked) : null;
}

async function interactiveSave(ctx: ExtensionCommandContext, deps: CommandDeps): Promise<void> {
	const slot = await pickSlot(ctx, "Save current settings to slot:");
	if (slot === null) return;
	const existing = readStore().slots[String(slot)];
	const defaultName = existing?.name ?? `preset-${slot}`;
	// pi 的 ui.input 第二参数是 placeholder 且 TUI 不渲染，原名/默认名放进 title 提示。
	const name = await ctx.ui.input(`Preset name (empty = keep "${defaultName}"):`);
	if (name === undefined) return;
	saveSlot(ctx, deps, slot, name.trim() || defaultName);
}

async function interactiveLoad(ctx: ExtensionCommandContext, deps: CommandDeps): Promise<void> {
	const store = readStore();
	const occupied = Object.keys(store.slots).map(Number).sort();
	if (occupied.length === 0) {
		ctx.ui.notify("没有已保存的预设；先用 /sub-presets save <1-5> [name] 保存。", "warning");
		return;
	}
	const labels = occupied.map((slot) => {
		const preset = store.slots[String(slot)];
		return `[${slot}] ${preset.name}  — ${presetAgents(preset).length} agents, saved ${savedAtLabel(preset.savedAt)}`;
	});
	const picked = await ctx.ui.select("Load preset (replaces models/fallbacks/thinking):", labels);
	if (!picked) return;
	const slot = slotFromLabel(picked);
	const preset = slot !== null ? store.slots[String(slot)] : undefined;
	if (slot === null || !preset) return;
	applyPreset(ctx, deps, slot, preset);
}

async function interactiveShow(ctx: ExtensionCommandContext): Promise<void> {
	const slot = await pickSlot(ctx, "Show slot:");
	if (slot === null) return;
	showSlot(ctx, slot);
}

async function interactiveClear(ctx: ExtensionCommandContext): Promise<void> {
	const slot = await pickSlot(ctx, "Clear slot:");
	if (slot === null) return;
	clearSlot(ctx, slot);
}

async function interactiveRename(ctx: ExtensionCommandContext): Promise<void> {
	const slot = await pickSlot(ctx, "Rename slot:");
	if (slot === null) return;
	const preset = readStore().slots[String(slot)];
	if (!preset) {
		ctx.ui.notify(`槽位 [${slot}] 为空，先保存再命名`, "warning");
		return;
	}
	// pi 的 ui.input 不支持预填，原名放 title 让用户看得见。
	const name = await ctx.ui.input(`New name for [${slot}] (current: ${preset.name}):`);
	if (name === undefined) return;
	if (!name.trim()) return;
	renameSlot(ctx, slot, name.trim());
}

// ── 命令注册 ────────────────────────────────────────────────────────

interface CommandDeps {
	reloadConfig: () => PresetConfigLike;
	writeConfig: (cfg: PresetConfigLike) => void;
}

export function registerSubPresetsCommand(pi: ExtensionAPI, deps: CommandDeps): void {
	pi.registerCommand("sub-presets", {
		description: "子代理模型预设槽位（5 个）：save/load/show/clear/rename <1-5> [name]",
		handler: async (args, ctx) => {
			const text = (args ?? "").trim();
			const parts = text.split(/\s+/).filter(Boolean);

			// 无参数：TUI 进交互菜单，否则等同 list
			if (parts.length === 0) {
				if (ctx.hasUI) {
					const ACTIONS = [
						"💾 Save current → slot",
						"📥 Load slot → current",
						"🔎 Show slot",
						"🧹 Clear slot",
						"✏️ Rename slot",
						"📄 List all",
					] as const;
					const picked = await ctx.ui.select("Subagent model presets:", [...ACTIONS]);
					if (!picked) return;
					switch (picked) {
						case ACTIONS[0]: return interactiveSave(ctx, deps);
						case ACTIONS[1]: return interactiveLoad(ctx, deps);
						case ACTIONS[2]: return interactiveShow(ctx);
						case ACTIONS[3]: return interactiveClear(ctx);
						case ACTIONS[4]: return interactiveRename(ctx);
						case ACTIONS[5]: break; // List all → 落到下方公共 list 输出
						default: return;
					}
				}
				ctx.ui.notify(listText(readStore(), deps.reloadConfig()), "info");
				return;
			}

			const action = parts[0].toLowerCase();

			if (action === "list") {
				ctx.ui.notify(listText(readStore(), deps.reloadConfig()), "info");
				return;
			}

			if (action === "save") {
				const slot = parseSlot(parts[1]);
				if (slot === null) {
					ctx.ui.notify("用法: /sub-presets save <1-5> [name]", "error");
					return;
				}
				const existing = readStore().slots[String(slot)];
				const name = parts.slice(2).join(" ").trim() || existing?.name || `preset-${slot}`;
				saveSlot(ctx, deps, slot, name);
				return;
			}

			if (action === "load") {
				const slot = parseSlot(parts[1]);
				const preset = slot !== null ? readStore().slots[String(slot)] : undefined;
				if (!preset) {
					ctx.ui.notify(slot === null ? "用法: /sub-presets load <1-5>" : `槽位 [${slot}] 为空`, "error");
					return;
				}
				applyPreset(ctx, deps, slot, preset);
				return;
			}

			if (action === "show") {
				const slot = parseSlot(parts[1]);
				if (slot === null) {
					ctx.ui.notify("用法: /sub-presets show <1-5>", "error");
					return;
				}
				showSlot(ctx, slot);
				return;
			}

			if (action === "clear") {
				const slot = parseSlot(parts[1]);
				if (slot === null) {
					ctx.ui.notify("用法: /sub-presets clear <1-5>", "error");
					return;
				}
				clearSlot(ctx, slot);
				return;
			}

			if (action === "rename") {
				const slot = parseSlot(parts[1]);
				const name = parts.slice(2).join(" ").trim();
				if (slot === null || !name) {
					ctx.ui.notify("用法: /sub-presets rename <1-5> <new-name>", "error");
					return;
				}
				renameSlot(ctx, slot, name);
				return;
			}

			ctx.ui.notify(
				"用法: /sub-presets [save|load|show|clear|rename <1-5> [name] | list]\n" +
				"  save <1-5> [name]   当前模型设置存入槽位（覆盖；省略名字沿用原名）\n" +
				"  load <1-5>          应用槽位（整体替换 models/fallbacks/thinking）\n" +
				"  show <1-5>          查看槽位详情\n" +
				"  clear <1-5>         清空槽位\n" +
				"  rename <1-5> <name> 重命名槽位\n" +
				"  list                列出槽位与当前设置",
				"info",
			);
		},
	});
}
