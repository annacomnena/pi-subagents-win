/**
 * runtime/autonomy/kill-switch.ts — Autonomy 总门（等价 cutover 总门：kill 先于一切）。
 *
 * Task 2002 · plans/0923_autonomy_suite_v1_plan.md（设计要点 a'）。
 * - 红线条款 2：kill 文件优先级高于一切配置；kill 在场时所有 wake 类函数恒 no-wake
 *   （fail-safe）；坏文件按"未 kill"处理（容忍读 → null，不猜）；缺字段不猜。
 * - 文件住自有 namespace：`<runtimeDir>/state/autonomy/kill-switch.json`（stateDir 可注入，
 *   defaultRuntimeDir() 走 PI_RUNTIME_DIR，同 liveness.ts 模式）——测试用 temp 目录，零真实 ~/.pi 污染。
 * - engage/clear 各产出一行审计：由装配层（collect.ts 的 *Audited 包装 + appendAuditLine）
 *   落 `state/autonomy/audit.jsonl`；本模块不写审计（避免与 collect 循环依赖）。
 * - 原子写 tmp+rename（同 timers/mailbox/liveness）；never-throw（失败返回 false，不抛）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultRuntimeDir } from "../journal.ts";
import type { AutonomyConfig } from "./config.ts";

export interface KillSwitchRecord {
	version: 1;
	reason: string;
	at: string;
	by: string;
}

function killSwitchPath(stateDir?: string): string {
	return join(stateDir ?? join(defaultRuntimeDir(), "state"), "autonomy", "kill-switch.json");
}

/** 容忍读：无文件/坏 JSON/坏版本/关键字段缺失 → null（坏文件 = 未 kill；缺文件/读失败不放行也不误杀——gating 层按 null 走配置判据）。 */
export function readKillSwitch(opts?: { stateDir?: string }): KillSwitchRecord | null {
	try {
		const raw = JSON.parse(readFileSync(killSwitchPath(opts?.stateDir), "utf8")) as KillSwitchRecord;
		if (
			raw?.version !== 1 ||
			typeof raw.reason !== "string" ||
			typeof raw.at !== "string" ||
			typeof raw.by !== "string"
		) {
			return null;
		}
		return raw;
	} catch {
		return null;
	}
}

/** 原子写（tmp+rename）；never-throw，失败返回 false。now 可注入（测试 fake clock）。 */
export function engageKillSwitch(input: { reason: string; by: string }, opts?: { stateDir?: string; now?: Date }): boolean {
	try {
		const path = killSwitchPath(opts?.stateDir);
		mkdirSync(dirname(path), { recursive: true });
		const record: KillSwitchRecord = {
			version: 1,
			reason: input.reason,
			at: (opts?.now ?? new Date()).toISOString(),
			by: input.by,
		};
		const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
		renameSync(tmp, path);
		return true;
	} catch {
		return false;
	}
}

/** 删除 kill 文件（不存在也算成功）；never-throw，失败返回 false。 */
export function clearKillSwitch(opts?: { stateDir?: string }): boolean {
	try {
		const path = killSwitchPath(opts?.stateDir);
		if (existsSync(path)) unlinkSync(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * gating 判定（纯）：优先级 kill 文件在场（形状合法）> cfg.enabled !== true > active。
 * 返回 reason ∈ "active" | "autonomy-disabled" | "kill-switch:<reason>"——
 * 所有 wake 类纯函数消费该 reason 产出 no-wake 审计行（红线条款 2 / 10）。
 */
export function evaluateAutonomyGating(cfg: AutonomyConfig, kill: KillSwitchRecord | null): { active: boolean; reason: string } {
	if (kill) return { active: false, reason: `kill-switch:${kill.reason}` };
	if (cfg.enabled !== true) return { active: false, reason: "autonomy-disabled" };
	return { active: true, reason: "active" };
}
