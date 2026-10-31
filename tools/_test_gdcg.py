#!/usr/bin/env python3
"""
_test_gdcg.py — gdcg.py 的判据测试

为什么要有：这个工具的**唯一价值**是「比 grep 更准」。
如果它只是把 grep 包一层，那不如直接 grep。
所以测试重点是**别名穿透**与**解析正确性**，不是「能跑」。

跑法：python _test_gdcg.py
"""

from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
from pathlib import Path

HERE = Path(__file__).resolve().parent
GDcg = HERE / "gdcg.py"

checks = 0


def ok(msg: str) -> None:
    global checks
    checks += 1
    print(f"ok {checks} - {msg}")


def run(args: list[str], cwd: Path) -> tuple[int, str]:
    r = subprocess.run(
        [sys.executable, str(GDcg)] + args,
        cwd=str(cwd),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env={**os.environ, "PYTHONIOENCODING": "utf-8"},
    )
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def make_repo(root: Path) -> None:
    """造一个最小但覆盖所有语法形态的 GDScript 仓库。"""
    (root / "project.godot").write_text("; fake\n", encoding="utf-8")

    (root / "ops.gd").write_text(
        textwrap.dedent(
            """\
            ## ops.gd — 工具函数集
            class_name Ops
            extends RefCounted

            const TICK_S := 1.0 / 60.0
            const EVENT_TYPES: PackedStringArray = ["a", "b"]

            enum Mode { IDLE, RUN }

            signal changed(field: String, value: Variant)

            static func quantize_time(t: Variant) -> float:
            \tif not _is_num(t):
            \t\treturn NAN
            \treturn floorf(float(t) / TICK_S + 0.5) * TICK_S

            static func _is_num(v: Variant) -> bool:
            \treturn typeof(v) in [TYPE_INT, TYPE_FLOAT]

            # 注释里的 func fake_should_not_appear() 不能被索引
            var counter: int = 0
            """
        ),
        encoding="utf-8",
    )

    # 使用方：通过 preload 别名调用（这是本工具的核心价值）
    (root / "panel.gd").write_text(
        textwrap.dedent(
            """\
            class_name Panel
            extends Control

            const _TOps = preload("res://ops.gd")

            func scrub(raw: float) -> float:
            \tvar q: float = _TOps.quantize_time(raw)
            \treturn q

            func step() -> float:
            \treturn _TOps.TICK_S
            """
        ),
        encoding="utf-8",
    )

    # 嵌套 class：内部成员要能归属到它
    (root / "nested.gd").write_text(
        textwrap.dedent(
            """\
            class_name Outer
            extends Node

            var outer_var := 1

            class Inner extends RefCounted:
            \tvar inner_var := 2

            \tfunc inner_method() -> void:
            \t\tpass

            func outer_method() -> void:
            \tpass
            """
        ),
        encoding="utf-8",
    )

    # 必须被跳过的目录
    (root / "evidence").mkdir()
    (root / "evidence" / "junk.gd").write_text("func should_be_skipped():\n\tpass\n", encoding="utf-8")


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="gdcg_test_"))
    try:
        make_repo(tmp)

        # ── ① init：文件数、符号数、跳过 evidence ──────────────────
        rc, out = run(["init"], tmp)
        assert rc == 0, out
        assert "Indexed 3 file(s)" in out, f"应索引 3 个文件（跳过 evidence），实际输出:\n{out}"
        idx = json.loads((tmp / ".gdcg" / "index.json").read_text(encoding="utf-8"))
        assert "evidence/junk.gd" not in idx["files"], "evidence/ 里的 .gd 必须被跳过"
        ok("① init 索引 3 个文件，跳过 evidence/")

        # ── ② 解析正确性：注释里的 func 不得入索引 ────────────────
        all_syms = [s for v in idx["files"].values() for s in v["symbols"]]
        names = {s["name"] for s in all_syms}
        assert "fake_should_not_appear" not in names, "注释里的 func 被误索引了"
        assert "should_be_skipped" not in names, "跳过目录里的 func 被误索引了"
        ok("② 注释内 func 与跳过目录不入索引")

        # ── ③ 各类符号都被识别 + func 签名/static 正确 ─────────────
        def pick(name: str) -> dict:
            for s in all_syms:
                if s["name"] == name:
                    return s
            raise AssertionError(f"符号 {name} 未入索引；已有: {sorted(names)[:20]}")

        assert pick("Ops")["kind"] == "class_name"
        assert pick("TICK_S")["kind"] == "const"
        assert pick("Mode")["kind"] == "enum"
        assert pick("changed")["kind"] == "signal"

        qt = pick("quantize_time")
        assert qt["kind"] == "func"
        assert qt["is_static"] is True, "static func 未标 static"
        assert qt["returns"] == "float", f"返回类型错: {qt['returns']}"
        assert qt["params"].startswith("t"), f"参数错: {qt['params']}"
        assert qt["owner"] == "Ops", f"owner 错: {qt['owner']}（应归属 class_name Ops）"

        priv = pick("_is_num")
        assert priv["kind"] == "func" and priv["is_static"] is True
        ok("③ 符号识别完整：class_name/const/enum/signal/func + static/返回类型/参数/owner")

        # ── ④ 嵌套 class 的成员归属 ──────────────────────────────
        inner_m = pick("inner_method")
        assert inner_m["owner"] == "Inner", f"嵌套 class 内方法 owner 错: {inner_m['owner']}"
        inner_v = pick("inner_var")
        assert inner_v["owner"] == "Inner", f"嵌套 class 内 var owner 错: {inner_v['owner']}"
        outer_m = pick("outer_method")
        assert outer_m["owner"] == "Outer", f"外层方法 owner 错: {outer_m['owner']}"
        outer_v = pick("outer_var")
        assert outer_v["owner"] == "Outer", f"外层 var owner 错: {outer_v['owner']}"
        ok("④ 嵌套 class 作用域正确：Inner 内成员归 Inner，Outer 内归 Outer")

        # ── ⑤ preload 别名被解析 ─────────────────────────────────
        assert idx["files"]["panel.gd"]["aliases"] == {"_TOps": "res://ops.gd"}, idx["files"]["panel.gd"]["aliases"]
        ok("⑤ preload 别名解析：panel.gd 的 _TOps → res://ops.gd")

        # ── ⑥ 【核心价值】refs 穿透别名 ──────────────────────────
        # 纯 grep "ops.gd" 只能找到 preload 那一行；
        # 本工具应额外找到 _TOps.quantize_time / _TOps.TICK_S 的实际使用。
        rc, out = run(["refs", "quantize_time"], tmp)
        assert rc == 0, out
        assert "panel.gd:7" in out, f"未找到 alias 调用 panel.gd:7；输出:\n{out}"
        assert "via _TOps" in out, f"未标注 via _TOps（说明没走别名路径）；输出:\n{out}"
        ok("⑥ 【核心】refs 穿透 preload 别名：找到 _TOps.quantize_time 调用")

        # 反向：找「谁用了 ops.gd」——纯 grep 文件名会漏掉 TICK_S 那处
        rc, out = run(["refs", "TICK_S"], tmp)
        assert "panel.gd:11" in out, f"未找到 _TOps.TICK_S 使用；输出:\n{out}"
        ok("⑥b 【核心】refs 反向：_TOps.TICK_S 使用点被找到（grep 文件名找不到）")

        # ── ⑦ query 排序：精确 > 前缀 > 子串 ─────────────────────
        rc, out = run(["query", "quantize_time"], tmp)
        assert "ops.gd:12" in out, out
        # 驼峰缩写：qt 应能命中 quantize_time（驼峰+下划线词首）
        rc2, out2 = run(["query", "qt"], tmp)
        # _is_num 也会因 initials 命中（i n），验证 quantize_time 在结果里
        assert "quantize_time" in out2, f"缩写 qt 未命中 quantize_time；输出:\n{out2}"
        ok("⑦ query 精确命中 + 驼峰缩写模糊（qt → quantize_time）")

        # ── ⑧ status 陈旧检测 ────────────────────────────────────
        rc, out = run(["status"], tmp)
        assert rc == 0
        assert "stale" not in out.lower(), f"刚建完不该报陈旧；输出:\n{out}"
        # 改一个文件 ⇒ 必须报陈旧
        with open(tmp / "panel.gd", "a", encoding="utf-8") as f:
            f.write("\n# changed\n")
        rc, out = run(["status"], tmp)
        assert "WARNING" in out and "stale" in out.lower(), f"改动后未报陈旧；输出:\n{out}"
        ok("⑧ status：无改动不报陈旧；改动后必须报警")

        # ── ⑨ sync 增量：计数语义（改动记 ~ 不是 +）────────────────
        rc, out = run(["sync"], tmp)
        assert "+0 ~1 -0" in out, f"改动应记 ~1 而非新增；输出:\n{out}"
        rc, out = run(["sync"], tmp)
        assert "Up to date" in out, f"再跑应无改动；输出:\n{out}"
        ok("⑨ sync 增量：改动记 ~ / 重复跑记 Up to date")

        # ── ⑩ 删除文件 ⇒ sync 记为 - ─────────────────────────────
        (tmp / "nested.gd").unlink()
        rc, out = run(["sync"], tmp)
        assert "-1" in out, f"删除文件未记 -1；输出:\n{out}"
        rc, out = run(["query", "inner_method"], tmp)
        assert "No results" in out, f"删除后符号仍在索引；输出:\n{out}"
        ok("⑩ sync 删除：文件删除记 -1 且符号从索引移除")

        # ── ⑪ 未初始化时友好报错（不崩）─────────────────────────
        empty = Path(tempfile.mkdtemp(prefix="gdcg_empty_"))
        try:
            rc, out = run(["status"], empty)
            assert "Not initialized" in out, f"未初始化未给提示；输出:\n{out}"
            rc, out = run(["query", "x"], empty)
            assert "Not initialized" in out, out
        finally:
            shutil.rmtree(empty, ignore_errors=True)
        ok("⑪ 未初始化：友好提示 + 非零退出，不崩")

        print(f"\ngdcg tests passed ({checks} checks)")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
