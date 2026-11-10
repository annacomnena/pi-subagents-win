/**
 * `evaluateFusionGate` 回归网（2026-11-09）。
 *
 * 门槛口径（gen14 裁定）：**最近 5 个 qualified run 中 ≥4 个 `repair: null`**
 *   qualified = 排除 cancelled/abandoned/未进融合阶段的 run；缺 `repair` 字段 ⇒ 剔除（不当 clean）
 *   分母不足 5 ⇒ `insufficient-sample`（**未达但不阻断**，不是失败）
 *
 * 本套件锁 5 条实现约束（每条对应 gen14 的一条批复）：
 *   ① createdAt 并列 ⇒ 必须有 runId 次级键（否则判决依赖 V8 排序实现）
 *   ② opts 边界有定义（window<1 / minClean<1 / minClean>window 收敛到缺省/上限，不静默）
 *   ③ not-yet 分支线上覆盖率 0 ⇒ 只能靠夹具构造
 *   ④ repair 语义是「六节齐不齐」（格式门），detail 文案不得写「质量」
 *   ⑤ 容错口径：解析失败跳过 / fusion 缺 ⇒ 剔除 / runsDir 不存在 ⇒ insufficient-sample 不抛
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { evaluateFusionGate, FUSION_GATE_DEFAULT_WINDOW, FUSION_GATE_DEFAULT_MIN_CLEAN } =
	await import("./trace-fusion/gate.ts");

let pass = 0;
const ok = (n: string) => { pass++; console.log(`  ✅ ${n}`); };

/** 造一个 run 目录（meta.json 可控）。 */
function mkRun(root: string, runId: string, meta: Record<string, unknown> | null): void {
	const d = join(root, runId);
	mkdirSync(d, { recursive: true });
	if (meta === null) { writeFileSync(join(d, "meta.json"), "{broken", "utf8"); return; }
	writeFileSync(join(d, "meta.json"), JSON.stringify(meta), "utf8");
}
const ok_ = (runId: string, createdAt: string, repair: unknown = null) => ({
	runId, status: "completed", mode: "diagnose", createdAt,
	fusion: { status: "completed", ...(repair === "MISSING" ? {} : { repair }) },
});

// ── ① 基线：5 个 qualified 全 clean ⇒ pass ──
{
	const root = mkdtempSync(join(tmpdir(), "gate1-"));
	for (let i = 0; i < 5; i++) mkRun(root, `tfl-2026110${i}-000000-aaaa`, ok_(`tfl-2026110${i}-000000-aaaa`, `2026-11-0${i + 1}T00:00:00.000Z`));
	const r = evaluateFusionGate(root);
	assert.equal(r.verdict, "pass");
	assert.equal((r as { clean: number }).clean, 5);
	assert.equal((r as { examined: number }).examined, 5);
	ok("① 基线 5/5 clean ⇒ pass");
	rmSync(root, { recursive: true, force: true });
}

// ── ② 缺 repair 字段 ⇒ **剔除分母，不得当 clean**（gen14 实测 c7e2 就是这形）──
// 这条最关键：误当 clean 会让「窗口 6」从 insufficient-sample 变成 pass，口径就错了。
{
	const root = mkdtempSync(join(tmpdir(), "gate2-"));
	// 6 个 completed+fusion.completed+diagnose，但**只有 5 个有 repair 字段**
	for (let i = 0; i < 5; i++) mkRun(root, `tfl-2026110${i}-000000-bbbb`, ok_(`tfl-2026110${i}-000000-bbbb`, `2026-11-0${i + 1}T00:00:00.000Z`));
	mkRun(root, "tfl-20261103-192444-c7e2", {
		runId: "tfl-20261103-192444-c7e2", status: "completed", mode: "diagnose",
		createdAt: "2026-11-03T11:24:44.717Z", fusion: { status: "completed" }, // ← 无 repair 字段
	});
	const r6 = evaluateFusionGate(root, { window: 6, minClean: 5 });
	assert.equal(r6.verdict, "insufficient-sample", `缺 repair 字段必须剔除分母 ⇒ examined=5 < 6（实际 ${JSON.stringify(r6)}）`);
	assert.equal((r6 as { examined: number }).examined, 5, "examined 必须是 5（不是 6）");
	assert.equal((r6 as { clean: number }).clean, 5, "clean 必须是 5（缺字段那个不算 clean）");
	ok("② ★缺 repair 字段 ⇒ 剔除分母（不得当 clean）");
	rmSync(root, { recursive: true, force: true });
}

// ── ③ not-yet 分支（线上覆盖率 0，只能靠夹具）──
{
	const root = mkdtempSync(join(tmpdir(), "gate3-"));
	// 5 个 qualified，但 2 个 repair 非 null ⇒ clean=3 < 4 ⇒ not-yet
	for (let i = 0; i < 3; i++) mkRun(root, `tfl-2026110${i}-000000-cccc`, ok_(`tfl-2026110${i}-000000-cccc`, `2026-11-0${i + 1}T00:00:00.000Z`, null));
	for (let i = 3; i < 5; i++) mkRun(root, `tfl-2026110${i}-000000-cccc`, ok_(`tfl-2026110${i}-000000-cccc`, `2026-11-0${i + 1}T00:00:00.000Z`, { status: "failed" }));
	const r = evaluateFusionGate(root);
	assert.equal(r.verdict, "not-yet");
	assert.equal((r as { clean: number }).clean, 3);
	assert.equal((r as { needed: number }).needed, 4);
	ok("③ ★not-yet 分支（线上覆盖率 0，夹具构造）");
	rmSync(root, { recursive: true, force: true });
}

// ── ④ createdAt 并列 + runId 次级键（gen14 约束 1：判决不得依赖排序实现）──
// 夹具：两个 qualified 并列 createdAt，一个 clean 一个 non-clean，窗口=1。
// 若排序不稳定，判决会在 pass/not-yet 之间翻转；有 runId 倒序则**确定**。
{
	const root = mkdtempSync(join(tmpdir(), "gate4-"));
	const SAME = "2026-11-04T03:17:28.837Z";
	// runId 字典序更大的那个是 non-clean ⇒ 倒序时应排前面 ⇒ clean=0 ⇒ not-yet（确定性）
	mkRun(root, "tfl-20261104-034440-repair", {
		runId: "tfl-20261104-034440-repair", status: "completed", mode: "diagnose", createdAt: SAME,
		fusion: { status: "completed", repair: { status: "failed" } },
	});
	mkRun(root, "tfl-20261104-111728-8618", {
		runId: "tfl-20261104-111728-8618", status: "completed", mode: "diagnose", createdAt: SAME,
		fusion: { status: "completed", repair: null },
	});
	// 窗口 1 ⇒ 只取排序第一；重复跑 5 次断言**每次结果相同**（确定性）
	const results = [];
	for (let i = 0; i < 5; i++) {
		const r = evaluateFusionGate(root, { window: 1, minClean: 1 });
		results.push(`${r.verdict}/${(r as { clean?: number }).clean}`);
	}
	assert.equal(new Set(results).size, 1, `并列 createdAt 时判决必须确定（实际多次结果不同：${results.join(" | ")}）`);
	// 具体期望：runId 倒序 ⇒ "tfl-20261104-111728-8618" > "tfl-20261104-034440-repair"（字典序）
	// 所以排在前面的是 8618（clean）⇒ clean=1 ⇒ pass
	assert.equal(results[0], "pass/1", `应按 runId 倒序取 8618(clean)（实际 ${results[0]}）`);
	ok("④ ★createdAt 并列 ⇒ runId 次级键让判决确定（不依赖 V8 排序实现）");
	rmSync(root, { recursive: true, force: true });
}

// ── ⑤ opts 边界收敛（不静默扭曲）──
{
	const root = mkdtempSync(join(tmpdir(), "gate5-"));
	for (let i = 0; i < 5; i++) mkRun(root, `tfl-2026110${i}-000000-dddd`, ok_(`tfl-2026110${i}-000000-dddd`, `2026-11-0${i + 1}T00:00:00.000Z`));
	// window<1 / 非整数 ⇒ 缺省 5
	for (const bad of [0, -3, 2.5, Number.NaN]) {
		const r = evaluateFusionGate(root, { window: bad });
		assert.equal((r as { window: number }).window, FUSION_GATE_DEFAULT_WINDOW, `window=${bad} 应收敛到缺省（实际 ${(r as { window: number }).window}）`);
	}
	// minClean<1 ⇒ 缺省 4
	for (const bad of [0, -1]) {
		const r = evaluateFusionGate(root, { minClean: bad });
		assert.equal(r.verdict, "pass", `minClean=${bad} 收敛到 4 ⇒ 5/5 clean 应 pass`);
	}
	// minClean>window ⇒ 收敛到 window（不造「恒 not-yet 死档」）
	const r2 = evaluateFusionGate(root, { window: 5, minClean: 9 });
	assert.equal(r2.verdict, "pass", `minClean=9,window=5 ⇒ 收敛到 5 ⇒ 5/5 clean 应 pass（实际 ${r2.verdict}）`);
	assert.notEqual(evaluateFusionGate(root, { window: 0, minClean: 0 }).verdict, "not-yet", "window=0 收敛后不应落 not-yet");
	ok("⑤ opts 非法值收敛到缺省/上限（不造死档、不静默）");
	rmSync(root, { recursive: true, force: true });
}

// ── ⑥ 容错：解析失败跳过 / runsDir 不存在不抛 ──
{
	const root = mkdtempSync(join(tmpdir(), "gate6-"));
	for (let i = 0; i < 5; i++) mkRun(root, `tfl-2026110${i}-000000-eeee`, ok_(`tfl-2026110${i}-000000-eeee`, `2026-11-0${i + 1}T00:00:00.000Z`));
	mkRun(root, "tfl-broken-xxxxxx", null); // 坏 meta
	const r = evaluateFusionGate(root);
	assert.equal(r.verdict, "pass", `坏 meta 应被跳过、不影响判定（实际 ${r.verdict}）`);
	assert.equal((r as { examined: number }).examined, 5, "坏 meta 不得计入 examined");
	ok("⑥ 单条 meta 解析失败 ⇒ 跳过该 run，不中断");

	const missing = join(tmpdir(), "gate-does-not-exist-xyz");
	const r2 = evaluateFusionGate(missing);
	assert.equal(r2.verdict, "insufficient-sample");
	assert.equal((r2 as { examined: number }).examined, 0);
	assert.equal((r2 as { clean: number }).clean, 0, "insufficient-sample 也必须带 clean（g14 约束 5）");
	ok("⑥ runsDir 不存在 ⇒ insufficient-sample 不抛，且带 clean 读数");
	rmSync(root, { recursive: true, force: true });
}

// ── ⑥b 缺 fusion.status = 不合格（补上「status 筛」的独立路径）──
// 为什么另立一条：变异 D（去掉 status 筛）在本套件里居然仍 10/10 绿 ——
// 因为那个夹具的 cancelled 项本来就没有 fusion.status ⇒ 被「fusionStatus 必须 completed」挡住了。
// 一个行为有两条路径都能达成时，单独回退任何一条都不会红（R-22 第 5 条教训）。
// 本组只走 status 一条路：**cancelled 但 fusion.status=completed**。
{
	const root = mkdtempSync(join(tmpdir(), "gate6b-"));
	for (let i = 0; i < 5; i++) mkRun(root, `tfl-2026110${i}-000000-ffff`, ok_(`tfl-2026110${i}-000000-ffff`, `2026-11-0${i + 1}T00:00:00.000Z`));
	mkRun(root, "tfl-20261105-133213-595c", {
		runId: "tfl-20261105-133213-595c", status: "cancelled", mode: "diagnose",
		createdAt: "2026-11-05T05:32:13.619Z",
		fusion: { status: "completed", repair: null },  // ← 只有 status 这一条能挡它
	});
	const r = evaluateFusionGate(root, { window: 6, minClean: 6 });
	assert.equal((r as { examined: number }).examined, 5, `cancelled 即使 fusion.completed 也不得进分母（实际 examined=${(r as { examined: number }).examined}）`);
	ok("⑥b ★status 筛独立生效（cancelled + fusion.completed 仍被剔除）");
	rmSync(root, { recursive: true, force: true });
}

// ── ⑦ cancelled/abandoned 不进分母（旧「连续」口径的失败原因）──
{
	const root = mkdtempSync(join(tmpdir(), "gate7-"));
	for (let i = 0; i < 5; i++) mkRun(root, `tfl-2026110${i}-000000-ffff`, ok_(`tfl-2026110${i}-000000-ffff`, `2026-11-0${i + 1}T00:00:00.000Z`));
	// 最新两个是 cancelled / abandoned（且无 fusion）——按「连续」口径会把门槛清零
	mkRun(root, "tfl-20261105-133213-595c", { runId: "tfl-20261105-133213-595c", status: "cancelled", mode: "diagnose", createdAt: "2026-11-05T05:32:13.619Z" });
	mkRun(root, "tfl-20261105-153551-58ac", { runId: "tfl-20261105-153551-58ac", status: "abandoned", mode: "diagnose", createdAt: "2026-11-05T07:35:51.449Z" });
	const r = evaluateFusionGate(root);
	assert.equal(r.verdict, "pass", `cancelled/abandoned 不得进分母（实际 ${r.verdict}）`);
	assert.equal((r as { examined: number }).examined, 5);
	ok("⑦ cancelled/abandoned 不进分母（这是旧「连续」口径不可达成的原因）");
  rmSync(root, { recursive: true, force: true });
}

// ── ⑧ detail 文案口径（gen14 约束 4：不得写「质量」）──
{
  const root = mkdtempSync(join(tmpdir(), "gate8-"));
  for (let i = 0; i < 5; i++) mkRun(root, `tfl-2026110${i}-000000-gggg`, ok_(`tfl-2026110${i}-000000-gggg`, `2026-11-0${i + 1}T00:00:00.000Z`));
  const r = evaluateFusionGate(root);
  assert.ok(r.detail.includes("首轮六节齐全"), `detail 必须用「首轮六节齐全」口径（实际：${r.detail}）`);
  assert.ok(!r.detail.includes("质量"), `detail 不得写「质量」（repair 是格式门，不是质量指标）（实际：${r.detail}）`);
  ok("⑧ detail 写「首轮六节齐全」而非「融合质量」");
  rmSync(root, { recursive: true, force: true });
}

// ── ⑧b 容错：runsDir 不存在时**不抛**（变异 F 的判别力靠这条）──
{
	const missing = join(tmpdir(), "gate-does-not-exist-xyz");
	let threw = false;
	try { evaluateFusionGate(missing); } catch { threw = true; }
	assert.equal(threw, false, "runsDir 不存在必须不抛（返回 insufficient-sample）（实际抛了）");
	ok("⑧b ★runsDir 缺失不抛");
}

// ── ⑨ 真机读数锁定（防止将来跑偏）──
{
  const real = join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".pi", "agent", "trace-fusion-runs");
  const r = evaluateFusionGate(real);
  assert.ok(["pass", "not-yet", "insufficient-sample"].includes(r.verdict), `真机判决必须是合法三态（实际 ${r.verdict}）`);
  console.log(`     （真机读数：${r.verdict} / examined=${(r as { examined: number }).examined} / clean=${(r as { clean: number }).clean}）`);
  ok("⑨ 真机目录可判定（不抛）");
}

console.log(`\n_test_trace_fusion_gate: ${pass} checks passed`);
