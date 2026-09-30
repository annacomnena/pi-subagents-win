/**
 * gui/src/pages/AutonomyPage.tsx — 「主动性」设置页（RuntimeOverlay 第 6 个 section）。
 *
 * 2026-09-30：从微信连接页（ChannelsPage）拆出独立设置页——用户要求「主动性套件从微信链接中
 * 拆出来单独做一个设计页面」。AutonomySettings 原先内嵌在 ChannelsPage（3 处引用：403/401/正常
 * 分支），现整体迁至此；**开关行为 / API 调用不变**（GET /v1/autonomy/status + POST /v1/autonomy/set）。
 * 视觉语言对齐 gui-workbench-ui（shadcn 套件、暗色一套、token 口径）。
 *
 * frontier 可视化（核心）：GET /v1/autonomy/frontier 读盘即返回的完整快照，分三块呈现——
 *   C 快照时效（asof 相对时间 + baseline 首帧标记 + 项目/触发计数）
 *   A 项目状态矩阵（每 project：state+variant / needsUser 高亮 / gate / resultMissing /
 *     stagnation / overdue / runs 明细）——一眼看出哪个项目卡住/需要人
 *   B 触发记录表（rule/project/evidence；approximate 视觉区分）
 * 不加图表库（数据量小，现有 Badge/Card 足够）。
 * gate:"unknown" 是常态（watchdog 3/8 恒 unknown 同款"不猜"语义）→ 呈现为中性「未知」，非错误。
 */

import { useCallback, useEffect, useState } from "react";
import { Activity } from "lucide-react";
import { api } from "../api/client";
import type {
	AutonomyGateStatus,
	FrontierProjectState,
	FrontierSnapshot,
	FrontierTrigger,
	ProjectFrontier,
} from "../api/types";
import { Badge, Card, EmptyState, PageIntro, RelTime, Term, Toggle } from "../ui";

// ── 迁出组件：AutonomySettings（开关 + 摘要状态；行为/API 逐字不变）────────────────

function AutonomySettings() {
	const [state, setState] = useState<{ enabled: boolean; kill: string; frontier: string | null; wakeGate: string | null } | null>(null);
	const [error, setError] = useState("");
	const refresh = useCallback(async () => { try { const r = await fetch("/v1/autonomy/status"); if (r.ok) setState(await r.json()); else setError(`状态读取失败 HTTP ${r.status}`); } catch { setError("状态读取失败"); } }, []);
	useEffect(() => { void refresh(); }, [refresh]);
	const toggle = async (enabled: boolean) => { try { const r = await fetch("/v1/autonomy/set", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) }); if (!r.ok) { setError(`写入失败 HTTP ${r.status}`); return; } setError(""); await refresh(); } catch { setError("写入失败"); } };
	return <Card title="主动性套件"><div className="space-y-2 text-xs"><div className="flex items-center gap-2"><Toggle on={state?.enabled ?? false} disabled={!state} onChange={(v) => void toggle(v)} labels={["关","开"]} />启用主动性套件</div><p>开启后启用总门（可压制唤醒）+ 写审计/快照；当前不执行任何自动动作（不自动派活、不自动重启 worker）。</p><p>状态：enabled={state?.enabled ? "on" : "off"} · kill={state?.kill ?? "—"} · frontier={state?.frontier ?? "(none)"} · wake-gate={state?.wakeGate ?? "(never)"}</p><p>awayMode：未实现（保留字段），不提供开关。</p>{error && <p className="text-destructive">{error}</p>}</div></Card>;
}

// ── frontier 可视化（C 时效 / A 项目矩阵 / B 触发记录）──────────────────────────

type Tone = "green" | "red" | "gray" | "yellow" | "blue" | "purple" | "na";

const STATE_LABEL: Record<FrontierProjectState, string> = {
	Working: "进行中",
	Blocked: "阻塞",
	Completed: "已完成",
	Failed: "失败",
	Cancelled: "已取消",
};
const STATE_TONE: Record<FrontierProjectState, Tone> = {
	Working: "blue",
	Blocked: "yellow",
	Completed: "green",
	Failed: "red",
	Cancelled: "gray",
};

/** gate 三态：ok=绿 / awaiting=黄（等人）/ unknown=中性灰（常态"不猜"，非异常）。 */
function GateBadge({ gate }: { gate: AutonomyGateStatus }) {
	if (gate === "ok") return <Badge tone="green" title="仓库 gate 正常">gate ok</Badge>;
	if (gate === "awaiting") return <Badge tone="yellow" title="gate 等待（等人）">gate 等待</Badge>;
	return <Badge tone="na" title="gate 未知/未定：无载体，不猜（常态非异常，同 watchdog 3/8 恒 unknown 语义）">gate 未知</Badge>;
}

/** A 项目状态矩阵：一行一项目；needsUser 高亮（暖色描边/底），一眼看出哪个卡住/需要人。 */
function ProjectRow({ p }: { p: ProjectFrontier }) {
	const runs = Object.entries(p.runs);
	return (
		<div className={`rounded-md border p-2.5 ${p.needsUser ? "border-warning/50 bg-warning/5" : "border-border bg-surface"}`}>
			<div className="flex flex-wrap items-center gap-1.5">
				<Badge tone={STATE_TONE[p.state]}>{STATE_LABEL[p.state]}</Badge>
				{p.variant !== null && <Badge tone="gray" title="C5 变体标注（waiting/orphaned/resultMissing）">{p.variant}</Badge>}
				<GateBadge gate={p.gate} />
				{p.needsUser && <Badge tone="yellow" title="需要人工介入（needsUser 边沿触发）">⚠ 需人工</Badge>}
				{p.resultMissing && <Badge tone="gray" title="unconfirmed → 结果缺失（走 stagnation）">结果缺失</Badge>}
				{p.stagnation && <Badge tone="red" title="非终态 45min 无进展 ∨ 结果缺失">停滞</Badge>}
				{p.overdue > 0 && <Badge tone="red" title="timer overdue（approx 载体）">overdue {p.overdue}</Badge>}
			</div>
			<p className="mt-1.5 break-all font-mono text-ui-xs text-foreground">{p.project}</p>
			{runs.length > 0 && (
				<div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-ui-xs">
					{runs.map(([runId, phase]) => (
						<span key={runId} className="text-foreground-subtle">
							<span className="font-mono">{runId}</span> → <span className="text-foreground">{phase}</span>
						</span>
					))}
				</div>
			)}
		</div>
	);
}

/** B 触发记录表：rule/project/evidence；approximate 视觉区分（降透明度 + 「近似」徽标）。 */
function TriggerRow({ t }: { t: FrontierTrigger }) {
	return (
		<div className={`flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-border py-1.5 text-ui-sm last:border-b-0 ${t.approximate ? "opacity-65" : ""}`}>
			<span className="font-mono text-foreground">{t.rule}</span>
			<span className="min-w-0 break-all font-mono text-ui-xs text-foreground-subtle">{t.project}</span>
			<span className="text-ui-xs text-foreground-subtle">{t.evidence}</span>
			{t.approximate && <Badge tone="na" title="近似触发（不猜/降级：非硬证据，wake-gate 会降级为 no-wake/ordinary）">近似</Badge>}
		</div>
	);
}

/** frontier 可视化容器：读盘快照（5s 轮询）→ C 时效 / A 项目 / B 触发。 */
function FrontierViz() {
	// undefined=加载中 / null=无快照文件 / FrontierSnapshot=有数据
	const [snap, setSnap] = useState<FrontierSnapshot | null | undefined>(undefined);
	const [error, setError] = useState("");
	const refresh = useCallback(async () => {
		const r = await api.autonomyFrontier();
		if (r.ok) {
			setSnap(r.data);
			setError("");
		} else {
			setError(`读取 frontier 失败 HTTP ${r.status}`);
		} // 失败保留旧快照；首次失败时显示可恢复错误，避免永久停在加载态。
	}, []);
	useEffect(() => {
		void refresh();
		const t = window.setInterval(() => void refresh(), 5000);
		return () => window.clearInterval(t);
	}, [refresh]);

	const title = <Term zh="自主性前沿" en="frontier" hint="autonomy 套件的触发投影：系统据此判断要不要放行唤醒。只读读盘，不重计算。" />;

	if (snap === undefined) {
		return <Card title={title}><EmptyState>{error || "正在加载 frontier 快照…"}</EmptyState></Card>;
	}
	if (snap === null) {
		return (
			<Card title={title}>
				<EmptyState icon={<Activity className="size-6" />}>
					frontier 快照尚未生成（autonomy 未启用，或尚未完成首次 tick）。
				</EmptyState>
			</Card>
		);
	}

	return (
		<div className="space-y-3">
			{/* C 快照时效 */}
			<Card title={title}>
				{error && <p role="status" className="mb-2 text-ui-xs text-destructive">{error}；显示最近一次快照。</p>}
				<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ui-sm">
					<span className="text-foreground-subtle">快照时间</span>
					<RelTime at={new Date(snap.asof).toISOString()} className="text-foreground" />
					{snap.baseline && (
						<Badge tone="na" title="首帧（prev=null）：只建基线、不算触发——防冷启动风暴">首帧基线</Badge>
					)}
					<span className="text-foreground-subtle">· {snap.projects.length} 项目 · {snap.triggers.length} 触发</span>
				</div>
			</Card>

			{/* A 项目状态矩阵 */}
			<Card title={<Term zh="项目状态" en="projects" hint="每项目一行：state+variant / needsUser 高亮 / gate / 结果缺失 / 停滞 / overdue / runs 明细" />}>
				{snap.projects.length === 0 ? (
					<EmptyState>无进行中项目（盘面无可见 tab）。</EmptyState>
				) : (
					<div className="space-y-2">
						{snap.projects.map((p) => <ProjectRow key={p.project} p={p} />)}
					</div>
				)}
			</Card>

			{/* B 触发记录表 */}
			<Card title={<Term zh="触发记录" en="triggers" hint="本帧触发：rule / project / evidence；approximate 降透明度 + 「近似」徽标区分" />}>
				{snap.triggers.length === 0 ? (
					<EmptyState>{snap.baseline ? "首帧基线：无触发（防冷启动风暴）。" : "本帧无触发。"}</EmptyState>
				) : (
					<div>
						{snap.triggers.map((t, i) => <TriggerRow key={`${t.rule}-${t.project}-${i}`} t={t} />)}
					</div>
				)}
			</Card>
		</div>
	);
}

export function AutonomyPage() {
	return (
		<div className="space-y-3">
			<PageIntro>主动性套件：总门开关 + 自主性前沿（frontier）状态。当前不执行任何自动动作。</PageIntro>
			<AutonomySettings />
			<FrontierViz />
		</div>
	);
}
