import json, glob, re, sys, os

sessions_root = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/.pi/agent/sessions")
timers_root = sys.argv[2] if len(sys.argv) > 2 else os.path.expanduser("~/.pi/agent/timers")

# ── load all timer records: root (self) + mailboxes ──
timers = {}  # id -> record
def load_dir(d):
    if not os.path.isdir(d):
        return
    for f in glob.glob(os.path.join(d, "*.json")):
        try:
            with open(f, encoding="utf-8") as fh:
                r = json.load(fh)
            timers[r["id"]] = r
        except Exception:
            pass

load_dir(timers_root)
mail_root = os.path.join(timers_root, "mail")
if os.path.isdir(mail_root):
    for box in os.listdir(mail_root):
        load_dir(os.path.join(mail_root, box))

label_to_timer = {}
for tid, r in timers.items():
    if r.get("label"):
        label_to_timer[r["label"]] = r

# ── scan sessions ──
rows = []
for bucket in sorted(os.listdir(sessions_root)):
    bdir = os.path.join(sessions_root, bucket)
    if not os.path.isdir(bdir):
        continue
    for f in sorted(glob.glob(os.path.join(bdir, "*.jsonl"))):
        firstuser = ""
        is_tab_prompt = False
        fires = []   # (ts, label, message)
        creates = [] # labels created by this session's assistant set-timer calls
        with open(f, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                if d.get("type") != "message":
                    continue
                msg = d.get("message", {})
                ts = d.get("timestamp", "")
                content = msg.get("content")
                if msg.get("role") == "user":
                    if isinstance(content, list):
                        for block in content:
                            if isinstance(block, dict) and block.get("type") == "text":
                                text = block.get("text", "")
                                if not firstuser:
                                    firstuser = text[:80]
                                m = re.match(r".*?Timer fired \(([^)]*)\):\s*(.{0,60})", text, re.S)
                                if m:
                                    fires.append((ts, m.group(1), m.group(2)))
                                    if "根据workflow进行工作" in text or "根据research进行工作" in text or "根据execute进行工作" in text:
                                        is_tab_prompt = True
                elif msg.get("role") == "assistant":
                    if isinstance(content, list):
                        for block in content:
                            if isinstance(block, dict) and block.get("type") == "tool_use":
                                name = block.get("name", "")
                                inp = block.get("input", {})
                                if name == "set-timer" and isinstance(inp, dict) and inp.get("label"):
                                    creates.append(inp["label"])
                            elif isinstance(block, dict) and block.get("type") == "text":
                                text = block.get("text", "")
                                m = re.match(r".*?Timer fired \(([^)]*)\):", text, re.S)
                                if m:
                                    fires.append((ts, m.group(1), ""))
        if fires or creates:
            rows.append((os.path.basename(f)[:24], bucket, firstuser.replace("\n", " ")[:40], is_tab_prompt, creates, fires))

# ── report ──
print("=== sessions with timer activity ===")
for name, bucket, first, is_tab, creates, fires in rows:
    print(f"[{name}] bucket={bucket[:40]} tab={is_tab}")
    print(f"    first: {first}")
    if creates:
        print(f"    created timers: {creates}")
    for ts, label, msg in fires:
        tr = label_to_timer.get(label)
        if tr:
            target = tr.get("target")
            print(f"    fire {ts[:19]} label={label!r} -> timer target={target} status={tr.get('status')}")
        else:
            print(f"    fire {ts[:19]} label={label!r} (NO MATCHING TIMER RECORD) msg={msg}")
