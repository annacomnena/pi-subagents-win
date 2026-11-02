# trace-fusion lane 产出的判定基准

> 校准状态：**current（2026-11-02 源码级核实 + 五个 run 实测对照）**
> 关联：`trace-fusion-architecture.md`、`autonomy-consumer-gap.md`
>
> 本文解决一个**判定陷阱**：判「lane 该产出哪些 artifact」时，很容易拿错标准答案，
> 从而把**答对的 lane 误判成答错**。这个陷阱我自己踩过，且踩了整整五个 run。

---

## 正确答案是 2 个，不是 6 个

`worker-prompt.ts:85-100` 的 artifact 契约（**直接告诉 worker 要写什么**）：

```
1. trajectory.md   —— 完整叙事，按九节组织
2. validation.json —— 可执行验证清单
3. patch.diff 由 supervisor 用 git diff --binary <base> HEAD + 未跟踪文件归档自动收集，
   【你不需要也不应该自己生成 patch.diff】
```

`worker-prompt.ts:205` 再加一条硬约束：

```
edit 工具对你禁用（不改代码）；write 只能写上述两个 artifact 文件
```

**⇒ lane（worker）的产出义务 = `trajectory.md` + `validation.json`。**

## 陷阱：拿 `artifacts.ts` 当标准答案会得到 6 个

`artifacts.ts:163-264` 的 `collectLaneArtifacts` 里有 6 处 `writeFileSync(join(laneDir, ...))`：

| 文件 | 行 | **谁写的** | 是不是 lane 的义务 |
|---|---|---|---|
| `trajectory.md` | `:179` | worker | ✅ 是 |
| `validation.json` | `:180` | worker | ✅ 是 |
| `patch.diff` | `:194` | **supervisor** | ❌ 否（prompt 明说不用生成） |
| `untracked` | `:197` | **supervisor** | ❌ 否 |
| `status.txt` | `:222/:227` | **supervisor**（`git status --porcelain`） | ❌ 否 |
| `result.json` | `:238` | **supervisor**（归档 tab result） | ❌ 否 |

**`collectLaneArtifacts` 是采集器，不是契约。** 它需要收集 supervisor 自己派生出来的文件，
这不代表 worker 要写它们。

## 我踩过的坑（如实登记）

我用 `grep 'join(laneDir,' artifacts.ts` 得出「6 个」，当成标准答案，然后：

| run | lane | 实际答了 | 真实答案 | **我的误判** |
|---|---|---|---|---|
| 15:19 | A | 2 个 | 2 个 | ❌ 判「漏 4 项」 |
| 15:19 | B | 2 个 | 2 个 | ❌ 判「漏 4 项」 |
| 15:19 | C | 4 个 | 2 个 | ❌ 判「最好」（其实把 supervisor 的也算进去了） |
| 15:59 | A | 2 个（引用 `worker-prompt.ts`） | 2 个 | ✅ 且它读对了源文件 |

**lane A 一直是对的。** 是我拿错了标尺。

## 判可信度时真正该看什么

**不是「答了几个」，而是「读的是哪个文件」：**

| lane 读的源 | 得到的答案 | 判定 |
|---|---|---|
| `worker-prompt.ts:85-100` | 2 个 | ✅ **对**（这是契约） |
| `artifacts.ts:163-264` 前段 | 2~4 个 | ⚠️ 混入了 supervisor 产出 |
| `artifacts.ts` 全文件 | 6 个 | ❌ 把采集当契约 |

15:59 的 lane A 明确写「Based on my analysis of `worker-prompt.ts` (lines 196-219)」——
**它读对了文件，所以答对了，而且答得比其他 run 更稳。**

## 其它已知失效模式（这些是真的）

| 模式 | 实例 |
|---|---|
| 命令不可执行却标 pass | 11:57 lane C 用 `cd /dev/null && cat ...`（必失败） |
| `output_excerpt` 为空却标 pass | 13:46 lane C 五条全空 |
| 产物未被采集 | 15:19 lane B 的 `lanes/B/` 不存在（但 `lastAssistantText` 有完整答案） |
| 把正确实现当 bug | 13:46 lane C 把 `config.ts:42-52` 的 `workerModelByLane` 正确实现说成 H1 bug |

## 一条给复核者的最小判据

> **判 lane 答对与否，先确认它的答案来源文件是 `worker-prompt.ts`（契约）还是 `artifacts.ts`（采集）。**
> 只有前者能作为「lane 该产出什么」的依据。

---

## 附：我今晚的同类错误清单（第五次）

```
① delivery-reconciler.json  单快照当稳态，断言"卡死 12 小时"
② frontier "5 个项目全 Working"  一次采样当系统性质
③ tab 判活  漏看 heartbeatAt 和更早的 result
④ lane C 的 dispatchLane  只看片段就说"函数不存在"（其实在 :336）
⑤ 本文  只看 artifacts.ts 就定"标准答案"
```

**共同点：拿到一个看起来权威的证据源，就停止查证。**
