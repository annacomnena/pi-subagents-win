// 让任意进程（含 local master 主会话）发一份**显式指定接收方**的 report。
//
// 为什么需要它：`tab-report` 工具对非 tab 进程硬拒绝（`PI_TAB_RUN_ID` 硬门是防伪造的正确设计，
// 不应放宽）。但 local master 需要横向汇报 ⇒ 需要一个不伪造身份的入口。
//
// ⚠ 2026-11-26 两轮修正（global master 的现场核查逼出来的）：
//   ① 原版接受手工 `from`，于是「在 X 仓的 cwd 里跑脚本 + from 写 X」看起来像 X 发的。
//      ⇒ 现在 `from` **默认从继承的 `PI_SESSION_ID` 反查自己的地址**；手工传入会与 env 核对，
//        不一致直接**拒绝发送**。
//   ② 但在脚本入口下，`pid` 永远是**短命子进程**，收方无法用它核「哪个会话」（实测：GreenCAD
//      那份报 pid=31244 已退出，会话是 30212）。⇒ **身份在这里天然不可核**。
//      要可核身份只能用会话进程内的工具 `work-report`。
//
// 用法：
//   node --experimental-strip-types --import "file:///<此仓>/extensions/runtime-host/pi-deps-loader.mjs" \
//        <此仓>/scripts/report_to_master.mjs <to> <bodyFile> [fromAddr] [taskId]
//   to        agent://master_default | agent://master_local_X | 会话 UUID | tab_*
//   bodyFile  正文文件路径
//   fromAddr  **建议不传**（自动取你自己）。传了必须与你的 PI_SESSION_ID 一致，否则拒绝。
//
// 环境变量：
//   REPORT_NO_AUTO_CTX=1  不自动注入 [auto] cwd/repo/head/branch 行
//
// ⚠ `--import` 必须写 `file:///C:/…`；写 `C:/…` 会报 ERR_UNSUPPORTED_ESM_URL_SCHEME。
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const [to, bodyFile, fromArg, taskId] = process.argv.slice(2);
if (!to || !bodyFile) {
	console.error("usage: node ... report_to_master.mjs <to> <bodyFile> [fromAddr] [taskId]");
	process.exit(2);
}

const { recipientSessionIdFor, sendReportToMain } = await import(
	new URL("../extensions/report.ts", import.meta.url).href
);
const { readAttachment, findAttachmentBySession } = await import(
	new URL("../extensions/runtime/registry.ts", import.meta.url).href
);

const envSession = process.env.PI_SESSION_ID?.trim() || "";
const explicit = fromArg?.trim() || "";

let from;
let fromSource;

if (explicit) {
	// 手工 from ⇒ 必须能自证。这是为了拦住「用别人的身份发」这种形状（我自己犯过）。
	const att = readAttachment(explicit);
	if (envSession && att && att.sessionId !== envSession) {
		console.error(
			JSON.stringify(
				{
					ok: false,
					error: "from-mismatch（拒绝发送）",
					explicitFrom: explicit,
					attachmentSessionId: att.sessionId,
					yourEnvSessionId: envSession,
					why: "你正以别的会话的身份发报。收方核查会把这条判为冒充 —— 发出去只会浪费双方时间。",
					fix: "去掉 fromAddr 参数（自动取你自己的地址），或换到那个会话里执行。",
				},
				null,
				2,
			),
		);
		process.exit(3);
	}
	from = explicit;
	fromSource = att ? "explicit(与 attachment 一致)" : "explicit(无 attachment，收方需额外核查)";
} else {
	const own = envSession ? findAttachmentBySession(envSession) : null;
	if (!own) {
		console.error(
			JSON.stringify(
				{
					ok: false,
					error: "无法自动确定自己的身份",
					envSessionId: envSession || null,
					why: "没有 PI_SESSION_ID（不在 pi 会话进程树里），或这个会话没有 master attachment。",
					fix: "在 pi 会话里用 bash 调用本脚本（子进程会继承 PI_SESSION_ID）；或显式传 fromAddr（但必须真实）。",
				},
				null,
				2,
			),
		);
		process.exit(4);
	}
	from = own.agentAddress;
	fromSource = "auto(从 PI_SESSION_ID 反查)";
}

/**
 * 自动注入可核事实（global master 的硬要求「正文必须带 HEAD 与 cwd」的自动化版）。
 *
 * 为什么自动而不是让人手写：手写的字段和 `from` 一样不可信 —— 会写错、会忘记、会复制上一次的。
 * 脚本在哪个 cwd 跑就读哪个仓的 HEAD，至少保证「它真的在那个目录读过 git」。
 *
 * ⚠ 不得超额声称：`HEAD` **零身份证明力** —— 任何进程都能
 * `git -C <别人的仓> rev-parse HEAD` 读到（实测：我在 subagent-win 里读到了 GreenCAD 的 f9c8c0cf）。
 * 它证明的是「发这条的人读过那个仓」，不是「那个仓的人发的」。
 * 真正可核的身份只有 pid(存活时) + OS 命令行，或 work-report 工具（pid = 会话进程）。
 */
function autoContext() {
	const cwd = process.cwd();
	const NL = String.fromCharCode(10);
	try {
		const git = (args) =>
			execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
		const head = git(["rev-parse", "--short", "HEAD"]);
		const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
		const toplevel = git(["rev-parse", "--show-toplevel"]);
		let dirty = "?";
		try {
			dirty = `${git(["status", "--porcelain"]).split(NL).filter(Boolean).length} changed`;
		} catch {
			dirty = "?";
		}
		return `[auto] cwd=${cwd} repo=${toplevel} head=${head} branch=${branch} ${dirty}`;
	} catch {
		return `[auto] cwd=${cwd} repo=(not a git repo)`;
	}
}

const rawBody = readFileSync(bodyFile, "utf8");
const NL2 = String.fromCharCode(10);
const body = process.env.REPORT_NO_AUTO_CTX === "1" ? rawBody : `${autoContext()}${NL2}${NL2}${rawBody}`;

// 先算「能不能路由」再发，让调用方当场知道结果（而不是发完才发现是黑洞）
const recipient = recipientSessionIdFor({ from, to });

const id = sendReportToMain({
	from,
	to,
	message: body,
	...(taskId ? { taskId } : {}),
	summary: `report_to_master → ${to}`,
});

console.log(
	JSON.stringify(
		{
			ok: true,
			reportId: id,
			to,
			from,
			fromSource,
			envSessionId: envSession || null,
			recipient: recipient ?? null,
			willRoute: Boolean(recipient),
			identityStrength: {
				pid: "短命子进程，收方无法据此核会话 ⇒ 弱",
				envSessionId: "继承自父进程 ⇒ 中（可主动伪造）",
				autoCtxHead: "零身份力（谁都能读别人的 HEAD），只证明「读过那个仓」",
			},
			hint: recipient
				? "接收方已解析；消费与否看 reports/<id>.notified（R-25：发送侧成功 ≠ 送达）"
				: "解析不出接收方 ⇒ 会落 .unroutable 并可重试（检查 registry/attachments/<addr>.json 是否存在）",
		},
		null,
		2,
	),
);
