/**
 * channel-wechat/worker.ts — 微信 iLink 长轮询 worker 循环（W1：只收不投）
 *
 * 规格：plans/0924_wechat_receive_w1_spec.md §2/§4（D14：长驻长轮询走受监督 worker 子进程；
 * 本模块是循环本体，进程组装在 index.ts，进程监督在 runtime-host/channel-supervisor.ts）。
 *
 * 批次顺序不变量（§4.2/§4.3/§4.5/§4.6 + MF1 修复 0924）——**顺序不可倒**：
 *   getUpdates(buf) → parseBatch → 逐条 claimMessage 去重（dedupe 先落盘）→ putInbox →
 *   recordQuarantine → **全部落盘后** commitBatch(prevBuf, nextBuf) 提交新 buf → 才允许下一次 poll。
 *   空批也 commitBatch（防重复拉同一批）。任何落盘抛错 → 不提交游标，退避后以同 buf 重试。
 *   重放安全：claim={fresh:false,materialized:true} → 跳过（真重复）；{fresh:false,
 *   materialized:false} = claim 已持久化但 inbox/quarantine 写失败（MF1 崩溃残留）→
 *   **幂等补写**，补写成功才提交游标（同一 msgId 只 materialize 一次不变量保持）。
 *
 * 错误面（§2/§4.4）：
 *   - auth（401/403）→ status=auth_required（持久告警 authRequiredAt）+ **停 poll**（绝不风暴）；
 *   - rate_limited → honor Retry-After（respects retryAfterMs）；
 *   - transient/protocol → 指数退避 ±jitter（5s 起，上限 5min），protocol 连续 ≥3 → uncertain（继续慢轮询）；
 *   - 外部 signal abort → 优雅退出（disconnected）。
 *
 * 安全（§4.1）：bot_token 只在 client 的 Authorization header；本模块不记 token 进任何日志/状态。
 * 定时器：ref'd（worker 是独立长驻进程，须靠 pending 工作/睡眠保活；停机靠 abort）——与
 * daemon 内 unref 先例（ws.ts:615/803）场景不同，二者各自正确。
 */

import { getUpdates, WechatIlinkError, type GetUpdatesReq, type GetUpdatesRes } from "./client.ts";
import { parseBatch, type QuarantineEntry } from "./parser.ts";
import { WechatStore, type WechatReceiveCounts, type WechatReceiveStatus, type InboundRecord } from "./store.ts";

/** 退避基序列（纯函数，测试锁定）：5s → 10s → 20s → 40s → … 封顶 5min。 */
export function backoffDelayMs(attempt: number, startMs = 5000, maxMs = 300_000): number {
	const base = startMs * Math.pow(2, Math.max(0, attempt));
	return Math.min(base, maxMs);
}

/** ±20% jitter（真实调度用；测试可用 backoffDelayMs 纯函数断言序列）。 */
function jitter(ms: number): number {
	const f = 0.8 + Math.random() * 0.4;
	return Math.max(1, Math.round(ms * f));
}

export interface WechatWorkerStatus {
	status: WechatReceiveStatus;
	lastPollAt: string | null;
	counts: WechatReceiveCounts;
	lastError: string | null;
}

export interface WechatWorkerOptions {
	/** iLink 基址 + bot_token（token 只透传给 client header，永不落地）。 */
	baseUrl: string;
	botToken: string;
	store: WechatStore;
	/** getUpdates 注入口（缺省真 client；单测 stub）。 */
	fetchUpdates?: (req: GetUpdatesReq) => Promise<GetUpdatesRes>;
	signal?: AbortSignal;
	now?: () => number;
	/** 成功批次之间的间隔（缺省 250ms；长轮询本身即节流，防 stub 场景 tight-loop）。 */
	pollGapMs?: number;
	/** HTTP 超时（缺省 95s 硬上限）。 */
	timeoutMs?: number;
	backoffStartMs?: number;
	backoffMaxMs?: number;
	/** rate_limited 无 Retry-After 时的缺省等待（缺省 60s）。 */
	rateLimitDefaultMs?: number;
	/** 连续 protocol 错误 ≥ 此值 → status=uncertain（缺省 3；继续慢轮询不停止）。 */
	protocolUncertainThreshold?: number;
	log?: (msg: string) => void;
}

export interface WechatWorkerHandle {
	/** 优雅停机：abort 当前 poll + 等循环退出（有界）；幂等。 */
	stop(): Promise<void>;
	status(): WechatWorkerStatus;
	/** 循环是否已终结（auth_required 停 poll / 外部 abort / 致命错误）。 */
	ended(): boolean;
}

function sleepRef(ms: number, signal: AbortSignal): Promise<boolean> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve(false);
			return;
		}
		let settled = false;
		const t = setTimeout(() => finish(true), ms); // 故意 ref'd：worker 进程靠它保活
		const onAbort = (): void => finish(false);
		const finish = (ok: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(t);
			signal.removeEventListener("abort", onAbort);
			resolve(ok);
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * 启动长轮询循环（fire-and-forget，同 wechat-bind runLoop 先例）。返回 handle 立即可用；
 * 循环内 never-throw（异常归一为退避/停机路径），进程不因单批失败退出。
 */
export function startWechatWorker(opts: WechatWorkerOptions): WechatWorkerHandle {
	const store = opts.store;
	const now = opts.now ?? (() => Date.now());
	const log = opts.log ?? (() => {});
	const doFetch = opts.fetchUpdates ?? ((req: GetUpdatesReq) => getUpdates(req));
	const pollGapMs = opts.pollGapMs ?? 250;
	const timeoutMs = opts.timeoutMs;
	const backoffStartMs = opts.backoffStartMs ?? 5000;
	const backoffMaxMs = opts.backoffMaxMs ?? 300_000;
	const rateLimitDefaultMs = opts.rateLimitDefaultMs ?? 60_000;
	const uncertainAfter = opts.protocolUncertainThreshold ?? 3;
	const controller = new AbortController();
	const outer = opts.signal;
	const onOuterAbort = (): void => {
		try {
			controller.abort();
		} catch {
			/* ignore */
		}
	};
	if (outer?.aborted) onOuterAbort();
	else outer?.addEventListener("abort", onOuterAbort, { once: true });

	let done = false;
	store.setStatus("polling");

	const loop = (async (): Promise<void> => {
		let buf = store.getCursor().lastBuf; // 首次空串（§3 协议）
		let attempt = 0; // 连续失败计数（成功清零；决定退避档）
		let protocolStreak = 0;
		for (;;) {
			if (controller.signal.aborted) break;
			store.touchPoll();
			try {
				const res = await doFetch({
					baseUrl: opts.baseUrl,
					botToken: opts.botToken,
					buf,
					...(timeoutMs !== undefined ? { timeoutMs } : {}),
					signal: controller.signal,
				});
				if (controller.signal.aborted) break;
				const at = new Date(now()).toISOString();
				const parsed = parseBatch(res.items, at);
				const recs: InboundRecord[] = [];
				for (const item of parsed.items) {
					// 去重前置（§4.3）+ MF1：materialized=true 的真重复才跳过；claim 已持久化但落盘缺失
					// （putInbox 曾经失败）→ 幂等补写，补写成功才允许提交游标（不吞消息）。
					const claim = store.claimMessage(item.msgId);
					if (!claim.fresh && claim.materialized) {
						store.bumpCount("dedupeSkipped");
						continue;
					}
					const rec: InboundRecord = { ...item, state: "pending" };
					// MF1 收敛（0924）：计数只看“是否真的新写入”（新建 inbox 文件），
					// 不得由 claim.materialized 推断（读失败/去重裁剪会让推断偏 false → 重复计数）。
					const created = store.putInbox(rec); // fresh 或补写重放：均只落一条（文件名按 msgId 定，幂等覆盖）
					recs.push(rec);
					if (created) store.bumpCount("received");
				}
				// quarantine 也走 claim（有 msgId 时）：重放不重复计数/重复落 quarantine 记录；
				// MF1：claim 已持久化但 quarantine 行缺失 → 幂等补记（失败不吞，§4.6）。
				for (const q of parsed.quarantined) {
					if (q.msgId === null) {
						store.recordQuarantine(q);
						continue;
					}
					const claim = store.claimMessage(q.msgId);
					if (!claim.fresh && claim.materialized) continue;
					store.recordQuarantine(q);
				}
				// 全部落盘后才提交游标（§4.2）；空批也推进（§4.5）
				store.commitBatch(buf, res.buf, recs);
				buf = res.buf;
				attempt = 0;
				protocolStreak = 0;
				store.setStatus("connected");
				log(`batch ok: items=${parsed.items.length} quarantined=${parsed.quarantined.length}`);
			} catch (e) {
				if (controller.signal.aborted) break;
				if (e instanceof WechatIlinkError) {
					if (e.kind === "auth") {
						// §4.4：auth → 停 poll + 持久告警（authRequiredAt），绝不长轮询风暴。
						// 终态落盘后 return：stop()/循环收尾不得把 auth_required 改写（supervisor 读 state.json 决定不重启）。
						store.setStatus("auth_required", { lastError: e.message, bump: "authErrors" });
						log("auth error: stop polling (auth_required)");
						done = true;
						return;
					}
					if (e.kind === "rate_limited") {
						store.setStatus("polling", { lastError: e.message, bump: "rateLimited" });
						const wait = e.retryAfterMs ?? rateLimitDefaultMs;
						log(`rate_limited: wait ${wait}ms`);
						if (!(await sleepRef(wait, controller.signal))) break;
						continue; // 限流不累计退避档
					}
					const bump = e.kind === "protocol" ? "protocolErrors" : "transientErrors";
					if (e.kind === "protocol") protocolStreak += 1;
					store.setStatus(protocolStreak >= uncertainAfter ? "uncertain" : "polling", { lastError: e.message, bump });
					const delay = jitter(backoffDelayMs(attempt, backoffStartMs, backoffMaxMs));
					attempt += 1;
					log(`${e.kind} error: backoff ${delay}ms (attempt=${attempt})`);
					if (!(await sleepRef(delay, controller.signal))) break;
					continue;
				}
				// 落盘失败（claim/putInbox/commitBatch 抛）或未分类异常：不推进游标，退避重试同 buf
				const msg = e instanceof Error ? e.message : String(e);
				store.setStatus("uncertain", { lastError: `批次落盘失败（不推进游标，退避重试）：${msg}`, bump: "transientErrors" });
				const delay = jitter(backoffDelayMs(attempt, backoffStartMs, backoffMaxMs));
				attempt += 1;
				log(`batch persist failed: backoff ${delay}ms (attempt=${attempt})`);
				if (!(await sleepRef(delay, controller.signal))) break;
			}
			// 成功后的短间隔（长轮询自然节流；stub 场景防 tight-loop）
			if (!(await sleepRef(pollGapMs, controller.signal))) break;
		}
		store.setStatus("disconnected");
	})();

	const handle: WechatWorkerHandle = {
		stop: async (): Promise<void> => {
			if (controller.signal.aborted) {
				await loop.catch(() => {});
				return;
			}
			controller.abort();
			// 有界等循环退出（fetch abort + sleep abort → ms 级；防御性 10s 兜底）
			await Promise.race([loop.catch(() => {}), new Promise<void>((r) => setTimeout(r, 10_000).unref?.())]);
			// auth_required 是持久终态（supervisor 据此不重启）；其余情况记 disconnected
			if (store.readState().status !== "auth_required") store.setStatus("disconnected");
		},
		status: (): WechatWorkerStatus => {
			const s = store.readState();
			return { status: s.status, lastPollAt: s.lastPollAt, counts: s.counts, lastError: s.lastError };
		},
		ended: (): boolean => done,
	};
	void loop
		.then(() => {
			done = true;
		})
		.catch(() => {
			done = true;
		});
	return handle;
}
