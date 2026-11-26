// 让任意进程（含 local master 主会话）发一份**显式指定接收方**的 report。
//
// 为什么需要它：`tab-report` 工具对非 tab 进程硬拒绝（`PI_TAB_RUN_ID` 硬门是防伪造的正确设计，
// 不应放宽）。但 local master 需要向 global master 横向汇报 ⇒ 需要一个**不伪造身份**的入口。
// 本脚本复用 `sendReportToMain`（同一落盘咽喉点），要求**显式给 to**（不从 from 推导，避免自环）。
//
// 用法：
//   node --experimental-strip-types scripts/report_to_master.mjs <to> <bodyFile> [fromAddr] [taskId]
//   to        agent://master_default | agent://master_local_X | 会话 UUID | tab_*
//   bodyFile  正文文件路径（建议 >1000 字符的内容写文件，report 里的 message 自带路径）
//   fromAddr  缺省 agent://master_local_<cwd basename>（仅作标识，不参与路由）
//
// 输出：{ ok, reportId, to, recipient, willRoute }
//   willRoute=false ⇒ 接收方解析不出来（会落 .unroutable 并被重试，不是静默丢弃）
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { recipientSessionIdFor, sendReportToMain } from "../extensions/report.ts";

const [to, bodyFile, fromArg, taskId] = process.argv.slice(2);
if (!to || !bodyFile) {
	console.error("usage: node --experimental-strip-types scripts/report_to_master.mjs <to> <bodyFile> [fromAddr] [taskId]");
	process.exit(2);
}

const from = fromArg?.trim() || `agent://master_local_${basename(resolve(process.cwd())).replace(/[^A-Za-z0-9._-]/g, "-")}`;
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
