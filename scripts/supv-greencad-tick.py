#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
supv-greencad-tick.py — GreenCAD 督管 tick（每次定时器到期跑一次）

流程：抓快照 → 与上次落盘的签名比对 → 有实质变化才推微信（无变化只更新状态文件，不打扰）
      → 发现「进程没了 / 长期静默 / 新增失败红」时强制推送并标 ⚠。

用法：
  PYTHONIOENCODING=utf-8 python scripts/supv-greencad-tick.py            # 执行 tick
  PYTHONIOENCODING=utf-8 python scripts/supv-greencad-tick.py --dry      # 只看会不会推，不真发

状态文件：<repo>/debug/supv-greencad-state.json（不写 plans/，不是交付物）
"""
import json
import io
import sys as _sys

# Windows 控制台默认 GBK：中文/⚠ 会变乱码或直接抛 UnicodeEncodeError。
# 让脚本自己保证 UTF-8 输出，不依赖调用方设 PYTHONIOENCODING。
try:
    _sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    _sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import importlib.util

spec = importlib.util.spec_from_file_location("supv", os.path.join(HERE, "supv-greencad.py"))
supv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(supv)

STATE = os.path.expanduser("~/.pi/agent/runtime/state/supv-greencad/state.json")
STALL_MIN = 45          # 静默超过这么久 = 疑似停滞，必须推
DRY = "--dry" in sys.argv
DELEG_FILE_HINT = "G:/code/GreenCAD/plans/20261116_owner_offline_delegation.md"


def load_state():
    try:
        return json.load(open(STATE, encoding="utf-8"))
    except Exception:
        return {}


def save_state(s):
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    tmp = STATE + ".tmp"
    json.dump(s, open(tmp, "w", encoding="utf-8", newline="\n"), ensure_ascii=False, indent=1)
    os.replace(tmp, STATE)


def _ts(value):
    """把本地 'YYYY-MM-DD HH:MM:SS' 与 ISO '…Z' 统一成 epoch；无法解析 → 0。

    WHY 必须统一：冷却判定原来直接比字符串，而两种格式同日比较恒为 '本地 < ISO'
    （空格 0x20 < 'T' 0x54）⇒ 冷却每轮都被误解除，等于没有冷却。自测抓到的。
    """
    if not value:
        return 0.0
    import datetime as _dt
    s = str(value).strip()
    try:
        if "T" in s:
            return _dt.datetime.strptime(s.replace("Z", "")[:19], "%Y-%m-%dT%H:%M:%S").replace(
                tzinfo=_dt.timezone.utc).timestamp()
        return _dt.datetime.strptime(s[:19], "%Y-%m-%d %H:%M:%S").timestamp()
    except Exception:
        return 0.0


def signature(snap):
    """进度签名：任何一项变化就算「有进展」，需要推送。"""
    repos = snap.get("repos") or {}
    return {
        "lines": snap.get("session_lines"),
        "tests": snap.get("tests"),
        "heads": {k: (v.get("head") or "")[:40] for k, v in repos.items()},
        "dirty": {k: v.get("dirty") for k, v in repos.items()},
        "plans": [p["f"] for p in (snap.get("plans_newest") or [])[:2]],
        "alive": snap.get("alive"),
        # 委托是否进了他正文（outbox pending 只是「已提交」，不算送达）
        "deleg": (snap.get("delegation") or {}).get("landed_in_session"),
    }


OUTBOX_FALLBACK = os.path.expanduser("~/.pi/agent/runtime/state/supv-greencad/undelivered.md")

# 积压上限：超过则滚动归档并只保留最新状态段（防 -2 长期失败把文件堆成几十 KB）
OUTBOX_MAX_BYTES = 6000
# 出站失败（ret=-2 / prepare failed）：HTTP 200 + 业务拒收，**原因未确证**。
# 已否证的假设（2026-11-16 当天数据）：
#   ✗ 「每入站 ≈ 只允许回 10 条」——11:09–14:44 有 6 条入站，15:39–16:28 仍 9 连 -2
#   ✗ 「业主发新消息即重置」——18:44 距 18:02 已 42 分钟，仍 -2
#   ✗ 与 token 无关（入站 connected / received 正常）、与正文长度无关（17–1367 字符全挂）
# ⇒ 只能按**纯时间衰减**冷却（撞 -2 就退避、不再空发；每次空发都是一条失败记录），内容落盘留档。
OUTBOUND_COOLDOWN_MIN = 15


def _roll_outbox_if_too_big():
    """积压超上限 ⇒ 归档原件，只保留「最新状态段」，防 -2 长期失败把文件堆到几十 KB。"""
    try:
        if not os.path.exists(OUTBOX_FALLBACK):
            return
        if os.path.getsize(OUTBOX_FALLBACK) <= OUTBOX_MAX_BYTES:
            return
        raw = io.open(OUTBOX_FALLBACK, encoding="utf-8").read()
        arch = OUTBOX_FALLBACK.replace(".md", "-ARCHIVE-%s.md" % time.strftime("%Y%m%d-%H%M%S"))
        io.open(arch, "w", encoding="utf-8", newline="\n").write(raw)
        blocks = [b.strip() for b in raw.split("\n---\n") if b.strip()]
        keep = None
        for b in reversed(blocks):
            if "【GreenCAD 督管】" in b:
                keep = b
                break
        head = ("# 待送达积压（自动滚动压缩）\n\n"
                "> 原件归档：`%s`\n"
                "> 只保留最新一条状态，通道恢复后整条补发。\n\n" % os.path.basename(arch))
        io.open(OUTBOX_FALLBACK, "w", encoding="utf-8", newline="\n").write(head + (keep or "") + "\n")
    except Exception:
        pass


def append_undelivered(text, reason):
    os.makedirs(os.path.dirname(OUTBOX_FALLBACK), exist_ok=True)
    with open(OUTBOX_FALLBACK, "a", encoding="utf-8", newline="\n") as fh:
        fh.write("\n---\n**%s**（未送达：%s）\n\n%s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), reason, text))
    _roll_outbox_if_too_big()


def notify(text):
    """发一条；返回 (ok, detail)。失败一律落盘留档，绝不丢内容。"""
    if DRY:
        print("[DRY] would send:\n" + text)
        return True, "dry"
    f = os.path.join(HERE, "_notify_txt.txt")
    open(f, "w", encoding="utf-8", newline="\n").write(text)
    try:
        r = subprocess.run(
            ["node", "--experimental-strip-types", os.path.join(HERE, "notify-wechat.mjs"), f],
            cwd=os.path.dirname(HERE), capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
        out = (r.stdout or "").strip()
        print("notify:", out[:300], (r.stderr or "").strip()[:200])
        ok = '"ok":true' in out.replace(" ", "")
        if not ok:
            append_undelivered(text, "sendmessage 失败: %s" % (out[:200] or "unknown"))
        return ok, ("" if ok else out[:200])
    finally:
        try:
            os.remove(f)
        except OSError:
            pass


def main():
    snap = supv.dump()
    st = load_state()
    sig = signature(snap)
    prev = st.get("sig") or {}

    alerts = []
    if snap.get("alive") is False:
        alerts.append("⚠ 主会话进程不在了")
    if snap.get("idle_min", 0) >= STALL_MIN:
        alerts.append("⚠ 会话已静默 %d 分钟（≥%d）" % (snap["idle_min"], STALL_MIN))
    t = snap.get("tests")
    pt = prev.get("tests")
    # 失败数告警要防抖：他自己在跑变异实验时失败数本来就会涨（真红是预期结果），
    # 只有「失败数上升 **且** 静默 ≥15 分钟」才算卡住；否则纯噪声会每 tick 刷屏。
    if t and pt and t.get("failed", 0) > pt.get("failed", 0) and snap.get("idle_min", 0) >= 15:
        alerts.append("⚠ 失败数上升 %d → %d（且已静默 %d 分钟）" % (pt.get("failed", 0), t.get("failed", 0), snap["idle_min"]))

    # 委托长时间没进正文：outbox 已提交但目标会话一直没到回合边界 ⇒ 必须让业主知道
    dg = snap.get("delegation") or {}
    if dg.get("landed_in_session") is False:
        age = st.get("delegPendingSince")
        if not age:
            st["delegPendingSince"] = snap.get("at")
        else:
            try:
                import datetime as _dt
                t0 = _dt.datetime.strptime(age, "%Y-%m-%d %H:%M:%S")
                mins = int((time.time() - t0.timestamp()) / 60)
                if mins >= 60:
                    alerts.append("⚠ 离线委托已提交 %d 分钟仍未进他正文（outbox=%s）—— 他可能长回合未完；文件在盘：%s"
                                  % (mins, dg.get("outbox"), DELEG_FILE_HINT))
            except Exception:
                pass
    else:
        st.pop("delegPendingSince", None)

    changed = sig != prev
    msg = supv.digest(snap)
    if alerts:
        msg = msg + "\n" + "\n".join(alerts)

    if not (changed or alerts):
        print("NO-CHANGE (nothing to push) at %s" % snap.get("at"))
        st["sig"] = sig
        st["lastTickAt"] = snap.get("at")
        save_state(st)
        return

    # 出站 -2（prepare failed）的真实因果**未确证**：2026-11-16 实测反证了「业主发新消息即重置」
    # ——当天 11:09~14:44 有 6 条入站，15:39~16:28 的 9 次发送仍全部 -2。
    # ⇒ 冷却只按时间衰减，**不**把入站当重置开关；冷却期内最多每 15 分钟探测一次，
    #   探测失败就重新冷却（避免每 tick 空撞）。
    cool_until = st.get("outboundCoolUntil")
    if cool_until and _ts(snap.get("at")) < _ts(cool_until):
        append_undelivered(msg, "出站冷却中（上次 -2，冷却至 %s；-2 原因未确证）" % cool_until)
        print("OUTBOUND-COOLDOWN: 出站冷却中，落盘留档不发送（至 %s，原因未确证）" % cool_until)
        st["sig"] = sig
        st["lastTickAt"] = snap.get("at")
        save_state(st)
        return

    ok, detail = notify(msg)
    if ok:
        st.pop("outboundCoolUntil", None)
        st["outboundFails"] = 0
        print("PUSHED changed=%s alerts=%d" % (changed, len(alerts)))
    else:
        st["outboundFails"] = int(st.get("outboundFails") or 0) + 1
        if "-2" in detail or "prepare failed" in detail:
            import datetime as _dt
            st["outboundCoolUntil"] = (_dt.datetime.now() + _dt.timedelta(minutes=OUTBOUND_COOLDOWN_MIN)).strftime("%Y-%m-%d %H:%M:%S")
            st["quotaFailAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            print("SEND-FAILED(ret=-2): 进入 %d 分钟出站冷却；内容已落盘 %s（-2 原因未确证：与 token/长度无关，恢复时机未知）" % (OUTBOUND_COOLDOWN_MIN, OUTBOX_FALLBACK))
        else:
            print("SEND-FAILED: %s（内容已落盘）" % detail)

    st["sig"] = sig
    st["lastTickAt"] = snap.get("at")
    st["pushes"] = (st.get("pushes") or [])[-20:] + [{"at": snap.get("at"), "changed": changed, "alerts": alerts, "sent": ok}]
    save_state(st)


if __name__ == "__main__":
    main()
