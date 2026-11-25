/**
 * 探针：验证「角色 frontmatter 的 tools: 豁免第三方 CLI」在**真实角色文件**上的判定。
 * 不 spawn 任何 CLI —— 只算判定，证明两条分支可区分。
 *
 * 两条分支的 effectiveTools 必须分别按各自的输入计算，不能复用同一份：
 *   ① 仅角色声明：resolveEffectiveTools(roleTools, undefined)
 *   ② 调用方显式：resolveEffectiveTools(roleTools, callerTools)
 */
import { discoverAgents } from "./index.ts";
import { resolveEffectiveTools, toolsSupportedForBackend } from "./runner-argv.ts";

const agents = discoverAgents();
const rows: string[] = [];
let fail = 0;

for (const a of agents) {
	const roleTools = a.tools;
	// ① 仅角色声明：caller 未传 tools
	const effRoleOnly = resolveEffectiveTools(roleTools, undefined, a.name);
	const okRoleOnly = toolsSupportedForBackend("cli:codex", effRoleOnly, undefined);
	// ② 调用方显式传 tools（用一份必然非空且合法的列表）
	const callerTools = ["read"];
	const effExplicit = resolveEffectiveTools(roleTools, callerTools, a.name);
	const okExplicit = toolsSupportedForBackend("cli:codex", effExplicit, callerTools);

	const declared = roleTools === undefined ? "（无声明）" : `${roleTools.length} 个`;
	rows.push(
		`${a.name.padEnd(15)} tools=${declared.padEnd(10)} ①仅角色→cli:codex ${okRoleOnly ? "放行" : "拒绝"} | ②调用方显式→cli:codex ${okExplicit ? "放行" : "拒绝"}`,
	);

	// ① 是本次改动的核心断言：任何角色（含声明了 tools 的）都必须能走 cli:*
	if (okRoleOnly !== true) {
		console.error(`❌ ${a.name}: 分支①（仅角色声明）应放行，实际 ${okRoleOnly}`);
		fail++;
	}
	// ② 调用方显式策略一律拒
	if (okExplicit !== false) {
		console.error(`❌ ${a.name}: 分支②（调用方显式 tools）应拒绝，实际 ${okExplicit}`);
		fail++;
	}
}

console.log(rows.join("\n"));
console.log("");
console.log(`角色数 ${agents.length}｜判据失败 ${fail}`);
if (fail > 0) process.exit(1);
console.log("PASS：所有角色的 frontmatter tools: 均豁免 cli:*；调用方显式策略仍一律拒。");
