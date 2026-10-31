/**
 * runtime/recentwork-text.ts — `recentwork.md` 文本解析（**纯函数，零 IO，零 host 依赖**）
 *
 * 为什么单独成模块（2026-11-01 L4 审查 N-1 修正）：
 *   这两个函数同时被两个消费者需要 ——
 *     · `runtime/frontier-carriers.ts::readGateStatus`（主动性套件的 gate 判定）
 *     · `runtime/hydrate.ts::buildHandoff`（交接包的 RecentWork 摘要）
 *   最初把它们放在 `frontier-carriers.ts`，让 `hydrate` import 那边 —— 但
 *   `frontier-carriers.ts:33` 引了 `../tab-runs-runtime.ts`（**Pi tool 层**，
 *   依赖 `@earendil-works/pi-tui` / `typebox`），于是 `hydrate`（runtime 层）
 *   反向依赖了 tool 层，违反 `runtime/wake.ts:15` 的明文禁令：
 *     「本模块**不得** import `../supervision-runtime.ts`（Pi tool 层）」
 *   且有 `_test_supervise_gate.ts:785` 的「分层锚点」断言守着这个方向。
 *
 *   搬到本模块后：`hydrate` 与 `frontier-carriers` 都从这里 import，
 *   **两个消费者读同一份实现**（原目标不变），但**不引入任何依赖边**。
 *
 * 本文件只允许依赖：语言内建（`TextEncoder` / `TextDecoder`）。
 * 不得 import node:fs / 任何 host 包 / 任何其他项目模块。
 */

/**
 * `## Active Tasks` 区段标题别名（方言并集）：英文（本仓）`## Active Tasks`；
 * 中文（GreenCAD 等）`## 待办事项 (Todo)`。
 */
export const GATE_ACTIVE_HEADING = /^##\s+(?:Active Tasks|待办事项)/;

/** 索引表标题别名：`### Task Index` / `### 任务简报索引`。 */
export const GATE_INDEX_HEADING = /^###\s+(?:Task Index|任务简报索引)/;

/**
 * 从 `recentwork.md` 全文切出 `## Active Tasks` 区段（纯函数，零 IO，可单测）。
 *
 * 为什么单独抽出（2026-10-31）：交接包 `hydrate.ts::buildHandoff` 原先直接取文件
 * **前 2048 字节**当 RecentWork 摘要。实测三个仓的本文件开头全是「Maintenance Rules」
 * 之类的写入端规范，真正的任务状态在 1 KB 之后：
 *   subagent-win 172,622 B → 截断后 2,048 B（1.2%），2048 内只有 **1 条**任务索引行且被劈断；
 *   battlesandbox 119,793 B → 2,047 B（1.7%），**0 条**任务索引行；
 *   GreenCAD 119,068 B → 2,047 B（1.7%），**0 条**任务索引行。
 * 即：交接包拿到的永远是「怎么维护这份文件」，而拿不到「现在做到哪」。
 * 本函数与 `readGateStatus` 共用同一套区段判据与方言别名，**消除「同一份文件两个读法」**。
 *
 * ````text
 * 返回：
 *   string  —— 区段正文（含 `## Active Tasks` 标题行，到下一个 `## ` 之前）
 *   null    —— 文件里没有该区段（调用方自行决定回退策略）
 * ```
 */
export function extractActiveTasksSection(text: string): string | null {
	const lines = text.split("\n");
	const start = lines.findIndex((l) => GATE_ACTIVE_HEADING.test(l));
	if (start < 0) return null;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (/^##\s+/.test(lines[i] ?? "")) { end = i; break; }
	}
	return lines.slice(start, end).join("\n");
}

/**
 * 把 `Active Tasks` 区段压成「**交接可用**」的前缀（纯函数，零 IO）。
 *
 * 为什么不能直接按字节截断（2026-10-31 实测）：区段**自身头部也可能很长**。
 * 首个 `### Item N` 在区段内的偏移：
 *   subagent-win 9,979 / battlesandbox 17 / GreenCAD 16,990（上限 2,048）。
 * 即 3 个仓里 2 个即使切了区段，机械截断后仍然**一条任务条目都进不去**。
 * 直接抬上限也不行：区段 52K~81K 字符，全塞进交接包会挤掉别的输入。
 *
 * 按**结构价值**取块，而非按字节顺序：
 *   ① 区段标题行（让接手者知道这是哪一节）
 *   ② `### Task Index` 表（若能放下）——一屏总览，信息密度最高
 *   ③ 逐个 `### Item N` 条目（按文件中出现顺序）直到预算用尽
 *   ④ 上面一条都放不下 ⇒ 退回普通截面（至少不是空白）
 *
 * 不完整的地方用一行 `…（还有 K 条未列入）` 如实声明，**不静默截断**。
 */
export function buildRecentWorkExcerpt(section: string, capBytes: number): string {
	const lines = section.split("\n");
	const byteLen = (s: string): number => new TextEncoder().encode(s).length;
	/** 单个条目在本预算下的取用上限（字符，非字节；留余量）。 */
	const PER_ITEM_BUDGET = 260;
	/** 从整条目里取「标题 + 至多 2 行正文」，不超 PER_ITEM_BUDGET。
	 *  设计取舍（实测）：
	 *    - 整条（不裁） → 只进 1 条（单条 1.4K~11.6K 字符）
	 *    - 标题 + 5 行 → 进 3~6 条，但每条吃 ~400 字符
	 *    - 标题 + 2 行 → 进 3~4 条，内容仍能看出「这条在干什么」
	 *  选「标题 + 至少 1 行、至多 2 行」：让每条都能看出主题，而不是只有编号。
	 *  PER_ITEM_BUDGET 是**软上限**：首行（标题）本身超长也允许（不能把标题也切了）。
	 */
	const itemHead = (block: string): string => {
		const bl = block.split("\n");
		const out: string[] = [];
		let n = 0;
		let bodyLines = 0;
		for (const ln of bl) {
			const isTitle = out.length === 0;
			if (!isTitle) {
				if (ln.trim() === "") {
					// 空行不占行数预算，但也不无限追问
					if (out.length > 0 && bodyLines === 0) { out.push(ln); continue; }
					break;
				}
				if (bodyLines >= 2) break;
				if (n + ln.length > PER_ITEM_BUDGET && bodyLines >= 1) break;
			}
			// 单行超长（无换行的巨块，如一整段长文）⇒ 硬截断该行，
			// 否则 itemHead 自身就超预算→ tryPush 永久失败→ 该条目**静默消失**。
			// 实测真实仓有 11,625 字符的单条；测试仓有 14KB 无换行单行。
			//
			// 2026-11-01 L4 修正（P1）：旧实现帶 `budgetLeft > 40` 下限 ⇒ 若标题本身
			// 就占满了 budgetLeft（≤40），该行**不截断** ⇒ itemHead 仍达 14KB ⇒
			// `tryPush` 永久失败、条目丢失，而预算还剩 1,892B 闲置。
			// 现在：**标题行永不裁**（它是识别条目的唯一依据），其余行无下限截断。
			const budgetLeft = Math.max(0, PER_ITEM_BUDGET - n);
			const line = isTitle || ln.length <= budgetLeft ? ln : `${ln.slice(0, Math.max(1, budgetLeft))}\u2026`;
			out.push(line);
			n += line.length + 1;
			if (!isTitle) bodyLines++;
		}
		const head = out.join("\n").trimEnd();
		return out.length < bl.length ? `${head}\n  \u2026` : head;
	};
	const parts: string[] = [];
	let used = 0;
	/** 给末尾「未列入」声明预留的空间（**必须先扣**，否则会把预算吃满导致声明被丢，
	 *  那就是静默截断 —— 实测 subagent-win/battlesandbox 已经踩中过：2046/2048 用满 →
	 *  note 放不下 → return body（无任何声明）。 */
	const NOTE_RESERVE = 110;
	const contentCap = Math.max(0, capBytes - NOTE_RESERVE);

	const tryPush = (block: string, cap: number = contentCap): boolean => {
		const cost = byteLen(block) + 1; // +1 = 换行
		if (used + cost > cap) return false;
		parts.push(block);
		used += cost;
		return true;
	};
	/** Task Index 块的预算上限：占总预算 40%。
	 *  为什么要分账：索引行信息密度高（一屏总览），但 Summary 列很长（单行 400+ 字符）。
	 *  不分账时实测：索引会吃掉 5 行 × 200 字符 ≈ 1KB，把 Item 条目饿到只剩 1 条；
	 *  而 Item 条目才是「现在在干什么」的直接证据。40/60 分账后两者都有。 */
	const INDEX_CAP = capBytes * 0.4;

	// ① 标题行
	const heading = lines.find((l) => GATE_ACTIVE_HEADING.test(l));
	if (!heading) return truncateUtf8ToBytes(section, capBytes);
	tryPush(heading);

	// 按 `### ` 切块（标题行之后的每个块 = 一个二级小节，如 Task Index / Item NN）
	const blocks: string[] = [];
	let cur: string[] = [];
	for (const line of lines) {
		if (/^###\s+/.test(line) && cur.length > 0) {
			blocks.push(cur.join("\n"));
			cur = [];
		}
		if (GATE_ACTIVE_HEADING.test(line)) continue; // 标题已单独处理
		cur.push(line);
	}
	if (cur.length > 0) blocks.push(cur.join("\n"));

	// 分类（三类块，互斥不重叠）
	const indexBlocks = blocks.filter((b) => GATE_INDEX_HEADING.test(b.split("\n")[0] ?? ""));
	const isIndex = (b: string): boolean => GATE_INDEX_HEADING.test(b.split("\n")[0] ?? "");
	const itemBlocks = blocks.filter((b) => !isIndex(b) && /^###\s+Item\s+\d+/m.test(b));
	const otherBlocks = blocks.filter((b) => !isIndex(b) && !/^###\s+Item\s+\d+/m.test(b));

	// ② Task Index 优先（信息密度最高）—— **按行裁，不整块拒**
	//    实测本仓 Task Index 块 = 9,962 字符 / 15,532 字节，整块塞不进 2KB 预算，
	//    于是整块被 `tryPush` 拒掉 ⇒ 最有用的一屏总览反而一条都进不去。
	//    改为：表头 + 分隔行务必保留，后续数据行逐行加入直到预算用尽。
	//
	//    ⚠ 2026-11-01 口径修正：块内行被截**不算「块未列入」**。
	//    旧实现在这里 `omitted += 1; break`，但该索引块明明已经产出（表头 + 几行数据），
	//    于是 note 说「共 22 块、19 未列入 ⇒ 隐含 3 块已列入」而实际产出 4 块
	//    （实测本仓：index 1 + item 3 + other 0 = 4）。行级截断只影响块内「共 N 行」声明，
	//    行级截断只影响块内自带的「共 N 行，此处 M 行」声明，不污染块级分母/分子。

	let indexBlocksKept = 0;
	for (const b of indexBlocks) {
		const bl = b.split("\n");
		const kept: string[] = [];
		let truncatedHere = false;
		for (const ln of bl) {
			// 表格行的 Summary 列极长（实测单行 400+ 字符）⇒ 逐行裁到 ~150 字符，
			// 牺牲细节换行数：交接者需要知道「有哪几条、大致是什么」，细节可重读文件。
			const line = ln.length > 150 && /^\|/.test(ln) ? `${ln.slice(0, 150)}… |` : ln;
			if (!tryPush(line, INDEX_CAP)) { truncatedHere = true; break; }
			kept.push(line);
		}
		if (kept.length > 0) indexBlocksKept += 1; // 该块**已列入**（至少表头进了）
		if (!truncatedHere) continue;

		// 若数据行被截，补一行如实告知（不静默）
		if (kept.length > 2) {
			const total = bl.filter((l) => /^\|/.test(l)).length;
			const shown = kept.filter((l) => /^\|/.test(l)).length;
			const noteRow = `| … 共 ${total} 行，此处 ${shown} 行 |`;
			if (used + byteLen(noteRow) + 1 <= contentCap) {
				parts.push(noteRow);
				used += byteLen(noteRow) + 1;
			}
		}
	}
	// ③ Item 条目：**每条只取标题 + 前几行**（不是整条）
	//    实测单条 1.4K~11.6K 字符 —— 整条只能塞进 1 条，而交接者要的是「有哪些活」。
	//    只取首段能在同一预算下覆盖 3~8 倍多的条目数。
	let itemsKept = 0;
	for (const b of itemBlocks) {
		if (tryPush(itemHead(b))) itemsKept++;
	}
	// ④ **其它块无条件尝试**（2026-11-01 L4 修正 P0/P1）：
	//    旧实现只在 `itemBlocks.length > 0 && omitted === itemBlocks.length` 时才试，
	//    于是三条真实丢失路径全部静默：
	//      · 无编号条目（`### SBS-RUNS-M1`，真实仓 10,466B，是**活跃任务**）
	//      · 区段内完全无 `###` 子标题（全部正文进一个块）⇒ 正文一条不剩
	//      · `omitted` 混入 index 失败计数 ⇒ `omitted === itemBlocks.length` 判据误判
	//    改为：跳过纯空白块后**总是**尝试。
	let othersKept = 0;
	for (const b of otherBlocks) {
		if (b.trim() === "") continue; // 纯空块不占预算也不计数（否则分母虚增）
		if (tryPush(b.trimEnd())) othersKept++;
	}

	const body = parts.join("\n");
	if (byteLen(body) === 0) return truncateUtf8ToBytes(section, capBytes);
	// 如实声明被省略的块（不静默截断）。
	//
	// 2026-11-01 口径重构：之前用 `omitted` 反推已列入数，而 `omitted` 里混过
	// 索引块**行级**截断的计数 ⇒ note 说「隐含 3 块已列入」而实际产出 4 块
	// （本仓实测：index 1 + item 3 + other 0 = 4）。现改成两边都直接数：
	//   totalBlocks = 所有**非空**块
	//   keptBlocks  = 真正产出的块
	//   omitted     = totalBlocks - keptBlocks（不再靠读时自行加减）
	const nonEmptyOther = otherBlocks.filter((b) => b.trim() !== "").length;
	const totalBlocks = indexBlocks.length + itemBlocks.length + nonEmptyOther;
	const keptBlocks = indexBlocksKept + itemsKept + othersKept;
	const omitted = totalBlocks - keptBlocks;
	if (omitted > 0) {
		const note = `\n…（本区段共 ${totalBlocks} 个块，${omitted} 个因体积未列入；完整内容见文件）`;
		return byteLen(body) + byteLen(note) <= capBytes ? body + note : body;
	}
	return body;
}

/** 按 UTF-8 字符边界截断（**先扣 marker 字节**，不会超限）。
 *  也被 `hydrate.ts` 的 RecentWork 回退路径使用——旧实现（hydrate 自带版）先 slice
 *  再追加 marker，实测超限 14~16 字节。`buildRecentWorkExcerpt` 的兑底：把区段按字节截断。
 *  与 `recent-calls.ts::truncateUtf8` **同语义**（按 UTF-8 字符边界回退，不破字）。
 *  本地实现避免 runtime 层反向依赖 tool 层（同 `wake.ts` 与 `supervision-runtime.ts` 的双写先例）。 */
export function truncateUtf8ToBytes(s: string, maxBytes: number): string {
	const bytes = new TextEncoder().encode(s);
	if (bytes.length <= maxBytes) return s;
	const marker = "…";
	const markerBytes = new TextEncoder().encode(marker).length;
	let end = Math.max(0, maxBytes - markerBytes);
	while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
	const body = new TextDecoder().decode(bytes.slice(0, end));
	return maxBytes - new TextEncoder().encode(body).length >= markerBytes ? body + marker : body;
}
