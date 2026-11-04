/**
 * runtime/session-liveness.ts — 会话存活状态机（单一事实源）
 *
 * 2026-10-30 事故驱动的重构。三个问题其实是同一个：
 *   ① S2 拉起死会话时误判「活着的 tab = 死的」⇒ 每发一句就拉起新 tab
 *   ② GUI 会话列表只能按「最近更新 / 按创建」排序，无法「只看活跃中」
 *   ③ 没有一处能回答「现在哪些会话是活的」
 *
 * ── 为什么不能用命令行匹配 sessionId（第一版 S2 的致命错误）──
 *
 * 第一版 `probeSessionProcess()` 枚举 node.exe 命令行，找含 `--session <path>` 或
 * sessionId 的进程。**但 pi tab 有两种启动形态**：
 *   - `pi --session <file>`            ⇒ 命令行**含** sessionId，能匹配上
 *   - `pi --tab-run-id X @prompt.md`   ⇒ 命令行**不含** sessionId，匹配不上 ← 常态！
 * 实测：活着的 tab `pid 90508` 走的是 `@prompt` 形态 ⇒ 永远判 `no-live-process`
 * ⇒ 判 dead ⇒ 每发一条消息拉起一个 tab。
 *
 * ── 正确判据：用 pid，不用命令行 ──
 *
 * `tab-runs/<runId>.state.json` 本来就写了自己进程的 `pid`（`tab-runs-runtime.ts:250`
 * `pid: ownPid`）。这是**唯一可靠**的会话↔进程关联：
 *   - 不受启动形态影响（两种形态都写）
 *   - 不受命令行文本变化影响
 *   - 可直接 `isProcessAlive(pid)` 验证
 *
 * 对于**不是 tab** 的会话（`pi --session <file>` 直接起的，如主会话），
 * state 文件不存在 ⇒ 回落到命令行以 `--session <该会话文件>` 精确匹配
 * （这条路径少见且形态确定，可以严格匹配）。
 *
 * ── 三态而非两态 ──
 *
 * `unknown`（缺证据）绝不等于 `dead`。拉起窗口是有副作用的动作（开可见窗口、
 * 可能重复消耗额度），必须由强证据触发。这与本仓 `judgeScopeOwnerStale` 的
 * `skip:no-liveness`（判不了 = 不动）同一条原则。
 */

/** 会话存活状态。**三态**：缺证据（unknown）不得当作死亡。 */
export type SessionLiveness = "alive" | "dead" | "unknown";

/** 判定依据（可观测，便于排查）。 */
export type LivenessEvidence =
	/** tab state 的 pid 活着。最强证据。 */
	| { kind: "tab-pid-alive"; runId: string; pid: number }
	/** tab state 的 pid 已死。最强证据（可据此安全拉起）。 */
	| { kind: "tab-pid-dead"; runId: string; pid: number }
	/**
	 * `session-owner` 全生命周期记录里的 pid 活着。
	 *
	 * 2026-11-04：这是**普通 TUI 会话**唯一的活证据来源。
	 * `state/session-owner/<sid>.json` 由 `session-hooks.ts` 在 session_start 写、
	 * session_shutdown 删 ⇒ **与忙闲无关、全生命周期存在**，且带进程启动时间做
	 * PID 复用交叉验证（`session-owner.ts` 不变量 2）。
	 */
	| { kind: "owner-pid-alive"; pid: number }
	/**
	 * `session-owner` 记录里的 pid 已死 ⇒ 该会话**确定**没有活实例。
	 *
	 * 这是普通 TUI 会话能被安全拉起的**唯一**依据（tab state 只覆盖 tab 会话）。
	 * 强证据等级与 `tab-pid-dead` 同级：都是「观测到某个进程已死」，
	 * 但 owner 记录带 sessionId 身份绑定 + 启动时间防复用 ⇒ 不会像 legacy
	 * 时间就近配对那样张冠李戴。
	 */
	| { kind: "owner-pid-dead"; pid: number }
	/** 非 tab 会话，命令行精确含 `--session <file>` 且进程在。 */
	| { kind: "session-flag-alive"; pid: number }
	/** 非 tab 会话，未找到对应进程。 */
	| { kind: "session-flag-absent" }
	/** 探针失败/平台不支持/无任何证据。**不得当作 dead。** */
	| { kind: "probe-unavailable"; reason: string };

/** 一个会话的存活判定结果。 */
export interface SessionLivenessVerdict {
	sessionId: string;
	liveness: SessionLiveness;
	evidence: LivenessEvidence;
	/** 关联的 tab runId（若有）。 */
	runId?: string;
	/** 进程 pid（若已知）。 */
	pid?: number;
}

/**
 * 把证据映射为三态。**纯函数**。
 *
 * 关键不变量：**只有明确观测到「pid 已死」才判 dead**。
 * `probe-unavailable` / `session-flag-absent` 都只是「没看到活证据」，
 * 不能推出「已死」——尤其 `session-flag-absent` 在 `@prompt` 形态下是**误判**。
 */
export function livenessFromEvidence(evidence: LivenessEvidence): SessionLiveness {
	switch (evidence.kind) {
		case "tab-pid-alive":
		case "session-flag-alive":
		case "owner-pid-alive":
			return "alive";
		case "tab-pid-dead":
		case "owner-pid-dead":
			return "dead";
		// ⚠️ `session-flag-absent` **不是** dead：
		//    非 tab 会话可能是通过 @prompt / 别名 / 未来新形态启动的，
		//    命令行里没有 `--session` 不代表进程不存在。保守判 unknown。
		case "session-flag-absent":
		case "probe-unavailable":
		default:
			return "unknown";
	}
}

/**
 * 由 tab state 的 pid 判定。**纯函数**（isAlive 注入）。
 *
 * 这是 S2 的主路径：tab 派发的会话必然有 state 文件 + pid。
 */
export function livenessFromTabState(
	state: { pid?: number } | null,
	isAlive: (pid: number) => boolean,
): { liveness: SessionLiveness; evidenceKind: "tab-pid-alive" | "tab-pid-dead" | "probe-unavailable" } {
	const pid = state?.pid;
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
		// state 缺失或 pid 未写（进程刚起、尚未首心跳）⇒ 无证据
		return { liveness: "unknown", evidenceKind: "probe-unavailable" };
	}
	return isAlive(pid)
		? { liveness: "alive", evidenceKind: "tab-pid-alive" }
		: { liveness: "dead", evidenceKind: "tab-pid-dead" };
}

/**
 * 合并多份证据，取**最强**的那份。
 *
 * 优先级（强 → 弱）：
 *   1. `owner-pid-alive`    —— 全生命周期 owner 记录 + 启动时间交叉验证（身份绑定最硬）
 *   2. `tab-pid-alive`      —— 明确活（tab state 的 pid + isProcessAlive）
 *   3. `session-flag-alive` —— 明确活（命令行当下观测）
 *   4. `owner-pid-dead`     —— **历史**某实例已死（生命周期受管 + 身份绑定）
 *   5. `tab-pid-dead`       —— **历史**某实例已死
 *   6. `session-flag-absent` / `probe-unavailable` —— 无结论
 *
 * ## 为什么 alive 必须高于 dead（2026-10-30 第五次修正）
 *
 * 旧规则是 dead 最高，理由是「tab state 是权威」。**这个理由错在两点：**
 *
 * ① **时间性错位**：tab 记录是**历史的**（例：`tab_mvuld64u_m023` 是 06:28
 *    那次派发，进程 242324 后来死了），而命令行是**当下的**。会话被拉起后，
 *    新进程不属于任何 tab 记录 ⇒ 旧 dead 永远压过新 alive。
 *
 * ② **语义层级错**：`tab-pid-dead` 只能证明「**某个**历史实例退了」，
 *    它不能证明「**这个逻辑会话现在没有活进程**」。一个会话可以有多个前后
 *    相继的运行实例，问「要不要拉起」只能看「**现在**有没有活实例」。
 *
 * 实测后果（真实数据）：`01a18b7f-…` 在 `pid 291780` 下正常运行，但因为旧 tab
 * 记录 `pid 242324` 已死，每发一条消息就再开一个标签页。
 *
 * **反向风险仍然守住**：只有**观测到** alive 才判 alive。
 * `absent` / `probe-unavailable` 仍是 unknown ⇒ 不拉起（见 `livenessFromEvidence`）。
 *
 * ## 2026-11-04：owner 证据的插入位置（不是随手排的）
 *
 * `owner-pid-alive` 排在**最前**：它是「sessionId ↔ pid」的**身份绑定**，
 * 且经进程启动时间交叉验证（防 PID 复用）⇒ 比 tab 记录的 sessionPath 路径
 * 匹配更硬，比命令行的文本匹配更可靠。
 *
 * `owner-pid-dead` 与 `tab-pid-dead` **同 rank**（L4 审查 M1 修正）：
 * 原稿把 owner 排更高，理由是「owner 记录指向最近那个实例」——**该前提不成立**：
 * owner 记录在 `session_shutdown` 时即被删除（`session-hooks.ts:140`）
 * ⇒ **正常退出的会话永远没有 owner 记录** ⇒ owner 记录只覆盖「崩溃/被杀」的会话。
 * 而 tab 记录（`tab-runs/*.state.json`）是**永久留存**的。
 * ⇒ 两个证据源的**存活期恰好互补**（owner 短命、tab 长命），
 *   让「短命源的陈旧记录」压过「长命源的历史记录」没有依据 ⇒ 同 rank。
 *
 * ## 不变量（最高优先级，不因新增证据而松动）
 *
 * **所有 alive 类证据的 rank 都高于所有 dead 类证据** —— 2026-10-30「第五次修正」锁定：
 * dead 只证明「某个历史实例退了」，不能证明「这个逻辑会话现在没有活进程」。
 * 问「要不要拉起」只能看「**现在**有没有活实例」。
 */
export function mergeEvidence(evidences: readonly LivenessEvidence[]): LivenessEvidence {
	const rank = (e: LivenessEvidence): number => {
		switch (e.kind) {
			case "owner-pid-alive": return 6;
			case "tab-pid-alive": return 5;
			case "session-flag-alive": return 4;
			// owner-pid-dead 与 tab-pid-dead 同 rank（L4 审查 M1）：两个证据源存活期互补
			case "owner-pid-dead": return 2;
			case "tab-pid-dead": return 2;
			case "session-flag-absent": return 1;
			case "probe-unavailable": return 0;
			default: return 0;
		}
	};
	let best: LivenessEvidence = evidences[0] ?? { kind: "probe-unavailable", reason: "no-evidence" };
	for (const e of evidences) {
		if (rank(e) > rank(best)) best = e;
	}
	return best;
}

/**
 * GUI 会话列表的「活跃中」筛选依据。**纯函数**。
 *
 * owner 需求（2026-10-30）：「我希望以后 gui 上过滤会话的『最近更新/按创建』
 * 改成『最近更新/活跃中』」。
 *
 * `active` 的语义：**有活进程**。与「最近更新」正交 —— 一个会话可能刚被读过
 * （mtime 很新）但进程早已退出；也可能进程活着但长时间思考（mtime 很旧）。
 */
export type SessionActivity = "active" | "inactive" | "unknown";

export function activityOf(liveness: SessionLiveness): SessionActivity {
	if (liveness === "alive") return "active";
	if (liveness === "dead") return "inactive";
	return "unknown";
}

/** 会话列表的排序/筛选键（GUI 端可直接用）。 */
export interface SessionActivityView {
	sessionId: string;
	activity: SessionActivity;
	liveness: SessionLiveness;
	/** 关联 tab runId（若该会话是 tab 派发的）。 */
	runId?: string;
	pid?: number;
}

/**
 * 仅依据 liveness 判断「是否允许拉起会话」（权限/cwd 由 `decideSendAction` 另行把关）。
 *
 * 抽成纯函数是为了让「**只有 dead 才允许拉起**」成为可单测的单一事实源：
 * 任何一处调用只要不经过它就值得怀疑。
 */
export function decideSendActionAllowed(liveness: SessionLiveness): boolean {
	return liveness === "dead";
}
