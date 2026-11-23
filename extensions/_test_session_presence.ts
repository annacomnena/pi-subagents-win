/**
 * `session-presence` 回归网（2026-11-23，step-0 第 1 步：只读观测）。
 *
 * ## 这套要防的具体错误
 *
 * ① **多值被压成单值**（这条是既有代码的真实缺陷）：
 *    `runtime-host/server.ts::scanSessionCommandLines()` 返回 `Map<sid, pid>`，
 *    同一会话 2 个进程时**后写覆盖先写** ⇒ 只看到一个 pid ⇒
 *    **观测能力本身把双重占用抹平了**（这也是以前没人发现双控的原因）。
 *    ⇒ 必须断言 `processCount === 2`，而不是「至少看到 1 个」。
 *
 * ② **pid 复用被算成两个实例**：同 pid + 不同 startTicks = 两个实例；
 *    同 pid + 同 startTicks = **同一个实例**（重复行不能算）。step-0 实验 E 证明
 *    `CreationDate.Ticks` 逐位稳定可用。
 *
 * ③ **「读不到」被当成「没有」**（R-11 / AGENTS §0）：
 *    枚举失败 ⇒ 必须 `readable:false`，**不得**返回空 map 让调用方说"无占用"。
 *
 * ④ **命令行解析太窄**：`--session <path>` 与裸 `<...>.jsonl` 两种形态都要认；
 *    `--session-id` 形态（无文件名）要能靠 UUID 认出来。
 *
 * ⑤ **文案不得越界**：`multiWriter` 只证明「有 N 个进程连着」，
 *    **不证明**「已经双写了」（那需要 prompt）。文案里必须写清。
 */
import assert from "node:assert/strict";

const m = await import("./runtime/session-presence.ts");

let pass = 0;
let fail = 0;
const check = (name: string, fn: () => void): void => {
	try {
		fn();
		pass++;
		console.log(`  ok ${pass} - ${name}`);
	} catch (e) {
		fail++;
		console.log(`  NOT OK ${pass + fail} - ${name}`);
		console.log(`    ${e instanceof Error ? e.message : String(e)}`);
	}
};

const SID_A = "01a1aaaa-0000-7000-8000-00000000000a";
const SID_B = "01a1bbbb-0000-7000-8000-00000000000b";

/**
 * 走**真实聚合实现**（`collectPresenceRows`），不复制逻辑。
 *
 * 为什么必须这样 —— 第一版我用自造的 buildMap 复制了聚合逻辑，结果：
 * ```
 * 变异 2（aggregation 退回单值/后写覆盖）→ 8 passed 0 failed   ← 假绿
 * 变异 3（不可读返回空 map 不设哨兵）    → 8 passed 0 failed   ← 假绿
 * ```
 * 因为测试测的是**它自己抄的那份**，不是实现。这正是 AGENTS R-4 的教训
 *（「断言必须经过真实入口」）。改成调真实函数后两个变异都能红（见 commit）。
 */
const buildMap = (lines: string[], via: "win32-cim" | "ps" = "win32-cim"): Map<string, unknown> => {
	const out = new Map<string, unknown>();
	// 每行形如 `pid=1001 ticks=111 | <commandline>`
	const text = lines
		.map((l) => {
			const pid = Number.parseInt((/pid=(\d+)/.exec(l) ?? ["", "0"])[1], 10);
			const ticks = (/ticks=([0-9]+)/.exec(l) ?? ["", "0"])[1];
			const cmd = l.replace(/^.*?\|\s*/, "");
			return `${pid}|${ticks}|${cmd}`;
		})
		.join(String.fromCharCode(10));
	const parseRow = (line: string): { pid: number; ticks: string | null; cmd: string } | null => {
		const a = line.indexOf("|");
		const b = line.indexOf("|", a + 1);
		if (a <= 0 || b <= 0) return null;
		const pid = Number.parseInt(line.slice(0, a).trim(), 10);
		if (!Number.isInteger(pid) || pid <= 0) return null;
		const ticks = line.slice(a + 1, b).trim();
		return { pid, ticks: ticks === "0" ? null : ticks, cmd: line.slice(b + 1) };
	};
	m.collectPresenceRows(out as never, text, via, parseRow);
	return out;
};

// ── ① 多值不被压成单值 ───────────────────────────────────────
check("① 同一会话 2 个不同进程 ⇒ processCount=2 且 multiWriter=true（既有单值 Map 的缺陷）", () => {
	const map = buildMap([
		`cmd ... --session C:\\tmp\\x_${SID_A}.jsonl pid=1001 ticks=111`,
		`cmd ... --session C:\\tmp\\x_${SID_A}.jsonl pid=1002 ticks=222`,
	]);
	const p = map.get(SID_A);
	assert.ok(p, "会话 A 应在 map 里");
	assert.equal(p.processCount, 2, `应 2 个实例（若是 1 ⇒ 多值被压成单值 = 原缺陷）`);
	assert.equal(p.multiWriter, true);
	assert.equal(p.instances.length, 2);
});

// ── ② pid 复用：同 pid 不同 ticks = 2 实例；同 pid 同 ticks = 1 ──
check("② 同 pid 不同 startTicks ⇒ 2 实例（求破 pid 复用）；同 pid 同 ticks ⇒ 1 实例", () => {
	assert.equal(m.distinctInstanceCount([{ pid: 7, startTicks: "aaa" }, { pid: 7, startTicks: "bbb" }]), 2, "同 pid 不同启动时刻 = 两个实例");
	assert.equal(m.distinctInstanceCount([{ pid: 7, startTicks: "aaa" }, { pid: 7, startTicks: "aaa" }]), 1, "同 pid 同启动时刻 = 同一实例（重复行不得算两个）");
	assert.equal(m.distinctInstanceCount([{ pid: 7, startTicks: null }, { pid: 7, startTicks: null }]), 1, "都取不到身份时应保守算 1 个");
});

// ── ③ 单进程 ⇒ 不误报 ────────────────────────────────────────
check("③ 单进程会话 ⇒ multiWriter=false（不得误报）", () => {
	const map = buildMap([`cmd --session C:\\tmp\\x_${SID_A}.jsonl pid=1001 ticks=111`]);
	assert.equal(map.get(SID_A)?.processCount, 1);
	assert.equal(map.get(SID_A)?.multiWriter, false);
});

// ── ④ 命令行解析两种形态 ─────────────────────────────────────
check("④ 解析：`--session <path>` / `--session \"<path>\"` / 裸 .jsonl 三种形态都要认出", () => {
	assert.equal(m.sessionFileFromCommandLine(`--session C:\\a\\b_${SID_A}.jsonl`), `C:\\a\\b_${SID_A}.jsonl`);
	assert.equal(m.sessionFileFromCommandLine(`--session "C:\\a b\\c_${SID_A}.jsonl"`), `C:\\a b\\c_${SID_A}.jsonl`);
	assert.equal(m.sessionFileFromCommandLine(`node cli.js C:\\a\\b_${SID_A}.jsonl --model x`), `C:\\a\\b_${SID_A}.jsonl`);
	assert.equal(m.sessionFileFromCommandLine(`--no-session`), null, "无会话不得不算命中");
	assert.equal(m.sessionIdFromCommandLine(`--session C:\\a\\b_${SID_A}.jsonl`, ), SID_A);
	assert.equal(m.sessionIdFromCommandLine(`--session-id ${SID_B}`), SID_B, "--session-id 形态也要能认出 UUID");
});

// ── ⑤ 不可读 ≠ 没有 ─────────────────────────────────────────
check("⑤ 枚举失败 ⇒ readable:false + 文案明写『不可读 ≠ 无占用』（R-11）", () => {
	const empty = new Map<string, never>();
	empty.set("", { sessionId: "", sessionFile: null, instances: [], processCount: 0, multiWriter: false, readable: false, via: "unavailable" } as never);
	const lines = m.presenceLines(empty as never);
	assert.equal(lines.length, 1);
	assert.ok(lines[0].includes("不可读"), `文案必须说不可读，实际: ${lines[0]}`);
	assert.ok(lines[0].includes("不得"), `文案必须禁止据此判"没有双控"，实际: ${lines[0]}`);
});

// ── ⑥ 空集（枚举成功但真的没有）文案要区分 ──────────────────
check("⑥ 枚举成功但 0 会话 ⇒ 文案说「枚举成功，确实为空」（与 ⑤ 区分）", () => {
	const lines = m.presenceLines(new Map());
	assert.ok(lines[0].includes("枚举成功"), `必须与"不可读"区分，实际: ${lines[0]}`);
});

// ── ⑦ 文案不得越界：multiWriter ≠ 已双写 ────────────────────
check("⑦ 多重占用文案必须写清「Pi 不拦、父链会分叉」而不宣称已双写", () => {
	const map = buildMap([
		`--session C:\\tmp\\x_${SID_A}.jsonl pid=1 ticks=1`,
		`--session C:\\tmp\\x_${SID_A}.jsonl pid=2 ticks=2`,
	]);
	const lines = m.presenceLines(map as never);
	const txt = lines.join("\n");
	assert.ok(txt.includes("双写风险"), `应写「风险」而非「已发生」，实际:\n${txt}`);
	assert.ok(!txt.includes("已经双写"), `不得宣称已双写，实际:\n${txt}`);
});

// ── ⑧ listMultiWriterSessions 只返 multi ────────────────────
check("⑧ listMultiWriterSessions 只返 multiWriter 的，跳过单进程与哨兵", () => {
	const map = buildMap([
		`--session C:\\tmp\\x_${SID_A}.jsonl pid=1 ticks=1`,
		`--session C:\\tmp\\x_${SID_A}.jsonl pid=2 ticks=2`,
		`--session C:\\tmp\\x_${SID_B}.jsonl pid=3 ticks=3`,
	]);
	const multi = m.listMultiWriterSessions(map as never);
	assert.equal(multi.length, 1, `应只有 A 是 multi，实际 ${multi.length}`);
	assert.equal(multi[0].sessionId, SID_A);
});

// ── ⑨ 真实聚合路径：同一行集喂 collectPresenceRows ⇒ 多值必须保留 ──
check("⑨ 真实 collectPresenceRows：2 行同会话 ⇒ processCount=2（不是后写覆盖）", () => {
  const map = buildMap([
    `pid=1001 ticks=111 | node cli.js --session C:\\tmp\\x_${SID_A}.jsonl`,
    `pid=1002 ticks=222 | node cli.js --session C:\\tmp\\x_${SID_A}.jsonl`,
  ]);
  const p = map.get(SID_A) as { processCount: number; multiWriter: boolean; instances: unknown[] };
  assert.equal(p.processCount, 2, "真实聚合应保留 2 个实例");
  assert.equal(p.multiWriter, true);
  assert.equal(p.instances.length, 2);
});

// ── ⑩ 哨兵键必须是空串（presenceLines 靠它区分"读不到"）──
check("⑩ readable:false 的哨兵键必须是空串，且 presenceLines 认它（结构与文案契约）", () => {
  const withSentinel = new Map<string, unknown>();
  withSentinel.set("", { sessionId: "", sessionFile: null, instances: [], processCount: 0, multiWriter: false, readable: false, via: "unavailable" });
  const lines = m.presenceLines(withSentinel as never);
  assert.ok(lines[0].includes("不可读"), `哨兵键空串必须被认作不可读，实际: ${lines[0]}`);
  assert.equal(lines.length, 1, "不可读时不得再输出别的行（避免把 0 当成读数）");
});

console.log(`\nsession-presence: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
