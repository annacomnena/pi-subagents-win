/**
 * runtime/autonomy/action/classes/types.ts — 动作类共享类型（report / notify 共用）。
 *
 * FileSnapshot / EffectResult 由 report.ts 迁出为单一事实源（避免 registry 与具体类之间
 * 循环 import）；ActionClass 是注册表接口——run.ts 按 class 取 6 个事务原语
 * （targetPath / withinSurface / snapshot / effect / postverify / rollback）+ name /
 * allowedPrefixes / buildContent。
 *
 * 每个动作类声明自己的**效应面边界**（allowedPrefixes，文件夹分好）与**事务原语**
 * （快照/效应/验证/回退同一清单——设计风险 2 缓解：postverify/rollback 单一事实源）。
 */
import type { FrontierSnapshot } from "../../frontier.ts";

/** 文件快照（原字节/权限/存在性）——回退句柄的数据源。 */
export interface FileSnapshot {
	path: string;
	existed: boolean;
	mode: number | null;
	bytes: Buffer | null;
}

export interface EffectResult {
	bytes: number;
	/** 本次效应删除的文件清单（只增不删：本类恒 []；非空 = 违规 → 熔断）。 */
	deletedFiles: string[];
}

/** buildContent 的输入（report 用 frontier 富化正文；notify 用 trigger/project 组装帧）。 */
export interface BuildContentArgs {
	project: string;
	trigger: { rule: string; project: string; evidence: string; approximate: boolean };
	now: number;
	frontier: FrontierSnapshot;
}

/**
 * 动作类注册接口。run.ts 编排层按 class 取用；各原语 never-throw（读失败 = null/unknown）。
 */
export interface ActionClass {
	readonly name: string;
	/** 效应面目录前缀（§A ① 文件夹分好；越界 = DENY namespace-escape）。 */
	allowedPrefixes(stateDir: string): string[];
	/** 目标效应路径（快照/回退/postverify 的作用对象）。 */
	targetPath(stateDir: string, project: string, ts: number): string;
	/** 效应路径是否越出声明前缀（policy 层 + TOCTOU 复验都查）。 */
	withinSurface(stateDir: string, path: string): boolean;
	/** 构造 effect 输入内容（report = markdown 正文；notify = MessageFrame JSON）。 */
	buildContent(args: BuildContentArgs): string;
	/** 快照（原字节/权限/存在性；never-throw；读失败 = null → fail-closed）。 */
	snapshot(path: string): FileSnapshot | null;
	/** 原子效应（report = 写报告；notify = deliverLetter；never-throw；失败 = null）。 */
	effect(path: string, content: string): EffectResult | null;
	/** 后置验证（match | mismatch | unknown；never-throw）。 */
	postverify(path: string, expected: string): "match" | "mismatch" | "unknown";
	/** 回退（按快照恢复；never-throw；失败 = {ok:false} → 熔断 + 冻结）。 */
	rollback(snap: FileSnapshot): { ok: boolean; deletedFiles: string[]; reason?: string };
}
