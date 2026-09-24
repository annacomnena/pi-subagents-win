/**
 * gui/src/pages/ChannelsPage.tsx — 「微信连接」（0923 wechat iLink 绑定 v1：绑定/解绑/状态，不做消息收发）。
 *
 * 状态机 idle→waiting(qr)→scanned→bound | expired | error（server /v1/wechat/bind/status 唯一真相源；
 * token 永不进任何响应/浏览器）。waiting/scanned 每 2s 轮询 status（daemon 驱动服务端 2.5s 轮询；
 * 前端不直连腾讯）。二维码 = daemon /v1/wechat/bind/qr-image 的 data URL（≤200KB/10s；失败回退
 * 图片 URL 文本 + 复制，前端永不拿轮询凭证串渲染）。L3 UX 修复：入口始终渲染（RuntimeOverlay
 * 不再过滤）——未启用（403 wechat-disabled）→ 页内明确说明 +「启用微信连接」按钮（POST
 * /v1/wechat/enable 后自动刷新 status）；401 → 引导本机 TUI `/gui open` 后刷新。
 */

import { useCallback, useEffect, useState } from "react";
import { api, type FetchErr } from "../api/client";
import type { WechatBindStatusBody, WechatQrImageBody } from "../api/types";
import { Badge, Button, Card, EmptyState, PageIntro, RelTime, Term, Toggle } from "../ui";

type UiState = "loading" | "idle" | "waiting" | "scanned" | "bound" | "expired" | "error";

const STATE_LABEL: Record<UiState, string> = {
	loading: "加载中",
	idle: "未绑定",
	waiting: "等待扫码",
	scanned: "已扫码待确认",
	bound: "已绑定",
	expired: "已过期",
	error: "错误",
};

const STATE_TONE: Record<UiState, "na" | "gray" | "blue" | "yellow" | "green" | "red"> = {
	loading: "na",
	idle: "gray",
	waiting: "blue",
	scanned: "yellow",
	bound: "green",
	expired: "gray",
	error: "red",
};

/** 真网待测 7 项（只读提示条；测法见 plans/0923_wechat_ilink_probe_checklist.md 步骤③.①–⑦）。
 *  本切片只覆盖绑定链路；未知项不得当事实引用（Wiki/Architecture/wechat-ilink-channel.md#未确认清单）。 */
const PENDING_MEASURES: [string, string][] = [
	["①", "bot_token 何时失效（长期 listen；首次 401/403 时间戳 vs 绑定时刻）"],
	["②", "context_token 过期行为（新旧 context 各 reply 一次，看 ret/HTTP 码）"],
	["③", "同 buf 是否重放（listen 观察「去重跳过」）"],
	["④", "空批是否推进 buf（静默期 listen 观察）"],
	["⑤", "固定 client_id 重发是否去重（send ×2 看手机收几条）"],
	["⑥", "同 token 并发 poll+send 是否限流（send --with-poll 看 429）"],
	["⑦", "附件 URL 主机/大小限制（手机发图片看 attach 行 host/size）"],
];

/** 动作失败 → 用户可读文案（server body 的 message/hint/error 优先；网络错给白话）。 */
function describeActionError(r: FetchErr): string {
	const b = r.body as { error?: unknown; message?: unknown; hint?: unknown } | undefined;
	if (b && typeof b.message === "string" && b.message.length > 0) return b.message;
	if (b && typeof b.hint === "string" && b.hint.length > 0) return b.hint;
	if (b && typeof b.error === "string" && b.error.length > 0) return b.error;
	return r.status === 0 ? "网络错误（daemon 可能未在线）" : `HTTP ${r.status}`;
}

/** 二维码块：daemon 代理 data URL；失败回退图片 URL 文本 + 复制（+ 浏览器打开该 URL 再扫码）。 */
function QrBlock({ image, url, loading }: { image: WechatQrImageBody | null; url: string | null; loading: boolean }) {
	const [copied, setCopied] = useState(false);
	const copy = (v: string): void => {
		void navigator.clipboard?.writeText(v).then(
			() => {
				setCopied(true);
				window.setTimeout(() => setCopied(false), 1200);
			},
			() => {},
		);
	};
	const dataUrl: string | null = image !== null && image.dataUrl !== null ? image.dataUrl : null;
	const showImage = dataUrl !== null;
	return (
		<div className="space-y-2">
			{showImage ? (
				<img src={dataUrl} alt="微信登录二维码" className="h-48 w-48 rounded border border-border bg-white" />
			) : (
				<div className="space-y-2 rounded border border-border bg-surface p-3">
					<p className="text-[10px] text-foreground-subtlest">
						{image === null ? (loading ? "正在加载二维码…" : "等待二维码数据…") : `二维码取图失败（回退为 URL）：${image.error ?? "未知原因"}`}
					</p>
					{url !== null && (
						<div className="flex items-center gap-2">
							<span className="min-w-0 break-all font-mono text-[10px] text-foreground" title={url}>
								{url}
							</span>
							<Button variant="ghost" onClick={() => copy(url)}>
								{copied ? "已复制" : "复制"}
							</Button>
						</div>
					)}
				</div>
			)}
			{url !== null && !showImage && (
				<a
					href={url}
					target="_blank"
					rel="noreferrer"
					className="text-[11px] text-brand underline decoration-brand/40 underline-offset-2 hover:decoration-brand"
				>
					在浏览器里打开该图片 URL 后扫码
				</a>
			)}
		</div>
	);
}

/** W1（0924）收到的消息：worker 状态 + inbox 只读投影（脱敏在 server 端点层完成）。 */
interface WechatWorkerStatusBody {
	enabled: boolean;
	required: boolean;
	running: boolean;
	status: "disconnected" | "polling" | "connected" | "auth_required" | "uncertain";
	lastPollAt: string | null;
	backlog: number;
	dedupeSize: number;
	lastError: string | null;
}

interface WechatInboxBody {
	version: number;
	count: number;
	messages: {
		msgId: string;
		from: string;
		nickname: string | null;
		text: string;
		receivedAt: string;
		state: "pending" | "injected" | "rejected";
		artifactPending?: boolean;
	}[];
}

const WORKER_STATUS_LABEL: Record<WechatWorkerStatusBody["status"], string> = {
	disconnected: "未运行",
	polling: "轮询中",
	connected: "已连接",
	auth_required: "需重新扫码",
	uncertain: "状态不确定",
};

const WORKER_STATUS_TONE: Record<WechatWorkerStatusBody["status"], "gray" | "blue" | "green" | "red" | "yellow"> = {
	disconnected: "gray",
	polling: "blue",
	connected: "green",
	auth_required: "red",
	uncertain: "yellow",
};

/** 同源只读拉取（never-throw；未进 api/client——W1 冻结路径纪律，只改本页）。 */
async function fetchWechatReadonly<T>(path: string): Promise<{ ok: true; data: T } | { ok: false; status: number }> {
	const controller = new AbortController();
	const timer = window.setTimeout(() => controller.abort(), 5000);
	try {
		const res = await fetch(path, { signal: controller.signal });
		if (!res.ok) return { ok: false, status: res.status };
		return { ok: true, data: (await res.json()) as T };
	} catch {
		return { ok: false, status: 0 };
	} finally {
		window.clearTimeout(timer);
	}
}

/** 「收到的消息」只读区块（W1：只收不投——pending 一律标注「尚未注入（W2 未启用）」）。 */
function ReceiveBlock() {
	const [worker, setWorker] = useState<WechatWorkerStatusBody | null>(null);
	const [inbox, setInbox] = useState<WechatInboxBody | null>(null);
	const [failed, setFailed] = useState(false);

	const refresh = useCallback(async (): Promise<void> => {
		const [w, i] = await Promise.all([
			fetchWechatReadonly<WechatWorkerStatusBody>("/v1/wechat/worker/status"),
			fetchWechatReadonly<WechatInboxBody>("/v1/wechat/inbox?limit=20"),
		]);
		if (w.ok && i.ok) {
			setWorker(w.data);
			setInbox(i.data);
			setFailed(false);
		} else {
			setFailed(true);
		}
	}, []);

	useEffect(() => {
		void refresh();
		const t = window.setInterval(() => {
			void refresh();
		}, 5000);
		return () => window.clearInterval(t);
	}, [refresh]);

	if (failed && worker === null) {
		return (
			<Card title={<Term zh="收到的消息" en="inbox" hint="W1 接收；W2 注入需 channels.wechat.input.enabled" />}>
				<EmptyState>暂无法加载收到的消息（daemon 可能未在线）。</EmptyState>
			</Card>
		);
	}
	const st = worker?.status ?? "disconnected";
	return (
		<Card
			title={<Term zh="收到的消息" en="inbox" hint="W1 只持久化+展示，不注入任何 pi 会话；token/完整发送者 ID 永不进浏览器" />}
			right={<Badge tone={worker !== null && worker.enabled ? WORKER_STATUS_TONE[st] : "gray"}>{worker !== null && worker.enabled ? WORKER_STATUS_LABEL[st] : "接收未启用"}</Badge>}
		>
			<div className="space-y-2">
				{worker !== null && !worker.enabled && (
					<p className="text-xs text-foreground-subtle">
						消息接收未启用（config <span className="font-mono">channels.wechat.receive.enabled</span> 缺省 false——显式 opt-in 后 daemon 才会拉取；本页为只读展示）。
					</p>
				)}
				{worker?.status === "auth_required" && (
					<p className="text-xs text-destructive">{worker.lastError ?? "bot_token 已失效"}：请解绑后重新扫码绑定（worker 已停止轮询，不会风暴重试）。</p>
				)}
				{worker?.status === "uncertain" && worker.lastError !== null && (
					<p className="text-xs text-yellow-600">{worker.lastError}</p>
				)}
				{worker !== null && worker.enabled && (
					<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
						<dt className="text-foreground-subtle">轮询状态</dt>
						<dd className="text-foreground">
							{WORKER_STATUS_LABEL[worker.status]}；最近拉取 <RelTime at={worker.lastPollAt} />；待处理 {worker.backlog} 条
						</dd>
					</dl>
				)}
				{inbox !== null && inbox.messages.length === 0 && (
					<EmptyState>暂无消息{worker !== null && worker.enabled ? "（长轮询静默期或无私聊文本）" : "（接收未启用）"}。</EmptyState>
				)}
				{inbox !== null && inbox.messages.length > 0 && (
					<ul className="space-y-1.5">
						{inbox.messages.map((m) => (
							<li key={m.msgId} className="rounded border border-border bg-surface p-2">
								<div className="flex flex-wrap items-center gap-2 text-[11px] text-foreground-subtle">
									<span className="font-mono">{m.msgId}</span>
									<span>{m.nickname ?? m.from}</span>
									<RelTime at={m.receivedAt} />
									{m.state === "pending" ? (
										<Badge tone="yellow" title="注入需 channels.wechat.input.enabled 且满足准入条件">尚未注入</Badge>
									) : (
										<Badge tone="green">{m.state === "injected" ? "已注入" : m.state}</Badge>
									)}
									{m.artifactPending === true && <Badge tone="gray">附件待处理</Badge>}
								</div>
								<p className="mt-1 break-all text-xs text-foreground">{m.text}</p>
							</li>
						))}
					</ul>
				)}
				<p className="text-[10px] leading-relaxed text-foreground-subtlest">
					W1 只收不投：收到的消息仅持久化在本机私有 inbox 并在此只读展示（发送者 ID 前缀脱敏、正文截断）。
				</p>
			</div>
		</Card>
	);
}

interface InputStatus { enabled: boolean; allowFrom: { id: string; masked: string }[]; masterAlive: boolean; masterSid12?: string; lastDecision: string | null; lastReason: string | null; lastAt: string | null }
interface Sender { fromId: string; fromNicknameMasked: string | null; lastAt: string; msgCount: number; allowlisted: boolean }
function InputBlock() {
 const [status, setStatus] = useState<InputStatus | null>(null); const [senders, setSenders] = useState<Sender[]>([]);
 const refresh = useCallback(async () => { const [s, a] = await Promise.all([fetchWechatReadonly<InputStatus>("/v1/wechat/input/status"), fetchWechatReadonly<Sender[]>("/v1/wechat/senders")]); if(s.ok) setStatus(s.data); if(a.ok) setSenders(a.data); }, []);
 useEffect(() => { void refresh(); const t=window.setInterval(()=>void refresh(),5000); return ()=>window.clearInterval(t); },[refresh]);
 const save = async (patch: {enabled?:boolean;allowFrom?:string[];add?:string[];remove?:string[]}) => { const r=await fetch("/v1/wechat/input/set",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(patch)}); if(r.ok) await refresh(); };
 return <Card title="允许微信消息进入对话"><div className="space-y-3">
 <p className="text-xs font-semibold text-destructive">开启后，白名单内的微信消息将作为你本人的输入进入当前 master 会话（单条一次批 + 脱敏审计）。</p>
 <Toggle on={status?.enabled===true} onChange={v=>void save({enabled:v})} labels={["关闭","开启"]}/>
 <div><p className="text-xs font-medium">白名单</p>{(status?.allowFrom.length??0)===0?<p className="text-xs text-destructive">未配置 = 拒绝所有（fail-closed）</p>:<ul>{status?.allowFrom.map(item=><li key={item.id}>{item.masked}<Button variant="ghost" onClick={()=>void save({remove:[item.id]})}>删除</Button></li>)}</ul>}</div>
 <div><p className="text-xs font-medium">最近发送者</p>{senders.map(s=><div key={s.fromId} className="flex gap-2 text-xs"><span>{s.fromId.slice(0,6)}…{s.fromId.slice(-4)} {s.fromNicknameMasked??""} · {s.lastAt} · {s.msgCount} 条</span>{s.allowlisted?<Badge tone="green">已允许</Badge>:<Button variant="secondary" onClick={()=>void save({add:[s.fromId]})}>允许</Button>}</div>)}</div>
 <p className="text-xs">为什么没进来：<span className={status?.masterAlive?"text-green-600":"text-destructive"}>{status?.masterAlive?"master 在线":"master 离线"}</span> · {status?.lastDecision??"暂无判定"} ({status?.lastReason??"—"}) · <RelTime at={status?.lastAt??null}/>{status?.masterAlive===false&&"；先 /gui open"}</p>
 </div></Card>;
}

export function ChannelsPage() {
	const [status, setStatus] = useState<WechatBindStatusBody | null>(null);
	const [disabled, setDisabled] = useState(false);
	const [unauthorized, setUnauthorized] = useState(false);
	const [busy, setBusy] = useState<"start" | "cancel" | "unbind" | "enable" | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [qrImage, setQrImage] = useState<WechatQrImageBody | null>(null);

	const uiState: UiState = status?.state ?? "loading";
	const polling = uiState === "waiting" || uiState === "scanned";

	/** status 唯一真相源（never-throw）。403 = 未启用 → 页内显启用按钮；401 = 无本机凭据 → 引导 /gui open。 */
	const refreshStatus = useCallback(async (): Promise<void> => {
		const r = await api.wechatBindStatus();
		if (!r.ok) {
			if (r.status === 403) {
				setDisabled(true);
				setUnauthorized(false);
			} else if (r.status === 401) {
				setUnauthorized(true);
				setDisabled(false);
			}
			return;
		}
		setDisabled(false);
		setUnauthorized(false);
		setStatus(r.data);
		setActionError(null);
	}, []);

	// 挂载（每次打开覆盖层）先拉一次 status
	useEffect(() => {
		void refreshStatus();
	}, [refreshStatus]);

	// waiting/scanned 每 2s 轮询（daemon 驱动服务端 2.5s 轮询；前端不直连腾讯）
	useEffect(() => {
		if (!polling || disabled) return;
		const t = window.setInterval(() => {
			void refreshStatus();
		}, 2000);
		return () => window.clearInterval(t);
	}, [polling, disabled, refreshStatus]);

	// 二维码 data URL（换一张新 QR 时重取；失败保留 {dataUrl:null,url,error} 走回退）
	const qrKey = status !== null && (status.state === "waiting" || status.state === "scanned") ? status.qrImageUrl : null;
	useEffect(() => {
		if (qrKey === null) {
			setQrImage(null);
			return;
		}
		let cancelled = false;
		void api.wechatBindQrImage().then((r) => {
			if (cancelled) return;
			if (r.ok) setQrImage(r.data);
			else setQrImage({ dataUrl: null, url: qrKey, error: r.status === 0 ? "网络错误（daemon 可能未在线）" : `HTTP ${r.status}` });
		});
		return () => {
			cancelled = true;
		};
	}, [qrKey]);

	const doStart = async (): Promise<void> => {
		setBusy("start");
		setActionError(null);
		setQrImage(null);
		const r = await api.wechatBindStart();
		setBusy(null);
		if (r.ok) {
			// 乐观落 waiting（与 server 同值；下一拍 status 轮询校正确认）
			setStatus({
				state: "waiting",
				qrImageUrl: r.data.qr.qrImageUrl,
				expiresAt: r.data.qr.expiresAt,
				expiresIn: r.data.qr.expiresIn,
				boundAt: null,
				botIdPresent: false,
				message: null,
			});
		} else {
			setActionError(describeActionError(r));
		}
	};

	const doCancel = async (): Promise<void> => {
		setBusy("cancel");
		setActionError(null);
		const r = await api.wechatBindCancel();
		setBusy(null);
		if (r.ok) {
			setStatus(r.data);
			setQrImage(null);
		} else {
			setActionError(describeActionError(r));
		}
	};

	const doEnable = async (): Promise<void> => {
		// L3 UX 正常启用路径：POST /v1/wechat/enable（本机凭据鉴权，不受 opt-in 闸限制）
		// → 成功自动刷新 status（403 → 正常绑定页）；失败如实展示 server message/hint。
		setBusy("enable");
		setActionError(null);
		const r = await api.wechatEnable();
		setBusy(null);
		if (!r.ok) {
			setActionError(describeActionError(r));
			return;
		}
		if (r.data.enabled) {
			await refreshStatus();
		} else {
			setActionError(r.data.message ?? "启用未生效（回执 enabled=false）");
		}
	};

	const doUnbind = async (): Promise<void> => {
		setBusy("unbind");
		setActionError(null);
		const r = await api.wechatUnbind();
		setBusy(null);
		if (r.ok) {
			setStatus(r.data);
			setQrImage(null);
		} else {
			setActionError(describeActionError(r));
		}
	};

	// 未启用（403 wechat-disabled）：入口始终可见 → 页内给正常启用路径（不再要求手工改 config.json）
	if (disabled) {
		return (
			<div className="space-y-3">
				<PageIntro>微信连接</PageIntro>
				<Card
					title={
						<Term
							zh="未启用"
							en="wechat-disabled"
							hint="config.json channels.wechat.enabled 缺省 OFF；启用走 POST /v1/wechat/enable（本机凭据鉴权，写盘保留其余字段）"
						/>
					}
				>
					<div className="space-y-3">
						<EmptyState>
							微信连接功能尚未启用（channels.wechat.enabled = off）。点击下方按钮启用后，即可在本页生成绑定二维码。
						</EmptyState>
						<p className="text-xs text-foreground-subtle">启用后需在本机 TUI 侧完成扫码。</p>
						<div className="flex gap-2">
							<Button variant="primary" onClick={() => void doEnable()} disabled={busy !== null}>
								{busy === "enable" ? "启用中…" : "启用微信连接"}
							</Button>
						</div>
						{actionError !== null && <p className="text-xs text-destructive">{actionError}</p>}
					</div>
				</Card>
			</div>
		);
	}

	// 无本机凭据（401）：引导先在本机 TUI /gui open 换 cookie，再刷新（当前用户真实卡点文案）
	if (unauthorized) {
		return (
			<div className="space-y-3">
				<PageIntro>微信连接</PageIntro>
				<Card title={<Term zh="未获得本机凭据" en="401 unauthorized" />}>
					<div className="space-y-3">
						<EmptyState>未获得本机凭据：请先在本机 TUI 执行 /gui open 后再刷新。</EmptyState>
						<div className="flex gap-2">
							<Button variant="secondary" onClick={() => void refreshStatus()} disabled={busy !== null}>
								刷新
							</Button>
						</div>
					</div>
				</Card>
			</div>
		);
	}

	const qrUrl = status?.qrImageUrl ?? null;
	const expiresIn = status?.expiresIn ?? null;

	return (
		<div className="space-y-3">
			<PageIntro>扫码绑定微信（v1 只做绑定/解绑/状态；消息收发是后续切片）</PageIntro>

			<Card
				title={<Term zh="绑定状态" en="status" hint="状态由 daemon 的 /v1/wechat/bind/status 提供；token 永不进浏览器" />}
				right={<Badge tone={STATE_TONE[uiState]}>{STATE_LABEL[uiState]}</Badge>}
			>
				{uiState === "loading" && <EmptyState>正在加载绑定状态…（daemon 未就绪时此页不可用）</EmptyState>}

				{uiState === "idle" && (
					<div className="space-y-3">
						<p className="text-xs text-foreground-subtle">未绑定。生成后用**手机微信**扫码确认（二维码约 120 秒内有效，过期需重新生成）。</p>
						<div className="flex gap-2">
							<Button variant="primary" onClick={() => void doStart()} disabled={busy !== null}>
								{busy === "start" ? "生成中…" : "生成二维码"}
							</Button>
						</div>
						{actionError !== null && <p className="text-xs text-destructive">{actionError}</p>}
					</div>
				)}

				{(uiState === "waiting" || uiState === "scanned") && (
					<div className="space-y-3">
						<p className="text-xs text-foreground-subtle">
							{uiState === "scanned" ? "已扫码，请在**手机端**点「确认登录」…" : "等待扫码：请用**手机微信**扫描下方二维码"}
							{expiresIn !== null && (
								<span className="text-foreground-subtlest">（约 {expiresIn}s 内有效）</span>
							)}
						</p>
						<QrBlock image={qrImage} url={qrUrl} loading={qrImage === null} />
						<div className="flex flex-wrap items-center gap-2">
							{qrUrl !== null && (
								<a
									href={qrUrl}
									target="_blank"
									rel="noreferrer"
									className="text-[11px] font-medium text-brand underline decoration-brand/40 underline-offset-2 hover:decoration-brand"
								>
									在手机微信里打开
								</a>
							)}
							<Button variant="secondary" onClick={() => void doCancel()} disabled={busy !== null}>
								{busy === "cancel" ? "取消中…" : "取消"}
							</Button>
						</div>
						{actionError !== null && <p className="text-xs text-destructive">{actionError}</p>}
					</div>
				)}

				{uiState === "bound" && (
					<div className="space-y-3">
						<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
							<dt className="text-foreground-subtle">绑定时间</dt>
							<dd className="text-foreground">
								<RelTime at={status?.boundAt ?? null} />
							</dd>
							<dt className="text-foreground-subtle">机器人 ID</dt>
							<dd className="text-foreground">{status?.botIdPresent ? "已取到（存在）" : "无"}</dd>
						</dl>
						<p className="text-[11px] text-foreground-subtlest">
							凭据存于本机 runtime 目录（0600 尽力；Windows 仅尽力）；token 永不进浏览器/日志，解绑即删除。
						</p>
						<div className="flex gap-2">
							<Button variant="danger" onClick={() => void doUnbind()} disabled={busy !== null}>
								{busy === "unbind" ? "解绑中…" : "解绑"}
							</Button>
						</div>
						{actionError !== null && <p className="text-xs text-destructive">{actionError}</p>}
					</div>
				)}

				{uiState === "expired" && (
					<div className="space-y-3">
						<p className="text-xs text-foreground-subtle">二维码已过期（约 120s 未确认）。请重新生成后再次扫码。</p>
						<div className="flex gap-2">
							<Button variant="primary" onClick={() => void doStart()} disabled={busy !== null}>
								{busy === "start" ? "生成中…" : "重新生成"}
							</Button>
						</div>
						{actionError !== null && <p className="text-xs text-destructive">{actionError}</p>}
					</div>
				)}

				{uiState === "error" && (
					<div className="space-y-3">
						<p className="text-xs text-destructive">{status?.message ?? "未知错误"}</p>
						<div className="flex gap-2">
							<Button variant="primary" onClick={() => void doStart()} disabled={busy !== null}>
								{busy === "start" ? "重试中…" : "重试"}
							</Button>
						</div>
					</div>
				)}
			</Card>

			<InputBlock />
			{/* W1（0924）：收到的消息只读区块 */}
			<ReceiveBlock />

			{/* 7 项真网待测只读提示条（本切片只覆盖绑定链路；未知项不得当事实引用） */}
			<Card title={<Term zh="真网待测" en="pending probes" hint="绑定链路之外的 7 个协议未知项，需真机微信测量" />}>
				<ul className="list-disc space-y-1 pl-4 text-[11px] leading-relaxed text-foreground-subtle">
					{PENDING_MEASURES.map(([no, text]) => (
						<li key={no}>
							<span className="font-mono text-foreground">{no}</span> {text}
						</li>
					))}
				</ul>
				<p className="mt-2 text-[10px] leading-relaxed text-foreground-subtlest">
					测法与回传格式见 <span className="font-mono">plans/0923_wechat_ilink_probe_checklist.md</span> 步骤③.①–⑦
					（绑定完成后续切片用探针脚本测量；输出不含 token 原文）。
				</p>
			</Card>
		</div>
	);
}
