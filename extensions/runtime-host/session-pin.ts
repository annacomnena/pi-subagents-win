/**
 * runtime-host/session-pin.ts — /v1/sessions 置顶数据源（会话 rail 三件套 L3，host 侧 1/3）
 *
 * 纯读、never-throw、无 Pi API（红线同 server.ts）：
 *   - isMaster：sessionId === 全局 master attachment 的 sessionId（registry 现有函数
 *     readAttachment(masterAddress())，与 /v1/sessions 的 masterProtected 护栏同源）；
 *   - isScopeMaster：sessionId 命中某 scope attachment（agent://master_local_<scope>），且
 *     该 scope 可逆解码回 basename == 会话 cwd 的 basename（scope.ts decodeScopeSegment
 *     只读调用；`-worktree` 后缀先剥再解码，与 localMasterScope 编码约定一致；
 *     解码失败 → 不标该会话）。v1 同名跨盘/跨 worktree 碰撞为已知局限（scope.ts 头注）：
 *     只做 basename 级比对，不引入 toplevel 全路径比对。
 *   - cwd 归一与 GUI workspaceGroup.normalizeCwdKey 同式（`\`→`/`、去尾 `/`、Windows
 *     盘符/UNC 全小写）——两端「同一仓库」语义对齐；basename 比对 Windows 侧大小写
 *     不敏感、POSIX 精确。
 * 字段 additive：仅当 true 时挂出（与 masterProtected 同形），缺省 = 非置顶。
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { masterAddress } from "../runtime/address.ts";
import { defaultRuntimeDir } from "../runtime/journal.ts";
import { readAttachment } from "../runtime/registry.ts";
import { decodeScopeSegment } from "../runtime/scope.ts";

/** scope 地址前缀（localMasterAddress 约定：agent://master_local_<scope>，单段无 `/`）。 */
const SCOPE_PREFIX = "agent://master_local_";
/** worktree 后缀（localMasterScope 追加在编码后 base 上；解码时先剥再还原 basename）。 */
const WORKTREE_SUFFIX = "-worktree";
/** 编码保留前缀（scope.ts 契约值：落在该命名空间的一律 hex 编码）；据此判定「编码形」。 */
const ENCODED_PREFIX = "e39";

/** 输入（sessionId + cwd 足够；其余字段不参与置顶判定）。 */
export interface PinSessionInput {
	sessionId: string;
	cwd: string | null;
}

/** 置顶标记（均 additive：仅 true 时挂出）。 */
export interface SessionPinFlags {
	/** sessionId === 全局 master attachment 的 sessionId（与 masterProtected 同源）。 */
	isMaster?: true;
	/** sessionId 为某 scope attachment 的 owner，且该 scope 解码 basename 与会话 cwd basename 一致。 */
	isScopeMaster?: true;
}

/**
 * sessionId → 置顶标记（Map 仅含至少一个标记的会话；无标记的会话不出现在 Map 中）。
 * 纯读 never-throw：registry 目录缺失/坏文件/非 scope 地址/解码失败 → 对应维度不标。
 * `runtimeDir` 缺省 defaultRuntimeDir()（env PI_RUNTIME_DIR 覆盖，测试隔离；与
 * readAttachment 自身的路径解析同源）。
 */
export function computeSessionPinFlags(
	sessions: readonly PinSessionInput[],
	opts: { runtimeDir?: string } = {},
): Map<string, SessionPinFlags> {
	const out = new Map<string, SessionPinFlags>();

	// 全局 master（registry 现有函数只读；与 masterProtected 护栏同源）
	let globalSid: string | null = null;
	try {
		globalSid = readAttachment(masterAddress())?.sessionId ?? null;
	} catch {
		globalSid = null;
	}

	// scope attachments（registry/attachments 目录只读枚举；坏文件/非 scope 地址/解码失败 → skip）
	// 以 owner sessionId 建索引：避免在每条会话上重扫所有 scope attachment（原形为 O(sessions×scopes)）。
	const scopeAtts = new Map<string, Array<{ base: string; baseLower: string }>>();
	try {
		const dir = join(opts.runtimeDir ?? defaultRuntimeDir(), "registry", "attachments");
		for (const f of readdirSync(dir)) {
			if (!f.endsWith(".json")) continue;
			let raw: unknown;
			try {
				raw = JSON.parse(readFileSync(join(dir, f), "utf8"));
			} catch {
				continue;
			}
			const rec = raw as { agentAddress?: unknown; sessionId?: unknown };
			if (typeof rec.agentAddress !== "string" || !rec.agentAddress.startsWith(SCOPE_PREFIX)) continue;
			if (typeof rec.sessionId !== "string" || rec.sessionId.length === 0) continue;
			const encoded = rec.agentAddress.slice(SCOPE_PREFIX.length);
			// localMasterAddress 的 scope 是单个安全段；坏/伪造地址不可作为 scope attachment。
			if (!/^[A-Za-z0-9._-]+$/.test(encoded)) continue;
			const segment = encoded.endsWith(WORKTREE_SUFFIX) ? encoded.slice(0, -WORKTREE_SUFFIX.length) : encoded;
			const decoded = decodeScopeBase(segment);
			if (decoded === null) continue; // 解码失败 → 不标该会话
			const atts = scopeAtts.get(rec.sessionId) ?? [];
			atts.push({ base: decoded, baseLower: decoded.toLowerCase() });
			scopeAtts.set(rec.sessionId, atts);
		}
	} catch {
		/* 目录缺失/不可读 → 无 scope master（never-throw） */
	}

	for (const s of sessions) {
		const flags: SessionPinFlags = {};
		if (globalSid !== null && s.sessionId === globalSid) flags.isMaster = true;
		const cb = sessionCwdBase(s.cwd);
		const scopeHit =
			cb !== null &&
			(scopeAtts.get(s.sessionId) ?? []).some((a) => (cb.win ? a.baseLower === cb.baseLower : a.base === cb.base));
		if (scopeHit) flags.isScopeMaster = true;
		if (flags.isMaster !== undefined || flags.isScopeMaster !== undefined) out.set(s.sessionId, flags);
	}
	return out;
}

/**
 * scope 单段可逆解码（scope.ts decodeScopeSegment 只读调用 + 解码失败判定）：
 *   - e39 编码形：余下必须合法 hex（偶数位、全 hex 字符），否则 null（解码失败 → 不标）；
 *   - passthrough 形：原样返回；空段 → null（地址契约不允许空段）。
 */
function decodeScopeBase(segment: string): string | null {
	if (segment.length === 0) return null;
	if (segment.startsWith(ENCODED_PREFIX)) {
		const h = segment.slice(ENCODED_PREFIX.length);
		if (h.length % 2 !== 0 || !/^[0-9a-f]+$/.test(h)) return null;
		const decoded = decodeScopeSegment(segment);
		// Buffer 的 UTF-8 解码对坏字节会以 U+FFFD 替换而不抛；验 round-trip 才能兑现
		// 「解码失败不标」，避免损坏 attachment 恰与 U+FFFD cwd basename 误命中。
		if (Buffer.from(decoded, "utf8").toString("hex") !== h) return null;
		return decoded;
	}
	return decodeScopeSegment(segment);
}

/**
 * 会话 cwd → 比对用 basename（归一与 GUI workspaceGroup.normalizeCwdKey + basename 同式）：
 * null/空/全空白 → null；`\`→`/`、去尾 `/`；Windows 盘符/UNC 全路径小写（basename 大小写
 * 不敏感比对），POSIX 保留大小写（精确比对）。
 */
function sessionCwdBase(cwd: string | null): { base: string; baseLower: string; win: boolean } | null {
	if (cwd === null || cwd.trim() === "") return null;
	const norm = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
	if (norm.length === 0) return null;
	const win = /^[A-Za-z]:(?:\/|$)/.test(norm) || norm.startsWith("//");
	const base = norm.slice(norm.lastIndexOf("/") + 1);
	if (base.length === 0) return null;
	return { base, baseLower: base.toLowerCase(), win };
}
