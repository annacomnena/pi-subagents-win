/**
 * runtime-host/commands.ts — G4：POST /v1/commands 薄 HTTP 层（总计划 §24/§26）。
 *
 * 只做「HTTP 请求体 → CommandFrame」的解析/校验与「CommandOutcome → HTTP status」的
 * 映射，不碰任何业务（红线：业务全在 runtime/command-executor.ts 纯库；本层禁 import
 * 业务模块，保持 host→runtime 单向）。
 *
 * 契约（plans/0920_G4_cmdexec_plan.md §1）：
 *   - body 限 64KB；只收 CommandFrame 形状（服务端不造第二套 RPC 形状）；
 *   - issuedBy 服务端注入 agent://runtime-host（客户端可不传；四 scheme 无 host 位，
 *     validateCommandFrame 直过，不改 address.ts——未决 1）；
 *   - outcome 映射：accepted→200 / 4xx(400 invalid-payload·unknown-command·not-implemented，
 *     404 no-workstream·no-proposal，409 bad-state·not-owner·not-attached·replay-unknown-outcome)
 *     / 5xx 仅 io-error·failed；
 *   - 同步执行、同步回执（四命令全是快状态迁移）；
 *   - **POST /v1/commands 是唯一命令入口**（mailbox 命令信 G4 不消费）。
 */

import { RUNTIME_HOST_ISSUER, type CommandOutcome } from "../runtime/command-executor.ts";
import { validateCommandFrame, type CommandFrame } from "../runtime/protocol.ts";

export const COMMAND_BODY_LIMIT_BYTES = 64 * 1024;

/** 请求体解析失败（HTTP 400/413）。server.ts 捕获后直接落 JSON 错误回执。 */
export class CommandRequestError extends Error {
	status: number;
	body: Record<string, unknown>;
	constructor(status: number, body: Record<string, unknown>) {
		super(String(body.error ?? "command-request-error"));
		this.status = status;
		this.body = body;
	}
}

/**
 * 解析并校验 POST /v1/commands 请求体 → CommandFrame。
 * issuedBy 缺失时服务端注入 RUNTIME_HOST_ISSUER；结构非法一律 CommandRequestError(400)。
 */
export function parseCommandRequest(rawBody: string): CommandFrame {
	if (Buffer.byteLength(rawBody, "utf8") > COMMAND_BODY_LIMIT_BYTES) {
		throw new CommandRequestError(413, { error: "payload-too-large", hint: `body 限 ${COMMAND_BODY_LIMIT_BYTES} 字节` });
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawBody);
	} catch {
		throw new CommandRequestError(400, { error: "invalid-json", hint: "body 必须是 CommandFrame JSON" });
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new CommandRequestError(400, { error: "invalid-frame", hint: "body 必须是 CommandFrame 对象" });
	}
	const candidate = parsed as Record<string, unknown>;
	// 拍板 2：服务端注入 issuedBy（GUI/Host 不是 agent；v1 惯例 agent://runtime-host）
	if (candidate.issuedBy === undefined || candidate.issuedBy === null || candidate.issuedBy === "") {
		candidate.issuedBy = RUNTIME_HOST_ISSUER;
	}
	if (!validateCommandFrame(candidate)) {
		throw new CommandRequestError(400, {
			error: "invalid-frame",
			hint: "CommandFrame 校验失败（frame/type 白名单/to·issuedBy 地址/commandKey/issuedAt）",
		});
	}
	return candidate as unknown as CommandFrame;
}

/** 拒绝 reason → HTTP status（§1 词表映射；G6-P2 additive：403 master-session-protected / 404 no-session）。 */
const REJECT_HTTP_STATUS: Record<string, number> = {
	"invalid-payload": 400,
	"unknown-command": 400,
	"not-implemented": 400,
	"master-session-protected": 403,
	"no-workstream": 404,
	"no-proposal": 404,
	"no-session": 404,
	"bad-state": 409,
	"not-owner": 409,
	"not-attached": 409,
	"replay-unknown-outcome": 409,
};

export interface CommandHttpResponse {
	status: number;
	body: Record<string, unknown>;
}

/** CommandOutcome → HTTP 回执（accepted 200 / 拒绝 4xx / 失败 5xx）。 */
export function commandOutcomeHttpResponse(outcome: CommandOutcome): CommandHttpResponse {
	if (outcome.status === "accepted") {
		return { status: 200, body: { status: "accepted", summary: outcome.summary, replayed: outcome.replayed } };
	}
	if (outcome.status === "rejected") {
		return {
			status: REJECT_HTTP_STATUS[outcome.reason] ?? 400,
			body: {
				status: "rejected",
				reason: outcome.reason,
				...(outcome.detail ? { detail: outcome.detail } : {}), // G5.2 additive：面向用户的补充说明
				replayed: outcome.replayed,
			},
		};
	}
	return {
		status: 500,
		body: { status: "failed", reason: outcome.reason, ...(outcome.error ? { error: outcome.error } : {}), replayed: outcome.replayed },
	};
}
