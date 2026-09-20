/**
 * gui/src/api/client.ts — HTTP 客户端（never-throw + 409 resync 信号，拍板 4/7）。
 *
 * 纪律：fetch 失败/超时/非 JSON **绝不抛**——返回 FetchResult 判别联合，由 store 决定
 * connection 置 down / 保留旧数据继续轮询。所有请求走同源相对路径（vite dev proxy 转发
 * /v1/* → runtime-host），POST /v1/commands 亦同源无预检。
 */

import type {
	AttentionResponse,
	CommandFrameInput,
	CommandOutcomeBody,
	EventsResponse,
	HealthView,
	RuntimeSnapshot,
	TimelineResponse,
} from "./types";

export type ConnState = "up" | "down";

export interface FetchOk<T> {
	ok: true;
	status: number;
	data: T;
	/** 客户端收到响应的时刻（「数据 as-of」横幅用）。 */
	at: string;
}

export interface FetchErr {
	ok: false;
	status: number;
	/** 409 cursor-invalid 时为 true（server {reason:"cursor-invalid",resync:true}）。 */
	resync: boolean;
	at: string;
}

export type FetchResult<T> = FetchOk<T> | FetchErr;

const DEFAULT_TIMEOUT_MS = 5000;

/** never-throw fetch：超时/网络错/坏 JSON → {ok:false}。 */
async function fetchJson<T>(path: string, init?: RequestInit, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<FetchResult<T>> {
	const at = new Date().toISOString();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(path, { ...init, signal: controller.signal });
		let data: unknown = null;
		try {
			data = await res.json();
		} catch {
			/* 非 JSON（如代理 502 HTML）→ data=null，按状态码处理 */
		}
		if (res.status === 409) {
			const reason = (data as { reason?: unknown } | null)?.reason;
			return { ok: false, status: 409, resync: reason === "cursor-invalid", at };
		}
		if (!res.ok) return { ok: false, status: res.status, resync: false, at };
		return { ok: true, status: res.status, data: data as T, at };
	} catch {
		return { ok: false, status: 0, resync: false, at };
	} finally {
		clearTimeout(timer);
	}
}

function postJson<T>(path: string, body: unknown, timeoutMs?: number): Promise<FetchResult<T>> {
	return fetchJson<T>(
		path,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
		timeoutMs,
	);
}

function newCommandKey(prefix: string): string {
	const rand = Math.random().toString(36).slice(2, 8);
	return `gui_${Date.now().toString(36)}_${prefix}_${rand}`;
}

/** 6 端点封装 + 命令工厂。全部 never-throw。 */
export const api = {
	health: (): Promise<FetchResult<HealthView>> => fetchJson<HealthView>("/v1/health"),

	snapshot: (): Promise<FetchResult<RuntimeSnapshot>> => fetchJson<RuntimeSnapshot>("/v1/snapshot", undefined, 8000),

	events: (after: string, limit?: number): Promise<FetchResult<EventsResponse>> => {
		const q = new URLSearchParams({ after });
		if (limit !== undefined) q.set("limit", String(limit));
		return fetchJson<EventsResponse>(`/v1/events?${q.toString()}`);
	},

	attention: (includeResolved: boolean): Promise<FetchResult<AttentionResponse>> =>
		fetchJson<AttentionResponse>(`/v1/attention${includeResolved ? "?includeResolved=1" : ""}`),

	timeline: (limit = 200): Promise<FetchResult<TimelineResponse>> =>
		fetchJson<TimelineResponse>(`/v1/timeline?limit=${limit}`),

	/** workstream.pause / workstream.resume（to = workstream://<id>；payload 白名单 {reason?}）。 */
	workstreamPauseResume: (
		type: "workstream.pause" | "workstream.resume",
		wsId: string,
		reason?: string,
	): Promise<FetchResult<CommandOutcomeBody>> =>
		postJson<CommandOutcomeBody>("/v1/commands", {
			frame: "command",
			type,
			to: `workstream://${wsId}`,
			commandKey: newCommandKey(type.split(".")[1]),
			issuedAt: new Date().toISOString(),
			...(reason ? { payload: { reason } } : {}),
		} satisfies CommandFrameInput),

	/** master.handoff.accept（to 钉死 agent://master_default；payload 白名单 {reason?}）。 */
	handoffAccept: (reason?: string): Promise<FetchResult<CommandOutcomeBody>> =>
		postJson<CommandOutcomeBody>("/v1/commands", {
			frame: "command",
			type: "master.handoff.accept",
			to: "agent://master_default",
			commandKey: newCommandKey("accept"),
			issuedAt: new Date().toISOString(),
			...(reason ? { payload: { reason } } : {}),
		} satisfies CommandFrameInput),

	/** master.auto-handoff.set（payload {auto:boolean} 必填）。 */
	autoHandoffSet: (auto: boolean, reason?: string): Promise<FetchResult<CommandOutcomeBody>> =>
		postJson<CommandOutcomeBody>("/v1/commands", {
			frame: "command",
			type: "master.auto-handoff.set",
			to: "agent://master_default",
			commandKey: newCommandKey("auto"),
			issuedAt: new Date().toISOString(),
			payload: { auto, ...(reason ? { reason } : {}) },
		} satisfies CommandFrameInput),
};
