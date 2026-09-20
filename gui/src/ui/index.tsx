/** 手写小组件（≤8 个 + G5.1 人话化微增：Term/ShortId/RelTime/PageIntro，无新依赖）。 */

import { useState, type ReactNode } from "react";
import { fmtDateTime, fmtRel } from "../format";

// ── 1. Button ──────────────────────────────────────────────────────

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
	primary: "bg-blue-600 hover:bg-blue-500 text-white border-blue-600",
	secondary: "bg-zinc-800 hover:bg-zinc-700 text-zinc-100 border-zinc-700",
	danger: "bg-red-700 hover:bg-red-600 text-white border-red-700",
	ghost: "bg-transparent hover:bg-zinc-800 text-zinc-300 border-transparent",
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
		<section className="rounded-lg border border-zinc-800 bg-zinc-900/60">
			{title !== undefined && (
				<header className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
					<h2 className="text-xs font-semibold tracking-wide text-zinc-400">{title}</h2>
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
	green: "bg-emerald-900/60 text-emerald-300 border-emerald-800",
	red: "bg-red-900/60 text-red-300 border-red-800",
	gray: "bg-zinc-800 text-zinc-400 border-zinc-700",
	yellow: "bg-amber-900/60 text-amber-300 border-amber-800",
	blue: "bg-sky-900/60 text-sky-300 border-sky-800",
	purple: "bg-violet-900/60 text-violet-300 border-violet-800",
	na: "bg-zinc-900 text-zinc-600 border-zinc-800",
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
				on ? "border-emerald-700 bg-emerald-900/50 text-emerald-300" : "border-zinc-700 bg-zinc-800 text-zinc-400"
			}`}
		>
			<span className={`rounded-full px-1.5 py-0.5 ${on ? "" : "bg-zinc-700 text-zinc-200"}`}>{offLabel}</span>
			<span className={`rounded-full px-1.5 py-0.5 ${on ? "bg-emerald-700 text-white" : ""}`}>{onLabel}</span>
		</button>
	);
}

// ── 5. Tooltip（CSS-only；disabled 按钮不触发 hover，需外层 span 承载）──

export function Tooltip({ text, children }: { text: string; children: ReactNode }) {
	return (
		<span className="group relative inline-flex">
			{children}
			<span className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1 -translate-x-1/2 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-[10px] whitespace-nowrap text-zinc-300 opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
				{text}
			</span>
		</span>
	);
}

// ── 6. Spinner ─────────────────────────────────────────────────────

export function Spinner({ label }: { label?: string }) {
	return (
		<span className="inline-flex items-center gap-2 text-xs text-zinc-500">
			<span className="h-3 w-3 animate-spin rounded-full border-2 border-zinc-600 border-t-transparent" />
			{label}
		</span>
	);
}

// ── 7. EmptyState ──────────────────────────────────────────────────

export function EmptyState({ children }: { children: ReactNode }) {
	return <div className="py-6 text-center text-xs text-zinc-600">{children}</div>;
}

// ── 8. ErrorText ───────────────────────────────────────────────────

export function ErrorText({ children }: { children: ReactNode }) {
	return <p className="font-mono text-[11px] text-red-400">{children}</p>;
}

// ── G5.1 人话化微增组件 ────────────────────────────────────────────

/** 术语：中文主词 + 小字英文原词（G5.1 固定术语表）。 */
export function Term({ zh, en, hint }: { zh: string; en?: string; hint?: string }) {
	const word = (
		<span className="inline-flex items-baseline gap-1">
			{zh}
			{en && <span className="text-[9px] font-normal tracking-normal text-zinc-600">{en}</span>}
		</span>
	);
	return hint ? (
		<span className="inline-flex items-center gap-1">
			{word}
			<Tooltip text={hint}>
				<span className="cursor-help rounded-full border border-zinc-700 px-1 text-[9px] leading-3 text-zinc-500">?</span>
			</Tooltip>
		</span>
	) : (
		word
	);
}

/** 每页顶部白话导语（≤24 字）。 */
export function PageIntro({ children }: { children: ReactNode }) {
	return <p className="text-xs text-zinc-500">{children}</p>;
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
			className={`cursor-pointer break-all font-mono ${copied ? "text-emerald-400" : ""} ${className}`}
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
