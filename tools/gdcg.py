#!/usr/bin/env python3
"""
gdcg.py — GDScript Code Graph：给 Godot 项目用的符号索引工具。

## 为什么需要它

`codegraph`（@colbymchenry/codegraph）支持 33 种语言，**唯独没有 GDScript**。
实测对它喂纯 `.gd` 目录 → `No files found to index`。

而 `battlesandbox` 的全部产品代码是 GDScript（69 文件 / 21,538 行），
测试也是 GDScript（47,491 行）。没有符号索引，agent 只能靠 grep 猜。

## 与 codegraph 的关系

**接口对齐**（`init` / `sync` / `status` / `query` / `refs` / `files`），
方便上层工具统一调用；但实现完全独立 —— 不追求语义分析，
只做 GDScript 的**结构索引**（class / func / signal / const / enum / var）。

## 设计取舍（重要）

### 为什么不用正则一把梭
GDScript 的关键词出现在**行首或缩进后**才算声明。注释里的 `func xxx`、
字符串里的 `"func"` 都不能算。所以按行扫描 + 状态机（跳过块注释 / 字符串），
而不是全局 `re.finditer`。

### 为什么记录缩进深度
嵌套 `class` 内的成员要能归属到那个 class。GDScript 靠缩进定作用域
（同 Python），所以缩进是唯一的作用域信号。

### 为什么解析 preload 别名
实测项目里大量 `const _TOps = preload("res://scripts/battle/timeline_ops.gd")`，
然后 `_TOps.quantize_time(...)` 调用。不解析别名，「谁调用了 quantize_time」
这个问题就会漏掉大部分命中。这是本工具相对 grep 的**主要增量价值**。

### 为什么 links 要单独存
`class_name` 与文件名可以不一致（实测 `timeline_ops.gd` → `TimelineOps`），
`_TOps` 又是 `TimelineOps` 的别名。三层映射全靠 links 表打通。

## 用法

    python gdcg.py init   [path]     # 全量建索引
    python gdcg.py sync   [path]     # 增量更新（按 mtime+size 判断）
    python gdcg.py status [path]     # 索引统计 + 陈旧告警
    python gdcg.py query  <name>     # 搜符号（支持模糊）
    python gdcg.py refs   <name>     # 找引用（含 preload 别名穿透）
    python gdcg.py files  [glob]     # 列文件
    python gdcg.py show   <name>     # 显示符号源码

索引存 `<repo>/.gdcg/index.json`（建议 gitignore）。
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any

INDEX_DIRNAME = ".gdcg"
INDEX_FILENAME = "index.json"
SCHEMA_VERSION = 1

# 解析时跳过的目录（相对于仓库根）
SKIP_DIRS = {
    ".git",
    ".godot",
    ".gdcg",
    ".import",
    "node_modules",
    "__pycache__",
    "evidence",  # battlesandbox 的 evidence 有 15 万文件，必须跳
    ".toolchain",
}

# GDScript 声明关键字 → 符号 kind
# 注意：只匹配「行首（允许缩进）就是关键字」的情况，避免注释/字符串误命中
DECL_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("class_name", re.compile(r"^class_name\s+([A-Za-z_]\w*)(?:\s+extends\s+([\w.]+))?")),
    ("class", re.compile(r"^class\s+([A-Za-z_]\w*)(?:\s+extends\s+([\w.]+))?")),
    ("extends", re.compile(r"^extends\s+([\w.]+)")),
    ("signal", re.compile(r"^signal\s+([A-Za-z_]\w*)")),
    ("enum", re.compile(r"^enum\s+([A-Za-z_]\w*)")),
    ("const", re.compile(r"^(?:static\s+)?const\s+([A-Za-z_]\w*)")),
    ("var", re.compile(r"^(?:@\w+(?:\([^)]*\))?\s+)*(?:static\s+)?var\s+([A-Za-z_]\w*)")),
    ("func", re.compile(r"^(?:static\s+)?func\s+([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?\s*(?:->\s*([\w.\[\]]+))?")),
    ("annotation", re.compile(r"^@(\w+)")),
]

PRELOAD_PATTERN = re.compile(r'^(?:static\s+)?(?:const|var)\s+([A-Za-z_]\w*)\s*(?::\s*\w+\s*)?=\s*(?:preload|load)\(\s*"([^"]+)"\s*\)')


def indent_of(line: str) -> int:
    """返回缩进宽度（tab 记 4 空格；GDScript 官方风格用 tab）。"""
    n = 0
    for ch in line:
        if ch == "\t":
            n += 4
        elif ch == " ":
            n += 1
        else:
            break
    return n


def strip_comment(line: str) -> str:
    """
    去掉行尾注释（`#` 之后），但保留字符串里的 `#`。

    简化处理：找第一个不在引号内的 `#`。GDScript 没有三引号字符串，
    但字符串可以跨行（GDScript 用三个双引号或三个单引号做多行字符串），
    那种情况这里会保守地当成有引号，只影响注释剥离的准确性，
    不影响代码行本身的识别。
    """
    in_str: str | None = None
    i = 0
    while i < len(line):
        ch = line[i]
        if in_str:
            if ch == "\\":
                i += 2
                continue
            if ch == in_str:
                in_str = None
        else:
            if ch in ("'", '"'):
                in_str = ch
            elif ch == "#":
                return line[:i]
        i += 1
    return line


@dataclass
class Symbol:
    """一个可检索的实体。"""
    name: str
    kind: str  # class_name / class / func / signal / const / var / enum / annotation
    file: str  # 相对仓库根的 posix 路径
    line: int  # 1-based
    depth: int = 0
    # 归属的 class（嵌套 class 或文件级 class_name）；空串表示文件级
    owner: str = ""
    # func 专有
    params: str = ""
    returns: str = ""
    is_static: bool = False
    # class 专有
    extends: str = ""
    # const/var 专有：preload 目标（res:// 路径），用于别名穿透
    preload_target: str = ""


@dataclass
class FileRecord:
    path: str
    mtime: float
    size: int
    line_count: int
    symbols: list[Symbol] = field(default_factory=list)
    # const _TOps = preload("res://...")  →  {_TOps: "res://..."}
    aliases: dict[str, str] = field(default_factory=dict)


def scan_file(path: Path, repo: Path) -> FileRecord:
    """解析单个 .gd 文件（状态机，跳过块注释与多行字符串）。"""
    raw = path.read_text(encoding="utf-8", errors="replace")
    lines = raw.split("\n")
    rel = path.relative_to(repo).as_posix()

    symbols: list[Symbol] = []
    aliases: dict[str, str] = {}
    # 作用域栈：[(depth, class_name)]
    scope: list[tuple[int, str]] = []
    file_class = ""
    in_block_comment = False
    in_triple: str | None = None  # '"""' or "'''"

    for idx, line in enumerate(lines):
        lineno = idx + 1
        stripped = line.strip()

        # ── 块注释 `#` 开头整行：GDScript 没有真正的块注释，
        #    但项目里常用连续 `##` 文档注释，按「整行以 # 开头」跳过
        if in_triple:
            if in_triple in line:
                in_triple = None
            continue
        if stripped.startswith("#"):
            continue
        if not stripped:
            continue

        # ── 多行字符串起始（""" 或 '''）
        for q in ('"""', "'''"):
            if line.count(q) % 2 == 1:
                in_triple = q
                break
        if in_triple:
            continue

        code = strip_comment(line).rstrip()
        if not code.strip():
            continue

        depth = indent_of(code)
        body = code.lstrip()

        # ── 维护作用域栈：当前行的深度比栈顶浅 ⇒ 弹出
        while scope and depth <= scope[-1][0]:
            scope.pop()

        # ── preload 别名
        m_pre = PRELOAD_PATTERN.match(body)
        if m_pre:
            alias_name, target = m_pre.group(1), m_pre.group(2)
            aliases[alias_name] = target
            symbols.append(
                Symbol(
                    name=alias_name,
                    kind="const",
                    file=rel,
                    line=lineno,
                    depth=depth,
                    owner=scope[-1][1] if scope else file_class,
                    preload_target=target,
                )
            )
            continue

        # ── 声明
        matched = False
        for kind, pat in DECL_PATTERNS:
            m = pat.match(body)
            if not m:
                continue
            name = m.group(1)
            sym = Symbol(name=name, kind=kind, file=rel, line=lineno, depth=depth)

            if kind == "class_name":
                file_class = name
                sym.owner = ""
                if m.lastindex and m.lastindex >= 2 and m.group(2):
                    sym.extends = m.group(2)
                # class_name 一定是文件级
                scope.clear()
            elif kind == "class":
                sym.owner = scope[-1][1] if scope else file_class
                if m.lastindex and m.lastindex >= 2 and m.group(2):
                    sym.extends = m.group(2)
                # 进入新作用域
                scope.append((depth, name))
            elif kind in ("func", "signal", "const", "var", "enum"):
                sym.owner = scope[-1][1] if scope else file_class
                if kind == "func":
                    sym.is_static = body.startswith("static")
                    sym.params = (m.group(2) or "").strip()
                    if m.lastindex and m.lastindex >= 3:
                        sym.returns = (m.group(3) or "").strip()
            elif kind == "annotation":
                # 注解本身不算符号，跳过（它修饰的是下一行的 var/func）
                matched = True
                break
            elif kind == "extends":
                matched = True
                break

            symbols.append(sym)
            matched = True
            break

        if not matched:
            continue

    return FileRecord(
        path=rel,
        mtime=path.stat().st_mtime,
        size=path.stat().st_size,
        line_count=len(lines),
        symbols=symbols,
        aliases=aliases,
    )


def iter_gd_files(repo: Path) -> list[Path]:
    """遍历仓库内所有 .gd 文件，跳过 SKIP_DIRS。"""
    out: list[Path] = []
    for root, dirs, files in os.walk(repo):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")]
        # evidence 目录名可能不同大小写，再兜一层
        dirs[:] = [d for d in dirs if d.lower() not in {s.lower() for s in SKIP_DIRS}]
        for f in files:
            if f.endswith(".gd"):
                out.append(Path(root) / f)
    return out


# ── 索引读写 ────────────────────────────────────────────────────────


def index_path(repo: Path) -> Path:
    return repo / INDEX_DIRNAME / INDEX_FILENAME


def load_index(repo: Path) -> dict[str, Any] | None:
    p = index_path(repo)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def save_index(repo: Path, data: dict[str, Any]) -> None:
    p = index_path(repo)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(p)


def build_files_map(records: list[FileRecord]) -> dict[str, Any]:
    return {
        r.path: {
            "mtime": r.mtime,
            "size": r.size,
            "line_count": r.line_count,
            "symbols": [asdict(s) for s in r.symbols],
            "aliases": r.aliases,
        }
        for r in records
    }


# ── 命令实现 ────────────────────────────────────────────────────────


def find_repo(start: str | None) -> Path:
    """从 start 向上找含 .gdcg/ 或 project.godot 的目录。"""
    p = Path(start or os.getcwd()).resolve()
    cur = p
    for _ in range(20):
        if (cur / INDEX_DIRNAME).is_dir() or (cur / "project.godot").is_file():
            return cur
        if cur.parent == cur:
            break
        cur = cur.parent
    return p


def cmd_init(args: list[str]) -> int:
    repo = Path(args[0]).resolve() if args else find_repo(None)
    t0 = time.time()
    files = iter_gd_files(repo)
    records: list[FileRecord] = []
    errors: list[str] = []
    for f in files:
        try:
            records.append(scan_file(f, repo))
        except Exception as e:
            errors.append(f"{f}: {e}")

    idx = {
        "schema_version": SCHEMA_VERSION,
        "repo": str(repo),
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "files": build_files_map(records),
    }
    save_index(repo, idx)
    nsym = sum(len(r.symbols) for r in records)
    nlines = sum(r.line_count for r in records)
    dt = time.time() - t0
    print(f"  Initialized in {repo}")
    print(f"  Indexed {len(records)} file(s), {nlines} lines, {nsym} symbols in {dt:.2f}s")
    if errors:
        print(f"  {len(errors)} file(s) failed:")
        for e in errors[:5]:
            print(f"    {e}")
    return 0


def cmd_sync(args: list[str]) -> int:
    repo = Path(args[0]).resolve() if args else find_repo(None)
    old = load_index(repo)
    if old is None:
        return cmd_init([str(repo)])

    t0 = time.time()
    files = iter_gd_files(repo)
    files_map = old.get("files", {})
    seen: set[str] = set()
    added = modified = removed = 0

    for f in files:
        rel = f.relative_to(repo).as_posix()
        seen.add(rel)
        st = f.stat()
        # 注意：用 `rel in files_map` 判有无，而不是 `files_map.get(rel)`
        # —— 后者在旧索引存在时对 touch 场景会误判为「新增」。
        existed = rel in files_map
        prev = files_map.get(rel)
        if prev and abs(prev.get("mtime", 0) - st.st_mtime) < 1e-6 and prev.get("size") == st.st_size:
            continue
        try:
            rec = scan_file(f, repo)
        except Exception:
            continue
        if existed:
            modified += 1
        else:
            added += 1
        files_map[rel] = {
            "mtime": rec.mtime,
            "size": rec.size,
            "line_count": rec.line_count,
            "symbols": [asdict(s) for s in rec.symbols],
            "aliases": rec.aliases,
        }

    for rel in list(files_map):
        if rel not in seen:
            del files_map[rel]
            removed += 1

    old["files"] = files_map
    old["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    save_index(repo, old)
    dt = time.time() - t0
    if added == modified == removed == 0:
        print(f"  Up to date ({len(files)} files, no changes) in {dt:.2f}s")
    else:
        print(f"  Synced: +{added} ~{modified} -{removed} in {dt:.2f}s")
    return 0


def cmd_status(args: list[str]) -> int:
    repo = Path(args[0]).resolve() if args else find_repo(None)
    idx = load_index(repo)
    if idx is None:
        print(f"  Not initialized: {repo}")
        print(f"  Run: python gdcg.py init {repo}")
        return 1

    files = idx.get("files", {})
    nsym = sum(len(v.get("symbols", [])) for v in files.values())
    nlines = sum(v.get("line_count", 0) for v in files.values())

    by_kind: dict[str, int] = {}
    for v in files.values():
        for s in v.get("symbols", []):
            by_kind[s["kind"]] = by_kind.get(s["kind"], 0) + 1

    print(f"  repo      = {idx.get('repo')}")
    print(f"  files     = {len(files)}   lines = {nlines}   symbols = {nsym}")
    print(f"  updated   = {idx.get('updated_at')}")
    print(f"  by kind   = {json.dumps(by_kind, ensure_ascii=False)}")

    # 陈旧检测：对比磁盘 mtime
    stale_add = stale_mod = stale_del = 0
    disk_files = iter_gd_files(repo)
    disk_rel = {f.relative_to(repo).as_posix(): f for f in disk_files}
    for rel, f in disk_rel.items():
        prev = files.get(rel)
        if not prev:
            stale_add += 1
            continue
        try:
            st = f.stat()
        except OSError:
            continue
        if abs(prev.get("mtime", 0) - st.st_mtime) > 1e-6 or prev.get("size") != st.st_size:
            stale_mod += 1
    for rel in files:
        if rel not in disk_rel:
            stale_del += 1

    total_stale = stale_add + stale_mod + stale_del
    if total_stale:
        print()
        print(f"  WARNING: index is stale (+{stale_add} ~{stale_mod} -{stale_del}).")
        print('  The index reflects the tree as of `updated_at`, not now.')
        print('  Run: python gdcg.py sync   (or treat reported line numbers with suspicion)')
    return 0


def collect_symbols(idx: dict[str, Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for rel, v in idx.get("files", {}).items():
        for s in v.get("symbols", []):
            out.append(s)
    return out


def score_match(name: str, query: str) -> int:
    """
    匹配打分：完全相同 > 前缀 > 驼峰缩写 > 子串（大小写折叠）。

    驼峰缩写必须排在子串之前：查 `be` 时想要的是 `BattleEvaluator`，
    而不是名字里碰巧出现 be 的 `ProbeDoc`。实测旧评分确实把 ProbeDoc 排前面。
    """
    n = name.lower()
    q = query.lower()
    if n == q:
        return 100
    if n.startswith(q):
        return 70

    # 驼峰/下划线缩写：BE → BattleEvaluator、qt → quantize_time
    parts = [p for p in re.split(r"[_\W]+", name) if p]
    if len(parts) > 1:
        initials = "".join(p[0].lower() for p in parts)
        if q == initials:
            return 60
        if initials.startswith(q):
            return 50
    # 驼峰边界：BattleEvaluator 的驼峰首字母是 be
    camel = "".join(c.lower() for c in name if c.isupper())
    if camel and q == camel:
        return 60
    if camel and camel.startswith(q):
        return 50

    if q in n:
        return 40
    return 0


def cmd_query(args: list[str]) -> int:
    if not args:
        print("  usage: gdcg.py query <name> [--kind func|class|signal|...] [--limit N]")
        return 1
    query = args[0]
    kind = None
    limit = 30
    for i, a in enumerate(args):
        if a == "--kind" and i + 1 < len(args):
            kind = args[i + 1]
        if a == "--limit" and i + 1 < len(args):
            limit = int(args[i + 1])

    repo = find_repo(None)
    idx = load_index(repo)
    if idx is None:
        print(f"  Not initialized: {repo}")
        return 1

    hits = []
    for s in collect_symbols(idx):
        if kind and s["kind"] != kind:
            continue
        sc = score_match(s["name"], query)
        if sc:
            hits.append((sc, s))
    hits.sort(key=lambda x: (-x[0], x[1]["file"], x[1]["line"]))

    if not hits:
        print(f"  No results for {query!r}")
        return 0

    print(f"  {len(hits)} hit(s) for {query!r}  (showing {min(limit, len(hits))})")
    for sc, s in hits[:limit]:
        loc = f'{s["file"]}:{s["line"]}'
        extra = ""
        if s["kind"] == "func":
            sig = f'({s.get("params", "")})'
            ret = f' -> {s["returns"]}' if s.get("returns") else ""
            st = "static " if s.get("is_static") else ""
            extra = f"  {st}func{sig}{ret}"
        elif s["kind"] in ("class", "class_name") and s.get("extends"):
            extra = f'  extends {s["extends"]}'
        if s.get("owner"):
            extra += f'  [in {s["owner"]}]'
        print(f'  {s["kind"]:<10} {s["name"]:<28} {loc}{extra}')
    return 0


def cmd_refs(args: list[str]) -> int:
    """
    找引用 —— 本工具相对 grep 的主要增量：**穿透 preload 别名**。

    实测：`_TOps.quantize_time(...)` 里 `_TOps` 是
    `preload("res://scripts/battle/timeline_ops.gd")` 的别名。
    纯 grep `quantize_time` 能找到调用点，但不知道 `_TOps` 指向哪个文件；
    反过来，想找「谁用了 timeline_ops.gd」时 grep 文件名会漏掉所有别名调用。
    """
    if not args:
        print("  usage: gdcg.py refs <name>")
        return 1
    name = args[0]
    repo = find_repo(None)
    idx = load_index(repo)
    if idx is None:
        print(f"  Not initialized: {repo}")
        return 1

    files = idx.get("files", {})

    # ① 先定位符号定义，得到它所属文件（以及可能的 class_name）
    defs = [s for s in collect_symbols(idx) if s["name"] == name]
    target_files: set[str] = set()
    target_classes: set[str] = set()
    for d in defs:
        target_files.add(d["file"])
    for rel, v in files.items():
        for s in v.get("symbols", []):
            if s["kind"] == "class_name" and rel in target_files:
                target_classes.add(s["name"])

    # ② 建立别名 → 目标文件 的反向表（哪些文件里的哪个别名指向 target）
    alias_map: dict[tuple[str, str], str] = {}  # (file, alias) -> res path
    for rel, v in files.items():
        for alias, res_path in (v.get("aliases") or {}).items():
            alias_map[(rel, alias)] = res_path

    # res:// → 相对路径
    def res_to_rel(res: str) -> str:
        return res[len("res://") :] if res.startswith("res://") else res

    # ③ 在磁盘上找文本引用（索引里不存源码，必须实读）
    print(f"  Definitions of {name!r}:")
    if defs:
        for d in defs:
            print(f'    {d["kind"]:<10} {d["file"]}:{d["line"]}')
    else:
        print("    (none — searching text references only)")

    print()
    print(f"  References to {name!r}:")
    total = 0
    for rel in sorted(files):
        fpath = repo / rel
        try:
            text = fpath.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        # 该文件里的别名 → 是否指向目标文件
        local_aliases = {
            alias: res_to_rel(res)
            for (f, alias), res in alias_map.items()
            if f == rel and (res_to_rel(res) in target_files)
        }
        for i, line in enumerate(text.split("\n"), start=1):
            code = strip_comment(line)
            hit = False
            why = ""
            if re.search(rf"\b{re.escape(name)}\b", code):
                hit = True
                why = "direct"
            elif local_aliases:
                for alias in local_aliases:
                    if re.search(rf"\b{re.escape(alias)}\b", code):
                        hit = True
                        why = f"via {alias}"
                        break
            elif target_classes:
                for cn in target_classes:
                    if re.search(rf"\b{re.escape(cn)}\b", code):
                        hit = True
                        why = f"via class {cn}"
                        break
            if hit:
                total += 1
                snippet = line.strip()[:100]
                suffix = f"  ({why})" if why != "direct" else ""
                print(f"    {rel}:{i}  {snippet}{suffix}")
    if total == 0:
        print("    (none)")
    else:
        print()
        print(f"  {total} reference(s)")
    return 0


def cmd_files(args: list[str]) -> int:
    glob = args[0] if args else "*"
    repo = find_repo(None)
    idx = load_index(repo)
    if idx is None:
        print(f"  Not initialized: {repo}")
        return 1
    import fnmatch

    rows = []
    for rel, v in sorted(idx.get("files", {}).items()):
        if glob != "*" and not fnmatch.fnmatch(rel, glob):
            continue
        nsym = len(v.get("symbols", []))
        rows.append((rel, v.get("line_count", 0), nsym))
    print(f"  {len(rows)} file(s)")
    for rel, lc, nsym in rows:
        print(f"    {rel:<56} {lc:>6} lines  {nsym:>4} symbols")
    return 0


def cmd_show(args: list[str]) -> int:
    """显示某符号的定义处源码（含上下文）。"""
    if not args:
        print("  usage: gdcg.py show <name> [--context N]")
        return 1
    name = args[0]
    ctx = 3
    for i, a in enumerate(args):
        if a == "--context" and i + 1 < len(args):
            ctx = int(args[i + 1])
    repo = find_repo(None)
    idx = load_index(repo)
    if idx is None:
        print(f"  Not initialized: {repo}")
        return 1
    defs = [s for s in collect_symbols(idx) if s["name"] == name]
    if not defs:
        print(f"  No definition found for {name!r}")
        return 1
    for d in defs:
        fpath = repo / d["file"]
        try:
            lines = fpath.read_text(encoding="utf-8", errors="replace").split("\n")
        except OSError:
            continue
        lo = max(0, d["line"] - 1 - ctx)
        hi = min(len(lines), d["line"] + ctx)
        print(f'  ── {d["kind"]} {name} @ {d["file"]}:{d["line"]}')
        for i in range(lo, hi):
            mark = ">>" if i == d["line"] - 1 else "  "
            print(f'  {mark} {i+1:>5}  {lines[i]}')
        print()
    return 0


COMMANDS = {
    "init": cmd_init,
    "sync": cmd_sync,
    "status": cmd_status,
    "query": cmd_query,
    "refs": cmd_refs,
    "files": cmd_files,
    "show": cmd_show,
}


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[1] in ("-h", "--help", "help"):
        print(__doc__)
        return 0
    cmd = argv[1]
    fn = COMMANDS.get(cmd)
    if fn is None:
        print(f"  Unknown command: {cmd}")
        print(f"  Available: {', '.join(COMMANDS)}")
        return 1
    return fn(argv[2:])


if __name__ == "__main__":
    sys.exit(main(sys.argv))
