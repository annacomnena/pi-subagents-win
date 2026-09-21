/** 手写小组件（≤8 个 + G5.1 人话化微增：Term/ShortId/RelTime/PageIntro，无新依赖）。 */

import { useState, type ReactNode } from "react";
import { fmtDateTime, fmtRel } from "../format";

// ── 1. Button ──────────────────────────────────────────────────────

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
	primary: "bg-brand hover:bg-brand/85 text-foreground-inverse border-brand",
	secondary: "bg-surface-hover hover:bg-selected text-foreground border-border",
	danger: "bg-destructive hover:bg-destructive/85 text-destructive-foreground border-destructive",
	ghost: "bg-transparent hover:bg-surface-hover text-foreground-subtle border-transparent",
};

export function Button({
	variant = "secondary",
	disabled = false,
	onClick,
	title,
	children,
}: {
	variant?: ButtonVariant;
	disabled?: boolean;
	onClick?: () => void;
	title?: string;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			disabled={disabled}
			title={title}
			onClick={onClick}
			className={`inline-flex items-center gap-1 rounded border px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${BUTTON_VARIANTS[variant]}`}
		>
			{children}
		</button>
	);
}

// ── 2. Card ────────────────────────────────────────────────────────

export function Card({ title, right, children }: { title?: ReactNode; right?: ReactNode; children: ReactNode }) {
	return (
		<section className="rounded-lg border border-border bg-surface/60">
			{title !== undefined && (
				<header className="flex items-center justify-between border-b border-border px-3 py-2">
					<h2 className="text-xs font-semibold tracking-wide text-foreground-subtle">{title}</h2>
					{right}
				</header>
			)}
			<div className="px-3 py-2">{children}</div>
		</section>
	);
}

// ── 3. Badge ───────────────────────────────────────────────────────

type BadgeTone = "green" | "red" | "gray" | "yellow" | "blue" | "purple" | "na";

const BADGE_TONES: Record<BadgeTone, string> = {
	green: "bg-success/20 text-success border-success/60",
	red: "bg-destructive/20 text-destructive border-destructive/60",
	gray: "bg-surface-hover text-foreground-subtle border-border",
	yellow: "bg-warning/15 text-warning border-warning/40",
	blue: "bg-brand/20 text-brand border-brand/60",
	purple: "bg-accent/60 text-foreground border-border",
	na: "bg-surface text-foreground-subtlest border-border",
};

export function Badge({ tone = "gray", title, children }: { tone?: BadgeTone; title?: string; children: ReactNode }) {
	return (
		<span
			title={title}
			className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap ${BADGE_TONES[tone]}`}
		>
			{children}
		</span>
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
			className={`inline-flex items-center rounded-full border px-1 py-0.5 text-[10px] font-semibold transition-colors disabled:opacity-40 ${
				on ? "border-success/60 bg-success/20 text-success" : "border-border bg-surface-hover text-foreground-subtle"
			}`}
		>
			<span className={`rounded-full px-1.5 py-0.5 ${on ? "" : "bg-surface text-foreground"}`}>{offLabel}</span>
			<span className={`rounded-full px-1.5 py-0.5 ${on ? "bg-success text-success-foreground" : ""}`}>{onLabel}</span>
		</button>
	);
}

// ── 5. Tooltip（CSS-only；disabled 按钮不触发 hover，需外层 span 承载）──

export function Tooltip({ text, children }: { text: string; children: ReactNode }) {
	return (
		<span className="group relative inline-flex">
			{children}
			<span className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1 -translate-x-1/2 rounded border border-border bg-background px-2 py-1 text-[10px] whitespace-nowrap text-foreground-subtle opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
				{text}
			</span>
		</span>
	);
}

// ── 7. EmptyState ──────────────────────────────────────────────────

export function EmptyState({ children }: { children: ReactNode }) {
	return <div className="py-6 text-center text-xs text-foreground-subtlest">{children}</div>;
}

// ── G5.1 人话化微增组件 ────────────────────────────────────────────

/** 术语：中文主词 + 小字英文原词（G5.1 固定术语表）。 */
export function Term({ zh, en, hint }: { zh: string; en?: string; hint?: string }) {
	const word = (
		<span className="inline-flex items-baseline gap-1">
			{zh}
			{en && <span className="text-[9px] font-normal tracking-normal text-foreground-subtlest">{en}</span>}
		</span>
	);
	return hint ? (
		<span className="inline-flex items-center gap-1">
			{word}
			<Tooltip text={hint}>
				<span className="cursor-help rounded-full border border-border px-1 text-[9px] leading-3 text-foreground-subtlest">?</span>
			</Tooltip>
		</span>
	) : (
		word
	);
}

/** 每页顶部白话导语（≤24 字）。 */
export function PageIntro({ children }: { children: ReactNode }) {
	return <p className="text-xs text-foreground-subtlest">{children}</p>;
}

/** 长 ID 短化：前 12 字符 + 「…」，悬停显全量，点击复制全量（G5.1 规格 4）。 */
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
			className={`cursor-pointer break-all font-mono ${copied ? "text-success" : ""} ${className}`}
		>
			{short}
		</span>
	);
}

/** 相对时间：显示「x 分钟前」，悬停 title 显完整时间（G5.1 规格 3）。 */
export function RelTime({ at, className = "" }: { at: string | null | undefined; className?: string }) {
	if (!at) return <span className={className}>—</span>;
	return (
		<span title={fmtDateTime(at)} className={className}>
			{fmtRel(at)}
		</span>
	);
}
