/**
 * runtime/wechat-remote-command.ts — 微信远程斜杠命令：分级白名单 + 分类（纯函数，零 IO / 零 Pi API）
 *
 * 依据：plans/0924_wechat_remote_slash_command_research.md（Q3 分级 + Q6.1#4 表 schema）与
 * Hermes 对照章（单一命令注册表 CommandDef 形态、双轴鉴权、未知命令显式拒绝不回落正文）。
 *
 * 用户最终裁定（覆盖研究中的待裁点，实现以裁定为准）：
 *   ① 三级白名单：safe（免确认，如 /wechat status）| sensitive（如 /reload /compact /model
 *      /thinking /wechat on|off）| danger（shell / 文件写入 / 会话销毁 → **恒拒**）。
 *   ② **不做二次确认**：研究建议的 nonce 挑战机制**不实现**（用户裁定「远程输入手滑少」）；
 *      sensitive 档直接执行，但**审计行保留**（decision=command-accepted, tier=sensitive）。
 *   ③ 未知 `/xxx` **必须显式拒绝、绝不回落成普通文本注入**——Hermes run.py#L9984-L9992 注释级证据
 *      （"Warn the user instead of silently forwarding it to the LLM as free text"）。拒绝文案分流：
 *      未知 → `Unknown command …`；danger 档 → 「该命令不支持远程执行」（原文，测试断言包含）。
 *   ④ 分类发生在**进 LLM 之前**的旁路（消费端 claim 后第一判），不走 outbox 注入路径。
 *   ⑤ 缺省 fail-closed：能力门在 `channels.wechat.remoteCommands.enabled`（缺省 false，
 *      runtime-host/wechat-bind.ts::readWechatRemoteCommandConfig）——与 Hermes 的 fail-open 相反。
 *
 * 解析纪律：**入口先归一化**（NFKC + 剔零宽 + trimStart，L4-M1 防绕过）→ shell 形态判 →
 * 只认**首 token 精确匹配**（`^/[A-Za-z][\w:.-]*(\s|$)`）+ 参数枚举校验；归一化后仍以 `/`
 * 开头却解析不出命令名的形态（`//x` `/_x` `/1x` `/-x` `/reload/`）**显式拒绝**不落 not-command。
 * **任何参数都不进 shell**（本模块无执行面，执行由 RemoteCommandDeps 注入）。
 * shell 形态（`!cmd` / `;` / `|` / `&` / `$(…)` / 反引号开头）与 skill/模板同名（含 `:`）
 * 的 `/xxx` 属 danger 展开面，恒拒且**永不展开**。
 */

/** 远程可执行档（danger 恒拒，不进此二档）。 */
export type RemoteCommandTier = "safe" | "sensitive";

/** danger 档恒拒文案（用户裁定原文；测试断言回执包含它）。 */
export const REMOTE_COMMAND_DANGER_TEXT = "该命令不支持远程执行";

/** `/wechat` 参数用法（与 extensions/index.ts `/wechat` handler 同口径）。 */
export const REMOTE_COMMAND_USAGE_WECHAT =
	"用法：/wechat on|off|status|reply on|off|reply mode broadcast|reply-only";

/** pi `/thinking` 可选值（pi dist: getAvailableThinkingLevels；DEFAULT_THINKING_LEVEL="medium"）。 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

/** 未知命令回执（Hermes run.py#L9984-L9992 文案形状：Unknown command + 引导去掉前导斜杠重发）。 */
export function unknownCommandText(raw: string): string {
	const shown = raw.trim().slice(0, 64);
	return `Unknown command \`${shown}\`。远程仅支持白名单命令（如 /wechat status）；如需作为普通消息发送，请去掉前导斜杠后重发。`;
}

/**
 * 命令执行依赖（全部注入，便于测试 fake；生产接线见 wechat-command-consumer.ts）。
 * 配置类（setWechatEnabled/setReplyMode/setReplyEnabled）**同步执行并如实回报**；
 * 会话类（reload/compact/setModel/setThinking）由消费端 defer 到回执落盘之后再派发
 * （研究 Q1.3：ctx.reload() 之后旧 ctx 即 stale，回执必须先落盘）。
 */
export interface RemoteCommandDeps {
	wechatStatus(): string;
	setWechatEnabled(on: boolean): { ok: boolean; error?: string };
	setReplyMode(mode: "broadcast" | "reply-only"): { ok: boolean; error?: string };
	setReplyEnabled(on: boolean): { ok: boolean; error?: string };
	reload(): void;
	compact(): void;
	setModel(id: string): void;
	setThinking(level: string): void;
}

/** 执行结果：text = 回执正文；defer = 回执落盘后再触发的副作用（会话类命令用）。 */
export interface RemoteCommandOutcome {
	text: string;
	defer?: () => void;
}

export type RemoteCommandPlan =
	/** 非命令形态 → **不 claim**，留给既有注入路（= 今天行为）。 */
	| { kind: "not-command" }
	/** 白名单命中（safe 直接执行 / sensitive 直接执行 + 审计，裁定②免确认）。 */
	| { kind: "exec"; key: string; tier: RemoteCommandTier; execute: (deps: RemoteCommandDeps) => RemoteCommandOutcome }
	/** 显式拒绝（绝不回落成正文注入）：danger 恒拒 / 未知 / 白名单命令参数非法。 */
	| { kind: "deny"; reason: "danger" | "unknown" | "usage"; tier: RemoteCommandTier | "danger" | "unknown"; text: string };

// ── danger 恒拒面（研究 Q3 danger 列 + 0923 delta E-4 禁开面）─────────────

/** shell 形态前缀：`!rm`、`;`、`|`、`&`/`&&`、`$(…)`、反引号——恒拒，任何参数不进 shell。 */
const SHELL_LIKE = /^(?:[!;|&`]|\$\()/;

/**
 * 首 token 精确匹配（研究 Q3 解析纪律；**锚定第 0 列** → 调用前必须先归一化，见 L4-M1）。
 * `/etc/passwd` 等路径不匹配（首 token 内还有 `/`）→ 由 classify 的路径分支判 not-command。
 */
const FIRST_TOKEN_RE = /^\/([A-Za-z][\w:.-]*)(?:\s|$)/;

/**
 * 路径形态（`/etc/passwd`、`/tmp/f.txt`）：首段非空 + 至少两段 → 不是命令（保持 L3 行为）。
 * 与命令形态的分界：命令首 token 不含第二个 `/`，`//x`（首段为空）不在此列 → 走显式 deny。
 */
const PATH_LIKE_RE = /^\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]/;

// ── 输入归一化（L4-M1：分类入口先归一化，堵死确定性绕过形态）──────────────────────

/**
 * 零宽/不可见字符（Unicode format 类常用子集）：软连字符、ZWSP/ZWNJ/ZWJ、双向控制符、
 * word joiner、BOM——全部**语义中立**（肉眼不可见、不改变文本含义），分类副本整串剔除：
 * `/​reload`、`/re​load` 这类零宽插入不再能躲开第 0 列锚定。
 */
const INVISIBLE_RE = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/**
 * 归一化策略（L4-M1「前导空白 / 全角 / 零宽」三类绕过 → 三步收敛；**只作用于分类副本**，
 * 不改写入库正文、不改写回执展示以外的任何数据）：
 *   1) **兼容分解 NFKC**：全角斜杠 `／`(U+FF0F)→`/`、全角字母/数字（`ｒｅｌｏａｄ`）→ASCII、
 *      全角空格→半角空格。全角本就是 ASCII 的兼容变体（同形同义），故 `／reload`、`/ｒｅｌｏａｄ`
 *      归一后与半角同判；`！`→`!`、`；`→`;` 亦同——与既有 ASCII danger 口径**一致**，
 *      不新增判定面（ASCII `!`/`;` 开头今天就恒拒）。
 *   2) **剔除不可见字符**（INVISIBLE_RE，整串）：中缀插入的零宽字符同样剔除。
 *   3) **trimStart**：` /x`、`\t/x`、`\n/x`、`\r\n/reload` 等前导空白不再逃逸第 0 列锚定
 *      （SHELL_LIKE 与首 token 正则都锚定第 0 列）。
 * 归一化后仍**以 `/` 开头但首 token 解析不出命令名**的（`//x` `/_x` `/1x` `/-x` `/reload/` …）
 * → 显式 deny（classify 第②步），**绝不落 not-command**（裁定③）。
 * 误伤面控制：散文（含汉字/中文标点/URL）归一化后仍不以 `/` 或 shell 运算符开头 → 照旧
 * not-command；路径（`/etc/passwd`）与单斜杠分隔符（`/`、`/ ok`）保留 not-command。
 */
function normalizeForClassify(text: unknown): string {
	if (typeof text !== "string" || text === "") return "";
	let s = text;
	try {
		s = s.normalize("NFKC");
	} catch {
		/* 极端输入：退化为原文（never-throw） */
	}
	return s.replace(INVISIBLE_RE, "").replace(/^\s+/, "");
}

/** 精确 danger 名（会话销毁/切换、凭据、外泄导出、本仓 master 接管面、Hermes 禁开面、shell 意图名）。 */
const DANGER_EXACT = new Set([
	// pi 内置：会话销毁与切换
	"new", "fork", "clone", "resume", "quit",
	// pi 内置：凭据 / 信任
	"login", "logout", "trust",
	// pi 内置：导出与外泄面（文件写入 / 分享）
	"export", "import", "share",
	// 0923 delta E-4：微信侧恒拒（审批旁路）
	"yolo", "approve", "deny",
	// shell / 文件删除意图名（即便本地不存在，也按 danger 文案拒）
	"rm", "sh", "bash", "exec", "shell", "sudo",
]);

/** 前缀 danger（本仓 master 接管/移交面，研究 Q3 `master-*`）。 */
const DANGER_PREFIXES = ["master-"];

const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

type Resolved =
	| { ok: true; key: string; tier: RemoteCommandTier; run: (deps: RemoteCommandDeps) => RemoteCommandOutcome }
	| { ok: false; usage: string };

interface CommandEntry {
	/** 该 name 的缺省档（仅用于 usage 拒绝的审计 tier）。 */
	tier: RemoteCommandTier;
	resolve: (args: string) => Resolved;
}

const ok = (key: string, tier: RemoteCommandTier, run: (deps: RemoteCommandDeps) => RemoteCommandOutcome): Resolved =>
	({ ok: true, key, tier, run });
const usage = (text: string): Resolved => ({ ok: false, usage: text });

/**
 * 白名单表（数据形态，对齐 Hermes `CommandDef{name → tier → exec}`；分级字段即裁定①）。
 * safe：只读或仅改出站偏好（可逆、不打断会话）；sensitive：改会话/中断运行/改模型（裁定②免确认）。
 */
const ENTRIES: Record<string, CommandEntry> = {
	wechat: {
		tier: "safe",
		resolve: (args) => {
			// 子命令不区分大小写（同 index.ts `/wechat` handler 的 toLowerCase 口径）
			const a = args.trim().toLowerCase();
			if (a === "" || a === "status") {
				return ok("wechat.status", "safe", (deps) => ({ text: deps.wechatStatus() }));
			}
			if (a === "on" || a === "off") {
				const on = a === "on";
				return ok("wechat.enabled", "sensitive", (deps) => {
					const r = deps.setWechatEnabled(on);
					return { text: r.ok ? `wechat enabled=${a}` : `wechat config write failed: ${r.error ?? ""}` };
				});
			}
			const parts = a.split(/\s+/);
			if (parts[0] === "reply" && parts.length === 3 && parts[1] === "mode" && (parts[2] === "broadcast" || parts[2] === "reply-only")) {
				const mode = parts[2] as "broadcast" | "reply-only";
				return ok("wechat.reply.mode", "safe", (deps) => {
					const r = deps.setReplyMode(mode);
					return { text: r.ok ? `wechat reply.mode=${mode}` : `wechat reply config write failed: ${r.error ?? ""}` };
				});
			}
			if (parts[0] === "reply" && parts.length === 2 && (parts[1] === "on" || parts[1] === "off")) {
				const on = parts[1] === "on";
				return ok("wechat.reply.enabled", "safe", (deps) => {
					const r = deps.setReplyEnabled(on);
					return { text: r.ok ? `wechat reply.enabled=${on ? "on" : "off"}` : `wechat reply config write failed: ${r.error ?? ""}` };
				});
			}
			return usage(REMOTE_COMMAND_USAGE_WECHAT);
		},
	},
	reload: {
		tier: "sensitive",
		resolve: (args) => (args === ""
			? ok("reload", "sensitive", (deps) => ({ text: "已请求执行 /reload（扩展重载中）", defer: () => deps.reload() }))
			: usage("用法：/reload")),
	},
	compact: {
		tier: "sensitive",
		resolve: (args) => (args === ""
			? ok("compact", "sensitive", (deps) => ({ text: "已请求执行 /compact（上下文压缩中）", defer: () => deps.compact() }))
			: usage("用法：/compact")),
	},
	model: {
		tier: "sensitive",
		resolve: (args) => (MODEL_ID_RE.test(args)
			? ok("model", "sensitive", (deps) => ({ text: `已请求执行 /model ${args}`, defer: () => deps.setModel(args) }))
			: usage("用法：/model <provider/model-id>")),
	},
	thinking: {
		tier: "sensitive",
		resolve: (args) => ((THINKING_LEVELS as readonly string[]).includes(args)
			? ok("thinking", "sensitive", (deps) => ({ text: `已请求执行 /thinking ${args}`, defer: () => deps.setThinking(args) }))
			: usage(`用法：/thinking ${THINKING_LEVELS.join("|")}`)),
	},
};

/** 分类主入口（纯函数）。text 非字符串按空串处理 → not-command。 */
export function classifyRemoteCommand(text: unknown): RemoteCommandPlan {
	// ① 归一化（L4-M1）：前导空白 / 全角 / 零宽三类绕过形态先收敛到同一形态再判
	const raw = normalizeForClassify(text);
	if (raw === "") return { kind: "not-command" };
	// ② shell 形态最先判（`!rm` 不以 `/` 开头，必须在 slash 解析之前）
	if (SHELL_LIKE.test(raw)) return { kind: "deny", reason: "danger", tier: "danger", text: REMOTE_COMMAND_DANGER_TEXT };
	let m: RegExpExecArray | null = null;
	if (raw.startsWith("/")) {
		// ②a 单斜杠 / 斜杠后带空白（`/`、`/ ok`）：分隔符形态，不是命令（L3 行为不变）
		if (raw === "/" || /^\s/.test(raw.slice(1))) return { kind: "not-command" };
		m = FIRST_TOKEN_RE.exec(raw);
		if (!m) {
			// ②b 路径形态（`/etc/passwd`、`/tmp/f.txt`）→ 不是命令（L3 行为不变）
			if (PATH_LIKE_RE.test(raw)) return { kind: "not-command" };
			// ②c **L4-M1 必须修**：归一化后以 `/` 开头却解析不出命令名（`//x` `/_x` `/1x`
			// `/-x` `/reload/` 及归一化后仍异常的形态）→ 显式拒绝，绝不落 not-command，
			// 否则这类形态会连 `considered` 都不进、照单全收进注入路（裁定③被破）。
			return { kind: "deny", reason: "unknown", tier: "unknown", text: unknownCommandText(raw) };
		}
	}
	// ②d 非 `/` 开头且非 shell 形态 → 散文/路径/URL：今天行为（不 claim，交回注入路）
	if (!m) return { kind: "not-command" };
	const name = m[1].toLowerCase();
	const args = raw.slice(m[0].length).trim();
	// ③ skill / prompt 模板同名展开面（含 `:`）：恒拒且永不展开（研究 Q3/Q7-1）
	if (name.includes(":")) return { kind: "deny", reason: "danger", tier: "danger", text: REMOTE_COMMAND_DANGER_TEXT };
	if (DANGER_EXACT.has(name) || DANGER_PREFIXES.some((p) => name.startsWith(p))) {
		return { kind: "deny", reason: "danger", tier: "danger", text: REMOTE_COMMAND_DANGER_TEXT };
	}
	// ④ 白名单表
	const entry = ENTRIES[name];
	if (!entry) return { kind: "deny", reason: "unknown", tier: "unknown", text: unknownCommandText(raw) };
	const resolved = entry.resolve(args);
	if (!resolved.ok) return { kind: "deny", reason: "usage", tier: entry.tier, text: resolved.usage };
	return { kind: "exec", key: resolved.key, tier: resolved.tier, execute: resolved.run };
}

/** 执行白名单命中项（消费端先落回执、后调用本函数返回的 defer）。 */
export function executeRemoteCommand(
	plan: Extract<RemoteCommandPlan, { kind: "exec" }>,
	deps: RemoteCommandDeps,
): RemoteCommandOutcome {
	return plan.execute(deps);
}
