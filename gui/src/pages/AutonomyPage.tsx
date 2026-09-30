/**
 * gui/src/pages/AutonomyPage.tsx — 「主动性」设置页（RuntimeOverlay 第 6 个 section）。
 *
 * 2026-09-30：从微信连接页（ChannelsPage）拆出独立设置页——用户要求「主动性套件从微信链接中
 * 拆出来单独做一个设计页面」。AutonomySettings 原先内嵌在 ChannelsPage（3 处引用：403/401/正常
 * 分支），现整体迁至此；**开关行为 / API 调用不变**（GET /v1/autonomy/status + POST /v1/autonomy/set）。
 * 视觉语言对齐 gui-workbench-ui（shadcn 套件、暗色一套、token 口径）。
 */

import { useCallback, useEffect, useState } from "react";
import { Card, PageIntro, Toggle } from "../ui";

function AutonomySettings() {
	const [state, setState] = useState<{ enabled: boolean; kill: string; frontier: string | null; wakeGate: string | null } | null>(null);
	const [error, setError] = useState("");
	const refresh = useCallback(async () => { try { const r = await fetch("/v1/autonomy/status"); if (r.ok) setState(await r.json()); else setError(`状态读取失败 HTTP ${r.status}`); } catch { setError("状态读取失败"); } }, []);
	useEffect(() => { void refresh(); }, [refresh]);
	const toggle = async (enabled: boolean) => { try { const r = await fetch("/v1/autonomy/set", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) }); if (!r.ok) { setError(`写入失败 HTTP ${r.status}`); return; } setError(""); await refresh(); } catch { setError("写入失败"); } };
	return <Card title="主动性套件"><div className="space-y-2 text-xs"><div className="flex items-center gap-2"><Toggle on={state?.enabled ?? false} disabled={!state} onChange={(v) => void toggle(v)} labels={["关","开"]} />启用主动性套件</div><p>开启后启用总门（可压制唤醒）+ 写审计/快照；当前不执行任何自动动作（不自动派活、不自动重启 worker）。</p><p>状态：enabled={state?.enabled ? "on" : "off"} · kill={state?.kill ?? "—"} · frontier={state?.frontier ?? "(none)"} · wake-gate={state?.wakeGate ?? "(never)"}</p><p>awayMode：未实现（保留字段），不提供开关。</p>{error && <p className="text-destructive">{error}</p>}</div></Card>;
}

export function AutonomyPage() {
	return (
		<div className="space-y-3">
			<PageIntro>主动性套件：总门开关 + 自主性前沿（frontier）状态。当前不执行任何自动动作。</PageIntro>
			<AutonomySettings />
		</div>
	);
}
