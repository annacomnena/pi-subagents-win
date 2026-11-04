/**
 * trace-fusion/fusion-dispatch.ts — fusionModel 的消费链（2026-11-02，④）
 *
 * ## 为什么要有这一段
 *
 * Packet 三段（Hard Facts / Conflicts / Instruction）+ validation 复跑 + 行号越界校验，
 * 此前**全部只写进 cross-test-report.md 等人读**。`fusionModel` 字段在设置面里存在
 * （`tf-settings.ts`），摘要文案明写「当前未实现消费」——即：材料做出来了，没有消费者。
 *
 * 本次把消费者接上：collect worker 在 deterministic 终态后，若用户设置了 `fusionModel`，
 * 派一个**无头 pi 子进程**读 packet 做融合，产物落 `<runDir>/fusion/fusion.md`，
 * 并按 async-subagent 的既有账本形状落 `subagent-runs/run_*.json` + links 记录 ⇒
 * 派发者会话的 async-result-watcher 会**自动注入完成通知**（零轮询，与 subagent 完成同一条路）。
 *
 * ## 三条硬边界
 *
 * 1. **未设置 fusionModel ⇒ 零动作**，且必须**显式记录**「未配置，跳过」到 meta 与 worker 日志
 *    （AGENTS.md R-2：降级不得静默）。绝不自动挑模型。
 * 2. **融合只读**：提示词明令禁止改代码、禁止派 subagent/tab（argv 也带 excludeTools 兜底）、
 *    禁止 push。它的唯一产物是 fusion.md。
 * 3. **拼装而非投票**（设计稿 §25 明令禁止多数投票）：三路不是三个候选票，
 *    复跑计数与越界计数是**证据权重**，不是选票。提示词把这一点写成硬指令。
 *
 * 完成通知依赖 subagent 账本形状：run json 必须写**终态**（`status !== "running"`）；
 * 停在 running 的账本 watcher 永远不通知 = 静默失效，测试里对此有专门断言。
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { buildPiArgv } from "../runner-argv.ts";
import { recordLink } from "../links.ts";
// 账本落点必须与 async subagent 同源（2026-11-04 实测缺陷：此前用 APPDATA 拼路径，
// 在本机是 C:\Users\<u>\AppData\Roaming\pi\agent\subagent-runs，与真实的 ~/.pi/agent/subagent-runs
// 是两个互不相关的目录 ⇒ run_fuse*.json 成孤岛，registerAsyncResultWatcher 永远监听不到，
// 导致融合进程在所有 UI 面（subagent list / async panel / 完成通知）都不可见。
// 复用 subagent-kill.ts 的单一常量，避免「两处硬编码漂移」（该文件 :43 注释即为此而写）。
import { DEFAULT_RUNS_DIR, registerRunProcess } from "../subagent-kill.ts";
import type { FusionAgentRequest, FusionAgentResult, FusionAgentRunner } from "./fusion-agent.ts";
import type { LaneId } from "./types.ts";

/** 融合者不得拥有的能力（防递归派发/开标签页/自设计时器）。 */
export const FUSION_EXCLUDE_TOOLS = [
	"subagent-win",
	"launch-tabs",
	"set-timer",
	"cancel-timer",
	"list-timers",
	"trace-fusion",
	"tab-finish",
	"tab-report",
	// 2026-11-02 #1 安全边界：**运行时**只读强制（旧版只有提示词里写「只读」，无兼平）。
	// 2026-11-03 首跑四次实测后的修正：完全禁写 ⇒ 小模型交不出报告。
	//   第 3 次：它用 bash 重定向写盘（写到主仓外）；第 4 次：它回复「报告已完成，185 行，六节齐全」
	//   ——而它根本没有写工具 ⇒ 谎报。禁写没有消除写盘行为，只是把交付变成幻觉。
	// ⇒ 形状改为：**给 write，但落点由 lane-bash-guard 锁到本 run 的产物目录**（仓内一律不可写）；
	//   edit 仍禁止（edit 能改仓内已有文件，write 只能造新文件且落点受控）。
	"edit",
	// 2026-11-04（用户：harness 相关功能不需要）：融合子会话是**无头只读核验 + 写一份报告**，
	// 主会话的编排/治理面全部排除（与 lane 同步收口，降低常驻 token 与攻击面）。
	// 保留：read / bash / write（落点由 lane-bash-guard 锁在产物目录）/ codegraph / wiki-nav / hotspot。
	"master-status",
	"master-dispatch",
	"master-attach",
	"master-detach",
	"master-cutover",
	"master-transfer",
	"master-transfer-confirm",
	"master-handoff",
	"master-pressure",
	"local-master-ensure",
	"global-view",
	"supervise-push",
	"tab-steer",
	"steer-status",
	"tab-status",
	"reclaim-tabs",
	"get_goal",
	"create_goal",
	"update_goal",
	"ds_websearch",
];

export const FUSION_DEFAULT_WALL_MS = 30 * 60_000;

/** 融合报告的固定六节标题（缺任一 ⇒ 不落盘）。 */
export const FUSION_REPORT_SECTIONS = [
	"## 1. 采纳结论",
	"## 2. 分歧与裁决",
	"## 3. 证据核验",
	"## 4. 不可采信项",
	"## 5. 后续行动",
	"## 6. 可复跑附录",
];

/**
 * 每节最小正文长度（2026-11-03 第 5 次实测驱动）：只数标题存在时，
 * 「## 4. 不可采信项」写两行套话也算齐全 ⇒ 小模型很容易交出一份结构完整、内容为空的报告。
 * 低于此门 ⇒ 计为缺口（与缺节同等对待）。
 */
export const FUSION_SECTION_MIN_CHARS = 40;

/**
 * 六节齐全度 + 每节长度门（文件侧与 stdout 侧共用一份判据，不得两处各自硬写）。
 * 返回缺口列表：缺标题，或该节正文 < FUSION_SECTION_MIN_CHARS 字符（含长度读数）。
 */
export function fusionSectionGaps(body: string): string[] {
	const gaps: string[] = [];
	for (let i = 0; i < FUSION_REPORT_SECTIONS.length; i++) {
		const h = FUSION_REPORT_SECTIONS[i];
		const at = body.indexOf(h);
		if (at < 0) {
			gaps.push(h);
			continue;
		}
		const starts = FUSION_REPORT_SECTIONS.slice(i + 1)
			.map((n) => body.indexOf(n, at + h.length))
			.filter((p) => p >= 0);
		const end = starts.length > 0 ? Math.min(...starts) : body.length;
		const seg = body.slice(at + h.length, end).trim();
		if (seg.length < FUSION_SECTION_MIN_CHARS) {
			gaps.push(`${h}（正文仅 ${seg.length} 字符 < ${FUSION_SECTION_MIN_CHARS}）`);
		}
	}
	return gaps;
}

export interface FusionDispatchInput {
	runId: string;
	runDir: string;
	repoRoot: string;
	/** cross-test-report.md（内含 Fusion Packet 三段 + 复跑段 + 越界段）。 */
	reportPath: string;
	/** 用户设置的融合模型；未设 ⇒ 零动作。 */
	fusionModel?: string;
	/** lane 所用模型（写进提示词，让融合者知道证据出自谁）。 */
	laneModel?: string;
	/** 派发者会话指纹（meta.dispatcherSessionId），用于完成通知归属。 */
	dispatcherSessionId?: string;
	piCli?: string;
	wallBudgetMs?: number;
	outputPath?: string;
	/** seams（测试注入）。 */
	spawnFn?: (cmd: string, argv: string[], opts: object) => ChildProcess;
	/**
	 * 融合者跑法 seam（2026-11-04，S2/S3）。缺省 = 模块内 headless spawn（原行为）。
	 * index.ts 注入 `runFusionAgentViaSubagent` 后，手动命令 `/trace-fusion-fuse` 走**同步**真 subagent。
	 */
	runFusionAgent?: FusionAgentRunner;
	/** 手动/同步通道：把融合者作为一次真 subagent 呈现（写进账本的 agent 名不变，仅影响 via 标签与日志）。 */
	via?: string;
	/**
	 * S1（2026-11-04）：视觉/控制面补齐 seam。缺省（不注入）保持旧行为（裸 spawn、不登记 pid、不发通知）。
	 * index.ts 注入后，headless 融合者也是「一等 async run」：list 有 pid、可 kill、有正规完成通知。
	 */
	registerRunProcess?: (runsDir: string, runId: string, info: { pid: number; marker: string }) => void;
	clearRunProcess?: (runId: string) => void;
	notifyCompletion?: (rec: { id: string; agent?: string; task?: string; status: "completed" | "failed"; startedAt: string; result?: { error?: string } }) => void;
	runsDir?: string;
	linksPath?: string;
	now?: () => number;
	/** 子进程启动时刻的参考值（测试可注入；缺省 = 真实 Date.now()）。 */
	spawnNow?: () => number;
	/**
	 * 有界补写一轮（2026-11-03 第 5 次实测驱动）：盘上已有产物但六节不齐/正文空壳 ⇒
	 * 同认领内**只补派一次**（提示词只列缺口 + 现有文件路径），不直接判死重烧整轮。
	 * 带 repair 时跳过 fusion.claim 幂等门（认领已存在），全链最多一轮由调用方结构性保证。
	 */
	repair?: { gaps: string[] };
}

export type FusionStatus = "skipped" | "launched" | "completed" | "failed" | "timeout" | "spawn-error";

/** 融合者的真实成本读数（旧版写死 0 ⇒ 「融合花多少钱」不可知）。 */
export interface FusionUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export interface FusionDispatchResult {
	status: FusionStatus;
	reason: string;
	runId?: string;
	fusionRunId?: string;
	reportPath?: string;
	/** 零模型调用（未配置）时 true。 */
	zeroModelCall: boolean;
	/** 子进程退出码（null = 未取到/信号终止）；#3 判定依据。 */
	exitCode?: number | null;
	/** 从 json 流解析出的真实用量；解析不出 = null（不得写 0 冒充「花了 0 元」）。 */
	usage?: FusionUsage | null;
	/**
	 * 产物新鲜但六节不齐时的缺口清单（缺标题 / 正文过短）；供调用方决定有界补写一轮。
	 * 只在「盘上已有本次新鲜产物」时非空（无产物的失败没有补写基础）。
	 */
	gaps?: string[];
}

/**
 * 从融合子进程的 `--mode json` 日志里解析用量（与主仓 subagent 解析同一形状：
 * `type==="message_end" && message.role==="assistant"` 的 `usage`）。
 *
 * 解析不出 ⇒ 返回 null（**不是 0**）：0 会被读成「本次融合没花钱」，属于静默失效。
 * 只取尾部 maxBytes（日志可能很大）。
 */
export function parseFusionUsage(logPath: string, maxBytes = 8_000_000): FusionUsage | null {
	try {
		const size = statSync(logPath).size;
		let text = readFileSync(logPath, "utf8");
		if (size > maxBytes) text = text.slice(-maxBytes);
		const out: FusionUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
		let seen = 0;
		for (const line of text.split("\n")) {
			const t = line.trim();
			if (!t.startsWith("{")) continue;
			let ev: unknown;
			try {
				ev = JSON.parse(t);
			} catch {
				continue; // 尾部可能被截断
			}
			const e = ev as { type?: string; message?: { role?: string; usage?: Record<string, number & { total?: number }> } };
			if (e?.type !== "message_end" || e?.message?.role !== "assistant") continue;
			const u = e.message.usage as (Record<string, number> & { cost?: number | { total?: number } }) | undefined;
			if (!u) continue;
			seen++;
			out.input += Number(u.input ?? 0) || 0;
			out.output += Number(u.output ?? 0) || 0;
			out.cacheRead += Number(u.cacheRead ?? 0) || 0;
			out.cacheWrite += Number(u.cacheWrite ?? 0) || 0;
			out.cost += Number(typeof u.cost === "object" ? (u.cost?.total ?? 0) : (u.cost ?? 0)) || 0;
			out.turns += 1;
		}
		return seen > 0 ? out : null;
	} catch {
		return null;
	}
}

/** 融合提示词（纯函数）。 */
/**
 * 从融合子进程的 `--mode json` stdout 里取出「最后一条 assistant 正文」并校验六节结构，
 * 合格才落盘（2026-11-03 首跑实测）：融合者的 write/edit 被运行时排除，旧提示词却让它
 * 「写 fusion.md」⇒ 它用 bash 重定向自己写，路径还写丢了个点（`.pi` → `pi`），
 * 在主仓外造出野文件。现形状：报告正文经 stdout 交回，由 harness 落到指定路径。
 * 不合格 ⇒ 不落盘，返回形状描述（供失败理由，R-2 不得静默）。
 */
/**
 * 产物文件的六节齐全度（交付主通道的验收判据）。
 * 只数标题存在：空壳六节仍可通过（已知未闭合，下一轮加每节长度门）。
 */
export function fusionFileSections(
	path: string,
): { ok: true; bytes: number } | { ok: false; missing: string[] } {
	try {
		const body = readFileSync(path, "utf8");
		const missing = fusionSectionGaps(body);
		return missing.length === 0
			? { ok: true, bytes: Buffer.byteLength(body, "utf8") }
			: { ok: false, missing };
	} catch {
		return { ok: false, missing: ["产物不可读"] };
	}
}

export function captureFusionReport(
	logPath: string,
	outPath: string,
	fromOffset = 0,
): { ok: true; bytes: number; shape: string } | { ok: false; shape: string } {
	try {
		const text =
			fromOffset > 0
				? readFileSync(logPath).subarray(fromOffset).toString("utf8")
				: readFileSync(logPath, "utf8");
		let last: string | null = null;
		for (const line of text.split("\n")) {
			const t = line.trim();
			if (!t.startsWith("{")) continue;
			let ev: unknown;
			try {
				ev = JSON.parse(t);
			} catch {
				continue; // 尾部截断
			}
			const e = ev as { type?: string; message?: { role?: string; content?: Array<{ type?: string; text?: string }> } };
			if (e?.type !== "message_end" || e?.message?.role !== "assistant") continue;
			const body = (e.message.content ?? [])
				.filter((c) => c?.type === "text" && typeof c.text === "string")
				.map((c) => c.text as string)
				.join("\n");
			if (body) last = body;
		}
		if (last === null) return { ok: false, shape: "无 assistant 正文" };
		const missing = fusionSectionGaps(last);
		if (missing.length > 0) {
			return { ok: false, shape: `回复 ${last.length} 字符，缺 ${missing.length} 节（${missing.slice(0, 3).join(" / ")}）；首 120 字符：${last.slice(0, 120)}` };
		}
		mkdirSync(dirname(outPath), { recursive: true });
		writeFileSync(outPath, last + "\n", "utf8");
		return { ok: true, bytes: Buffer.byteLength(last, "utf8"), shape: `六节齐全 ${last.length} 字符` };
	} catch (err) {
		return { ok: false, shape: `读 stdout 失败：${(err as Error).message}` };
	}
}

export function buildFusionPrompt(i: {
	runId: string;
	reportPath: string;
	laneModel?: string;
	outputPath: string;
	repoRoot: string;
	repair?: { gaps: string[] };
}): string {
	const lanes = (["A", "B", "C"] as LaneId[]).map((l) => `- TRACE ${l}：\`lanes/${l}/trajectory.md\``).join("\n");
	const repairBlock = i.repair
		? [
				``,
				`## 本轮是补写轮（已有报告，不得重做）`,
				``,
				`盘上已有 \`${i.outputPath}\`，但它缺下列节（标题缺失或正文过短 < ${FUSION_SECTION_MIN_CHARS} 字符）：`,
				...i.repair.gaps.map((g) => `- \`${g}\``),
				``,
				`要求：先 \`read\` 现有文件，**保留已有内容不删不改**；只补齐上面缺的几节（每节必须给出实质内容：`
				+ `证据出处 / 核验命令 / 具体行动，不得写「暂无」「待补充」凑数），然后用 write 将**全文**写回同一路径。`,
				`补写轮同样受机械门约束：写盘只允许这一个路径，禁止删除/截断（rm、truncate 会被拦）。`,
			].join("\n")
		: "";
	return [
		`你是 trace-fusion 的**融合者**（run ${i.runId}）。任务：把三路独立诊断**拼装**成一份可执行的推进方案。`,
		``,
		`## 材料（先读，不要自己重新诊断）`,
		``,
		`1. 主材料：\`${i.reportPath}\` —— 内含 Hard Facts、Validation 复跑、行号引用越界校验、Fusion Packet（Hard Facts / Conflicts / Instruction 三段）与三路 trajectory 摘录。`,
		`2. 需要细节时按下列路径 read 原文（不要全仓巡查）：`,
		lanes,
		`3. 三路诊断的基点 commit 已写在报告的 Hard Facts 段（一个真实 sha）；核验历史版本用 ` +
			`\`git show <那个 sha>:<path>\`，不要用当前工作树代替。`,
		``,
		`## 硬纪律`,
		``,
		`- **拼装，不是投票**（设计稿 §25 明令禁止多数投票）：三路不是三张票。共识只说明「值得优先核验」，不说明成立。`,
		`- **可执行证据压过自报置信度**：报告「Validation 复跑」段里 \`声称pass实测失败\` 计数高的 lane，其自报结论必须显式降级并写明降级理由；复跑通过项可作为事实引用。`,
		`- **引用越界即不可引用原文**：报告「行号引用越界校验」段列出的越界引用，**不得原样引用其结论**；需要该证据就自己重新定位并给出你在基点上核过的行。`,
		`- **lane 契约外文件必须逐条判定**：Hard Facts 段给出「lane 契约外文件」清单（收集器按白名单枚举 lane 目录得出，`
		+ `supervisor 自产文件已在白名单内）。对每一条写清：谁写的、内容是否构成证据、是否进 §4 不可采信项。`
		+ `清单为「无」时可以不管；**不得当噪声丢弃，也不得直接当权威**。`,
		`- **引用必须可复跑**：报告里出现的每个 commit 引用都必须写 Hard Facts 段里那个**真实 sha**；` +
			"禁止写 `<base>`、「`<runId>-base-commit`」这种占位符或**上一次 run 的 runId**（两次实测都出现过：" +
			"照字面执行必失败，附录变成废纸）。同理，你引用的行号必须来自你**实跑过的** `" +
			"`git show <sha>:<path>` / `grep -n` 输出；没跑过就别给行号。",
		`- 三路 trajectory 里的行号与引用**不得直接转抄**（越界校验段就是为它设的）；` +
			`你自己采信的每一条都要带自己的出处，不拿别人的行号当自己的证据。`,
		`- 结论必须给出：采纳什么 / 拒绝什么 / 为什么（按证据强度，不按票数）；分歧的裁决方式（可复核的判据，不是「两票对一票」。` +
			`**「三路都这么说」不是判据**：它只说明值得优先核验，不说明成立。`,
		`- **只读仓库**：禁止修改任何代码文件、禁止 git 写操作、禁止装包、禁止 push、禁止派发 subagent 或开标签页。`,
		`  命令只用于只读核验（read / git show / grep / 只读脚本）。`,
		`- **写盘只允许一个路径**：你唯一可写的文件是 \`${i.outputPath}\`（本 run 的产物目录）。`,
		`  任何其他路径（仓内、用户目录、把 \`.pi\` 写成 \`pi\` 这种拼错的野路径）都会被机械门当场拦下——`,
		`  实测有融合者用 printf 重定向写报告，把路径写丢了个点，在主仓外造出野文件。`,
		``,
		`## 输出`,
		``,
		`把融合报告**用 write 工具写入 \`${i.outputPath}\`**（这是交付物，不落盘就判失败）。六节固定标题：`,
		`1. \`## 1. 采纳结论\`（含每条的证据出处与复跑/越界读数）`,
		`2. \`## 2. 分歧与裁决\``,
		`3. \`## 3. 证据核验\`（你实际跑过的核验命令与结果）`,
		`4. \`## 4. 不可采信项\`（哪些 lane 的哪些结论因何不可采信）`,
		`5. \`## 5. 后续行动\`（有序、可验收，标明涉及的文件）`,
		`6. \`## 6. 可复跑附录\`（逐条命令 + 期望读数，任何人都能重跑）`,
		``,
		`写完后回复只要：文件路径 + ≤10 行摘要。**不得声称「报告已完成/已写入」而没有真的调用 write 工具**`,
		`（实测有融合者回复「报告已完成，185 行六节齐全」而盘上零产物 ⇒ 判失败并白烧一次模型）。工作目录 \`${i.repoRoot}\`。`,
		repairBlock,
	].join("\n");
}

const writeRunRecord = (runsDir: string, runId: string, rec: Record<string, unknown>): void => {
	try {
		if (!existsSync(runsDir)) mkdirSync(runsDir, { recursive: true });
		writeFileSync(join(runsDir, `${runId}.json`), JSON.stringify(rec, null, 2) + "\n", "utf8");
	} catch { /* 账本尽力而为（失败时 meta.fusion 仍是权威记录） */ }
};

/**
 * 派发融合（在 collect worker 里 await）。never-throw；任何失败都写进 meta/日志可见处。
 * 未设置 fusionModel ⇒ 零 spawn、零模型调用。
 */
export async function dispatchFusion(input: FusionDispatchInput): Promise<FusionDispatchResult> {
	const outputPath = input.outputPath ?? join(input.runDir, "fusion", "fusion.md");
	if (!input.fusionModel) {
		return { status: "skipped", reason: "未设置 fusionModel（不自动挑模型）", zeroModelCall: true };
	}
	if (!existsSync(input.reportPath)) {
		return { status: "skipped", reason: `主材料缺失：${input.reportPath}`, zeroModelCall: true };
	}
	// 幂等认领：同一 run 只融合一次（补写轮不得重抢认领——它就是在同一次融合内）
	if (!input.repair) {
		try {
			mkdirSync(join(input.runDir, "fusion"), { recursive: true });
			writeFileSync(join(input.runDir, "fusion", "fusion.claim"), `${new Date().toISOString()}\n`, { encoding: "utf8", flag: "wx" });
		} catch {
			return { status: "skipped", reason: "本 run 已有融合认领（fusion.claim 存在）", zeroModelCall: true };
		}
	}
	if (!input.piCli || !existsSync(input.piCli)) {
		return { status: "spawn-error", reason: "pi CLI 未找到（fusion 未启动）", zeroModelCall: false, reportPath: outputPath };
	}

	const fusionRunId = `run_fuse${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
	const runsDir = input.runsDir ?? DEFAULT_RUNS_DIR;
	const prompt = buildFusionPrompt({
		runId: input.runId,
		reportPath: input.reportPath,
		laneModel: input.laneModel,
		outputPath,
		repoRoot: input.repoRoot,
		repair: input.repair,
	});
	const argv = buildPiArgv({
		cliPath: input.piCli,
		model: input.fusionModel,
		task: prompt,
		excludeTools: FUSION_EXCLUDE_TOOLS,
	});
	// 融合者标记（2026-11-03 首跑实测）：它被排除了 write/edit，于是用 bash 自己写报告，
	// 并把路径写丢了个点（`.pi` → `pi`），在主仓外造出野文件。
	// env 随 spawn 透传 ⇒ 子会话里的 lane-bash-guard 据此接管（见 index.ts 注册处）。
	const fusionDirEnv = "PI_TRACE_FUSION_FUSION_DIR";
	const fusionRunEnv = "PI_TRACE_FUSION_FUSION_RUN";
	const startedMs = input.spawnNow?.() ?? Date.now();
	const startedAt = new Date(startedMs).toISOString();
	writeRunRecord(runsDir, fusionRunId, {
		id: fusionRunId,
		status: "running",
		agent: "fusion",
		task: prompt.slice(0, 200),
		model: input.fusionModel,
		startedAt,
	});
	if (input.dispatcherSessionId) {
		try {
			recordLink({ sessionId: input.dispatcherSessionId, kind: "async", targetId: fusionRunId, detail: `trace-fusion ${input.runId} fusion` }, input.linksPath ? { linksPath: input.linksPath } : {});
		} catch { /* 尽力 */ }
	}

	const outPath = join(input.runDir, "fusion", "fusion.stdout.log");
	// 日志是 append（多次补跑共用一份，保留取证）⇒ 必须记下本次启动的字节偏移，
	// 否则 capture 会把**上一次尝试**的正文当成本次结果（实测：attempt 5 刚跑 85s，
	// 日志尾部仍是 attempt 4 的 591 字符谎报正文）。
	const logStartOffset = existsSync(outPath) ? statSync(outPath).size : 0;
	const budget = Math.max(60_000, Math.trunc(input.wallBudgetMs ?? FUSION_DEFAULT_WALL_MS));
	// #3（2026-11-02）：必须拿退出码。「只要文件存在就算成功」会把非零退出（崩了/预算耗尽/模型报错）
	// 读成 completed，而旧产物存在时更是把**上一次融合的文件**当成本次结果。
	let timedOut = false;
	let exitCode: number | null = null;
	let exitSignal: string | null = null;
	let fusionCaptured: number | null = null;
	let fusionUsage: FusionUsage | null = null;
	let agentVia = "headless-spawn";
	let outcome: "exit" | "timeout" | "error" = "exit";

	if (input.runFusionAgent) {
		// ── subagent 通道（S2/S3，2026-11-04）：调用方注入 runFusionAgentViaSubagent ──
		// 融合者在主会话里表现为一次普通 subagent 调用（同步可等、结果直接回显）。
		agentVia = input.via ?? "subagent-runWithFallback";
		try {
			const res = await input.runFusionAgent({
				fusionRunId,
				traceRunId: input.runId,
				prompt,
				model: input.fusionModel,
				repoRoot: input.repoRoot,
				logPath: outPath,
				outputPath,
				wallBudgetMs: budget,
				runsDir,
				cmdMarker: input.piCli ?? process.execPath,
				spawnFn: input.spawnFn,
			});
			exitCode = res.exitCode;
			exitSignal = res.exitSignal;
			timedOut = res.timedOut;
			fusionUsage = res.usage;
			agentVia = res.via || agentVia;
			// subagent 通道没有 spawn 事件：用「超时 / 正常结束」两态映射，错误由 exitCode!==0 表达
			outcome = res.timedOut ? "timeout" : "exit";
		} catch (err) {
			writeRunRecord(runsDir, fusionRunId, { id: fusionRunId, status: "failed", agent: "fusion", startedAt, finishedAt: new Date().toISOString(), error: `subagent 通道异常：${(err as Error).message}` });
			return { status: "spawn-error", reason: `subagent 通道异常：${(err as Error).message}`, fusionRunId, zeroModelCall: false };
		}
	} else {
	const spawnFn = input.spawnFn ?? ((c, a, o) => spawn(c, a, o));
	let child: ChildProcess;
	let outFd: number | undefined;
	try {
		outFd = openSync(outPath, "a");
		// 2026-11-03 首跑实测两次踩坑（tfl-20261103-192444-c7e2）：
		//  ① 旧写法 `[--experimental-strip-types, ...argv.slice(1)]` 丢掉 argv[0]（pi CLI 脚本路径）
		//     ⇒ node.exe 把 `--mode` 当自己的旗标 ⇒ `bad option: --mode`，exit=9；
		//  ② 补上 argv[0] 但仍带 `--experimental-strip-types` ⇒ pi 的 cli.js（已编译 JS）
		//     回 `Unknown option: --experimental-strip-types`，exit=1。
		// 正确形状 = 与主 subagent 通道逐字一致（index.ts:1285 `spawn(process.execPath, argv)`）：
		// argv 由 buildPiArgv 生成，argv[0] 就是脚本路径，**不加任何 node 旗标**。
		child = spawnFn(process.execPath, argv, {
			cwd: input.repoRoot,
			shell: false,
			windowsHide: true,
			stdio: ["ignore", outFd, outFd],
			// 融合者交报告的真实通道（2026-11-03 首跑实测）：它的 write/edit 工具被运行时排除，
			// 旧提示词却要求它「写 fusion.md」⇒ 它用 bash 重定向自己写，并把路径写丢了个点
			// （`.pi` → `pi`），在主仓外造出野文件。改为：报告正文从 stdout 交回，harness 落盘。
			env: { ...process.env, FUSION_CAPTURE_REPORT: "1", PI_TRACE_FUSION_FUSION_RUN: input.runId, PI_TRACE_FUSION_FUSION_DIR: dirname(outputPath) },
		});
	} catch (err) {
		if (outFd !== undefined) closeSync(outFd);
		writeRunRecord(runsDir, fusionRunId, { id: fusionRunId, status: "failed", agent: "fusion", startedAt, finishedAt: new Date().toISOString(), error: String((err as Error).message) });
		return { status: "spawn-error", reason: `spawn 失败：${(err as Error).message}`, fusionRunId, zeroModelCall: false };
	}
	// S1：登记 pid（kill/身份校验需要）。marker 用 pi CLI 路径（命令行稳定子串）。
	if (child.pid && input.registerRunProcess) {
		try {
			input.registerRunProcess(runsDir, fusionRunId, { pid: child.pid, marker: input.piCli ?? process.execPath });
		} catch { /* 登记失败不阻塞派发 */ }
	}

	const done = new Promise<"exit" | "timeout" | "error">((resolve) => {
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill("SIGKILL");
			} catch { /* 尽力 */ }
			resolve("timeout");
		}, budget);
		child.once("error", (e) => {
			clearTimeout(timer);
			(e as Error & { __fuse?: string }).__fuse = String(e?.message ?? e);
			resolve("error");
		});
		child.once("exit", (code: number | null, signal: string | null) => {
			clearTimeout(timer);
			exitCode = code;
			exitSignal = signal;
			if (!timedOut) resolve("exit");
		});
	});
	outcome = await done;
	if (outFd !== undefined) closeSync(outFd);
	if (input.clearRunProcess) { try { input.clearRunProcess(fusionRunId); } catch { /* 尽力 */ } }
	}
	const finishedAt = new Date().toISOString();
	const usage = fusionUsage ?? parseFusionUsage(outPath);
	// harness 落盘：exit=0 且回复正文含六节标题 ⇒ 由调用方写 fusion.md（融合者无写工具）
	// 融合者交报告的唯一通道 = 回复正文（它没有 write/edit 工具）：exit=0 就**必定**跑一次
	// 六节校验。旧版写成 `!existsSync(outputPath)` 才校验 ⇒ 盘上有旧 fusion.md 时直接跳过，
	// 半截旧文件会被当成本次结果判 completed（夹具实测踩到）。
	// 交付主通道 = 融合者自己用 write 写 outputPath（落点由机械门锁死）；
	// stdout 正文作为兼平通道（它写不了盘时至少能报出正文）。
	const produced = existsSync(outputPath);
	// 「本次新写的」：产物 mtime 不得早于启动时刻（留 2s 容差防文件系统时间粒度/钟差）。
	const fresh = produced && statSync(outputPath).mtimeMs >= startedMs - 2_000;
	const fileSections = fresh ? fusionFileSections(outputPath) : null;
	const captured = exitCode === 0 && !fresh ? captureFusionReport(outPath, outputPath, logStartOffset) : null;
	if (captured?.ok) fusionCaptured = captured.bytes;
	let status: FusionStatus;
	let reason: string;
	if (outcome === "timeout") {
		status = "timeout";
		reason = produced && fresh
			? `墙钟预算 ${budget}ms 耗尽，已终止子进程（退出时已有本次产物，但 turn 未完，不得当完整结果）`
			: `墙钟预算 ${budget}ms 耗尽，已终止子进程`;
	} else if (outcome === "error") {
		status = "failed";
		reason = "子进程 error 事件（未能正常启动/执行）";
	} else if (exitCode !== 0) {
		status = "failed";
		reason = `融合者非零退出（exit=${exitCode ?? `signal ${exitSignal ?? "?"}`}），不得计为融合成功`;
	} else if (fileSections?.ok) {
		status = "completed";
		reason = `融合产物已由融合者写入：${outputPath}（${fileSections.bytes} 字节，六节齐全）`;
	} else if (captured?.ok) {
		status = "completed";
		reason = `融合者未写盘，已由 harness 从回复正文落盘：${outputPath}（${fusionCaptured} 字节）`;
	} else if (fresh) {
		// 写了盘但六节不齐 ⇒ 不得拿半截报告当结果
		status = "failed";
		reason = `产物已写但六节不齐（缺 ${fileSections?.missing.join(" / ")}），不得计为融合结果`;
	} else {
		// 第四次实测的真实形状：exit=0 + 回复「报告已完成，185 行六节齐全」+ 盘上零产物 ⇒ 谎报
		status = "failed";
		reason =
			`融合者未产出产物（盘上无本次新鲜 fusion.md），回复正文也不合格（${captured?.shape ?? "无 assistant 正文"}）。` +
			`不得拿口头报告当结果；详见 ${outPath}` +
			(produced && !fresh
				? `；盘上另有早于本次启动的旧产物 mtime=${new Date(statSync(outputPath).mtimeMs).toISOString()}（陈旧产物，同样不得计为本次结果）`
				: "");
	}
	writeRunRecord(runsDir, fusionRunId, {
		id: fusionRunId,
		status, // 必须终态：停在 running 的账本 watcher 永不通知 ⇒ 静默失效
		agent: "fusion",
		model: input.fusionModel,
		// via（2026-11-04）：区分「headless 子进程」与「真 subagent（runWithFallback）」两条通道
		via: agentVia,
		startedAt,
		finishedAt,
		exitCode,
		exitSignal,
		produced,
		productFresh: fresh,
		text: produced ? `融合产物：${outputPath}` : timedOut ? "墙钟预算耗尽，未见融合产物" : "子进程退出但未产出融合文件",
		// 成本读数：从 json 流解析；解析不出记 null（不得写 0 冒充「本次未花钱」）
		cost: usage ? { total: usage.cost, input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite } : null,
		turns: usage?.turns ?? null,
	});
	// S1：正规完成通知（旧版只有对账兜底「B 对账补投」，属降级路径）
	if (input.notifyCompletion) {
		try {
			input.notifyCompletion({
				id: fusionRunId,
				agent: "fusion",
				task: `trace-fusion ${input.runId} fusion`,
				status: status === "completed" ? "completed" : "failed",
				startedAt,
				...(status === "completed" ? {} : { result: { error: reason } }),
			});
		} catch { /* 通知尽力 */ }
	}
	return { status, reason, fusionRunId, reportPath: outputPath, zeroModelCall: false, exitCode, usage, gaps: fileSections && !fileSections.ok ? fileSections.missing : undefined };
}

/**
 * collect worker 的融合步骤（抽出成可测函数，2026-11-02）。
 * 职责：调 dispatchFusion → 把结果写进 meta.json 的 `fusion` 字段 → 日志。
 * **不抛**：融合失败不得弄崩收集链（收集已终态）。
 */
export async function runFusionStep(opts: {
	meta: { runId: string; runDir: string; repoRoot: string; dispatcherSessionId?: string; laneModels?: Record<string, string>; workerModel?: string };
	reportPath: string;
	fusionModel?: string;
	piCli?: string;
	log: (msg: string) => void;
	dispatch?: (i: FusionDispatchInput) => Promise<FusionDispatchResult>;
	runsDir?: string;
	linksPath?: string;
	spawnFn?: FusionDispatchInput["spawnFn"];
	/** S1 seams：透传给 dispatchFusion（collect-cli 注入后，自动链的融合者也有一等账本）。 */
	registerRunProcess?: FusionDispatchInput["registerRunProcess"];
	clearRunProcess?: FusionDispatchInput["clearRunProcess"];
	notifyCompletion?: FusionDispatchInput["notifyCompletion"];
}): Promise<FusionDispatchResult> {
	const dispatch = opts.dispatch ?? dispatchFusion;
	let res: FusionDispatchResult;
	try {
		res = await dispatch({
			runId: opts.meta.runId,
			runDir: opts.meta.runDir,
			repoRoot: opts.meta.repoRoot,
			reportPath: opts.reportPath,
			// 接线关键：模型只能来自用户设置（此处传什么就用什么，不得写死）
			fusionModel: opts.fusionModel,
			laneModel: opts.meta.laneModels?.A ?? opts.meta.workerModel,
			dispatcherSessionId: opts.meta.dispatcherSessionId,
			piCli: opts.piCli,
			runsDir: opts.runsDir,
			linksPath: opts.linksPath,
			spawnFn: opts.spawnFn,
			registerRunProcess: opts.registerRunProcess,
			clearRunProcess: opts.clearRunProcess,
			notifyCompletion: opts.notifyCompletion,
		});
	} catch (err) {
		res = { status: "spawn-error", reason: `融合步骤异常：${(err as Error).message}`, zeroModelCall: false };
	}
	opts.log(`fusion: ${res.status} — ${res.reason}${res.usage ? ` [成本 $${res.usage.cost.toFixed(4)} / ${res.usage.turns} turns / cacheRead ${res.usage.cacheRead}]` : " [成本读数缺失：json 流未解析出 usage]"}`);

	// 有界补写一轮（2026-11-03 第 5 次实测：产物写进了产物目录但六节不齐）。
	// 只在「盘上已有本次新鲜产物 + 缺口清单非空」时补派；无产物的失败不补（没有补写基础，
	// 重烧整轮是编排层/人的决定，不在自动链里）。**结构性只派一次**（本函数内单层，无循环）。
	let repair: FusionDispatchResult | null = null;
	let gapsRequested: string[] | null = null;
	if (res.status === "failed" && (res.gaps?.length ?? 0) > 0) {
		gapsRequested = res.gaps!.slice();
		opts.log(`fusion-repair: 产物已写但缺 ${res.gaps!.length} 节 ⇒ 同认领内补派一轮（只补不重做）`);
		try {
			repair = await dispatch({
				runId: opts.meta.runId,
				runDir: opts.meta.runDir,
				repoRoot: opts.meta.repoRoot,
				reportPath: opts.reportPath,
				fusionModel: opts.fusionModel,
				laneModel: opts.meta.laneModels?.A ?? opts.meta.workerModel,
				dispatcherSessionId: opts.meta.dispatcherSessionId,
				piCli: opts.piCli,
				runsDir: opts.runsDir,
				linksPath: opts.linksPath,
				spawnFn: opts.spawnFn,
				repair: { gaps: res.gaps! },
			});
		} catch (err) {
			repair = { status: "spawn-error", reason: `补写轮异常：${(err as Error).message}`, zeroModelCall: false };
		}
		opts.log(`fusion-repair: ${repair.status} — ${repair.reason}`);
		if (repair.status === "completed") res = repair;
		else res = { ...repair, gaps: repair.gaps ?? res.gaps };
	}
	try {
		const metaPath = join(opts.meta.runDir, "meta.json");
		const raw = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown> : {};
		// phase / result 正交（2026-11-02 #3）：completed 不再同时表示「收集完成」与「融合成功」两件事。
		// phase = 流水线走到哪；result = 本次融合的真实结局。
		const phase = res.status === "skipped" ? "collected" : res.status === "completed" ? "fused" : "fusing-failed";
		const result: Record<FusionStatus, string> = {
			skipped: "skipped",
			launched: "running",
			completed: "succeeded",
			failed: "failed",
			timeout: "timeout",
			"spawn-error": "failed",
		};
		writeFileSync(
			metaPath,
			JSON.stringify({
				...raw,
				phase,
				fusion: {
					status: res.status,
					result: result[res.status],
					reason: res.reason,
					model: opts.fusionModel ?? null,
					fusionRunId: res.fusionRunId ?? null,
					reportPath: res.reportPath ?? null,
					exitCode: res.exitCode ?? null,
					usage: res.usage ?? null,
					at: new Date().toISOString(),
					repair: repair
						? { status: repair.status, reason: repair.reason, gapsRequested, usage: repair.usage ?? null, at: new Date().toISOString() }
						: null,
				},
			}, null, 2) + "\n",
			"utf8",
		);
	} catch (err) {
		opts.log(`fusion: meta 写入失败 ${(err as Error).message}`); // 不弄崩收集链
	}
	return res;
}

