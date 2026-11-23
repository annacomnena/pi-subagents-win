/**
 * 端到端探针：code-reviewer（声明了 9 个 tools）+ cli:codex，**不传调用方 tools**。
 * 改动前必失败（--tools allowlist is not supported），改动后必须真的 spawn 出 codex。
 *
 * 对照：同一角色同一模型 + 调用方显式 tools ⇒ 必须仍然快速失败（不 spawn）。
 */
import { discoverAgents, runWithFallback } from "./index.ts";

const agents = discoverAgents();
const cr = agents.find((a) => a.name === "code-reviewer");
if (!cr) {
	console.error("❌ 找不到 code-reviewer 角色");
	process.exit(1);
}
console.log(`code-reviewer frontmatter tools: ${cr.tools?.length ?? 0} 个 → ${(cr.tools ?? []).join(",")}`);
console.log("");

// ── 分支②（负控，先跑，因为它不 spawn）：调用方显式 tools + cli:codex ──
const neg = await runWithFallback(
	cr,
	"回答 1+1。不要读写文件。",
	undefined,
	"cli:codex",
	60_000,
	undefined,
	undefined,
	{ tools: ["read"] },
);
console.log(`【负控】调用方显式 tools + cli:codex → status=${neg.status}`);
console.log(`        error=${(neg.error ?? "(none)").slice(0, 160)}`);
const negOk = neg.status === "failed" && /caller-declared tools cannot be enforced/.test(neg.error ?? "");
console.log(`        判据（必须快速失败且带新文案）：${negOk ? "PASS" : "FAIL"}`);
console.log("");

// ── 分支①（正控）：不传 tools ⇒ 应真的 spawn codex ──
console.log("【正控】不传 tools + cli:codex → 正在 spawn 真实 codex CLI（最长 150s）...");
const pos = await runWithFallback(
	cr,
	"用一句话回答：你是谁（哪个 CLI/模型）？然后算 6+7。不要读写任何文件，不要跑构建。",
	undefined,
	"cli:codex",
	150_000,
	undefined,
	undefined,
	{},
);
console.log(`        status=${pos.status}`);
console.log(`        model=${pos.model ?? "(none)"} requested=${pos.requestedModel ?? "(none)"}`);
console.log(`        error=${(pos.error ?? "(none)").slice(0, 200)}`);
console.log(`        text=${(pos.text ?? "").slice(0, 300)}`);
const posOk = pos.status === "completed" && (pos.text ?? "").trim().length > 0;
console.log(`        判据（必须 completed 且有文本）：${posOk ? "PASS" : "FAIL"}`);
console.log("");
console.log(`总判定：${negOk && posOk ? "PASS" : "FAIL"}`);
process.exit(negOk && posOk ? 0 : 1);
