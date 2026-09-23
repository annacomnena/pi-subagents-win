/**
 * lite-mode — 轻量工作流模式（/lite 开关 + 系统提示注入段）
 *
 * 用途：lite 链不在主会话开 launch-tabs、不用角色 agent（searcher/planner/…），
 * 而是主会话直接编排单一 general agent，按阶段自行选择模型。
 * 档位只有相对大小（small/medium/large），不规定具体模型——编排方按任务需要
 * 从当前 sub_models（config.models）自行选择（看上下文窗口与能力匹配，默认走
 * 各 agent 配置；只在默认明显不合适时才用 model= 覆盖）。/sub-models 改了自动
 * 同步，无独立配置表，无写死 ID。
 *
 * 设计约束（同 model-presets）：index.ts 不再增长——本模块逻辑独立，
 * 通过 deps 注入 config 读写；注入段由纯函数 litePromptLines 生成，
 * off 时返回 []（零注入、零行为变化）。
 *
 * 三态：
 *   off  — 默认。不注入任何内容，行为与历史版本完全一致
 *   on   — 本会话起工作流请求一律走 lite 链
 *   auto — 注入判据，模型按任务规模逐请求自选 lite / 完整链
 *
 * 命令：/lite            → 显示当前模式 + 档位映射 + 用法
 *       /lite on|off|auto → 持久化到 config.json（写前由 deps.reloadConfig 重读）
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { capabilities, currentProfile } from "./capabilities.ts";

// ── 数据模型 ────────────────────────────────────────────────────────

export type LiteMode = "off" | "on" | "auto";

/** config.json 的 lite 切片（结构兼容 index.ts 的 AgentConfig）。 */
export interface LiteConfigLike {
	models?: Record<string, string>;
	liteMode?: string;
}

export function normalizeLiteMode(value: unknown): LiteMode {
	return value === "on" || value === "auto" ? value : "off";
}

// ── 注入段生成（纯函数） ────────────────────────────────────────────

/**
 * 档位参考投影：small→searcher / medium→implementer / large→consultant 的**当前值**。
 * 仅供 /lite 命令展示与编排方选型参考，不构成规定——各阶段最终用哪个模型由编排
 * agent 按任务需要自行决定（默认走 agent 配置，只在不合适时覆盖）。
 */
export function liteTiers(models: Record<string, string> | undefined): { small: string; medium: string; large: string } {
	return {
		small: models?.searcher ?? "(未配置 models.searcher)",
		medium: models?.implementer ?? "(未配置 models.implementer)",
		large: models?.consultant ?? "(未配置 models.consultant)",
	};
}

const CHAIN =
	`[lite 链] L1 检索 → L2 计划 → L3 实现 → L4 独立审查 → L5 Wiki/文档收尾。全部 agent="general"（无角色身份）。各阶段模型由编排 agent 按任务需要从当前 sub_models 自行选择（看上下文窗口与能力匹配；默认走各 agent 配置的 default，只在默认明显不合适时才用 model= 覆盖）——这是 lite 的既定机制而非例外 override。禁止写死模型 ID（模型会更新，以 /sub-models 为准）。`;

const DISCIPLINE =
	"[lite 纪律] ①默认派 async 非阻塞（产物落盘 plans/ + 路径优先短摘要，靠 async-result-watcher 完成注入/完成事件/timer 收割；status 预览仅 500 字符，细节住磁盘）；仅当本轮就要用结果（下一步依赖、L4 复核点）才派 sync；同批独立任务用 parallel；②交接默认落盘：>30 行的产物让 general 写 plans/ 或 Wiki，回复只带路径 + ≤10 行摘要——细节住磁盘，不住主会话上下文；③检索事实每条仍带代码位置 + Wiki 章节引用 + 校准状态；④searcher-mode 串/并行约束对 L1 检索同样生效；⑤L4 审查必须独立 general 进程 + 交 git diff，不可省、不可自己审自己；⑥升级线：预计中转材料 >10K token、fan-out ≥3、或需跨会话存活 → 停用 lite，改 launch-tabs 完整链（mode=workflow/adaptive）。";

const BOUNDARY =
	"[lite 边界] 本段只约束本会话内的工作流编排；任务 tab（首行「根据workflow/research/execute/adaptive进行工作」）仍按其模式纪律块执行，不受本段影响。用户单次说「这次走完整链」可临时覆盖回 launch-tabs。切换：/lite on|auto|off。";

/**
 * 生成系统提示注入行。off → []；on → 纪律全量；auto → 判据 + 纪律全量。
 * 纯函数：只读 cfg，不触碰文件系统。
 */
export function litePromptLines(cfg: LiteConfigLike): string[] {
	const mode = normalizeLiteMode(cfg.liteMode);
	if (mode === "off") return [];
	if (mode === "on") {
		return [
			`Lite workflow mode: ON — 工作流请求在本会话内直接编排：不开 launch-tabs、不用 searcher/planner/implementer 等角色 agent，改用单一 general agent 走 lite 链（各阶段模型由编排方自选）。`,
			CHAIN,
			DISCIPLINE,
			BOUNDARY,
		];
	}
	return [
		`Lite workflow mode: AUTO — 每个工作流请求先按判据选链：lite（本会话直接编排，轻量）或完整链（launch-tabs tab）。`,
		`[lite 判据] 命中多数即选 lite：单/双模块、预期搜索结论可压进 ≤10K token 摘要、不需要跨会话存活、用户正在对话中等结果；反之（大范围调研、多模块并行实现、长任务需可见进度/断点续跑）→ 完整链 tab。存疑取完整链。`,
		CHAIN,
		DISCIPLINE,
		BOUNDARY,
	];
}

// ── /lite 命令 ──────────────────────────────────────────────────────

interface CommandDeps {
	reloadConfig: () => LiteConfigLike;
	writeConfig: (cfg: LiteConfigLike) => void;
}

const MODE_LABELS: Record<LiteMode, string> = {
	off: "⛔ off（默认，不注入，行为不变）",
	on: "🟢 on（一律走 lite 链）",
	auto: "🤖 auto（按任务判据自选 lite / 完整链）",
};

export function registerLiteCommand(pi: ExtensionAPI, deps: CommandDeps): void {
	pi.registerCommand("lite", {
		description: "轻量工作流模式：/lite on|off|auto（主会话直接编排 general agent + 档位模型，不开 tab）",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			// C4 运行时防护（设计稿 §58）：trace worker / 子 agent 无 lite 能力；
			// 即使命令在 UI 中可见，也不得生效。
			if (!capabilities().lite) {
				ctx.ui.notify(`⛔ 当前会话（profile: ${currentProfile()}）不支持 Lite workflow`, "error");
				return;
			}
			const val = (args ?? "").trim().toLowerCase();
			if (val === "on" || val === "off" || val === "auto") {
				// 写前重读，只改 liteMode 一个键，保留其余字段（同 /searcher-mode 约定）
				const cfg = deps.reloadConfig();
				cfg.liteMode = val;
				deps.writeConfig(cfg);
				ctx.ui.notify(`🪶 lite 模式已设为：${MODE_LABELS[val]}`, "info");
				return;
			}
			const cfg = deps.reloadConfig();
			const mode = normalizeLiteMode(cfg.liteMode);
			const tiers = liteTiers(cfg.models);
			ctx.ui.notify(
				[
					`当前 lite 模式：${MODE_LABELS[mode]}`,
					`档位参考（从 config.models 投影，供编排自选，不构成规定）：`,
					`  small  （检索/文档/找证据）= ${tiers.small}`,
					`  medium （实现/常规计划）  = ${tiers.medium}`,
					`  large  （咨询/修订计划/独立审查）= ${tiers.large}`,
					`用法：/lite on | off | auto`,
					`  on   — 本会话起工作流一律走 lite 链（general，主会话直接编排、按阶段自选模型）`,
					`  off  — 恢复完整链（launch-tabs + 角色 agent）`,
					`  auto — 按任务判据自选（单/双模块、结论可摘要、用户等结果 → lite）`,
				].join("\n"),
				"info",
			);
		},
	});
}
