#!/usr/bin/env node
/**
 * 微信 iLink 最小真网实验探针（独立脚本，不依赖 runtime/daemon）。
 *
 * 用法：
 *   node scripts/wechat-ilink-probe.mjs login [--timeout-ms N]
 *   node scripts/wechat-ilink-probe.mjs listen [--decrypt] [--out DIR] [--max-batches N] [--timeout-ms N]
 *   node scripts/wechat-ilink-probe.mjs send <toUserId> <text> [contextToken] [--client-id ID] [--with-poll]
 *   node scripts/wechat-ilink-probe.mjs reply [--from-last] <toUserId> <text...>  // 用持久化的最近入站 context_token 回复
 *   node scripts/wechat-ilink-probe.mjs typing <toUserId> [contextToken]
 *   node scripts/wechat-ilink-probe.mjs status
 *
 * 环境变量覆盖（用于 stub 测试）：
 *   WECHAT_ILINK_BASE_URL   默认 https://ilinkai.weixin.qq.com
 *   WECHAT_PROBE_DIR        默认 plans/.wechat-probe
 *   WECHAT_PROBE_TIMEOUT_MS 默认 95000（必须 >90s，见避坑#3）
 *   WECHAT_PROBE_EXTRA_HOSTS 附件 CDN 额外 allowlist，逗号分隔
 *
 * 安全：bot_token / context_token / aes_key 永不打到 stdout / measure.jsonl，
 *   只记存在性与长度。凭据文件尽量 0600（Windows 下 chmod 仅尽力，见清单文档）。
 */
import { Buffer } from "node:buffer";
import { createDecipheriv, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_TIMEOUT_MS = 95_000;
const QR_POLL_INTERVAL_MS = 2500;
const CLIENT_VERSION = "1";

const BASE_URL = (process.env.WECHAT_ILINK_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
const PROBE_DIR = process.env.WECHAT_ILINK_BASE_URL && process.env.WECHAT_PROBE_DIR
  ? process.env.WECHAT_PROBE_DIR
  : (process.env.WECHAT_PROBE_DIR || path.join("plans", ".wechat-probe"));
const CREDS_PATH = path.join(PROBE_DIR, "creds.json");
const STATE_PATH = path.join(PROBE_DIR, "state.json");
const MEASURE_PATH = path.join(PROBE_DIR, "measure.jsonl");
const LAST_CONTEXT_PATH = path.join(PROBE_DIR, "last-context.json");
const DEFAULT_OUT_DIR = path.join(PROBE_DIR, "downloads");

let aborted = false;
process.on("SIGINT", () => {
  aborted = true;
  console.log("\n[probe] SIGINT：干净退出（游标已持久化则不丢进度）。");
  process.exit(0);
});

// ---------- 小工具 ----------
function ensureDir() { fs.mkdirSync(PROBE_DIR, { recursive: true }); }
function redactPresence(v) {
  if (!v) return "<absent>";
  return `<present len=${String(v).length}>`;
}
function nowIso() { return new Date().toISOString(); }
function appendMeasure(obj) {
  ensureDir();
  fs.appendFileSync(MEASURE_PATH, JSON.stringify({ ts: nowIso(), ...obj }) + "\n", "utf8");
}
function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}
function saveJson0600(p, obj) {
  ensureDir();
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch { /* Windows：0600 仅尽力，见清单 */ }
}
function flagValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const FLAG_WITH_VALUE = new Set(["--timeout-ms", "--out", "--max-batches", "--client-id"]);
function positionalArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (FLAG_WITH_VALUE.has(args[i])) { i++; continue; }
    if (args[i].startsWith("--")) continue;
    out.push(args[i]);
  }
  return out;
}
function timeoutMsFromArgs(args) {
  const raw = flagValue(args, "--timeout-ms") ?? process.env.WECHAT_PROBE_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS);
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TIMEOUT_MS;
}
function randomUin() {
  const n = typeof globalThis.crypto?.getRandomValues === "function"
    ? globalThis.crypto.getRandomValues(new Uint32Array(1))[0]
    : Math.floor(Math.random() * 4294967295) + 1;
  return Buffer.from(String(n), "utf8").toString("base64");
}
function authHeaders(botToken) {
  return {
    "content-type": "application/json",
    "AuthorizationType": "ilink_bot_token",
    "Authorization": `Bearer ${botToken}`,
    "X-WECHAT-UIN": randomUin(),
    "iLink-App-ClientVersion": CLIENT_VERSION,
  };
}
function extraHosts() {
  return (process.env.WECHAT_PROBE_EXTRA_HOSTS || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}
const CDN_SUFFIX_ALLOW = [".qq.com", ".qpic.cn", ".weixin.qq.com", ".wx.qq.com", ".cdn.cn"];
function isHostAllowed(urlStr) {
  let host;
  try { host = new URL(urlStr).hostname.toLowerCase(); } catch { return { ok: false, host: "<invalid-url>" }; }
  const baseHost = new URL(BASE_URL).hostname.toLowerCase();
  if (host === baseHost) return { ok: true, host };
  if (extraHosts().includes(host)) return { ok: true, host };
  if (CDN_SUFFIX_ALLOW.some((s) => host.endsWith(s))) return { ok: true, host, note: "cdn-suffix" };
  return { ok: false, host };
}
async function fetchJson(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error(`HTTP 超时 ${timeoutMs}ms`)), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: opts?.signal ?? ctrl.signal });
    const text = await res.text();
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = { _raw_len: text.length }; }
    const payload = (json && typeof json === "object" && json.data && typeof json.data === "object") ? json.data : json;
    return { httpStatus: res.status, ok: res.ok, payload };
  } finally { clearTimeout(t); }
}
function parseAesKey(raw) {
  const s = String(raw || "").trim();
  if (/^[a-f0-9]{32}$/i.test(s)) return Buffer.from(s, "hex");
  try {
    const b = Buffer.from(s, "base64");
    if (b.length === 16) return b;
  } catch { /* fallthrough */ }
  return null;
}
function decryptEcb(encrypted, rawKey) {
  const key = parseAesKey(rawKey);
  if (!key) throw new Error("AES key 格式无效（需 32 hex 字符或 16 字节 base64）");
  const input = Buffer.isBuffer(encrypted) ? encrypted : Buffer.from(encrypted);
  const d = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([d.update(input), d.final()]);
}
// 纯 JS 二维码渲染：零依赖；优先尝试可选的 qrcode / qrcode-terminal（未安装则打印 URL）。
async function renderQrHint(qrUrl, qrCode) {
  for (const pkg of ["qrcode-terminal", "qrcode"]) {
    try {
      const mod = await import(pkg);
      if (pkg === "qrcode-terminal" && mod?.default?.generate) {
        mod.default.generate(qrUrl, { small: true });
        return "qrcode-terminal";
      }
    } catch { /* 未安装，继续 */ }
  }
  // 兜底：ASCII 边框 + URL（不做伪造二维码图形，避免误导扫码）。
  const line = "+-" + "-".repeat(Math.min(qrUrl.length, 60)) + "-+";
  console.log(line);
  console.log(`| ${qrUrl.slice(0, 60)} |`);
  console.log(line);
  console.log(`[probe] 未检测到二维码库，已打印 URL。请用以下任一方式扫码：`);
  console.log(`  1) 浏览器打开上方 URL 看图扫码；2) npm i -D qrcode-terminal 后重跑 login。`);
  console.log(`[probe] 轮询凭证 qrcode: ${redactPresence(qrCode)}`);
  return "url-only";
}

// ---------- 子命令 ----------
async function cmdLogin(args) {
  const timeoutMs = timeoutMsFromArgs(args);
  console.log(`[probe] base=${new URL(BASE_URL).hostname} timeout=${timeoutMs}ms`);
  const { httpStatus, ok, payload } = await fetchJson(
    `${BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`,
    { method: "GET", headers: { "iLink-App-ClientVersion": CLIENT_VERSION } }, timeoutMs);
  if (!ok) throw new Error(`申请二维码失败: HTTP ${httpStatus}`);
  const ret = payload.ret ?? payload.errcode ?? 0;
  if (ret !== 0) throw new Error(`申请二维码失败: ret=${ret} errmsg=${payload.errmsg || "?"}`);
  const qrCode = String(payload.qrcode || payload.qr_code || "");
  const qrUrl = String(payload.qrcode_img_content || payload.qrcode_url || "");
  if (!qrCode || !qrUrl) throw new Error("微信未返回有效的二维码数据");
  console.log(`[probe] 请用手机微信扫码（${payload.expires_in || 120}s 内有效）：`);
  await renderQrHint(qrUrl, qrCode);
  // 每 2.5s 轮询直到 confirmed / expired
  for (;;) {
    if (aborted) return;
    await new Promise((r) => setTimeout(r, QR_POLL_INTERVAL_MS));
    const st = await fetchJson(
      `${BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrCode)}`,
      { method: "GET", headers: { "iLink-App-ClientVersion": CLIENT_VERSION } }, timeoutMs);
    if (!st.ok) {
      console.log(`[probe] 轮询 HTTP ${st.httpStatus}，继续…`);
      appendMeasure({ kind: "api_error", op: "get_qrcode_status", httpStatus: st.httpStatus });
      continue;
    }
    const raw = st.payload.status ?? st.payload.qrcode_status;
    const s = typeof raw === "number"
      ? (raw === 2 ? "confirmed" : raw === 1 ? "scanned" : raw === 0 ? "pending" : "expired")
      : String(raw || "").toLowerCase();
    if (s === "confirmed" || s === "success" || s === "authorized" || s === "ok") {
      const botToken = String(st.payload.bot_token || st.payload.token || "");
      const botId = st.payload.ilink_bot_id || st.payload.bot_id
        ? String(st.payload.ilink_bot_id || st.payload.bot_id) : undefined;
      if (!botToken) throw new Error("扫码成功但未获取到 bot_token");
      const loginTs = nowIso();
      saveJson0600(CREDS_PATH, { botToken, botId, loginTs, baseUrl: BASE_URL });
      appendMeasure({ kind: "login_ok", loginTs, botIdPresent: Boolean(botId) });
      console.log(`[probe] 登录成功。凭据已存 ${CREDS_PATH}（0600 尽力）。bot_token: ${redactPresence(botToken)}`);
      console.log(`[probe] 下一步：node scripts/wechat-ilink-probe.mjs listen`);
      return;
    }
    if (["expired", "timeout", "cancel", "cancelled"].includes(s) || raw === 3 || raw === 4) {
      console.log("[probe] 二维码已过期，请重跑 login。");
      appendMeasure({ kind: "qr_expired" });
      return;
    }
    console.log(`[probe] 状态=${s === "scanned" ? "scanned（已扫码，请在手机端点确认登录）" : "pending（等待扫码）"}…`);
  }
}

function loadCredsOrThrow() {
  const c = loadJson(CREDS_PATH, null);
  if (!c?.botToken) throw new Error(`无凭据：先跑 login（期望 ${CREDS_PATH}）。`);
  return c;
}

function saveLastContext(msg) {
  // 私密持久化：只写文件，日志里只出现路径与存在性，绝不打印 token 原文。
  saveJson0600(LAST_CONTEXT_PATH, {
    toUserId: msg.senderId, msgId: msg.id, ts: nowIso(),
    contextToken: msg._contextToken,
  });
}

function loadLastContextOrThrow() {
  const r = loadJson(LAST_CONTEXT_PATH, null);
  if (!r?.contextToken) {
    throw new Error(`还没有收到任何入站消息，请先 listen 并让手机发一条（期望 ${LAST_CONTEXT_PATH}）。`);
  }
  return r;
}

function printInboundMessage(m, index) {
  // 只打印脱敏字段：id / sender / 文本 / 附件元数据（无 aes_key、无 token）。
  console.log(`--- inbound #${index} id=${m.id} from=${m.senderId}${m.displayName ? `(${m.displayName})` : ""}`);
  if (m.text) console.log(`    text: ${m.text.slice(0, 500)}`);
  if (m.contextTokenPresent) console.log(`    context_token: <present>（回复时自动回传，不打印原文）`);
  for (const a of (m.attachments || [])) {
    console.log(`    attach: kind=${a.kind} name=${a.filename} size=${a.sizeBytes ?? "?"} host=${a.host} aesKey=<${a.aesKeyPresent ? "present" : "absent"}>`);
  }
}

function normalizeUpdates(payload, prevBuf) {
  const rawList = Array.isArray(payload.item_list) ? payload.item_list
    : Array.isArray(payload.messages) ? payload.messages
    : Array.isArray(payload.msgs) ? payload.msgs : [];
  const messages = [];
  for (const raw of rawList) {
    const msg = (raw.msg && typeof raw.msg === "object" ? raw.msg : raw);
    const from = (msg.from && typeof msg.from === "object" ? msg.from : raw.from) || {};
    const senderId = String(from.id || from.wxid || from.user_id || msg.from_user_id || raw.from_user_id || "");
    if (!senderId) continue;
    let text = "";
    if (typeof msg.text === "string") text = msg.text;
    else if (typeof msg.content === "string") text = msg.content;
    else if (Array.isArray(msg.item_list)) {
      text = msg.item_list.map((it) => String(it?.text_item?.text || "")).filter(Boolean).join("\n");
    }
    const attachments = [];
    if (Array.isArray(msg.item_list)) {
      for (const it of msg.item_list) {
        const media = it?.image_item || it?.file_item || it?.video_item || it?.audio_item;
        if (!media) continue;
        const url = String(media.url || media.download_url || "");
        const gate = url ? isHostAllowed(url) : { ok: false, host: "<empty>" };
        attachments.push({
          kind: it.image_item ? "image" : it.audio_item ? "audio" : it.video_item ? "video" : "file",
          filename: String(media.filename || media.file_name || "unnamed"),
          sizeBytes: typeof media.size === "number" ? media.size : undefined,
          fileId: String(media.file_id || media.media_id || ""),
          host: gate.host,
          hostAllowed: gate.ok,
          aesKeyPresent: Boolean(media.aes_key || media.aeskey),
          _url: gate.ok ? url : undefined,           // 内存态仅保留，绝不打印/落盘
          _aesKey: gate.ok ? String(media.aes_key || media.aeskey || "") : undefined,
        });
        appendMeasure({
          kind: "attachment_meta",
          host: gate.host, allowed: gate.ok,
          sizeBytes: typeof media.size === "number" ? media.size : null,
        });
      }
    }
    messages.push({
      id: String(msg.id || msg.msg_id || raw.id || ""),
      senderId, displayName: typeof from.nickname === "string" ? from.nickname : undefined,
      text, attachments,
      contextTokenPresent: Boolean(msg.context_token || raw.context_token),
      _contextToken: String(msg.context_token || raw.context_token || ""),
    });
  }
  const nextBuf = String(payload.buf || payload.next_buf || payload.get_updates_buf || prevBuf);
  return { messages, nextBuf };
}

async function cmdListen(args) {
  const timeoutMs = timeoutMsFromArgs(args);
  const doDecrypt = args.includes("--decrypt");
  const outDir = flagValue(args, "--out") || DEFAULT_OUT_DIR;
  const maxBRaw = flagValue(args, "--max-batches") ?? process.env.WECHAT_PROBE_MAX_BATCHES ?? "Infinity";
  const maxB = Number(maxBRaw);
  const { botToken } = loadCredsOrThrow();
  const creds = loadJson(CREDS_PATH, {});
  let state = loadJson(STATE_PATH, { buf: "", seenIds: [], lastMeasurement: null });
  const seen = new Set(state.seenIds || []);
  if (doDecrypt) fs.mkdirSync(outDir, { recursive: true });
  console.log(`[probe] listen 启动：buf=${state.buf ? `<present len=${state.buf.length}>` : "<empty>"} decrypt=${doDecrypt} timeout=${timeoutMs}ms`);
  let batches = 0;
  for (;;) {
    if (aborted || batches >= maxB) break;
    const bufIn = state.buf || "";
    let res;
    try {
      res = await fetchJson(`${BASE_URL}/ilink/bot/getupdates`, {
        method: "POST", headers: authHeaders(botToken),
        body: JSON.stringify({ base_info: { channel_version: "2.0.0" }, get_updates_buf: bufIn }),
      }, timeoutMs);
    } catch (e) {
      console.log(`[probe] 长轮询异常：${e.message}，5s 后退避重试…`);
      appendMeasure({ kind: "api_error", op: "getupdates", error: String(e.message).slice(0, 120) });
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    if (!res.ok) {
      console.log(`[probe] getupdates HTTP ${res.httpStatus}（bot_token 有效性见 measure.jsonl 的 api_error + login_ok 时间差）`);
      appendMeasure({ kind: "api_error", op: "getupdates", httpStatus: res.httpStatus, loginTs: creds.loginTs || null });
      if (res.httpStatus === 401 || res.httpStatus === 403) {
        console.log("[probe] 401/403：bot_token 疑似失效，重跑 login。");
        return;
      }
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    const ret = res.payload.ret ?? res.payload.errcode ?? 0;
    if (ret !== 0) {
      console.log(`[probe] getupdates ret=${ret} errmsg=${String(res.payload.errmsg || "?").slice(0, 80)}`);
      appendMeasure({ kind: "api_error", op: "getupdates", ret, loginTs: creds.loginTs || null });
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    const { messages, nextBuf } = normalizeUpdates(res.payload, bufIn);
    // 未知项 ③④：重放检测 + 空批是否推进 buf
    const dupIds = messages.filter((m) => seen.has(m.id)).map((m) => m.id);
    const bufAdvanced = nextBuf !== bufIn;
    appendMeasure({
      kind: "updates_batch", count: messages.length,
      bufInEmpty: bufIn === "", bufAdvanced,
      replayDetected: dupIds.length > 0, replayCount: dupIds.length,
    });
    if (messages.length === 0) {
      appendMeasure({ kind: "empty_batch_buf_advanced", advanced: bufAdvanced });
      console.log(`[probe] 空批：buf ${bufAdvanced ? "推进" : "未推进"}。`);
    }
    let n = 0;
    let lastWithToken = null;
    for (const m of messages) {
      if (seen.has(m.id)) { console.log(`[probe] 去重跳过 id=${m.id}（同一 buf 重放）`); continue; }
      seen.add(m.id);
      printInboundMessage({ ...m, contextTokenPresent: m.contextTokenPresent }, ++n);
      if (m._contextToken) lastWithToken = m;
      if (doDecrypt) {
        for (const a of m.attachments) {
          if (!a._url || !a._aesKey) { console.log(`    [decrypt] 跳过 ${a.filename}（缺 URL/key 或 host 被拦截）`); continue; }
          try {
            const dl = await fetch(a._url, { signal: AbortSignal.timeout(timeoutMs) });
            if (!dl.ok) { console.log(`    [decrypt] 下载失败 HTTP ${dl.status}`); continue; }
            const plain = decryptEcb(Buffer.from(await dl.arrayBuffer()), a._aesKey);
            const fp = path.join(outDir, `${m.id}_${a.filename}`.replace(/[\\/:*?"<>|]/g, "_"));
            fs.writeFileSync(fp, plain);
            console.log(`    [decrypt] 已保存 ${fp} (${plain.length}B)`);
          } catch (e) { console.log(`    [decrypt] 失败：${String(e.message).slice(0, 100)}`); }
        }
      }
    }
    state = { buf: nextBuf, seenIds: [...seen].slice(-500), lastMeasurement: nowIso() };
    saveJson0600(STATE_PATH, state);   // 游标每批持久化，Ctrl+C 不丢
    if (lastWithToken) {
      saveLastContext(lastWithToken);
      // 只写路径与存在性，不打印 token 原文。
      console.log(`[probe] 已更新最近入站 context：${LAST_CONTEXT_PATH}（context_token: ${redactPresence(lastWithToken._contextToken)}，from=${lastWithToken.senderId}）`);
    }
    batches++;
    if (batches >= maxB) break;
  }
  console.log(`[probe] listen 结束：共 ${batches} 批，游标已存 ${STATE_PATH}。`);
}

async function cmdSend(args) {
  const timeoutMs = timeoutMsFromArgs(args);
  const [toUserId, text, contextToken] = positionalArgs(args);
  if (!toUserId || !text) throw new Error("用法：send <toUserId> <text> [contextToken] [--client-id ID] [--with-poll]");
  const clientIdOpt = flagValue(args, "--client-id");
  const clientId = clientIdOpt || randomUUID();
  const withPoll = args.includes("--with-poll");
  const { botToken } = loadCredsOrThrow();
  const body = {
    base_info: { channel_version: "2.0.0" },
    msg: {
      from_user_id: "", to_user_id: toUserId, client_id: clientId,
      message_type: 2, message_state: 2,
      ...(contextToken ? { context_token: contextToken } : {}),
      item_list: [{ type: 1, text_item: { text } }],
    },
  };
  const doSend = () => fetchJson(`${BASE_URL}/ilink/bot/sendmessage`, {
    method: "POST", headers: authHeaders(botToken), body: JSON.stringify(body),
  }, timeoutMs);
  let res;
  if (withPoll) {
    // 未知项 ⑥：同 token 并发 poll+send 是否限流
    const state = loadJson(STATE_PATH, { buf: "" });
    const [s, p] = await Promise.allSettled([doSend(), fetchJson(`${BASE_URL}/ilink/bot/getupdates`, {
      method: "POST", headers: authHeaders(botToken),
      body: JSON.stringify({ base_info: { channel_version: "2.0.0" }, get_updates_buf: state.buf || "" }),
    }, timeoutMs)]);
    res = s.status === "fulfilled" ? s.value : { httpStatus: 0, ok: false, payload: { _error: String(s.reason).slice(0, 120) } };
    const pollSt = p.status === "fulfilled" ? p.value.httpStatus : 0;
    appendMeasure({ kind: "concurrency_probe", sendHttp: res.httpStatus, pollHttp: pollSt });
    if (res.httpStatus === 429 || pollSt === 429) console.log("[probe] 观察到 429：同 token 并发被限流。");
    else console.log(`[probe] 并发完成：send=${res.httpStatus} poll=${pollSt}（均非 429 则暂无线流证据）`);
  } else {
    res = await doSend();
  }
  const ret = res.payload?.ret ?? res.payload?.errcode ?? (res.ok ? 0 : res.httpStatus);
  appendMeasure({ kind: "send_dedup", clientIdReused: Boolean(clientIdOpt), httpStatus: res.httpStatus, ret });
  if (contextToken !== undefined) {
    appendMeasure({ kind: "context_token_result", op: "sendmessage", ok: res.ok && ret === 0, ret });
  }
  if (!res.ok || ret !== 0) {
    console.log(`[probe] send 失败：HTTP ${res.httpStatus} ret=${ret}（context_token 过期常表现为非 0 ret，见 measure.jsonl）`);
    return;
  }
  console.log(`[probe] send 成功（client_id=${clientId}）。固定 client_id 重发可测去重，见清单步骤③⑤。`);
}

async function cmdReply(args) {
  const timeoutMs = timeoutMsFromArgs(args);
  const fromLast = args.includes("--from-last");
  const pos = positionalArgs(args);
  let toUserId, text;
  if (fromLast) {
    if (pos.length < 1) throw new Error("用法：reply --from-last <text...>");
    text = pos.join(" ");
  } else {
    if (pos.length < 2) throw new Error("用法：reply [--from-last] <toUserId> <text...>");
    toUserId = pos[0];
    text = pos.slice(1).join(" ");
  }
  // 跨进程可用：token 来自私密状态文件，绝不要求用户手工粘贴。
  const record = loadLastContextOrThrow();
  if (fromLast) toUserId = record.toUserId;
  if (!toUserId) throw new Error(`最近入站记录缺少 toUserId，请显式传 toUserId（期望 ${LAST_CONTEXT_PATH}）。`);
  const { botToken } = loadCredsOrThrow();
  const contextToken = record.contextToken;
  const body = {
    base_info: { channel_version: "2.0.0" },
    msg: {
      from_user_id: "", to_user_id: toUserId, client_id: randomUUID(),
      message_type: 2, message_state: 2,
      context_token: contextToken,
      item_list: [{ type: 1, text_item: { text } }],
    },
  };
  console.log(`[probe] reply：to=${toUserId} context_token=${redactPresence(contextToken)} fromLast=${fromLast}`);
  const res = await fetchJson(`${BASE_URL}/ilink/bot/sendmessage`, {
    method: "POST", headers: authHeaders(botToken), body: JSON.stringify(body),
  }, timeoutMs);
  const ret = res.payload?.ret ?? res.payload?.errcode ?? (res.ok ? 0 : res.httpStatus);
  const ok = res.ok && ret === 0;
  // 测量：是否成功用持久化的 context_token 回复（不含 token 原文）。
  appendMeasure({ kind: "context_token_result", op: "reply", ok, ret, httpStatus: res.httpStatus, fromLast });
  if (!ok) {
    console.log(`[probe] reply 失败：HTTP ${res.httpStatus} ret=${ret}（context_token 过期常表现为非 0 ret，见 measure.jsonl）`);
    return;
  }
  console.log(`[probe] reply 成功（to=${toUserId}）。`);
}

async function cmdTyping(args) {
  const timeoutMs = timeoutMsFromArgs(args);
  const [toUserId, contextToken] = positionalArgs(args);
  if (!toUserId) throw new Error("用法：typing <toUserId> [contextToken]");
  const { botToken } = loadCredsOrThrow();
  const cfg = await fetchJson(`${BASE_URL}/ilink/bot/getconfig`, {
    method: "POST", headers: authHeaders(botToken),
    body: JSON.stringify({ ilink_user_id: toUserId, ...(contextToken ? { context_token: contextToken } : {}) }),
  }, timeoutMs);
  const ticket = String(cfg.payload?.typing_ticket || "");
  if (!cfg.ok || !ticket) {
    console.log(`[probe] getconfig 未拿到 typing_ticket（HTTP ${cfg.httpStatus}）。`);
    appendMeasure({ kind: "context_token_result", op: "getconfig", ok: false, httpStatus: cfg.httpStatus });
    return;
  }
  const res = await fetchJson(`${BASE_URL}/ilink/bot/sendtyping`, {
    method: "POST", headers: authHeaders(botToken),
    body: JSON.stringify({ ilink_user_id: toUserId, typing_ticket: ticket, status: 1 }),
  }, timeoutMs);
  console.log(res.ok ? "[probe] typing 已发送。" : `[probe] sendtyping HTTP ${res.httpStatus}`);
  appendMeasure({ kind: "context_token_result", op: "sendtyping", ok: res.ok, httpStatus: res.httpStatus });
}

function cmdStatus() {
  const creds = loadJson(CREDS_PATH, null);
  const state = loadJson(STATE_PATH, null);
  const lastCtx = loadJson(LAST_CONTEXT_PATH, null);
  let measures = [];
  try {
    const lines = fs.readFileSync(MEASURE_PATH, "utf8").split("\n").filter(Boolean);
    measures = lines.slice(-5).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { /* 无日志 */ }
  console.log(JSON.stringify({
    credsPath: CREDS_PATH,
    loggedIn: Boolean(creds?.botToken),
    botToken: redactPresence(creds?.botToken),   // 只给存在性+长度
    botIdPresent: Boolean(creds?.botId),
    loginTs: creds?.loginTs || null,
    bufPresent: Boolean(state?.buf), bufLen: state?.buf?.length || 0,
    seenCount: state?.seenIds?.length || 0,
    lastContextPath: LAST_CONTEXT_PATH,
    lastContextPresent: Boolean(lastCtx?.contextToken),
    lastContextToken: redactPresence(lastCtx?.contextToken),
    lastContextFrom: lastCtx?.toUserId || null,
    lastContextTs: lastCtx?.ts || null,
    lastMeasurement: state?.lastMeasurement || null,
    recentMeasures: measures,
  }, null, 2));
}

// ---------- 入口 ----------
const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === "login") await cmdLogin(rest);
  else if (cmd === "listen") await cmdListen(rest);
  else if (cmd === "send") await cmdSend(rest);
  else if (cmd === "reply") await cmdReply(rest);
  else if (cmd === "typing") await cmdTyping(rest);
  else if (cmd === "status") cmdStatus();
  else {
    console.error("用法：login | listen [--decrypt] | send <toUserId> <text> [contextToken] | reply [--from-last] <toUserId> <text...> | typing <toUserId> [contextToken] | status");
    process.exit(2);
  }
} catch (e) {
  console.error(`[probe] 错误：${e.message}`);
  process.exit(1);
}
