/**
 * runtime/autonomy/action/classes/report.ts — diagnostic-report 动作类（P1 动作类）。
 *
 * 效应面（§1.3 / 计划 P1）：**仅 `<stateDir>/autonomy/actions/reports/` 子目录**（自有
 * namespace 内、最低风险）。动作 = 汇总失败/停滞证据 → 原子写报告文件；事务包裹：
 * 快照（原字节/权限/存在性）→ 原子写（tmp+rename）→ 回读比对 → 失配即回退并复验。
 *
 * §A 判据在本类的落实：
 *  ① 目录前缀（文件夹分好）：`allowedPrefixes` 声明允许写的目录前缀；`withinSurface` 判
 *     效应路径是否越界——越界 = DENY(namespace-escape)（policy 层 + TOCTOU 复验都查）。
 *  ② 只增不删（不删除原有文件）：`effect` **只创建/覆盖写**报告文件，**永不 remove/unlink
 *     既有文件** ⇒ 返回的 `deletedFiles` 恒 []。覆盖写经快照可恢复；回退删除的仅是本动作
 *     自创文件（撤销自身效应），不计入 deletedFiles。
 *
 * 本模块只做单文件事务原语；预算/熔断/账本/编排由 run.ts 承担。全部 IO never-throw。
 * FileSnapshot / EffectResult / ActionClass 迁至 types.ts（单一事实源，避免循环 import）；
 * 此处 re-export FileSnapshot/EffectResult 保持既有 import 路径（测试）可用。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { POLICY_VERSION } from "../ledger.ts";
import type { BuildContentArgs, EffectResult, FileSnapshot, ActionClass } from "./types.ts";

export type { EffectResult, FileSnapshot };

/** 报告正文（汇总失败/停滞证据：trigger + frontier 项目态 + 只读定性）。 */
function buildReportBody(args: BuildContentArgs): string {
	const { project, trigger: t, now, frontier } = args;
	const proj = frontier.projects.find((p) => p.project === t.project);
	const lines: string[] = [
		"# Autonomy Diagnostic Report",
		"",
		`> 自动生成的**只读**诊断报告（autonomy 动作面，policyVersion=${POLICY_VERSION}）。`,
		"> 学术诚实：本报告只记录观察，**不触发**任何修复 / 重试 / 派活。",
		"",
		`- **trigger**: \`${t.rule}\``,
		`- **project**: \`${t.project}\``,
		`- **evidence**: ${t.evidence}`,
		`- **approximate**: ${t.approximate}`,
		`- **generated_at**: ${new Date(now).toISOString()}`,
		"",
	];
	if (proj) {
		lines.push("## 项目状态（frontier 快照）");
		lines.push(`- state: ${proj.state}${proj.variant ? ` (${proj.variant})` : ""}`);
		lines.push(`- needs_user: ${proj.needsUser}`);
		lines.push(`- stagnation: ${proj.stagnation}`);
		lines.push(`- result_missing: ${proj.resultMissing}`);
		lines.push(`- visible_runs: ${Object.keys(proj.runs).length}`);
		lines.push("");
	}
	lines.push("_（无更多可安全自动化的处置；后续动作需人裁决。）_");
	return lines.join("\n");
}

export const diagnosticReportClass: ActionClass = {
	name: "diagnostic-report" as const,

	/**
	 * 效应面注册（§A ① 文件夹分好）：仅 `<stateDir>/autonomy/actions/reports/` 子目录。
	 * 单一事实源：postverify / rollback 覆盖同一清单（设计风险 2 缓解）。
	 */
	allowedPrefixes: (stateDir: string): string[] => [join(stateDir, "autonomy", "actions", "reports")],

	/** 目标报告路径（效应面内；project 归一 + 时间戳）。 */
	targetPath: (stateDir: string, project: string, ts: number): string => {
		const safe = project.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "project";
		return join(stateDir, "autonomy", "actions", "reports", `${safe}-${ts}.md`);
	},

	/**
	 * 效应路径是否越出声明前缀（§A ① 越界判定；policy 层 + TOCTOU 复验都查）。
	 * 用 relative 归一化分隔符（Windows 反斜杠 / POSIX 正斜杠不敏感）：
	 * rel 为空 = 路径即前缀目录本身（非其内文件）→ false；rel 以 .. 开头或为绝对路径 = 越界 → false。
	 */
	withinSurface: (stateDir: string, path: string): boolean => {
		const prefix = join(stateDir, "autonomy", "actions", "reports");
		const rel = relative(prefix, path);
		if (rel === "") return false; // 目录本身，非其内文件
		if (rel.startsWith("..") || rel.startsWith("/") || rel.startsWith("\\")) return false;
		return true;
	},

	/** 报告正文（只读诊断；不触发修复/重试/派活）。 */
	buildContent: (args: BuildContentArgs): string => buildReportBody(args),

	/** 快照（原字节/权限/存在性；never-throw；读失败 = null = 无快照 → fail-closed）。 */
	snapshot: (path: string): FileSnapshot | null => {
		try {
			if (!existsSync(path)) return { path, existed: false, mode: null, bytes: null };
			const st = statSync(path);
			return { path, existed: true, mode: st.mode, bytes: readFileSync(path) };
		} catch {
			return null;
		}
	},

	/**
	 * 原子写（tmp+rename；never-throw）。**只创建/覆盖写，永不删既有文件**（§A ②）。
	 * 返回 { bytes, deletedFiles: [] }；写失败 = null（fail-closed）。
	 */
	effect: (path: string, content: string): EffectResult | null => {
		try {
			mkdirSync(dirname(path), { recursive: true });
			const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
			writeFileSync(tmp, content, "utf8");
			renameSync(tmp, path);
			return { bytes: Buffer.byteLength(content, "utf8"), deletedFiles: [] };
		} catch {
			return null;
		}
	},

	/** 回读验证（never-throw）：match | mismatch | unknown（读失败 = unknown，不猜）。 */
	postverify: (path: string, expected: string): "match" | "mismatch" | "unknown" => {
		try {
			const actual = readFileSync(path, "utf8");
			return actual === expected ? "match" : "mismatch";
		} catch {
			return "unknown";
		}
	},

	/**
	 * 回退（never-throw）：按快照恢复原字节/权限/存在性。
	 * 返回 { ok, deletedFiles }：deletedFiles 恒 []（本类效应不删原文件；回退删除的自创
	 * 文件是撤销自身效应，非「删除原有文件」违规）。ok=false = 回退失败（→ 熔断 + 冻结）。
	 */
	rollback: (snap: FileSnapshot): { ok: boolean; deletedFiles: string[]; reason?: string } => {
		try {
			if (snap.existed) {
				if (snap.bytes === null) return { ok: false, deletedFiles: [], reason: "snapshot-bytes-missing" };
				const tmp = `${snap.path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.rollback.tmp`;
				try {
					writeFileSync(tmp, snap.bytes);
					renameSync(tmp, snap.path);
				} finally {
					try { unlinkSync(tmp); } catch { /* rename 后临时文件已不存在 */ }
				}
				if (snap.mode !== null) chmodSync(snap.path, snap.mode);
				const restored = diagnosticReportClass.snapshot(snap.path);
				if (!restored || !restored.existed || !restored.bytes?.equals(snap.bytes) || restored.mode !== snap.mode) {
					return { ok: false, deletedFiles: [], reason: "rollback-reverify-mismatch" };
				}
				return { ok: true, deletedFiles: [] };
			}
			// 原不存在 → 恢复非存在（删除本动作自创文件 = 撤销自身效应）
			if (existsSync(snap.path)) unlinkSync(snap.path);
			return { ok: true, deletedFiles: [] };
		} catch (e) {
			return { ok: false, deletedFiles: [], reason: String((e as Error)?.message ?? e).slice(0, 120) };
		}
	},
};

export type DiagnosticReportClass = typeof diagnosticReportClass;
