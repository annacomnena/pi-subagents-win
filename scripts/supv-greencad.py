#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
_gc_supervisor.py — GreenCAD 常驻督管快照（只读，不推送、不注入）

用途：每个督管 tick 跑一次，把「他还活着吗 / 干到哪了 / 有红吗 / 卡在什么」压成一段
可直接贴进微信的短报文。禁止用它自动改任何东西。

用法：
  PYTHONIOENCODING=utf-8 python scripts/_gc_supervisor.py            # 人类可读
  PYTHONIOENCODING=utf-8 python scripts/_gc_supervisor.py --digest   # 单段纯文本（给微信）
  PYTHONIOENCODING=utf-8 python scripts/_gc_supervisor.py --json     # 机器可读
"""
import glob
import io
import sys as _sys

# Windows 控制台默认 GBK：中文/⚠ 会变乱码或直接抛 UnicodeEncodeError。
# 让脚本自己保证 UTF-8 输出，不依赖调用方设 PYTHONIOENCODING。
try:
    _sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    _sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import json
import os
import subprocess
import sys
import time

SESS_DIR = r"C:\Users\Annacomnena\.pi\agent\sessions\--G--code-GreenCAD--"
MASTER_REG = r"C:\Users\Annacomnena\.pi\agent\runtime\registry\attachments\agent___master_local_GreenCAD.json"
MAIN_REPO = r"G:\code\GreenCAD"
WORKTREES = ["G:\\code\\worktrees\\GreenCAD-S2", "G:\\code\\GreenCAD"]


def sh(cmd, cwd):
    try:
        r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
        return (r.stdout or "") + (r.stderr or "")
    except Exception as e:  # noqa: BLE001
        return "<err %s>" % e


def ps(cmd):
    try:
        r = subprocess.run(["powershell", "-NoProfile", "-Command", cmd],
                           capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
        return (r.stdout or "").strip()
    except Exception as e:  # noqa: BLE001
        return "<err %s>" % e


def active_sessions(window_min=30):
    """近 window 分钟内被写过的所有 GreenCAD 会话（长驻 master + 唤醒派生的 tab 都算）。"""
    out = []
    now = time.time()
    for p in glob.glob(os.path.join(SESS_DIR, "*.jsonl")):
        try:
            mt = os.path.getmtime(p)
        except OSError:
            continue
        if (now - mt) / 60 <= window_min:
            out.append({"f": os.path.basename(p), "idle_min": int((now - mt) / 60)})
    out.sort(key=lambda x: x["idle_min"])
    return out


def find_session():
    paths = sorted(glob.glob(os.path.join(SESS_DIR, "*.jsonl")), key=os.path.getmtime)
    if not paths:
        return None, None
    f = paths[-1]
    return f, os.path.getmtime(f)


DELEG_MARK = "业主离线委托"
OWNER_DECISIONS = os.path.expanduser("~/.pi/agent/runtime/state/supv-greencad/owner-decisions.md")
OUTBOX_DELEG = "C:/Users/Annacomnena/.pi/agent/runtime/state/message-outbox/1c0c8d46f30e97beabe0467186129b5a1d733bc40b682bc7bf5e14b281ce5370.json"


def delegation_status(_session_file=None):
    """离线委托是否已进**任一**活跃会话正文（outbox 状态 ≠ 真收到；唤醒会开新 tab 接活）。"""
    status = "unknown"
    try:
        d = json.load(open(OUTBOX_DELEG, encoding="utf-8"))
        status = d.get("status") or "unknown"
    except Exception:
        status = "outbox-missing"
    landed = None
    landed_in = None
    now = time.time()
    for p in glob.glob(os.path.join(SESS_DIR, "*.jsonl")):
        try:
            mt = os.path.getmtime(p)
        except OSError:
            continue
        # 只看近 6 小时内写过的（更早的会话不可能收到今天这条委托）
        if (now - mt) / 3600 > 6:
            continue
        try:
            txt = open(p, encoding="utf-8", errors="replace").read()
        except Exception:
            continue
        if DELEG_MARK in txt:
            landed = True
            landed_in = os.path.basename(p)
            break
        if landed is None:
            landed = False
    return {"outbox": status, "landed_in_session": landed, "landed_in": landed_in}


def owner_decisions():
    """业主离线期间累积的待拍板项（我手工维护的短清单，不解析他的话）。"""
    try:
        rows = [ln.rstrip() for ln in open(OWNER_DECISIONS, encoding="utf-8").read().splitlines()]
    except Exception:
        return []
    return [r for r in rows if r.strip() and not r.lstrip().startswith("#")][:6]


INBOX_DIR = os.path.expanduser("~/.pi/agent/runtime/wechat/receive/inbox")


def latest_inbound():
    """最近一条业主入站消息的时间（ISO）。读不到 → None（不影响其它判据）。"""
    try:
        files = glob.glob(os.path.join(INBOX_DIR, "*.json"))
        if not files:
            return None
        newest = max(files, key=os.path.getmtime)
        d = json.load(open(newest, encoding="utf-8"))
        return {"latestAt": d.get("receivedAt"), "text": (d.get("text") or "")[:60]}
    except Exception:
        return None


def tail_events(path, n=120):
    """读会话 JSONL 尾部，抽出「助手文本 / 工具名 / 工具结果摘要」三种信号。"""
    try:
        lines = open(path, encoding="utf-8", errors="replace").read().splitlines()
    except Exception:
        return [], 0
    ev = []
    for ln in lines[-n:]:
        try:
            o = json.loads(ln)
        except Exception:
            continue
        t = o.get("type")
        m = o.get("message") or {}
        role = m.get("role")
        c = m.get("content")
        rl = (role or "").lower()
        if isinstance(c, list) and "toolresult" in rl.replace("_", ""):
            ev.append({"kind": "res", "role": role, "s": json.dumps(c, ensure_ascii=False)})
            continue
        if isinstance(c, list):
            for p in c:
                pt = p.get("type")
                if pt == "text":
                    ev.append({"kind": "text", "role": role, "s": (p.get("text") or "")})
                elif pt == "thinking":
                    ev.append({"kind": "think", "role": role, "s": (p.get("thinking") or "")})
                elif pt in ("toolCall", "tool_use", "tool_call"):
                    args = p.get("arguments", p.get("input"))
                    ev.append({"kind": "tool", "role": role,
                               "s": "%s %s" % (p.get("name"), json.dumps(args, ensure_ascii=False))})
                elif pt in ("toolResult", "tool_result"):
                    ev.append({"kind": "res", "role": role,
                               "s": json.dumps(p.get("content"), ensure_ascii=False)})
        elif isinstance(c, str) and c.strip():
            ev.append({"kind": "text", "role": role, "s": c})
    return ev, len(lines)


def first_regex(s, pats):
    import re
    for p in pats:
        m = re.search(p, s)
        if m:
            return m.group(0).strip()
    return None


def test_reading(ev):
    """从工具结果里抽最后一次 dotnet 测试读数（Failed/Passed/Total）。"""
    import re
    reading = None
    for e in ev:
        if e["kind"] != "res":
            continue
        m = re.search(r"Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+),\s*Total:\s*(\d+)", e["s"])
        if m:
            reading = {"failed": int(m.group(1)), "passed": int(m.group(2)),
                       "skipped": int(m.group(3)), "total": int(m.group(4))}
    return reading


def dump(*, as_json=False):
    f, mtime = find_session()
    snap = {"at": time.strftime("%Y-%m-%d %H:%M:%S"), "session": os.path.basename(f) if f else None}
    if not f:
        snap["error"] = "GreenCAD 会话文件不存在"
        return snap
    age_min = int((time.time() - mtime) / 60)
    snap["session_mtime"] = time.strftime("%H:%M:%S", time.localtime(mtime))
    snap["idle_min"] = age_min

    # 主会话进程是否还在（按 --session 路径里的会话文件名匹配命令行）
    snap["alive"] = None
    snap["master_pids"] = []
    try:
        reg = json.load(open(MASTER_REG, encoding="utf-8"))
        snap["pid_session"] = reg.get("sessionId")
    except Exception:
        reg = {}
    sid = f.rsplit("_", 1)[-1].replace(".jsonl", "")  # 文件名尾部就是 sessionId
    snap["session_id"] = sid
    # 两种形态都要匹配：长驻会话是 `--session ...--G--code-GreenCAD--\...jsonl`，
    # 唤醒派生的 tab 是 `--tab-run-id tab_xxx @launch-prompt.md`（命令行里都没有 sessionId）
    # ⇒ 按「仓桶 + 会话文件 basename」两者任一命中，都说明这个仓里还有活进程。
    base = os.path.basename(f)
    pids = ps("Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" |"
              " Where-Object { $_.CommandLine -like '*%s*' -or $_.CommandLine -like '*%s*' } |"
              " ForEach-Object { $_.ProcessId }" % ("--G--code-GreenCAD--", base)).split()
    snap["master_pids"] = [p for p in pids if p.isdigit()]
    # 判「活着」不能只看 pid：唤醒派生的 tab 命令行里既没有 sessionId 也没有仓桶名
    # （只有 `--tab-run-id tab_xxx @launch-prompt.md`），但它在往会话文件里写东西。
    # ⇒ pid 命中 **或** 会话文件近 10 分钟被写过，都算活着；只有两者皆否才算「进程不在」。
    fresh = int((time.time() - mtime) / 60) <= 10
    snap["alive"] = bool(snap["master_pids"]) or fresh
    snap["alive_by"] = "pid" if snap["master_pids"] else ("session-mtime" if fresh else "none")

    snap["active_sessions"] = active_sessions()
    ev, total = tail_events(f, 400)
    snap["session_lines"] = total
    def is_assistant_text(e):
        if e["kind"] != "text":
            return False
        r = (e.get("role") or "").lower()
        if "assistant" not in r:
            return False
        return len(e["s"]) > 60 and "Failed:" not in e["s"] and "\n" in e["s"][:200]

    snap["last_text"] = next((e["s"] for e in reversed(ev) if is_assistant_text(e)), "")[:700]
    snap["last_think"] = next((e["s"] for e in reversed(ev) if e["kind"] == "think"), "")[:400]
    snap["last_tools"] = [e["s"][:90] for e in reversed(ev) if e["kind"] == "tool"][:6]
    snap["tests"] = test_reading(ev)

    # 仓状态
    for wt in WORKTREES:
        if not os.path.isdir(wt):
            continue
        st = sh(["git", "status", "--short"], wt).strip().splitlines()
        log = sh(["git", "log", "--oneline", "-2"], wt).strip().splitlines()
        key = os.path.basename(wt)
        snap.setdefault("repos", {})[key] = {
            "dirty": len(st), "dirty_files": [x[:80] for x in st[:6]],
            "head": log[0][:110] if log else "",
        }

    # 入站最新时间：**仅供诊断显示**。不要再拿它当「出站额度重置」的判据 ——
    # 2026-11-16 实测已证伪该因果（6 条入站后仍有连续 9 次 -2）。
    snap["inbound"] = latest_inbound()

    # 离线委托投递状态：他到底收到那段「自己做完 + 只派 gpt-6.1-sol」的指令没有
    snap["delegation"] = delegation_status(f)

    # 最新 plans / 报告
    plans = sorted(glob.glob(os.path.join(MAIN_REPO, "plans", "*.md")), key=os.path.getmtime, reverse=True)[:4]
    snap["plans_newest"] = [
        {"f": os.path.basename(p), "age_min": int((time.time() - os.path.getmtime(p)) / 60),
         "kb": round(os.path.getsize(p) / 1024, 1)}
        for p in plans
    ]
    return snap


def digest(snap):
    """压成 ≤1200 字的微信报文。"""
    if snap.get("error"):
        return "【GreenCAD 督管】%s\n%s" % (snap.get("at"), snap["error"])
    L = []
    L.append("【GreenCAD 督管】%s" % snap["at"])
    alive = "在跑" if snap.get("alive") else "⚠ 无 node 进程"
    nact = len(snap.get("active_sessions") or [])
    if nact > 1:
        alive += "（%d 个活跃会话：长驻 %s + 唤醒 tab）" % (
            nact, "，".join("%s(%d分前)" % (os.path.basename(x["f"])[-46:][:26], x["idle_min"])
                           for x in (snap.get("active_sessions") or [])[:2]))
    L.append("状态：%s ｜ 会话静默 %d 分钟（末次 %s）" % (alive, snap["idle_min"], snap["session_mtime"]))
    for name, r in (snap.get("repos") or {}).items():
        L.append("%s：脏文件 %d ｜ HEAD %s" % (name, r["dirty"], r["head"]))
    if snap.get("tests"):
        t = snap["tests"]
        L.append("最新测试读数：Failed %d / Passed %d / Total %d" % (t["failed"], t["passed"], t["total"]))
    if snap.get("last_tools"):
        L.append("最近动作：" + " ; ".join(snap["last_tools"][:3]))
    if snap.get("last_text"):
        L.append("他的最新自述：" + snap["last_text"][:400].replace("\n", " "))
    if snap.get("last_think"):
        L.append("在想的：" + snap["last_think"][:180].replace("\n", " "))
    dg = snap.get("delegation") or {}
    if dg.get("landed_in_session") is False:
        L.append("⚠ 离线委托尚未进他正文（outbox=%s）" % dg.get("outbox"))
    elif dg.get("landed_in_session") is True:
        L.append("离线委托：已进他正文%s" % (("（" + dg["landed_in"][-32:] + "）") if dg.get("landed_in") else ""))
    if snap.get("plans_newest"):
        L.append("新落盘：" + " / ".join("%s(%d分前)" % (p["f"], p["age_min"]) for p in snap["plans_newest"][:2]))
    # 待拍板清单（我人工维护，只在有内容时附上）
    dec = owner_decisions()
    if dec and any("**" in d for d in dec):
        L.append("—— 待你拍板 ——")
        L.extend(dec)
    txt = "\n".join(L)
    return txt[:2200]


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    s = dump()
    if mode == "--json":
        print(json.dumps(s, ensure_ascii=False, indent=1))
    elif mode == "--digest":
        print(digest(s))
    else:
        print(json.dumps(s, ensure_ascii=False, indent=1))
        print("\n" + "=" * 60 + "\n")
        print(digest(s))
