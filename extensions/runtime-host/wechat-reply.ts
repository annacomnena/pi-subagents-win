import { appendFileSync, chmodSync, closeSync, mkdirSync, openSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { listReplyIntents, incrementReplyAttempts, markReplyIntent, replyIntentDir } from "../runtime/wechat-reply.ts";
import { sendMessage } from "../channel-wechat/send.ts";
import { WechatStore } from "../channel-wechat/store.ts";
import { readWechatCreds, readWechatReplyConfig, wechatCredsPath, readWechatConfigPath, maskWechatOpenId, type WechatFetch } from "./wechat-bind.ts";
import { authorizeBroadcastRecipient, readOutboundOwnerOpenId, type OutboundAuthContext } from "./wechat-outbound-auth.ts";

/**
 * 广播意图 TTL（计划 §5，用户裁定④：10min 常量，不配置化）：createdAt 超过仍 pending →
 * mark failed(broadcast-expired)，**先于 connected 门**判定——防通道长断恢复后陈旧回复倾泻。
 * reply intent 不受 TTL 影响（旧行为红线）。
 */
export const BROADCAST_INTENT_TTL_MS = 10 * 60_000;

export interface WechatReplyWatcherOptions {
 runtimeDir: string; stateDir?: string; configPath?: string; fetchImpl?: WechatFetch; intervalMs?: number;
 readConfig?: typeof readWechatReplyConfig;
}
function audit(stateDir: string, row: Record<string, unknown>): void {
 try { mkdirSync(stateDir, { recursive: true }); const file = join(stateDir, "wechat-reply-audit.jsonl"); const fd = openSync(file, "a", 0o600); try { appendFileSync(fd, JSON.stringify(row) + "\n"); } finally { closeSync(fd); } try { chmodSync(file, 0o600); } catch {} } catch {}
}

export function startWechatReplyWatcher(opts: WechatReplyWatcherOptions): () => void {
 const stateDir = opts.stateDir ?? join(opts.runtimeDir, "state");
 const intentDir = replyIntentDir(stateDir);
 const configPath = opts.configPath ?? readWechatConfigPath();
 const readConfig = opts.readConfig ?? readWechatReplyConfig;
 let busy = false, stopped = false, debounce: ReturnType<typeof setTimeout> | null = null;
 const run = async (): Promise<void> => {
  if (busy || stopped) return; busy = true;
  try {
   const cfg = readConfig(configPath);
   // 旧行为：reply.enabled=false → 整轮不消费、intent 保留 pending（reply/broadcast 红线不变）。
   // L4-S2 例外：**命令回执（kind="command"）豁免此门**——否则远程 `/wechat reply off` 的回执
   // （以及之后所有命令回执）会被这道门自己关在 pending，直到 reply 重新开启才发出（陈旧回执）。
   const replyEnabled = cfg.enabled === true;
   // 0925 P0 出站收件授权二次复核上下文（每轮现读一次：owner 从 credentials，allowOut 来自本轮 cfg）。
   // 解绑/换绑、撤销订阅、凭据损坏 → 本轮立即反映；授权是收件人的永久属性，与 mode 开关无关。
   let authCtx: OutboundAuthContext | null = null;
   const outboundAuth = (): OutboundAuthContext => (authCtx ??= { ownerOpenId: readOutboundOwnerOpenId(opts.runtimeDir), allowOut: cfg.allowOut ?? [] });
   // 接收 worker 在线状态（每轮 run 新建实例读——readState 实例内缓存，复用会陈旧；recon⑥/计划 §5）。
   // 懒读：仅当本轮遇到 pending broadcast intent 时读一次；reply-only 路径零额外 IO。
   let receiveStatus: string | null = null;
   for (const item of listReplyIntents(intentDir)) {
    if (stopped) break;
    if (item.status !== "pending") continue;
    // S2：reply.enabled=false 时只放行命令回执；reply/broadcast 仍 preserve pending（旧行为红线）。
    if (!replyEnabled && item.kind !== "command") continue;
    // 0925 P0（astra §二第 1 项 3）：**真正发送前再次检查收件授权**——即使 intent 是旧版已排队的、
    // 收件人已撤销订阅/已解绑换绑，也在出站前拦下。门序：enabled → 授权 → mode → attempts → TTL → connected
    //   - 放在 mode 门**之前**：撤权不等开关（当前 mode=reply-only 也要把历史撤权广播终态化，不等翻回再发）；
    //   - 放在 enabled 门**之后**：保留「enabled=false 全关、pending 不动」既有红线；重新 enabled 后授权门
    //     首先执行，撤权 intent 终态、绝不复活；
    //   - 放在 attempts 之前：未授权的绝不能走到 increment/send（attempts 是出站侧状态）。
    // 终态 = failed + error:"broadcast-unauthorized"（复用既有终态枚举，不扩 status enum、不碰重试策略）
    // + 一行 event:"denied" 审计（掩码 fromId + 具体 authz reason，可解释）。
    if (item.kind === "broadcast") {
     const decision = authorizeBroadcastRecipient(item.fromId, outboundAuth());
     if (!decision.authorized) {
      const base0 = { at: new Date().toISOString(), msgId: maskWechatOpenId(item.msgId), from: maskWechatOpenId(item.fromId) };
      if (markReplyIntent(intentDir, item.id, { status: "failed", error: "broadcast-unauthorized" })) audit(stateDir, { ...base0, kind: "broadcast", event: "denied", reason: "broadcast-unauthorized", authz: decision.reason });
      continue;
     }
    }
    // M1（L4 必须修）：mode 已回滚到 reply-only → broadcast intent 整轮跳过（保留 pending、
    // 零审计，与 enabled=false 同形态；TTL 窗口照走，翻回 broadcast 后过期即 failed、未过期续发）。
    // reply intent（无 kind）不进此分支——旧路径红线不变。
    if (item.kind === "broadcast" && cfg.mode !== "broadcast") continue;
    const base = { at: new Date().toISOString(), msgId: maskWechatOpenId(item.msgId), from: maskWechatOpenId(item.fromId) };
    if (item.attempts >= 1) {
     const updated = markReplyIntent(intentDir, item.id, { status: "unknown", error: "attempts-exhausted" });
     if (updated) audit(stateDir, { ...base, event: "unknown", reason: "attempts-exhausted" });
     continue;
    }
    if (item.kind === "broadcast") {
     // ① TTL（先于 connected 门）：过期即终态 failed，不发。
     const age = Date.now() - Date.parse(item.createdAt);
     // S2：createdAt 不可解析（Date.parse → NaN）→ fail-closed 判过期（防倾泻方向），不落 connected 门。
     if (!Number.isFinite(age) || age > BROADCAST_INTENT_TTL_MS) {
      if (markReplyIntent(intentDir, item.id, { status: "failed", error: "broadcast-expired" })) audit(stateDir, { ...base, kind: "broadcast", event: "failed", reason: "broadcast-expired" });
      continue;
    }
     // ② connected 门（用户裁定④：status==="connected" 才出站）；非 connected 保留 pending
     //    排队顺延（下个 tick 状态转 connected 即续发），不 mark failed、不丢。
     if (receiveStatus === null) { try { receiveStatus = new WechatStore(WechatStore.resolveDir(opts.runtimeDir)).readState().status; } catch { receiveStatus = "disconnected"; } }
     if (receiveStatus !== "connected") { audit(stateDir, { ...base, kind: "broadcast", event: "skipped", reason: "channel-not-connected" }); continue; }
    }
    // reply intent（kind 缺省）不加 connected 门/TTL——旧行为红线，S5 原断言不动。
    const creds = readWechatCreds(wechatCredsPath(opts.runtimeDir));
    if (!creds) { audit(stateDir, { ...base, event: "skipped", reason: "no-credentials" }); continue; }
    // Persist the attempt before any network request: a crash thereafter is conservatively unknown.
    const attempted = incrementReplyAttempts(intentDir, item.id);
    if (!attempted) continue;
    const result = await sendMessage({ baseUrl: creds.baseUrl, botToken: creds.botToken, toUserId: attempted.fromId, clientId: attempted.clientId, text: attempted.text }, opts.fetchImpl);
    if (result.kind === "sent") {
     if (markReplyIntent(intentDir, item.id, { status: "sent" })) audit(stateDir, { ...base, event: "sent" });
    } else if (result.kind === "failed") {
     const summary = `${result.error.kind}:${result.error.status ?? ""}:${result.error.ret ?? ""}`;
     if (markReplyIntent(intentDir, item.id, { status: "failed", error: summary })) audit(stateDir, { ...base, event: "failed", error: summary });
    } else {
     if (markReplyIntent(intentDir, item.id, { status: "unknown", error: "send-result-unknown" })) audit(stateDir, { ...base, event: "unknown", error: "send-result-unknown" });
    }
   }
  } catch { /* watcher is never-throw */ } finally { busy = false; }
 };
 let watcher: FSWatcher | null = null;
 try { watcher = watch(intentDir, () => { if (debounce) clearTimeout(debounce); debounce = setTimeout(() => { void run(); }, 200); debounce.unref?.(); }); } catch {}
 const tick = setInterval(() => { void run(); }, opts.intervalMs ?? 5000); tick.unref?.(); void run();
 return () => { stopped = true; clearInterval(tick); if (debounce) clearTimeout(debounce); try { watcher?.close(); } catch {} };
}
