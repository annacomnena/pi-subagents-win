#!/usr/bin/env node
/**
 * 微信 iLink 最小真网实验探针（独立脚本，不依赖 runtime/daemon）。
 *
 * 用法：
 *   node scripts/wechat-ilink-probe.mjs login [--timeout-ms N]
 *   node scripts/wechat-ilink-probe.mjs listen [--raw-items] [--decrypt] [--out DIR] [--max-batches N]
 *                                                [--short] [--stop-on-hit] [--timeout-ms N]
 *       --short = --max-batches 3 + --stop-on-hit：短跑，抓到一批新消息就收，少占游标（用户只发一次也能抓到）。
 *   node scripts/wechat-ilink-probe.mjs send <toUserId> <text> [contextToken] [--client-id ID] [--with-poll]
 *   node scripts/wechat-ilink-probe.mjs reply [--from-last] <toUserId> <text...>  // 用持久化的最近入站 context_token 回复
 *   node scripts/wechat-ilink-probe.mjs typing <toUserId> [contextToken]
 *   node scripts/wechat-ilink-probe.mjs status
 *
 * 探针阶段（M0，plans/0924_wechat_media_gateway_research.md §3.4 P1–P8）实验子命令：
 *   node scripts/wechat-ilink-probe.mjs upload-probe [--to <uid>] [--creds host|probe]
 *       P5：出站媒体硬前置门——候选 upload 端点存在性（最小请求，无用户可见副作用）。
 *           同时打 1 个已知端点 + 1 个负控制路径，用于判读 401/403 是否只说明“鉴权先于路由”。
 *   node scripts/wechat-ilink-probe.mjs listen --raw-items
 *       P1：入站 item 形状采集——**每个 item type（type=1/2/3/4…）逐条**落盘完整键名签名到 items.jsonl，
 *           字符串值一律降为 "string"、文本只记 textLen（不记任何原文/URL/key）。
 *   node scripts/wechat-ilink-probe.mjs conc [--mode read|send] [--n 3]
 *       P4：并发限流。read = 并发只读 getconfig（安全，可直接跑）；
 *           send = 真·poll+send，走既有 `send --with-poll`，需用户同意后手动执行。
 *   node scripts/wechat-ilink-probe.mjs media-probe [--stage pre|cdn|send] [--consent cdn|send] [--file F] [--caption T]
 *       P6：出站两段式上传。pre = getuploadurl（无副作用，可直接跑）；
 *           cdn = 密文 POST 到微信 CDN（写第三方存储，需 --consent cdn）；
 *           send = 再发一条带图片 item 的 sendmessage（**会打扰用户**，需 --consent send + 手机端人工确认）。
 *           cdn/send 的请求形状取自两份独立 C 级实现（Hermes weixin.py / photon-hq），脚本内已标注。
 *   P2/P3/P6/P8 用既有 `send` / `listen` 组合完成（见探针报告里的命令清单），不另造端点。
 *
 * 凭据（红线）：优先用本探针自己的 plans/.wechat-probe/creds.json；缺失时回退 host 侧
 *   <runtimeDir>/wechat/credentials.json，读法与 extensions/runtime-host/wechat-bind.ts#readWechatCreds
 *   严格同口径（botToken/boundAt/baseUrl 三串必须非空，坏 JSON → null）。token 永不打印/落盘到 measure。
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
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
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
const ITEMS_PATH = path.join(PROBE_DIR, "items.jsonl");   // P1 item 形状签名（脱敏）
// 附件落盘固定 <tmp>/wechat-probe/attachments/（不进仓库、不进 plans/）；--out 可覆盖。
// 命名：<msgId>_<kind>_<序号>.<ext>；只记 kind/host/hops/plainBytes，不记 URL/key/密文。
const DEFAULT_OUT_DIR = path.join(os.tmpdir(), "wechat-probe", "attachments");

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
const FLAG_WITH_VALUE = new Set(["--timeout-ms", "--out", "--max-batches", "--client-id", "--creds", "--to", "--mode", "--n"]);
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
    // Retry-After 只在 429/503 出现，是限流证据，非秘密 → 记录（P4/S1）。
    const retryAfter = res.headers.get("retry-after");
    const topKeys = (json && typeof json === "object") ? Object.keys(json) : [];
    return { httpStatus: res.status, ok: res.ok, payload, retryAfter, bodyBytes: text.length, topKeys };
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

/** host 侧凭据路径：与 runtime/journal.ts#defaultRuntimeDir + wechat-bind.ts#wechatCredsPath 同口径。 */
function hostRuntimeDir() {
  const override = (process.env.PI_RUNTIME_DIR || "").trim();
  return override ? override : path.join(os.homedir(), ".pi", "agent", "runtime");
}
function hostCredsPath() {
  return path.join(hostRuntimeDir(), "wechat", "credentials.json");
}
/** host 凭据读法：与 extensions/runtime-host/wechat-bind.ts#readWechatCreds 严格同口径
 *  （botToken/boundAt/baseUrl 三串必须非空；坏 JSON/缺字段 → null；错误信息不含 token 原文）。 */
function readHostCreds() {
  try {
    const raw = JSON.parse(fs.readFileSync(hostCredsPath(), "utf8"));
    if (typeof raw.botToken !== "string" || raw.botToken.length === 0) return null;
    if (typeof raw.boundAt !== "string" || raw.boundAt.length === 0) return null;
    if (typeof raw.baseUrl !== "string" || raw.baseUrl.length === 0) return null;
    return { botToken: raw.botToken, boundAt: raw.boundAt, baseUrl: raw.baseUrl };
  } catch {
    return null;
  }
}
/** 凭据解析：缺省 probe creds 优先（历史口径），无则回退 host 只读凭据；`--creds host|probe` 可强制。
 *  只返回 token 本身供内存内构造鉴权头，日志只打来源路径与存在性。 */
function loadCredsOrThrow(args = []) {
  const want = flagValue(args, "--creds");
  if (want !== "host") {
    const c = loadJson(CREDS_PATH, null);
    if (c?.botToken) return { botToken: c.botToken, source: CREDS_PATH, loginTs: c.loginTs };
    if (want === "probe") throw new Error(`无凭据：先跑 login（期望 ${CREDS_PATH}）。`);
  }
  const h = readHostCreds();
  if (!h) throw new Error(`无凭据：probe(${CREDS_PATH}) 与 host(${hostCredsPath()}) 均无可用 bot_token；先 login 或完成绑定。`);
  console.log(`[probe] 凭据来源：host ${hostCredsPath()}（bot_token: ${redactPresence(h.botToken)}）`);
  return { botToken: h.botToken, source: hostCredsPath(), loginTs: h.boundAt };
}

/** 最近入站发件人（P5 的 to_user_id 占位用真实值）：probe 自己的 last-context → host inbox 最新记录。 */
function latestInboxFromId() {
  const lc = loadJson(LAST_CONTEXT_PATH, null);
  if (lc?.toUserId) return String(lc.toUserId);
  try {
    const dir = path.join(hostRuntimeDir(), "wechat", "receive", "inbox");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    for (let i = files.length - 1; i >= 0; i--) {
      const o = loadJson(path.join(dir, files[i]), null);
      if (o?.fromId) return String(o.fromId);
    }
  } catch { /* host inbox 不可用则返回空串，由调用方决定是否继续 */ }
  return "";
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
    // 只打字段路径与 host：绝不打 URL 原文 / key 原文。
    console.log(`    attach: kind=${a.kind} variant=${a.variantKey} name=${a.filename} size=${a.sizeBytes ?? "?"} midSize=${a.midSize ?? "-"} host=${a.host} urlPath=${a.urlPath ?? "-"} keyPath=${a.aesKeyPath ?? "-"} shape=${a.shape} aesKey=<${a.aesKeyPresent ? "present" : "absent"}>`);
  }
}

/** P1 形状签名：只保留键名与值的类型，字符串值一律降为 "string"（不落任何原文）。
 *  深度上限放宽到 6：真机 image_item 已嵌两层（image_item.media.full_url），4 层会截断后续类型。 */
const SIG_MAX_DEPTH = 6;
function sigOf(v, depth = 0) {
  if (v === null) return "null";
  if (Array.isArray(v)) return v.length && depth < SIG_MAX_DEPTH ? [sigOf(v[0], depth + 1)] : "array";
  if (typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) o[k] = depth < SIG_MAX_DEPTH ? sigOf(v[k], depth + 1) : typeof v[k];
    return o;
  }
  return typeof v;
}
/** 枚举类字段（type/message_type/message_state）允许记取值：仅 number 或短标识符串。 */
function scalarEnum(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^[A-Za-z0-9_]{1,24}$/.test(v)) return v;
  return v === undefined ? undefined : typeof v;
}

/** 附件变体键 → kind。键名 = 既有候选（image/file/video/audio_item）+ 真机实测（image_item）；不臆造新键。 */
const VARIANT_KIND = { image_item: "image", file_item: "file", video_item: "video", audio_item: "audio" };
/** item 内的非媒体键（逐键排除，避免把 msg_id / button_item_list 当附件）。 */
const ITEM_META_KEYS = new Set([
  "type", "create_time_ms", "update_time_ms", "is_completed", "msg_id", "message_id",
  "button_item_list", "at_bot_username_list", "text_item",
]);
/** URL 候选键路径：首位 = 真机实测嵌套（image_item.media.full_url），其余 = 旧平铺候选（旧读数来源）。 */
const URL_PATHS = [
  ["media.full_url", (v) => v?.media?.full_url],
  ["media.url", (v) => v?.media?.url],
  ["full_url", (v) => v?.full_url],
  ["url", (v) => v?.url],
  ["download_url", (v) => v?.download_url],
];
/** AES key 候选键路径：首位 = 真机实测嵌套（media.aes_key），次位 = 真机实测顶层 aeskey。 */
const AES_PATHS = [
  ["media.aes_key", (v) => v?.media?.aes_key],
  ["aeskey", (v) => v?.aeskey],
  ["aes_key", (v) => v?.aes_key],
];
function pickPath(variant, paths) {
  for (const [p, get] of paths) {
    let v; try { v = get(variant); } catch { v = undefined; }
    if (typeof v === "string" && v) return { value: v, path: p };
  }
  return { value: "", path: null };
}
/**
 * 从 item 里抽附件引用：只按**已观测 / 既有候选**键路径查，命中即回报**真实键路径**（日志可输出）。
 * 查不到 → shape="unknown-shape"，只带回变体键名（值不带出）；不猜字段名，由调用方如实落盘。
 * 真机实测（B）：image_item = { aeskey, media:{encrypt_query_param,aes_key,full_url}, mid_size, … }。
 */
function extractAttachments(it) {
  const out = [];
  if (!it || typeof it !== "object") return out;
  for (const key of Object.keys(it)) {
    if (ITEM_META_KEYS.has(key)) continue;
    const v = it[key];
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const known = Object.prototype.hasOwnProperty.call(VARIANT_KIND, key);
    const url = pickPath(v, URL_PATHS);
    const aes = pickPath(v, AES_PATHS);
    const nestedMedia = Boolean(v.media && typeof v.media === "object");
    if (!known && !nestedMedia && !url.path && !aes.path) continue;   // 非附件变体（富卡片/列表等）
    const absolute = /^https?:\/\//i.test(url.value);
    const shape = url.path ? (absolute ? "url" : "url-non-absolute")
      : aes.path ? "missing-url"
      : "unknown-shape";
    out.push({
      kind: VARIANT_KIND[key] || "unknown",
      variantKey: key,
      variantKeys: Object.keys(v),
      filename: typeof v.filename === "string" && v.filename ? v.filename
        : (typeof v.file_name === "string" && v.file_name ? v.file_name : "unnamed"),
      sizeBytes: typeof v.size === "number" ? v.size : (typeof v.filesize === "number" ? v.filesize : undefined),
      midSize: typeof v.mid_size === "number" ? v.mid_size : undefined,
      fileId: String(v.file_id || v.media_id || ""),
      url: absolute ? url.value : "",
      urlPath: url.path,
      aesKey: aes.value,
      aesKeyPath: aes.path,
      encParamPresent: typeof v.media?.encrypt_query_param === "string" && v.media.encrypt_query_param.length > 0,
      shape,
    });
  }
  return out;
}
/** 消息 id 实际命中路径（真机：信封层 message_id=number、item 层 msg_id=string；id 可能整体缺）。 */
function pickMessageId(msg, raw, items) {
  const cands = [
    ["id", msg?.id], ["msg_id", msg?.msg_id], ["message_id", msg?.message_id],
    ["raw.id", raw?.id], ["raw.msg_id", raw?.msg_id], ["raw.message_id", raw?.message_id],
  ];
  for (const [p, v] of cands) if (v !== undefined && v !== null && String(v) !== "") return [String(v), p];
  for (const it of items) {
    const v = it && typeof it === "object" ? (it.msg_id ?? it.message_id) : undefined;
    if (v !== undefined && v !== null && String(v) !== "") return [String(v), "item_list[].msg_id"];
  }
  return ["", "none"];
}

function normalizeUpdates(payload, prevBuf, opts = {}) {
  const rawList = Array.isArray(payload.item_list) ? payload.item_list
    : Array.isArray(payload.messages) ? payload.messages
    : Array.isArray(payload.msgs) ? payload.msgs : [];
  const messages = [];
  const shapes = [];
  for (const raw of rawList) {
    const msg = (raw.msg && typeof raw.msg === "object" ? raw.msg : raw);
    const items = Array.isArray(msg.item_list) ? msg.item_list : Array.isArray(raw.item_list) ? raw.item_list : [];
    // id 先于形状解析：真机信封层常无 id（落在 item.msg_id），不修会把空串当 dedupe key 吞掉后续消息。
    const [id, idPath] = pickMessageId(msg, raw, items);
    if (opts.rawItems) {
      // 在 senderId 判空之前采形状：即使无法归一化为消息，也保留 type/键名证据（P1）。
      shapes.push({
        envelope: {
          message_type: scalarEnum(msg.message_type ?? raw.message_type),
          message_state: scalarEnum(msg.message_state ?? raw.message_state),
          hasContextToken: Boolean(msg.context_token || raw.context_token),
          hasGroupId: Boolean(msg.group_id || raw.group_id),
        },
        msgIdPath: idPath,
        itemCount: items.length,
        itemTypes: [...new Set(items.map((it) => scalarEnum(it?.type)))],
        items: items.map((it) => ({
          type: scalarEnum(it?.type),
          variantKeys: it && typeof it === "object" ? Object.keys(it).filter((k) => k !== "type") : [],
          sig: sigOf(it),
          textLen: typeof it?.text_item?.text === "string" ? it.text_item.text.length : undefined,
        })),
      });
    }
    const from = (msg.from && typeof msg.from === "object" ? msg.from : raw.from) || {};
    const senderId = String(from.id || from.wxid || from.user_id || msg.from_user_id || raw.from_user_id || "");
    if (!senderId) continue;
    let text = "";
    if (typeof msg.text === "string") text = msg.text;
    else if (typeof msg.content === "string") text = msg.content;
    else if (items.length) text = items.map((it) => String(it?.text_item?.text || "")).filter(Boolean).join("\n");
    const attachments = [];
    for (const it of items) {
      for (const a of extractAttachments(it)) {
        const gate = a.url ? isHostAllowed(a.url) : { ok: false, host: "<empty>" };
        attachments.push({
          kind: a.kind, variantKey: a.variantKey, filename: a.filename,
          sizeBytes: a.sizeBytes, midSize: a.midSize, fileId: a.fileId,
          shape: a.shape, variantKeys: a.variantKeys,
          urlPath: a.urlPath, aesKeyPath: a.aesKeyPath, encParamPresent: a.encParamPresent,
          host: gate.host, hostAllowed: gate.ok,
          hasUrl: Boolean(a.url), hasKey: Boolean(a.aesKey), aesKeyPresent: Boolean(a.aesKey),
          _url: gate.ok ? a.url : undefined,           // 内存态仅保留，绝不打印/落盘
          _aesKey: gate.ok && a.aesKey ? a.aesKey : undefined,
        });
        // 脱敏：只记 kind/键路径/host/判定/尺寸，不记 URL 原文、不记 key、不记密文。
        appendMeasure({
          kind: "attachment_meta", attKind: a.kind, variantKey: a.variantKey, shape: a.shape,
          host: gate.host, allowed: gate.ok,
          urlPath: a.urlPath, aesKeyPath: a.aesKeyPath,
          sizeBytes: a.sizeBytes ?? null, midSize: a.midSize ?? null,
          encParamPresent: a.encParamPresent, variantKeys: a.variantKeys,
        });
      }
    }
    messages.push({
      id, idPath, senderId, displayName: typeof from.nickname === "string" ? from.nickname : undefined,
      text, attachments,
      contextTokenPresent: Boolean(msg.context_token || raw.context_token),
      _contextToken: String(msg.context_token || raw.context_token || ""),
    });
  }
  const nextBuf = String(payload.buf || payload.next_buf || payload.get_updates_buf || prevBuf);
  return { messages, nextBuf, shapes };
}

/** P7/K2：带 redirect:"manual" 的下载——每一跳复检 allowlist（0923 L4 残余风险①：302 可越域）。 */
async function safeDownload(url, timeoutMs, maxHops = 3) {
  let cur = url;
  for (let hops = 0; ; ) {
    const gate = isHostAllowed(cur);
    if (!gate.ok) return { blocked: true, reason: "host-not-allowed", host: gate.host, hops };
    const res = await fetch(cur, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return { blocked: true, reason: "3xx-missing-location", host: "<unknown>", hops };
      if (++hops > maxHops) return { blocked: true, reason: "too-many-hops", host: "<unknown>", hops };
      try { cur = new URL(loc, cur).toString(); } catch { return { blocked: true, reason: "bad-location", host: "<invalid>", hops }; }
      continue;
    }
    let finalHost = "<unknown>";
    try { finalHost = new URL(cur).hostname; } catch { /* ignore */ }
    return { res, finalHost, hops };
  }
}

async function cmdListen(args) {
  const timeoutMs = timeoutMsFromArgs(args);
  const doDecrypt = args.includes("--decrypt");
  const outDir = flagValue(args, "--out") || DEFAULT_OUT_DIR;
  const shortRun = args.includes("--short");              // 短跑：3 批 + 命中即收
  const stopOnHit = shortRun || args.includes("--stop-on-hit");
  const maxBExplicit = flagValue(args, "--max-batches") ?? process.env.WECHAT_PROBE_MAX_BATCHES;
  const maxBv = Number(maxBExplicit ?? (shortRun ? "3" : "Infinity"));
  const maxB = Number.isFinite(maxBv) && maxBv > 0 ? maxBv : Infinity;
  const { botToken } = loadCredsOrThrow(args);
  const creds = loadJson(CREDS_PATH, {});
  const rawItems = args.includes("--raw-items");   // P1：只记 type/键名签名
  let state = loadJson(STATE_PATH, { buf: "", seenIds: [], lastMeasurement: null });
  const seen = new Set(state.seenIds || []);
  if (doDecrypt) fs.mkdirSync(outDir, { recursive: true });
  console.log(`[probe] listen 启动：buf=${state.buf ? `<present len=${state.buf.length}>` : "<empty>"} decrypt=${doDecrypt} rawItems=${rawItems} maxBatches=${maxB} stopOnHit=${stopOnHit} timeout=${timeoutMs}ms`);
  if (doDecrypt) console.log(`[probe] 附件落盘目录：${outDir}（命名 <msgId>_<kind>_<序号>.<ext>；日志/measure 只记 kind/host/hops/plainBytes）`);
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
    const { messages, nextBuf, shapes } = normalizeUpdates(res.payload, bufIn, { rawItems });
    if (rawItems && shapes.length) {
      for (const s of shapes) {
        // 只打 type 取值与键名签名：无文本、无 URL、无 token。
        console.log(`    [item-shape] envelope=${JSON.stringify(s.envelope)} items=${JSON.stringify(s.items)}`);
        fs.appendFileSync(ITEMS_PATH, JSON.stringify({ ts: nowIso(), ...s }) + "\n", "utf8");
        appendMeasure({ kind: "item_shape", envelope: s.envelope, itemCount: s.itemCount, types: s.items.map((i) => i.type ?? null), itemTypes: s.itemTypes, msgIdPath: s.msgIdPath });
      }
    }
    // 未知项 ③④：重放检测 + 空批是否推进 buf
    const dupIds = messages.filter((m) => m.id && seen.has(m.id)).map((m) => m.id);
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
      // 无 id 的消息不参与 dedupe（id 为空串会把后续消息全部当重放吞掉）。
      if (m.id && seen.has(m.id)) { console.log(`[probe] 去重跳过 id=${m.id}（同一 buf 重放）`); continue; }
      if (m.id) seen.add(m.id);
      printInboundMessage({ ...m, contextTokenPresent: m.contextTokenPresent }, ++n);
      if (m._contextToken) lastWithToken = m;
      if (doDecrypt) {
        let attIdx = 0;
        for (const a of m.attachments) {
          // 跳过原因分类：不猜字段名，unknown-shape 只回带变体键名（签名在 items.jsonl）。
          const skip = a.shape === "unknown-shape" ? "unknown-shape"
            : a.shape === "missing-url" ? "missing-url"
            : a.shape === "url-non-absolute" ? "url-non-absolute"
            : !a.hasUrl ? "no-url"
            : !a.hostAllowed ? "host-blocked"
            : !a.hasKey ? "no-key"
            : null;
          if (skip) {
            console.log(`    [decrypt] 跳过 ${a.filename}（${skip}；variant=${a.variantKey} urlPath=${a.urlPath ?? "-"} keyPath=${a.aesKeyPath ?? "-"}${skip === "unknown-shape" ? ` 键名=[${a.variantKeys.join(",")}] 已落盘 items.jsonl` : ` host=${a.host}`}）`);
            appendMeasure({
              kind: "attachment_skipped", reason: skip, attKind: a.kind, variantKey: a.variantKey,
              shape: a.shape, host: a.host, urlPath: a.urlPath, aesKeyPath: a.aesKeyPath,
              variantKeys: a.variantKeys,
            });
            if (skip === "host-blocked")
              appendMeasure({ kind: "attachment_download_blocked", reason: "host-not-allowed", host: a.host, hops: 0 });
            continue;
          }
          try {
            const dl = await safeDownload(a._url, timeoutMs);
            if (dl.blocked) {
              console.log(`    [decrypt] 拒绝下载 ${a.filename}（${dl.reason} host=${dl.host} hops=${dl.hops}）`);
              appendMeasure({ kind: "attachment_download_blocked", reason: dl.reason, attKind: a.kind, host: dl.host, hops: dl.hops });
              continue;
            }
            if (!dl.res.ok) {
              console.log(`    [decrypt] 下载失败 ${a.filename} HTTP ${dl.res.status}（kind=${a.kind} host=${dl.finalHost} hops=${dl.hops}）`);
              appendMeasure({ kind: "attachment_download", ok: false, status: dl.res.status, attKind: a.kind, host: dl.finalHost, hops: dl.hops });
              continue;
            }
            const plain = decryptEcb(Buffer.from(await dl.res.arrayBuffer()), a._aesKey);
            const extM = /\.([A-Za-z0-9]{1,8})$/.exec(a.filename);
            const safeId = (m.id || "noid").replace(/[\\/:*?"<>|]/g, "_");
            const fp = path.join(outDir, `${safeId}_${a.kind}_${++attIdx}${extM ? `.${extM[1]}` : ".bin"}`);
            fs.writeFileSync(fp, plain);
            // 只记 kind/host/跳数/明文字节：不记最终 URL、不记 key、不记密文（P7 证据口径）。
            appendMeasure({ kind: "attachment_download", ok: true, status: 200, attKind: a.kind, host: dl.finalHost, hops: dl.hops, plainBytes: plain.length, urlPath: a.urlPath, aesKeyPath: a.aesKeyPath });
            console.log(`    [decrypt] 已保存 ${fp} (${plain.length}B) kind=${a.kind} host=${dl.finalHost} hops=${dl.hops} urlPath=${a.urlPath} keyPath=${a.aesKeyPath}`);
          } catch (e) {
            const msg = String(e.message).slice(0, 100).replace(/https?:\/\/\S+/gi, "<url>");
            console.log(`    [decrypt] 失败：${msg}`);
            appendMeasure({ kind: "attachment_decrypt_error", attKind: a.kind, error: msg });
          }
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
    if (stopOnHit && n > 0) {
      console.log(`[probe] 命中新消息 ${n} 条，--stop-on-hit/--short 收束（游标已存，不长占）。`);
      break;
    }
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
  const { botToken } = loadCredsOrThrow(args);
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
    appendMeasure({ kind: "concurrency_probe", sendHttp: res.httpStatus, pollHttp: pollSt, sendRetryAfter: res.retryAfter ?? null, pollRetryAfter: p.status === "fulfilled" ? (p.value.retryAfter ?? null) : null });
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
  const { botToken } = loadCredsOrThrow(args);
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
  const { botToken } = loadCredsOrThrow(args);
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

// ---------- P5：出站媒体硬前置门（upload 端点存在性，无用户可见副作用） ----------
/** payload 字段摘要：只记类型/长度/键名；字符串若是 URL 则记 host 与 allowlist 判定，不记原串。 */
function fieldSummary(v, depth = 0) {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return { t: "array", len: v.length };
  if (typeof v === "object") {
    if (depth >= 2) return { t: "object", keys: Object.keys(v).slice(0, 20) };
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = fieldSummary(val, depth + 1);
    return o;
  }
  if (typeof v === "string") {
    if (/^https?:\/\//i.test(v)) {
      const gate = isHostAllowed(v);
      return { t: "url", len: v.length, host: gate.host, hostAllowed: gate.ok };
    }
    return { t: "string", len: v.length, enum: /^[A-Za-z0-9_\-]{1,16}$/.test(v) ? v : undefined };
  }
  if (typeof v === "number" || typeof v === "boolean") return { t: typeof v, v };
  return { t: typeof v };
}
/** 错误文案脱敏：URL 全部抹掉，长标识符串全部抹掉，只留可读短文本。 */
function redactErrmsg(s) {
  return String(s || "")
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/[A-Za-z0-9_@.\-]{12,}/g, "…")
    .slice(0, 120);
}
/**
 * 只打候选路径的“最小请求”，不下载、不上传任何媒体、不给任何人发消息。
 * 判读依赖两个控制组：
 *   control_known     = 既有端点 getconfig（同时验证 bot_token 仍有效）
 *   control_negative  = 明确不存在的路径（验证 401/403 是否只是“鉴权先于路由”）
 * 只记录 HTTP 状态 + 业务码 + payload 键名（不记任何值、不记 to_user_id 原文）。
 */
async function cmdUploadProbe(args) {
  const timeoutMs = timeoutMsFromArgs(args);
  const { botToken } = loadCredsOrThrow(args);
  const toUserId = flagValue(args, "--to") || latestInboxFromId();
  console.log(`[probe] P5 upload 端点探测：to_user_id=${toUserId ? "<present>" : "<absent>"} timeout=${timeoutMs}ms（不发消息、不上传媒体）`);
  const results = [];
  const hit = async (op, method, urlPath, headers, body) => {
    let res;
    try {
      res = await fetchJson(`${BASE_URL}${urlPath}`, { method, headers, body }, timeoutMs);
    } catch (e) {
      const rec = { op, method, path: urlPath, httpStatus: 0, error: String(e.message).slice(0, 80) };
      results.push(rec); appendMeasure({ kind: "upload_endpoint_probe", ...rec });
      console.log(`[probe] ${op}: ${method} ${urlPath} → 网络错误（${rec.error}）`);
      return rec;
    }
    const p = (res.payload && typeof res.payload === "object") ? res.payload : {};
    const ret = typeof p.ret === "number" ? p.ret : (typeof p.errcode === "number" ? p.errcode : null);
    const rec = {
      op, method, path: urlPath, httpStatus: res.httpStatus, ret,
      payloadKeys: Object.keys(p).slice(0, 30),
      topKeys: (res.topKeys || []).slice(0, 30),
      fields: fieldSummary(p),
      errmsg: redactErrmsg(p.errmsg || p.message),
      bodyBytes: typeof res.bodyBytes === "number" ? res.bodyBytes : null,
      retryAfter: res.retryAfter ?? null,
    };
    results.push(rec); appendMeasure({ kind: "upload_endpoint_probe", ...rec });
    console.log(`[probe] ${op}: ${method} ${urlPath} → HTTP ${res.httpStatus} ret=${ret} top=[${rec.topKeys.join(",")}] data=[${rec.payloadKeys.join(",")}]${rec.errmsg ? ` errmsg=${JSON.stringify(rec.errmsg)}` : ""}`);
    return rec;
  };
  await hit("control_known", "POST", "/ilink/bot/getconfig", authHeaders(botToken), JSON.stringify(toUserId ? { ilink_user_id: toUserId } : {}));
  await hit("control_known_noparam", "POST", "/ilink/bot/getconfig", authHeaders(botToken), "{}");
  // 控制组 2：明确不存在的路径（单个，不是穷举）。
  await hit("control_negative", "POST", "/ilink/bot/__probe_ctrl_no_such_path__", authHeaders(botToken), "{}");

  // 候选 A：getuploadurl（C/D 级候选：photon-hq 逆向实现 + Hermes 同名端点）。
  const raw = Buffer.from("test", "utf8");          // 占位内容，不上传
  const p5Body = JSON.stringify({
    filekey: randomBytes(16).toString("hex"),        // 占位 32hex（语义未知，候选实现字段名）
    media_type: 1,                                   // UploadMediaType.IMAGE（C 级候选枚举）
    to_user_id: toUserId,
    rawsize: raw.length,                             // md5/size 自洽（研究 §3.4 建议 rawsize=8，此处取真实长度）
    rawfilemd5: createHash("md5").update(raw).digest("hex"),
    filesize: 16,                                    // AES-128-ECB + PKCS7 后长度
    no_need_thumb: true,
    aeskey: randomBytes(16).toString("hex"),         // 占位 32hex 随机密钥
  });
  await hit("p5_getuploadurl_options", "OPTIONS", "/ilink/bot/getuploadurl", authHeaders(botToken), undefined);
  await hit("p5_getuploadurl_post", "POST", "/ilink/bot/getuploadurl", authHeaders(botToken), p5Body);
  // 鉴权敏感性（只读、无副作用）：坏 token / 无 token / 空 body，判断该端点是否校验 Authorization、是否校验参数。
  const badAuth = { ...authHeaders(botToken), Authorization: "Bearer probe_invalid_token_0000000000" };
  const noAuth = { "content-type": "application/json", "iLink-App-ClientVersion": CLIENT_VERSION };
  await hit("p5_getuploadurl_badtoken", "POST", "/ilink/bot/getuploadurl", badAuth, p5Body);
  await hit("p5_getuploadurl_noauth", "POST", "/ilink/bot/getuploadurl", noAuth, p5Body);
  await hit("p5_getuploadurl_emptybody", "POST", "/ilink/bot/getuploadurl", authHeaders(botToken), "{}");
  await hit("control_known_badtoken", "POST", "/ilink/bot/getconfig", badAuth, JSON.stringify(toUserId ? { ilink_user_id: toUserId } : {}));

  // 候选 B：/ilink/bot/upload（D 级分歧：另有实现声称 multipart 上传）。
  const mpHeaders = { ...authHeaders(botToken), "content-type": "multipart/form-data; boundary=probeboundary" };
  await hit("p5_upload_options", "OPTIONS", "/ilink/bot/upload", authHeaders(botToken), undefined);
  await hit("p5_upload_post", "POST", "/ilink/bot/upload", mpHeaders, "--probeboundary--\r\n");

  const known = results.find((r) => r.op === "control_known");
  const known2 = results.find((r) => r.op === "control_known_noparam");
  const neg = results.find((r) => r.op === "control_negative");
  const classify = (rec) => {
    if (!rec || rec.httpStatus === 0) return "network-error（未定论）";
    if (rec.op.endsWith("_badtoken") || rec.op.endsWith("_noauth")) {
      const hasUrl = JSON.stringify(rec.fields || {}).includes('\"t\":\"url\"');
      return rec.ret === -14 ? "鉴权对照：errcode -14（session timeout）→ 该路径确实校验 token，好 token 的 200 才有效"
        : hasUrl ? "鉴权对照：无 token 也拿到 URL → 该路径不校验 Authorization"
        : `鉴权对照：HTTP ${rec.httpStatus} ret=${rec.ret ?? "?"}`;
    }
    if (rec.op.endsWith("_emptybody"))
      return rec.ret != null && rec.ret !== 0 ? `参数对照：ret=${rec.ret} → body 参数被校验，占位参数非必需但不可为空`
        : "参数对照：空 body 也通过 → 服务端不校验该 body";
    if (rec.op.endsWith("_options"))
      return rec.httpStatus === 404 || rec.httpStatus === 405 ? "OPTIONS 404/405（路径未识别）"
        : rec.httpStatus >= 200 && rec.httpStatus < 300 ? "OPTIONS 2xx（方法被接受；弱证据，不证明业务实现）"
        : `OPTIONS HTTP ${rec.httpStatus}（不作为存在性证据）`;
    if (neg && (neg.httpStatus === 401 || neg.httpStatus === 403) && (rec.httpStatus === 401 || rec.httpStatus === 403))
      return "401/403 且负控制同码 → 鉴权先于路由，不能据此断定存在/不存在";
    if (rec.httpStatus === 404 || rec.httpStatus === 405) return "路径不存在（404/405）";
    if (rec.httpStatus === 401 || rec.httpStatus === 403) return "端点存在但无权限（401/403，负控制非同码）";
    if (rec.httpStatus >= 200 && rec.httpStatus < 300) {
      const hasUrl = JSON.stringify(rec.fields || {}).includes('"t":"url"');
      return rec.payloadKeys.includes("upload_param") ? "可用（200 + upload_param）"
        : hasUrl ? "200 + 返回 URL 字段（upload_full_url）→ 与 C/D 级候选键名不同，但端点确实应答"
        : "200 但无 URL/upload_param → 形状与候选实现不符";
    }
    if (neg && neg.httpStatus === rec.httpStatus) return `HTTP ${rec.httpStatus} 与负控制同码 → 大概率不存在`;
    return `HTTP ${rec.httpStatus}（参数层错误）→ 路径可能存在，需调参复测`;
  };
  const verdicts = {};
  for (const rec of results.filter((r) => r.op.startsWith("p5_"))) verdicts[rec.op] = classify(rec);
  const tokenOk = known && known.httpStatus >= 200 && known.httpStatus < 300 && known.ret === 0;
  appendMeasure({ kind: "p5_verdict", tokenOk: Boolean(tokenOk), controlKnown: known?.httpStatus ?? null, controlKnownRet: known?.ret ?? null, controlKnownNoParamRet: known2?.ret ?? null, controlNegative: neg?.httpStatus ?? null, verdicts });
  console.log(`[probe] P5 判读：`);
  console.log(`  - 控制组 getconfig HTTP ${known?.httpStatus ?? "?"} 业务码=${known?.ret ?? "?"}（无参对照=${known2?.ret ?? "?"}）：${tokenOk ? "token 有效" : "业务码非 0 → 先确认该码含义，再看候选结果"}`);
  console.log(`  - 负控制（不存在路径）HTTP ${neg?.httpStatus ?? "?"}：${neg && (neg.httpStatus === 401 || neg.httpStatus === 403) ? "鉴权先于路由 → 401/403 不可作为存在性证据" : "能区分不存在路径"}`);
  for (const [k, v] of Object.entries(verdicts)) console.log(`  - ${k}: ${v}`);
  const urls = (rec) => Boolean(rec && JSON.stringify(rec.fields || {}).includes('\"t\":\"url\"'));
  const authNote = (rec) => !rec ? "未测"
    : rec.httpStatus === 0 ? "网络错误"
    : urls(rec) ? `HTTP ${rec.httpStatus} + 返回 URL` : `HTTP ${rec.httpStatus} ret=${rec.ret ?? "?"}${rec.errmsg ? ` (${rec.errmsg})` : ""}`;
  const authSummary = {
    goodToken: authNote(results.find((r) => r.op === "p5_getuploadurl_post")),
    badToken: authNote(results.find((r) => r.op === "p5_getuploadurl_badtoken")),
    noAuth: authNote(results.find((r) => r.op === "p5_getuploadurl_noauth")),
    emptyBody: authNote(results.find((r) => r.op === "p5_getuploadurl_emptybody")),
    getconfigBadToken: authNote(results.find((r) => r.op === "control_known_badtoken")),
  };
  appendMeasure({ kind: "p5_auth_probe", ...authSummary });
  console.log(`[probe] P5 鉴权/参数敏感性：`);
  console.log(`  - getuploadurl 好 token: ${authSummary.goodToken}`);
  console.log(`  - getuploadurl 坏 token: ${authSummary.badToken}`);
  console.log(`  - getuploadurl 无 token: ${authSummary.noAuth}`);
  console.log(`  - getuploadurl 空 body: ${authSummary.emptyBody}`);
  console.log(`  - getconfig 坏 token 对照: ${authSummary.getconfigBadToken}`);
  console.log(`[probe] 结果已记入 ${MEASURE_PATH}（kind=upload_endpoint_probe / p5_verdict / p5_auth_probe，仅状态码+键名）。`);
}

// ---------- P4：同 token 并发限流（read 模式为无副作用子集） ----------
async function cmdConc(args) {
  const timeoutMs = timeoutMsFromArgs(args);
  const mode = flagValue(args, "--mode") || "read";
  const n = Math.min(Math.max(Number(flagValue(args, "--n") || "3"), 1), 8);
  if (mode === "send") {
    console.log("[probe] conc --mode send = 真·poll+send 并发（会给本人发一条文本，需用户同意后手动执行）：");
    console.log("[probe]   node scripts/wechat-ilink-probe.mjs send <toUserId> \"并发测试\" --with-poll");
    console.log("[probe]   （已加 Retry-After 记录：measure.jsonl 的 concurrency_probe.sendRetryAfter/pollRetryAfter）");
    return;
  }
  const { botToken } = loadCredsOrThrow(args);
  const toUserId = flagValue(args, "--to") || latestInboxFromId();
  const t0 = Date.now();
  const rs = await Promise.allSettled(Array.from({ length: n }, () =>
    fetchJson(`${BASE_URL}/ilink/bot/getconfig`, {
      method: "POST", headers: authHeaders(botToken),
      body: JSON.stringify(toUserId ? { ilink_user_id: toUserId } : {}),
    }, timeoutMs)));
  const statuses = rs.map((r) => (r.status === "fulfilled" ? r.value.httpStatus : 0));
  const retryAfters = rs.map((r) => (r.status === "fulfilled" ? (r.value.retryAfter ?? null) : null));
  const rets = rs.map((r) => {
    if (r.status !== "fulfilled") return null;
    const p = r.value.payload || {};
    return typeof p.ret === "number" ? p.ret : (typeof p.errcode === "number" ? p.errcode : null);
  });
  const elapsedMs = Date.now() - t0;
  appendMeasure({ kind: "concurrency_probe", mode: "read", n, statuses, rets, retryAfters, elapsedMs });
  console.log(`[probe] 并发 ${n}×getconfig（只读；不含 getupdates/sendmessage，避免与 worker 游标互相抢取消息）`);
  console.log(`[probe]   HTTP=[${statuses.join(",")}] ret=[${rets.join(",")}] Retry-After=[${retryAfters.map((x) => x ?? "-").join(",")}] 耗时=${elapsedMs}ms`);
  if (statuses.includes(429)) console.log("[probe] 观察到 429：同 token 并发被限流（读端点，B 级）。" );
  else {
    console.log("[probe] 读端点未见 429；这只证明读端点并发可接受。poll+send 组合仍未测（需用户同意后跑 send --with-poll）。" );
    if (statuses.every((s) => s >= 400 && s < 500)) console.log("[probe] 注意：全部为 4xx 参数层响应 → 只能说明未触发限流，不能证明并发吞吐。" );
  }
}

// ---------- P6：出站两段式上传（staged + 显式同意门；形状来源见每处 C 级标注） ----------
/** 最小 1×1 PNG（70B）：默认探针样本，不从磁盘拿用户文件。 */
const MIN_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** 原始请求（CDN/sendmessage 响应可能非 JSON；只回状态+头+体长/体，不回 URL）。 */
async function rawRequest(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error(`HTTP 超时 ${timeoutMs}ms`)), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: opts?.signal ?? ctrl.signal });
    const text = await res.text();
    return { status: res.status, ok: res.ok, headers: res.headers, bodyText: text };
  } finally { clearTimeout(t); }
}
function aesPaddedSize(n) { const r = n % 16; return n + (r === 0 ? 16 : 16 - r); }   // PKCS#7

async function cmdMediaProbe(args) {
  const timeoutMs = timeoutMsFromArgs(args);
  const stage = flagValue(args, "--stage") || "pre";
  const consent = flagValue(args, "--consent");
  if (!["pre", "cdn", "send"].includes(stage)) throw new Error("用法：media-probe [--stage pre|cdn|send] [--consent cdn|send] [--file F] [--caption T] [--to uid]");
  if (stage === "cdn" && consent !== "cdn" && consent !== "send")
    throw new Error("cdn 阶段需要 --consent cdn：会把密文 POST 到微信 CDN（写第三方存储，不给任何人发消息）。需先征得用户同意。");
  if (stage === "send" && consent !== "send")
    throw new Error("send 阶段需要 --consent send：会给本人发一张测试图片（会打扰用户；需用户明确同意 + 手机端人工确认图片可见清晰）。");
  const { botToken } = loadCredsOrThrow(args);
  const toUserId = flagValue(args, "--to") || latestInboxFromId();
  if (!toUserId) throw new Error("缺收件人：传 --to <uid>，或先跑 listen 拿到最近入站发件人。");

  const file = flagValue(args, "--file");
  const plain = file ? fs.readFileSync(file) : Buffer.from(MIN_PNG_B64, "base64");
  const aesKey = randomBytes(16);
  const filekey = randomBytes(16).toString("hex");
  console.log(`[probe] P6 stage=${stage} consent=${consent || "-"} 样本=${file ? "<--file>" : "最小PNG"}(${plain.length}B) to=${"<present>"}`);

  // ── stage pre：getuploadurl（无副作用） ──
  // 请求字段名 = Hermes weixin.py#L519-L548 / photon-hq 两份 C 级实现同名；本机实测已返回 upload_full_url。
  const upBody = JSON.stringify({
    filekey, media_type: 1, to_user_id: toUserId,
    rawsize: plain.length, rawfilemd5: createHash("md5").update(plain).digest("hex"),
    filesize: aesPaddedSize(plain.length), no_need_thumb: true, aeskey: aesKey.toString("hex"),
  });
  const r1 = await fetchJson(`${BASE_URL}/ilink/bot/getuploadurl`, {
    method: "POST", headers: authHeaders(botToken), body: upBody,
  }, timeoutMs);
  const p1 = (r1.payload && typeof r1.payload === "object") ? r1.payload : {};
  const upUrl = typeof p1.upload_full_url === "string" ? p1.upload_full_url : "";
  const upParam = typeof p1.upload_param === "string" ? p1.upload_param : "";
  const gate = upUrl ? isHostAllowed(upUrl) : { ok: false, host: "<none>" };
  appendMeasure({
    kind: "media_probe", stage: "pre", httpStatus: r1.httpStatus,
    topKeys: (r1.topKeys || []).slice(0, 20), hasFullUrl: Boolean(upUrl), hasUploadParam: Boolean(upParam),
    host: gate.host, hostAllowed: gate.ok, plainBytes: plain.length,
  });
  console.log(`[probe] pre: HTTP ${r1.httpStatus} top=[${(r1.topKeys || []).join(",")}] upload_full_url=${upUrl ? "<present>" : "<absent>"} upload_param=${upParam ? "<present>" : "<absent>"} host=${gate.host} allow=${gate.ok}`);
  if (stage === "pre") { console.log("[probe] pre 完成（只拿预签名 URL，未上传、未发送）。"); return; }
  if (!upUrl) { console.log("[probe] 无可用上传 URL，中止（不猜测其它字段）。"); return; }
  if (!gate.ok) { console.log("[probe] 上传 URL host 不在 allowlist，中止（K2 SSRF 纪律）。"); return; }

  // ── stage cdn：AES-128-ECB 加密 → POST 密文（Hermes weixin.py#L551-L580：POST + application/octet-stream，旧 PUT 会 404） ──
  const c = createCipheriv("aes-128-ecb", aesKey, null);
  const cipher = Buffer.concat([c.update(plain), c.final()]);
  let cdn = await rawRequest(upUrl, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: cipher }, timeoutMs);
  let cdnMethod = "POST";
  if (cdn.status === 403 || cdn.status === 404 || cdn.status === 405) {
    const alt = await rawRequest(upUrl, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: cipher }, timeoutMs);
    appendMeasure({ kind: "media_probe", stage: "cdn_retry", method: "PUT", httpStatus: alt.status, bodyBytes: alt.bodyText.length });
    if (alt.status === 200) { cdn = alt; cdnMethod = "PUT"; }
  }
  // 关键返回：响应头 x-encrypted-param = 后续 sendmessage 的 encrypt_query_param（Hermes 同名头）。
  const encParam = cdn.headers.get("x-encrypted-param");
  appendMeasure({
    kind: "media_probe", stage: "cdn", method: cdnMethod, httpStatus: cdn.status,
    cipherBytes: cipher.length, encParamPresent: Boolean(encParam), encParamLen: encParam ? encParam.length : 0,
    respBytes: cdn.bodyText.length, respJsonKeys: (() => { try { return Object.keys(JSON.parse(cdn.bodyText)).slice(0, 20); } catch { return []; } })(),
  });
  console.log(`[probe] cdn: ${cdnMethod} → HTTP ${cdn.status} 密文=${cipher.length}B x-encrypted-param=${encParam ? `<present len=${encParam.length}>` : "<absent>"} 响应体=${cdn.bodyText.length}B`);
  if (cdn.status !== 200 || !encParam) {
    console.log("[probe] CDN 上传未拿到 x-encrypted-param，中止（不臆造 encrypt_query_param）。");
    return;
  }
  if (stage !== "send") { console.log("[probe] cdn 完成（未发送任何消息）；手机端不受影响。"); return; }

  // ── stage send：sendmessage 带图片 item（Hermes weixin.py#L2197-L2225：type=2 / image_item.media / mid_size；
  //    aes_key 必须是 base64(hex字符串) —— Hermes 注释坑位，b64(raw) 会让对端变灰图） ──
  const aesKeyForApi = Buffer.from(aesKey.toString("hex"), "ascii").toString("base64");
  const mediaItem = {
    type: 2,
    image_item: { media: { encrypt_query_param: encParam, aes_key: aesKeyForApi, encrypt_type: 1 }, mid_size: cipher.length },
  };
  const caption = flagValue(args, "--caption");
  const itemList = caption ? [{ type: 1, text_item: { text: caption } }, mediaItem] : [mediaItem];   // P6 附带测：caption+图片同 item_list
  const sendBody = {
    base_info: { channel_version: "2.0.0" },
    msg: { from_user_id: "", to_user_id: toUserId, client_id: randomUUID(), message_type: 2, message_state: 2, item_list: itemList },
  };
  const r3 = await fetchJson(`${BASE_URL}/ilink/bot/sendmessage`, {
    method: "POST", headers: authHeaders(botToken), body: JSON.stringify(sendBody),
  }, timeoutMs);
  const p3 = (r3.payload && typeof r3.payload === "object") ? r3.payload : {};
  const ret3 = typeof p3.ret === "number" ? p3.ret : (typeof p3.errcode === "number" ? p3.errcode : null);
  appendMeasure({
    kind: "media_probe", stage: "send", httpStatus: r3.httpStatus, ret: ret3,
    payloadKeys: Object.keys(p3).slice(0, 20), hasCaption: Boolean(caption),
    messageIdPresent: "message_id" in p3,
  });
  console.log(`[probe] send: HTTP ${r3.httpStatus} ret=${ret3} keys=[${Object.keys(p3).join(",")}] → 请在手机端确认图片可见且清晰（人工验收点）。`);
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
  else if (cmd === "upload-probe") await cmdUploadProbe(rest);
  else if (cmd === "conc") await cmdConc(rest);
  else if (cmd === "media-probe") await cmdMediaProbe(rest);
  else if (cmd === "status") cmdStatus();
  else {
    console.error("用法：login | listen [--raw-items] [--decrypt] [--short] [--stop-on-hit] [--max-batches N] [--out DIR] | send <toUserId> <text> [contextToken] | reply [--from-last] <toUserId> <text...> | typing <toUserId> [contextToken] | upload-probe [--to uid] [--creds host|probe] | conc [--mode read|send] [--n N] | media-probe [--stage pre|cdn|send --consent ...] | status");
    process.exit(2);
  }
} catch (e) {
  console.error(`[probe] 错误：${e.message}`);
  process.exit(1);
}
