import json
import os

fixtures_dir = r"C:\Users\Annacomnena\pi-packages\subagent-win\extensions\fixtures"


def session_header(sid, ts, cwd):
    return {"type": "session", "version": 3, "id": sid, "timestamp": ts, "cwd": cwd}


def model_change(mid, ts):
    return {"type": "model_change", "id": mid, "parentId": None, "timestamp": ts, "provider": "openai-codex", "modelId": "gpt-5.6-luna"}


def msg(mid, parent, ts, role, text="", stopReason=None, usage=None):
    m = {"role": role, "content": [{"type": "text", "text": text}], "timestamp": ts}
    if stopReason:
        m["stopReason"] = stopReason
    if usage:
        m["usage"] = usage
    if role != "user":
        m["api"] = "responses"
        m["provider"] = "openai-codex"
        m["model"] = "gpt-5.6-luna"
        m["responseId"] = "resp_" + mid
    return {"type": "message", "id": mid, "parentId": parent, "timestamp": ts, "message": m}


USAGE = {"input": 1234, "output": 567, "cacheRead": 890, "cacheWrite": 12, "totalTokens": 2703, "cost": 0.0042}
CW = r"G:\code\worktrees\GreenCAD-219"
CW2 = r"C:\Users\Annacomnena\some-project"


def write(name, entries):
    with open(os.path.join(fixtures_dir, name), "w", encoding="utf8") as f:
        for e in entries:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")


# 1) toolUse 进行中
write("session-tooluse.jsonl", [
    session_header("019f0000-0000-7000-8000-000000000001", "2026-08-06T03:45:15.433Z", CW),
    model_change("a1", "2026-08-06T03:45:15.991Z"),
    msg("b1", None, 1785997500000, "user", "\u6839\u636eworkflow\u8fdb\u884c\u5de5\u4f5c1007\n\n> \u3010\u5de5\u4f5c\u65b9\u5f0f\u7ea6\u675f\u3011\u2026\n\n\u4fee\u590d 1007"),
    msg("c1", "b1", 1785997520000, "assistant", "", "toolUse", USAGE),
])

# 2) stop 等待输入
write("session-stop.jsonl", [
    session_header("019f0000-0000-7000-8000-000000000002", "2026-08-06T03:50:00.000Z", CW),
    model_change("a1", "2026-08-06T03:50:00.500Z"),
    msg("b1", None, 1785997800000, "user", "\u6839\u636eworkflow\u8fdb\u884c\u5de5\u4f5c1007\n\n\u4fee\u590d 1007"),
    msg("c1", "b1", 1785997820000, "assistant", "", "toolUse", USAGE),
    msg("d1", "c1", 1785997900000, "assistant", "\u5df2\u5b8c\u6210\u4fee\u590d\uff0cWiki \u6536\u5c3e\u5df2\u505a\uff0c\u7ed3\u8bba\u5982\u4e0b\uff1a\n\n- \u4fee\u6539 file.ts\n- \u6d4b\u8bd5\u901a\u8fc7", "stop", USAGE),
])

# 3) error 本回合失败
write("session-error.jsonl", [
    session_header("019f0000-0000-7000-8000-000000000003", "2026-08-06T04:00:00.000Z", CW),
    model_change("a1", "2026-08-06T04:00:00.500Z"),
    msg("b1", None, 1785998400000, "user", "\u6839\u636eworkflow\u8fdb\u884c\u5de5\u4f5c1007\n\n\u4fee\u590d 1007"),
    msg("c1", "b1", 1785998420000, "assistant", "\u51fa\u9519\u4e86", "error", USAGE),
])

# 4) aborted 中断（真实 219 会话形态）
write("session-aborted.jsonl", [
    session_header("019f0000-0000-7000-8000-000000000004", "2026-08-06T03:45:15.433Z", CW),
    model_change("a1", "2026-08-06T03:45:15.991Z"),
    msg("b1", None, 1785997500000, "user", "\u6839\u636eexecute\u8fdb\u884c\u5de5\u4f5c219\n\n> \u3010\u5de5\u4f5c\u65b9\u5f0f\u7ea6\u675f \u00b7 \u5f3a\u5236 \u00b7 \u5feb\u901f\u6267\u884c\u3011\u2026\n\n\u5b9e\u73b0 219"),
    msg("c1", "b1", 1785997520000, "assistant", "", "toolUse", USAGE),
    msg("d1", "c1", 1785998000000, "assistant", "", "aborted", USAGE),
    model_change("a2", "2026-08-06T04:00:00.000Z"),
])

# 5) 只有 user，无 assistant
write("session-useronly.jsonl", [
    session_header("019f0000-0000-7000-8000-000000000005", "2026-08-06T04:10:00.000Z", CW),
    model_change("a1", "2026-08-06T04:10:00.500Z"),
    msg("b1", None, 1785999000000, "user", "\u6839\u636eworkflow\u8fdb\u884c\u5de5\u4f5c1007\n\n\u4fee\u590d 1007"),
])

# 6) 不匹配：taskId 9999 vs 1007
write("session-nomatch.jsonl", [
    session_header("019f0000-0000-7000-8000-000000000006", "2026-08-06T04:20:00.000Z", CW),
    model_change("a1", "2026-08-06T04:20:00.500Z"),
    msg("b1", None, 1785999600000, "user", "\u6839\u636eworkflow\u8fdb\u884c\u5de5\u4f5c9999\n\n\u522b\u7684\u4efb\u52a1"),
    msg("c1", "b1", 1785999620000, "assistant", "\u597d\u4e86", "stop", USAGE),
])

# 7) research 前缀：对 workflow 模式不匹配，对 research 模式匹配
write("session-research.jsonl", [
    session_header("019f0000-0000-7000-8000-000000000007", "2026-08-06T04:30:00.000Z", CW2),
    model_change("a1", "2026-08-06T04:30:00.500Z"),
    msg("b1", None, 1786000200000, "user", "\u6839\u636eresearch\u8fdb\u884c\u5de5\u4f5c1008\n\n\u6df1\u5ea6\u8c03\u7814 X \u6a21\u5757"),
    msg("c1", "b1", 1786000300000, "assistant", "\u7814\u7a76\u62a5\u544a\u5df2\u5199\u5165 plans/\u2026", "stop", USAGE),
])

print("fixtures written:", sorted(os.listdir(fixtures_dir)))
