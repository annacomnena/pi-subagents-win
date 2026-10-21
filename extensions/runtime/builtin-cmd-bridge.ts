/**
 * runtime/builtin-cmd-bridge.ts — 补 `/reload` 与 `/model` 两条**内建命令**（2026-10-21）
 *
 * ## 为什么需要补
 * pi 的内建命令（`BUILTIN_SLASH_COMMANDS`，24 条，`dist/core/slash-commands.js`）**不在**
 * `pi.getCommands()` 的返回里 —— 后者只返 extension / prompt / skill 三类
 * （`dist/core/agent-session.js:2613-2634`）。内建命令的执行实现在 TUI 层
 * （`interactive-mode.js`），远端/GUI 完全够不着。
 *
 * 更糟的是 `prompt()` 的命令识别只走 `_tryExecuteExtensionCommand`（`agent-session.js:1458-1465`），
 * 找不到就**把字符串当正文发给 LLM** ⇒ 远端发 `/model x` 会污染上下文并白烧 token。
 *
 * ## 为什么能真执行（不是简化版）
 * `registerCommand` 的 handler 签名是
 * `(args: string, ctx: ExtensionCommandContext) => Promise<void>`（`types.d.ts:1128`），
 * 而 `ExtensionCommandContext` 明确提供 `reload()`（`types.d.ts:322`）；
 * `setModel()` 在 `ExtensionAPI`（`pi`）上（`types.d.ts:1248`）。
 * ⇒ 能力齐全，注册同名扩展命令即可真执行。
 *
 * ## 已知代价（必须登记，AGENTS R-5 同类纪律）
 * 注册同名命令后，TUI 侧会命中 `interactive-mode.js:429-437` 的「与内建冲突」检测，
 * 该名字会从**内建补全**里被摘掉；且 `prompt()` 里扩展命令优先 ⇒ TUI 原生的
 * `/model` 选择器 UI 可能被本简化版取代。本模块**只注册用户明确要的两条**。'
 */

/**
 * 本仓已知需要的 `argumentHint` 映射（显示适配）。
 *
 * 为何需要：`registerCommand` 的 options 类型 `RegisteredCommand`（`types.d.ts:1123-1129`）
 * **只有** name/description/getArgumentCompletions/handler，**没有 argumentHint 字段**
 * ⇒ 无法通过注册把提示传进 `getCommands()` 快照。而 pi 内建自己带 hint
 *（`BUILTIN_SLASH_COMMANDS` 的 `/model` = `<provider/model>`）。
 *
 * 所以本仓在**快照归一化侧**补一层：命令名 → hint。零新增 pi 契约，纯展示层。
 */
export const COMMAND_ARGUMENT_HINTS: Readonly<Record<string, string>> = Object.freeze({
	model: "<provider/id>",
	models: "<provider/id>",
});

/** 命令注册所需的最小 pi 面（结构化，便于测试注入，不依赖真实 ExtensionAPI）。 */
export interface CommandBridgeApi {
	getCommands?: () => unknown;
	setModel?: (model: unknown) => Promise<boolean>;
	registerCommand: (
		name: string,
		opts: { description?: string; handler: (args: string, ctx: CommandBridgeContext) => Promise<void> },
	) => void;
}

/** handler 实际用到的 ctx 面（`ExtensionCommandContext` 子集）。 */
export interface CommandBridgeContext {
	reload?: () => Promise<void>;
	modelRuntime?: {
		getAvailableSnapshot?: () => readonly ModelLike[];
		getError?: () => string | undefined;
	};
	model?: ModelLike;
	ui?: { notify?: (msg: string, level?: string) => void };
}

export interface ModelLike {
	provider?: string;
	id?: string;
	name?: string;
}

/** `/model xxx` 的解析结果（纯函数，可单测）。 */
export type ModelArgParse =
	| { kind: "list" }
	| { kind: "set"; ref: string };

/** 解析 `/model` 参数。
 *
 * - 空 ⇒ 列出
 * - 单个非空 token ⇒ 设值（`provider/id` 或短名，交给 pi 自己解析）
 * - 多个 token ⇒ 也算设值（用空格连接）—— pi 的 `findExactModelReferenceMatch` 认 `provider/id`，
 *   但短名可能含空格（模型名），所以整体当一个 ref，不擅自拆分。
 */
export function parseModelArg(args: string): ModelArgParse {
	const t = (args ?? "").trim();
	if (t.length === 0) return { kind: "list" };
	return { kind: "set", ref: t };
}

/** 在可用模型里按 ref 找精确匹配（`provider/id` 或 `id`）。
 *
 * 纯函数：**不做模糊自动纠正** —— 找不到就返回 null，由调用方列出候选。
 * 静默纠正会切到用户没要的模型（比报错更糟）。
 */
export function matchModel(ref: string, available: readonly ModelLike[]): ModelLike | null {
	const q = ref.trim().toLowerCase();
	if (q.length === 0) return null;
	const full = (m: ModelLike): string => `${m.provider ?? ""}/${m.id ?? ""}`.toLowerCase();
	// 1) 精确 provider/id
	for (const m of available) if (full(m) === q) return m;
	// 2) 精确 id（要求唯一，否则视为歧义 ⇒ null，让调用方列候选）
	const byId = available.filter((m) => (m.id ?? "").toLowerCase() === q);
	if (byId.length === 1) return byId[0]!;
	return null;
}

/** 列出模型的回执正文（当前标记 + 清单）。 */
export function formatModelList(current: ModelLike | undefined, available: readonly ModelLike[]): string {
	const cur = current ? `${current.provider ?? "?"}/${current.id ?? "?"}` : "（未知）";
	if (available.length === 0) {
		return `当前模型：${cur}\n可用模型：无（模型目录未加载或未配置 provider）`;
	}
	const lines = available
		.slice()
		.sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`))
		.map((m) => {
			const full = `${m.provider ?? "?"}/${m.id ?? "?"}`;
			return full === cur ? `  * ${full}（当前）` : `    ${full}`;
		});
	return [
		`当前模型：${cur}`,
		`可用模型 ${available.length} 个（* = 当前）：`,
		...lines,
		"",
		"用法：/model <provider/id>   例：/model Zhipu/glm-5.3",
	].join("\n");
}

/** 找不到模型时的回执：列出候选（截断，避免刷屏）。 */
export function formatModelNotFound(ref: string, available: readonly ModelLike[]): string {
	const shown = available
		.slice(0, 20)
		.map((m) => `  ${m.provider ?? "?"}/${m.id ?? "?"}`)
		.join("\n");
	const more = available.length > 20 ? `\n  …另有 ${available.length - 20} 个（/model 无参查看全部）` : "";
	return `未找到模型：${ref}\n可用候选（前 ${Math.min(20, available.length)} 个）：\n${shown}${more}\n\n注：不做模糊自动纠正（避免切到你要之外的模型）。`;
}

/**
 * 注册 `/reload` 与 `/model`（+ `/models` 别名）。
 *
 * never-throw：注册失败不影响对话；每条命令自身 try/catch。
 */
export function registerBuiltinCommandBridge(pi: CommandBridgeApi): string[] {
	const registered: string[] = [];	const notify = (ctx: CommandBridgeContext, msg: string, level: "info" | "warning" = "info"): void => {
		try {
			ctx.ui?.notify?.(msg, level);
		} catch {
			/* UI 不可用（headless）⇒ 回执只进结果，不炸 */
		}
	};

	const availableOf = (ctx: CommandBridgeContext): readonly ModelLike[] => {
		try {
			return ctx.modelRuntime?.getAvailableSnapshot?.() ?? [];
		} catch {
			return [];
		}
	};

	// ── /reload ────────────────────────────────────────────────────
	const reloadHandler = async (_args: string, ctx: CommandBridgeContext): Promise<void> => {
		const fn = ctx.reload;
		if (typeof fn !== "function") {
			notify(ctx, "/reload 不可用：当前上下文没有 reload()（可能不是用户发起的命令）", "warning");
			return;
		}
		try {
			await fn.call(ctx);
			// 措辞要点：reload **不丢会话上下文**（用户在 TUI 里也一样），别让远端用户以为丢历史
			notify(
				ctx,
				"/reload 完成：已重载 extensions / skills / prompts / themes / context files。会话上下文与历史未丢弃。",
			);
		} catch (e) {
			notify(ctx, `/reload 失败：${e instanceof Error ? e.message : String(e)}`, "warning");
		}
	};

	// ── /model ─────────────────────────────────────────────────────
	const modelHandler = async (args: string, ctx: CommandBridgeContext): Promise<void> => {
		const parsed = parseModelArg(args);
		const available = availableOf(ctx);
		const current = ctx.model;
		if (parsed.kind === "list") {
			const err = (() => {
				try {
					return ctx.modelRuntime?.getError?.();
				} catch {
					return undefined;
				}
			})();
			const body = formatModelList(current, available);
			notify(ctx, err ? `${body}\n\n⚠ 模型目录有错误：${err}` : body, err ? "warning" : "info");
			return;
		}
		if (available.length === 0) {
			notify(ctx, "/model 不可用：模型目录为空或未加载（先 /reload 或检查 provider 配置）", "warning");
			return;
		}
		const hit = matchModel(parsed.ref, available);
		if (hit === null) {
			notify(ctx, formatModelNotFound(parsed.ref, available), "warning");
			return;
		}
		const set = pi.setModel;
		if (typeof set !== "function") {
			notify(ctx, "/model 不可用：pi.setModel 未暴露", "warning");
			return;
		}
		let ok = false;
		try {
			ok = await set.call(pi, hit);
		} catch (e) {
			notify(ctx, `/model 切换异常：${e instanceof Error ? e.message : String(e)}`, "warning");
			return;
		}
		const full = `${hit.provider ?? "?"}/${hit.id ?? "?"}`;
		if (ok) {
			notify(ctx, `模型已切换：${full}`);
		} else {
			// setModel 返 false 的官方语义（types.d.ts:1244-1247）= 该 provider 未配认证
			notify(ctx, `切换失败：${full} 的 provider 未配置认证（/login 或检查 settings）`, "warning");
		}
	};

	try {
		pi.registerCommand("reload", {
			description: "重载 extensions / skills / prompts / themes / context files（不丢会话历史）",
			handler: reloadHandler,
		});
		registered.push("reload");
	} catch {
		/* never-throw */
	}

	for (const name of ["model", "models"] as const) {
		try {
			pi.registerCommand(name, {
				description:
					name === "model"
						? "查看或切换模型：/model（列出）| /model <provider/id>（切换）"
						: "同 /model（别名，兼容 /models 写法）",
				handler: modelHandler,
			});
			registered.push(name);
		} catch {
			/* never-throw */
		}
	}

	return registered;
}
