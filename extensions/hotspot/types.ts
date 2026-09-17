/**
 * hotspot/types — 热点路由缓存的数据模型与常量
 *
 * 设计文档：plans/20260915_plan_hotspot_memory_layer.md（v2）
 * - 热点是纯路由层：主题 → Wiki 章节切片 + 符号入口 + 证据指针
 * - 文件格式由工具生成/解析，代理不手工拼接 Markdown
 * - revision 与时间戳由工具管理
 */

export const SCHEMA_VERSION = 1;

/** 注入预算（字符）：固定说明预留后按完整条目选择，超预算整条省略。
 *  token 估算方法 = 字符数 ÷ 3.5（中英混合保守估计），4000 chars ≈ 1.1k token。
 *  这是试点参数，不是严格等价换算。 */
export const FIXED_PREAMBLE_CHARS = 900; // 含“最近活动”小节（任务 3 行 + 函数 5 项，现算零存储）
export const DEFAULT_INJECT_CHAR_BUDGET = 4000;

/** 存储上限（字符）：与注入预算分别限制；超限拒写并要求显式整理。 */
export const DEFAULT_STORE_CHAR_LIMIT = 12000;

export const HOTSPOT_FILENAME = "_hotspot.md";
export const HOTSPOT_TRASH_FILENAME = "_hotspot.trash.jsonl";
export const INJECT_CUSTOM_TYPE = "hotspot-injected";
export const TOPIC_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface WikiRef {
	/** 仓库相对路径（正斜杠分隔） */
	path: string;
	/** 章节标题（可选；空表示整页） */
	section?: string;
}

export interface SymbolRef {
	/** 仓库相对路径 */
	path: string;
	/** 符号名（CodeGraph 可解析） */
	name: string;
}

export interface HotspotEntry {
	topicId: string;
	title: string;
	/** 适用范围一句话 */
	scope?: string;
	wiki: WikiRef[];
	symbols: SymbolRef[];
	evidence: WikiRef[];
	/** 内容更新时间（ISO），由工具写入 */
	updatedAt: string;
	/** 最近引用验证时间（ISO）：只说明指针经过检查，不代表业务结论被验证 */
	verifiedAt: string;
}

export interface HotspotFile {
	schemaVersion: number;
	revision: number;
	entries: HotspotEntry[];
}

export type ParseResult =
	| { ok: true; file: HotspotFile }
	| { ok: false; error: string };

/** 单值字段在文件中的中文名（与 v2 文档 §4.3 示例一致） */
export const FIELD_LABELS = {
	title: "标题",
	scope: "适用范围",
	updatedAt: "内容更新",
	verifiedAt: "引用验证",
} as const;

export const MULTI_FIELD_LABELS = {
	wiki: "Wiki",
	symbols: "入口",
	evidence: "证据",
} as const;

export function nowIso(): string {
	return new Date().toISOString();
}

/** 条目字段数量/长度上限（写入校验用） */
export const ENTRY_LIMITS = {
	title: 40,
	scope: 80,
	refs: 5,
	topics: 8,
} as const;
