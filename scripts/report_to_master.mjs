// 让任意进程（含 local master 主会话）发一份**显式指定接收方**的 report。
//
// 为什么需要它：`tab-report` 工具对非 tab 进程硬拒绝（`PI_TAB_RUN_ID` 硬门是防伪造的正确设计，
// 不应放宽）。但 local master 需要向 global master 横向汇报 ⇒ 需要一个**不伪造身份**的入口。
//
// ⚠ 2026-11-26 修正（global master 用一个 pid 就揭穿了我）：
//   原版接受手工 `from`，于是我在 GreenCAD 的 cwd 里跑脚本、手写 `from=GreenCAD` ——
//   收到的报带 `pid=我的脚本进程`，与 GreenCAD 会话 pid 不符。**`from` 是自报，什么都不证明。**
//   ⇒ 现在 `from` **默认从继承的 `PI_SESSION_ID` 反查自己的地址**；手工传入时会与 env 核对，
//     不一致直接**拒绝发送**（而不是发出去让别人去查）。
//
// 用法：
//   node --experimental-strip-types --import <此仓>/extensions/runtime-host/pi-deps-loader.mjs \
//        <此仓>/scripts/report_to_master.mjs <to> <bodyFile> [fromAddr] [taskId]
//   to        agent://master_default | agent://master_local_X | 会话 UUID | tab_*
//   bodyFile  正文文件路径
//   fromAddr  **建议不传**（自动取你自己）。传了必须与你的 PI_SESSION_ID 一致，否则拒绝。
//
// 输出：{ ok, reportId, to, from, fromSource, recipient, willRoute }
// ⚠ 注意 `--import` 必须写 `file:///C:/…`；写 `C:/…` 会报 ERR_UNSUPPORTED_ESM_URL_SCHEME。
import { readFileSync } from "node:fs";

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
					why: "你正以别的会话的身份发报。收方会用一个 pid 核查并把它判为冒充 —— 发出去只会浪费双方时间。",
					fix: "去掉 fromAddr 参数（自动取你自己的地址），或换到那个会话里执行。",
				},
				null,
				2,
			),
		);
		process.exit(3);
	}
	from = explicit;
	fromSource = att ? "explicit(与 attachment 一致)" : "explicit(无 attachment，收方会要做额外核查)";
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

const body = readFileSync(bodyFile, "utf8");

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
			hint: recipient
				? "接收方已解析；消费与否看 reports/<id>.notified（R-25：发送侧成功 ≠ 送达）"
				: "解析不出接收方 ⇒ 会落 .unroutable 并可重试（检查 registry/attachments/<addr>.json 是否存在）",
		},
		null,
		2,
	),
);
