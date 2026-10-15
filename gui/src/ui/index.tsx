/** 手写小组件（G5.1 人话化：Term/ShortId/RelTime/PageIntro + 状态页 Button/Badge/Card 门面）。
 * 2026-09-30 视觉收敛：Button/Badge/Card 内核换 shadcn 套件（prop API 不变，页内 import 零改动）；
 * CSS-only Tooltip 删除（Term「?」与 MasterPage 改 radix ui/tooltip，TooltipProvider 已全局挂载）。 */

import { useState, type ReactNode } from "react";
import { fmtDateTime, fmtRel } from "../format";
import { cn } from "./lib/utils";
import { Button as ShadButton } from "./button";
import { Badge as ShadBadge } from "./badge";
import { Card as ShadCard, CardAction as ShadCardAction, CardContent as ShadCardContent, CardHeader as ShadCardHeader, CardTitle as ShadCardTitle } from "./card";
import {
	Tooltip as RadixTooltip,
	TooltipContent as RadixTooltipContent,
	TooltipTrigger as RadixTooltipTrigger,
} from "./tooltip";

// ── 1. Button（内核 = shadcn Button；variant 映射保 legacy 四档语义）────────

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

const BUTTON_VARIANT_MAP: Record<ButtonVariant, "default" | "secondary" | "destructive" | "ghost"> = {
	primary: "default",
	secondary: "secondary",
	danger: "destructive",
	ghost: "ghost",
};

export function Button({
	variant = "secondary",
	disabled = false,
	onClick,
	title,
	children,
	className,
	size = "sm",
}: {
	variant?: ButtonVariant;
	disabled?: boolean;
	onClick?: () => void;
	title?: string;
	children: ReactNode;
	/** 2026-09-30 新增：尺寸透传（默认 sm=h-6 适配状态页密度；主操作可传 "default"=h-7）。 */
	size?: "sm" | "default";
	/** 2026-09-30 新增：class 透传（tailwind-merge 合并，覆盖内核档位）。 */
	className?: string;
}) {
	return (
		<ShadButton
			type="button"
			variant={BUTTON_VARIANT_MAP[variant]}
			size={size}
			disabled={disabled}
			title={title}
			onClick={onClick}
			className={className}
		>
			{children}
		</ShadButton>
	);
}

// ── 2. Card（内核 = shadcn Card size=sm：bg-card 实底替代近透明 surface/60）────

export function Card({ title, right, children, className }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
	return (
		<ShadCard size="sm" className={className}>
			{title !== undefined && (
				<ShadCardHeader className="border-b border-border">
					{/* 标题：去 tracking-wide（CJK 不宜字距）；§7 B-9 建议升 ui-lg + 衬线——
					 * 对应 §4「唯一可用衬线的档」；色保持 subtle（标题是分区信息，不是主表述）。 */}
					<ShadCardTitle className="font-display text-ui-lg font-medium text-foreground-subtle">{title}</ShadCardTitle>
					{right !== undefined && <ShadCardAction>{right}</ShadCardAction>}
				</ShadCardHeader>
			)}
			<ShadCardContent className="pt-0">{children}</ShadCardContent>
		</ShadCard>
	);
}

// ── 3. Badge（内核 = shadcn Badge 胶囊 h-5 + text-ui-xs；七档 tone 语义保留）──
// §3.2 chip 规范（S2 落地）：底 mix(tone 12%, card)、字 mix(tone 70%, 提亮基色)、环 tone 50%。
// 实现集中在 index.css 的 .tone-chip（暗色 5.58–6.55:1 / 亮色 6.45–7.14:1，均 ≥4.5）。
// 旧写法 `bg-<tone>/20 + text-<tone>` 实测只有 3.64–4.43:1，不达 AA（§6 硬门）——已废除。

type BadgeTone = "green" | "red" | "gray" | "yellow" | "blue" | "purple" | "na";

const BADGE_TONES: Record<BadgeTone, string> = {
	green: "tone-chip [--chip-tone:var(--color-success)]",
	red: "tone-chip [--chip-tone:var(--color-destructive)]",
	gray: "tone-chip [--chip-tone:var(--color-foreground-subtle)]",
	yellow: "tone-chip [--chip-tone:var(--color-warning)]",
	// blue → 真信息蓝 info（brand 暗色=纯白致「蓝徽章」渲染成白块，P1-2）
	blue: "tone-chip [--chip-tone:var(--color-info)]",
	// purple → accent wash（§7 B-9①：不再用 bg-accent/60 实底；走 chip 公式的陶土档）
	purple: "tone-chip [--chip-tone:var(--color-accent)]",
	// na 档 subtlest→subtle（信息分级：缺字段提示是信息不是装饰，P1-4）
	na: "tone-chip [--chip-tone:var(--color-foreground-subtle)]",
};

export function Badge({ tone = "gray", title, children }: { tone?: BadgeTone; title?: string; children: ReactNode }) {
	return (
		<ShadBadge variant="outline" title={title} className={BADGE_TONES[tone]}>
			{children}
		</ShadBadge>
	);
}

/** 缺字段灰色「暂无数据」徽章（G5.1 规格 5：n/a → 白话灰字）——Badge tone="na" 的专用快捷方式。 */
export function naBadge(why?: string) {
	return (
		<Badge tone="na" title={why}>
			暂无数据{why ? `（${why}）` : ""}
		</Badge>
	);
}

// ── 4. Toggle ──────────────────────────────────────────────────────

export function Toggle({ on, disabled, onChange, labels }: {
	on: boolean;
	disabled?: boolean;
	onChange: (next: boolean) => void;
	labels?: [string, string];
}) {
	const [offLabel, onLabel] = labels ?? ["关", "开"];
	return (
		<button
			type="button"
			disabled={disabled}
			onClick={() => onChange(!on)}
			className={`inline-flex items-center rounded-full border px-1 py-0.5 text-ui-xs font-semibold transition-colors disabled:opacity-40 ${
				on ? "border-accent bg-accent text-accent-foreground" : "border-border bg-surface-hover text-foreground-subtle"
			}`}
		>
			<span className={`rounded-full px-1.5 py-0.5 ${on ? "" : "bg-surface text-foreground"}`}>{offLabel}</span>
			<span className={`rounded-full px-1.5 py-0.5 ${on ? "bg-accent-foreground text-accent" : ""}`}>{onLabel}</span>
		</button>
	);
}

// ── 5. EmptyState（2026-09-30：默认色 subtlest→subtle；新增可选 icon）────────
// 2026-10-15（P1）：新增可选 `icon` + `action`（一个明确出口），满足「空态有图标 + 说明 + 出口」。
// 不再新增间距尺度（沿用 gap-2 / py-6）。

export function EmptyState({ children, icon, action }: { children: ReactNode; icon?: ReactNode; action?: ReactNode }) {
	return (
		<div className="flex flex-col items-center gap-2 py-6 text-center text-ui-sm text-foreground-subtle">
			{/* §7 B-9④：icon 色 subtlest→subtle（图标是信息，不是纯装饰） */}
			{icon !== undefined && <span className="text-foreground-subtle">{icon}</span>}
			{children}
			{/* 出口：一个明确动作（按用户要求：空态必须给出口；无合适动作时不传，见各页裁决记录） */}
			{action !== undefined && <div className="mt-1">{action}</div>}
		</div>
	);
}

// ── G5.1 人话化微增组件 ────────────────────────────────────────────

/** 术语：中文主词 + 小字英文原词（G5.1 固定术语表）。「?」hint 走 radix Tooltip
 *  （2026-09-30：CSS-only 版删除；TooltipProvider 已全局挂载，App.tsx）。 */
export function Term({ zh, en, hint }: { zh: string; en?: string; hint?: string }) {
	const word = (
		<span className="inline-flex items-baseline gap-1">
			{zh}
			{en && <span className="text-ui-xs font-normal tracking-normal text-foreground-subtlest">{en}</span>}
		</span>
	);
	return hint ? (
		<span className="inline-flex items-center gap-1">
			{word}
			<RadixTooltip>
				<RadixTooltipTrigger asChild>
					<span className="cursor-help rounded-full border border-border px-1 text-ui-xs leading-3 text-foreground-subtle">?</span>
				</RadixTooltipTrigger>
				<RadixTooltipContent>{hint}</RadixTooltipContent>
			</RadixTooltip>
		</span>
	) : (
		word
	);
}

/** 每页顶部白话导语（≤24 字；信息性 → subtle 档，P1-4）。 */
export function PageIntro({ children }: { children: ReactNode }) {
	return <p className="text-ui-sm text-foreground-subtle">{children}</p>;
}

/** 长 ID 短化：前 12 字符 + 「…」，悬停显全量，点击复制全量（G5.1 规格 4）。
 *  默认色 subtle（ID 是信息）；调用方显式传 text-* 经 tailwind-merge 覆盖。 */
export function ShortId({ value, chars = 12, className = "" }: { value: string; chars?: number; className?: string }) {
	const [copied, setCopied] = useState(false);
	if (!value) return null;
	const short = value.length > chars ? `${value.slice(0, chars)}…` : value;
	const copy = () => {
		void navigator.clipboard?.writeText(value).then(
			() => {
				setCopied(true);
				window.setTimeout(() => setCopied(false), 1200);
			},
			() => {},
		);
	};
	return (
		<span
			title={copied ? "已复制全量 ID" : `点击复制全量：${value}`}
			onClick={copy}
			className={cn("cursor-pointer break-all font-mono text-foreground-subtle", copied && "text-success", className)}
		>
			{short}
		</span>
	);
}

/** 相对时间：显示「x 分钟前」，悬停 title 显完整时间（G5.1 规格 3）。
 *  默认色 subtle（时间是信息）；调用方显式传 text-* 经 tailwind-merge 覆盖。 */
export function RelTime({ at, className = "" }: { at: string | null | undefined; className?: string }) {
	if (!at) return <span className={cn("text-foreground-subtle", className)}>—</span>;
	return (
		<span title={fmtDateTime(at)} className={cn("text-foreground-subtle", className)}>
			{fmtRel(at)}
		</span>
	);
}
