/**
 * trace-fusion/lane-bash-guard.ts — lane（trace-worker）tab 的盘根递归扫描**机械门**（2026-11-03）
 *
 * ## 起因（实测，不是预防性设计）
 *
 * R-13 禁令**本来就写在 lane 提示词里**（`worker-prompt.ts:222-231`，连 `C:/` 绕过那次都写了），
 * 2026-11-03 首跑实测 lane A 仍然跑了三次盘根搜索：
 *
 * ```
 * 1.  ls -la /Users/Annacomnena/plans || ls -la plans || find / -name "lane_stray_files_brief.md"
 * 3.  find / -name "lane_stray_files_brief.md" 2>/dev/null | head -5
 * 12. find / -name "lane_stray_files_brief.md" 2>/dev/null | head -5
 * ```
 *
 * 后果实测读数：`find.exe` pid 207836 句柄 **699,972**（R-13 的阈值线是 10 万），
 * 主会话手动 `taskkill /T /F` 才止住。诱因是派发 prompt 里的路径写错 ⇒ lane 找不到文件就去全盘搜。
 *
 * ⇒ **提示词禁令不足以拦住它**（本仓已两次踩到：同一禁令下再犯）。本次把 R-13 落成机械门：
 * 只在 `trace-worker` profile 生效，拦「递归 + 盘根/家目录目标」这一形状，正常仓库内搜索零影响。
 *
 * ## 判据形状（只拦这一类，宁漏不误）
 *
 * `递归命令` ∧ `目标 = 盘根 / 家目录 / 顶层系统目录`
 * - 递归命令：`find` / `du`（默认递归）、`grep` 带 `-r`/`-a` 类含 r 的短旗、`rg`/`ag`（默认递归）、
 *   `ls -R`、PowerShell `Get-ChildItem -Recurse`（别名 `gci`）。
 * - 盘根目标：`/`、`//`、`X:`/`X:/`/`X:\`、`/c`、`/c/Users`（两段的盘符映射）、`~`、`$HOME`、
 *   `%USERPROFILE%`、`/Users`、`/Users/<x>`、`/home`、`/home/<x>`、`/mnt`、`/cygdrive`、`/proc`、`/sys`、
 *   `X:/Users`、`X:\Users`、`X:/Program Files` 等顶层目录（含单层子目录）。
 * - `find .`、`grep -rn x extensions/trace-fusion/`、`ls -la plans/`、`du plans/`、`rg pattern src/`
 *   这些**不拦**（实测 lane 的正常探查形状）。
 *
 * 取舍（AGENTS.md R-5）：本门**允许漏**（如 `bash -c "find /"` 的嵌套变形、脚本内部发起的扫描），
 * 不允许误杀正常仓库内搜索——误杀会让 lane 连产物都写不出来（2026-11-02 禁 write 的事故）。
 * 漏掉的面由墙钟时限与主会话巡检兜底，不假装已闭合。
 */

/** 递归扫描命令的首词（剥路径前缀与 .exe 后比较）。 */
const SCAN_HEADS = new Set(["find", "du", "grep", "rg", "ag", "ls", "get-childitem", "gci", "dir", "ls.exe"]);

/** 盘根 / 家目录 / 顶层系统目录（实测 lane 会写的斜杠形状都覆盖，不区分斜杠方向）。 */
const ROOTISH_PATTERNS: RegExp[] = [
	/^\/{1,2}$/, // / 与 //
	/^~$/, // 只有**裸 `~`** 算家目录起递归；`~/repo/sub` 是具体目录，不得误杀
	/^\$HOME\/?$/,
	/^\$\{HOME\}\/?$/,
	/^%USERPROFILE%\/?$/,
	/^\$env:USERPROFILE\/?$/i,
	/^[A-Za-z]:[\\/]*$/, // C:  C:/  C:\
	/^\/[A-Za-z]\/?$/, // /c  /c/（尾斜杠算同盘根，2026-11-03 L4 实验：旧版 `/c/` 逸出）
	// 下列是“盘根下的系统目录”，逐个点名；不得用 `/c/<任意>` 这种泛匹配（`/c/repo` 是普通项）
	/^\/(cygdrive|mnt)(\/[A-Za-z])?\/?$/i,
	/^\/(Users|home)(\/[^/]+)?\/?$/i, // /Users  /Users/x（家目录树）
	/^\/tmp\/?$/i, // 只算裸 /tmp；/tmp/x 是具体目录，不属盘根扫描
	/^\/[A-Za-z]\/(Users|home|Windows|Program Files( \(x86\))?)([\/][^\/]+)?[\/]?$/i,
	/^\/(proc|sys|etc|var|usr|bin|sbin|lib)(\/.*)?$/i,
	/^[A-Za-z]:[\\/](Users|home|Program Files( \(x86\))?|Windows)([\\/][^\\/]+)?[\\/]?$/i,
];

/** 剥掉引号/反引号/尾随重定向噪声后的路径形状判定。 */
export function isRootishTarget(raw: string): boolean {
	const t = raw.replace(/^['"`]+|['"`]+$/g, "").replace(/[;,)]+$/g, "").trim();
	if (!t) return false;
	// 纯 flag 与被引号包住的「词」不当路径判
	if (/^-/.test(t)) return false;
	return ROOTISH_PATTERNS.some((re) => re.test(t));
}

export interface LaneGuardVerdict {
	block: boolean;
	reason: string;
	/** 命中判据的那一段命令（可复跑证据）。 */
	segment: string;
	head: string;
	target: string;
}

const cleanHead = (token: string): string =>
	token
		.replace(/^['"`]+|['"`]+$/g, "")
		.split(/[\\/]/)
		.pop()!
		.replace(/\.exe$/i, "")
		.toLowerCase();

/** 该段是否声明了「递归」。 */
function isRecursive(head: string, flags: string[]): boolean {
	// find/du/rg/ag 默认递归；ls 需 -R；grep 需含 r 的短旗或 --recursive（**大小写不敏感**，
	// 2026-11-03 L4 实验：旧版 `f.includes("r")` 让 `grep -R needle /` 逸出）；PS 需 -Recurse
	if (head === "find" || head === "du" || head === "rg" || head === "ag") return true;
	if (head === "ls") return flags.some((f) => /^-[A-Za-z]*R[A-Za-z]*$/i.test(f) || f === "--recursive");
	if (head === "grep") return flags.some((f) => f === "--recursive" || (/^-[A-Za-z]+$/.test(f) && /[rR]/.test(f)));
	if (head === "get-childitem" || head === "gci" || head === "dir") return flags.some((f) => /^-r(ecurse)?$/i.test(f));
	return false;
}

/**
 * 判定一条 shell 命令里是否存在「递归 + 盘根/家目录目标」。
 * 按 `|`、`&&`、`||`、`;`、换行切段（与 validation-replay 的切段口径一致）。never-throw。
 */
export function judgeLaneBashCommand(command: string): LaneGuardVerdict {
	const pass: LaneGuardVerdict = { block: false, reason: "", segment: "", head: "", target: "" };
	try {
		const segments = String(command ?? "").split(/\|\||&&|[|\n;]+/);
		for (const rawSeg of segments) {
			const seg = rawSeg.trim();
			if (!seg) continue;
			const tokens = seg.split(/\s+/).filter(Boolean);
			if (tokens.length === 0) continue;
			// 剥包装命令（2026-11-03 L4 实验：旧版只看首词，`env find / …` 直接绕过本门）。
			// 只剥“已知包装器 + 它的参数”；剥完再看真命令是什么。
			const tokens2 = unwrapWrappers(tokens);
			if (tokens2.length === 0) continue;
			const head = cleanHead(tokens2[0]);
			if (!SCAN_HEADS.has(head)) continue;
			let rest = tokens2.slice(1);
			// rg/ag 的第一个非旗标位是**搜索模式**，不是路径（`rg '/' extensions/` 不得当盘根）。
			if ((head === "rg" || head === "ag") && rest.length > 0) {
				const first = rest.find((t) => !/^-/.test(t));
				if (first !== undefined) rest = rest.filter((t, i) => t !== first || i !== rest.indexOf(first));
			}
			const flags = rest.filter((t) => /^-/.test(t));
			if (!isRecursive(head, flags)) continue;
			const targets = rest.filter((t) => !/^-/.test(t) && !/^\d*$/.test(t));
			const hit = targets.find(isRootishTarget);
			if (hit !== undefined) {
				return {
					block: true,
					segment: seg,
					head,
					target: hit,
					reason:
						`R-13 盘根递归扫描拦截（lane 只读诊断不得做全盘搜索）：` +
						`「${head}」递归 + 目标「${hit}」= 盘根/家目录。` +
						`实测事故：同类命令把 find.exe 句柄推到 699,972（阈值 10 万），` +
						`历史同类事故导致 pi 包损坏 4 次。` +
						`改用：① codegraph（符号级）；② 把目录限定到具体子目录（如 grep -rn x extensions/trace-fusion/）；` +
						`③ 要找某个已知文件就直接 read 它的路径，不要搜盘。`,
				};
			}
		}
		return pass;
	} catch {
		return pass; // 判定失败 ⇒ 放行（本门只拦确定形状，不做默认拒绝）
	}
}

/**
 * 剥包装命令（2026-11-03 L4 实验：`env find / -name x` 绕过只看首词的判据）。
 * 只剥已知包装器与它自己的参数；剥不动就原样返回（不猜）。
 */
export function unwrapWrappers(tokens: string[]): string[] {
	const WRAPPERS = new Set(["env", "sudo", "nohup", "nice", "command", "time", "timeout", "stdbuf", "ionice"]);
	const out = [...tokens];
	for (let guard = 0; guard < 6 && out.length > 0; guard++) {
		const head = cleanHead(out[0]);
		if (!WRAPPERS.has(head)) break;
		let i = 1;
		// 吃掉包装器自己的参数：env 的 VAR=VAL、timeout/timeout 的旗标与时长、nice 的 -n N
		while (i < out.length && (/^-/.test(out[i]) || /=/.test(out[i]) || /^[\d.]+[smhd]?$/.test(out[i]) || out[i] === "--")) i++;
		out.splice(0, i);
	}
	return out;
}

/** 从 pi 原生 find/grep/ls 工具的 input 里提取候选路径参数（duck-typing，不依赖其类型）。 */export function collectPathCandidates(input: Record<string, unknown>): string[] {
	const out: string[] = [];
	for (const v of Object.values(input ?? {})) {
		if (typeof v === "string") out.push(v);
		else if (Array.isArray(v)) {
			for (const x of v) if (typeof x === "string") out.push(x);
		}
	}
	return out;
}

/**
 * 从一条 shell 命令里找「写盘落点」并判越界（2026-11-03 首跑实测）。
 * 首跑形状：`printf ... > "C:/Users/.../pi/agent/.../fusion.md"`（.pi 被写成 pi）
 * ⇒ 报告落到主仓外的野路径。故只认**写盘形状**后面的盘符绝对路径：
 * 重定向 `>`/`>>`、`tee`、`dd of=`。只读命令（read/grep/git show/cat 无重定向）零误杀
 * ——第一版按「命令里任何盘符路径」判，实测把只读 grep 也拦了（已修）。
 */
export function findStrayWriteTarget(command: string, artifactDir: string): string | undefined {
	const norm = (p: string): string => p.split("\\").join("/").replace(/\/+$/, "").toLowerCase();
	const dir = norm(artifactDir);
	const targets = new Set<string>();
	// 引号内允许空格（路径含空格），故带引号/不带引号各一条
	for (const m of command.matchAll(/>[^\S\n]*(["'])([A-Za-z]:[\\/][^"']*)\1/g)) targets.add(m[2]);
	for (const m of command.matchAll(/>[^\S\n]*([A-Za-z]:[\\/][^\s;|&<>]*)/g)) targets.add(m[1]);
	for (const m of command.matchAll(/\btee[^\S\n]*(?:-a[^\S\n]*)?(["'])([A-Za-z]:[\\/][^"']*)\1/g)) targets.add(m[2]);
	for (const m of command.matchAll(/\btee[^\S\n]*(?:-a[^\S\n]*)?([A-Za-z]:[\\/][^\s;|&<>]*)/g)) targets.add(m[1]);
	for (const m of command.matchAll(/\bof=(["']?)([A-Za-z]:[\\/][^\s;|&<>]*)/g)) targets.add(m[2]);
	for (const t of targets) {
		const n = norm(t);
		if (n === dir || n.startsWith(dir + "/")) continue;
		return t;
	}
	return undefined;
}

export interface LaneBashGuardOptions {
	/** 当前会话是不是 trace lane（缺省 = 永不拦，防止注册到主会话时误杀）。 */
	isLane?: () => boolean;
	/**
	 * 产物落点目录（2026-11-03 首跑实测缺口）：融合者被排除 write/edit 后，
	 * 用 bash 自己写 fusion.md，并把路径写丢了个点（`.pi` 写成 `pi`），
	 * 落到主仓外的野路径 ⇒ 判据正确地判 failed，但文件已经落在用户目录里。
	 * 传了本目录 ⇒ 额外要求 bash 命令里出现的**绝对写盘落点**必须落在该目录内，
	 * 否则拦截（只读诊断/融合的写盘只允许发生在指定产物目录）。
	 */
	artifactDir?: string;
}

const NATIVE_SCAN_TOOLS = new Set(["find", "grep", "ls", "directory_tree"]);

/**
 * 注册机械门。**只影响 lane（trace-worker profile）**；其他会话零作用。
 * `isLane` 缺省给 `() => false`：调用方忘记传 ⇒ 零拦截（零风险），
 * 而不是默认全拦（那会把主会话自己的搜索拦掉）。
 */
export function registerLaneBashGuard(pi: { on: (event: string, fn: (event: unknown) => unknown) => void }, opts: LaneBashGuardOptions = {}): void {
	const isLane = opts.isLane ?? (() => false);
	pi.on("tool_call", (eventRaw) => {
		const event = eventRaw as { toolName?: string; input?: Record<string, unknown> };
		if (!isLane()) return undefined;
		const name = String(event?.toolName ?? "");
		const isShell = name === "bash" || name === "powershell";
		if (isShell) {
			const command = String((event.input as { command?: string } | undefined)?.command ?? "");
			// 写盘落点越界（首跑实测：融合者无 write 工具，用 bash 重定向把 fusion.md 写到主仓外）。
			// 必须在下面 return 之前查——旧版把它写在本分支之后 ⇒ 对 bash 命令永不可达。
			if (opts.artifactDir) {
				const stray = findStrayWriteTarget(command, opts.artifactDir);
				if (stray !== undefined) {
					return {
						block: true,
						reason:
							`产物落点越界拦截：命令里的写盘目标「${stray}」不在本 run 的产物目录内（${opts.artifactDir}）。` +
							`融合报告必须由 harness 落盘——把报告正文写进你的**回复正文**即可，不要用 shell 写文件。`,
					};
				}
			}
			const verdict = judgeLaneBashCommand(command);
			if (verdict.block) return { block: true, reason: verdict.reason };
		}
		if (NATIVE_SCAN_TOOLS.has(name) && !isShell) {
			const hit = collectPathCandidates(event.input ?? {}).find(isRootishTarget);
			if (hit !== undefined) {
				return {
					block: true,
					reason:
						`R-13 盘根递归扫描拦截（lane 只读诊断不得搜盘）：「${name}」工具目标「${hit}」= 盘根/家目录。` +
						`改用：① codegraph；② 把路径限定到具体子目录；③ 已知文件就直接 read 它。`,
				};
			}
		}
		return undefined;
	});
}
