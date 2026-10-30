---
title: 本地端点压测的客户端污染（系统代理 / reasoning 开销 / 库差异）
kind: concept
status: current
updated: 2026-10-30
source_paths:
  - extensions/launch.ts
  - extensions/master-tools.ts
---

# 本地端点压测的客户端污染

评估局域网自托管模型端点（`192.168.x.x:port`、`127.0.0.1:port`）时，
**先排除客户端侧污染再判断服务端性能**。本页记录 2026-10-30 一次实测：
同一端点、同一份代码，**只因客户端代理开关不同，测出 5.4s vs 0.09s（60 倍差）**。

## Summary

一条错误的性能结论可以完全由客户端环境造成。三个坑按「迷惑性」排序：

1. **系统代理**（最致命）：Python `urllib` / `requests` 默认读 Windows 系统代理，
   把内网请求转发到 `127.0.0.1:7897` 再出来 ⇒ 每次 +5 秒。`http.client` / `curl`
   **不读**代理 ⇒ 测同一端点差一个数量级。
2. **`timings` 不覆盖全部开销**：llama-server 的 `predicted_ms` 只计**生成阶段**，
   不含排队 / 网关调度 / 代理转发。`wall − prompt_ms − predicted_ms` 的差额必须解释清楚，
   否则会把客户端延迟当成服务端缺陷。
3. **reasoning 开销表现方式特殊**：思考 token 计入 `predicted_n`，所以
   「默认 `reasoning=0`」**不等于**「默认关思考」——要拿 `enable_thinking=true`
   对照才算证明。

## 一、系统代理（决定性坑）

### 症状

同一端点、同一 prompt、同一 `max_tokens`，两个 Python HTTP 库测出 10 倍差：

```
urllib.request.urlopen      5.36, 5.11, 5.47, 5.10, 5.52 s
http.client.HTTPConnection  0.06, 0.39, 0.22              s
```

`reasoning_content` 为空、`predicted_n=10`、`predicted_ms=39`
⇒ **服务端只花 39ms 生成，5 秒全花在别处**。

### 根因

```python
>>> urllib.request.getproxies()
{'http': 'http://127.0.0.1:7897', 'https': 'http://127.0.0.1:7897', 'ftp': '...'}
>>> [type(h).__name__ for h in urllib.request.build_opener().handlers]
['ProxyHandler', 'UnknownHandler', 'HTTPHandler', ...]
```

Windows **系统代理设置**（Clash / V2Ray 之类，默认 `127.0.0.1:7897`）被
`urllib.request` 通过注册表读到并自动套用。**注意：`env` 里可能完全没有
`HTTP_PROXY` 变量**，所以「查环境变量」这一步查不出来，必须查 `getproxies()`。

`http.client` / `curl` 不实现代理自动发现 ⇒ 绕过代理 ⇒ 快。

### 判别单行

```python
import urllib.request
urllib.request.getproxies()      # 非空 ⇒ 所有 urllib 压测结果都不可信
```

### 正确做法

```python
# 显式禁用代理（本地端点压测必须这么写）
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
with opener.open(req, timeout=...) as r:
    ...
```

或环境层：

```bash
export NO_PROXY="192.168.0.0/16,127.0.0.1,localhost"
export no_proxy="$NO_PROXY"
```

> ⚠️ **`NO_PROXY` 未必够**：某些场景代理是系统级而非环境级，
> 显式 `ProxyHandler({})` 是唯一可靠写法。

### 实测对照（同代码只切代理）

```
走代理(127.0.0.1:7897)   5.36, 5.11, 5.47, 5.10, 5.52 s
绕过代理                  0.48, 0.09, 0.15, 0.07, 0.15 s
```

绕过后真实读数：
```
首 token 延迟     46 ms
短回答 50 tok     0.45-0.68 s
中回答 300 tok    2.29-3.52 s
长回答 1000 tok   6.09-11.84 s
吞吐             86-154 tok/s
```

## 二、`timings` 的边界

llama-server（`llama.cpp` 系）返回的 `timings` 字段：

| 字段 | 含义 | 是否含客户端/网关开销 |
|---|---|---|
| `prompt_n` / `prompt_ms` | prompt 处理 | 否（纯后端） |
| `predicted_n` / `predicted_ms` | 生成阶段 | 否（纯后端） |
| `predicted_per_second` | 生成吞吐 | 否 |

**没有字段覆盖**：TCP 建连、TLS、网关排队、负载均衡探测、代理转发。

⇒ 必须自己算差额并解释：

```python
overhead = wall_seconds - prompt_ms/1000 - predicted_ms/1000
```

- 差额 **< 100ms**：正常（建连 + 序列化）
- 差额 **数秒且稳定**：先查客户端（代理！），不是服务端
- 差额 **忽快忽慢**：查网关排队 / 多后端负载不均

## 三、reasoning 开销的判定

### 陷阱：`reasoning=0` 不等于「关闭思考生效」

```
不传参数                    reasoning=    0字  content=349字   ← 默认就是关的
enable_thinking=false      reasoning=    0字  content=229字   ← 也关
enable_thinking=true       reasoning= 4889字  content=  0字   ← 开了，但答案被截断
```

**只有「同一 prompt 下 `true` 版本产生了 thinking 内容」才能证明开关真的有效。**
否则「空 reasoning」可能只是模型本来就不思考。

### 参数有效性（实测：llama-server + Qwen 系模板）

| 参数 | 有效 | 说明 |
|---|---|---|
| `chat_template_kwargs.enable_thinking=false` | ✅ | **唯一有效**的关闭方式 |
| `chat_template_kwargs.enable_thinking=true` | ✅ | 开启；必须给足 `max_tokens` |
| `thinking.type=disabled` | ❌ | Anthropic 风格，llama-server 不认 |
| `reasoning_effort=none/minimal/high` | ❌ | OpenAI 风格，不作用于 chat template |

### 开启思考时必须给足额度

`enable_thinking=true` + `max_tokens=1500` ⇒ 思考吃光 4889 tok，
`finish_reason=length` 且 **`content=''`**（答案一个字没有）。
经验值：思考模式下 `max_tokens ≥ 3000`，否则拿到空答案。

## 四、通用压测清单

评估任何自托管端点前，按序执行：

1. **查代理**：`urllib.request.getproxies()` 非空 ⇒ 压测代码必须显式 `ProxyHandler({})`
2. **双库对照**：`http.client`（绕代理）vs `urllib`（读代理），差异 >2 倍先查客户端
3. **拆 timings**：`wall − prompt_ms − predicted_ms` 必须能解释
4. **TTFB 分层**：`http.client` 拿响应头时间 vs body 读完时间
   - 头快 body 慢 ⇒ 模型生成
   - 头慢 ⇒ 网关/后端排队（或客户端代理）
5. **reasoning 对照**：必须跑 `enable_thinking=true` 才能证明 false 有效
6. **`max_tokens` 阶梯**：1 / 10 / 300 / 1000，看固定开销是否随长度不变
   （不变 ⇒ 固定开销；线性 ⇒ 生成开销）

## 五、这次事故的教训

**「两个客户端库测同一端点差 10 倍」是强信号，必须当场追，不能略过。**

实际发生的错误链：
1. 用 `urllib` 测 → 5s
2. 看到 `predicted_ms=39` → 判定「5s 是网关调度开销」
3. 建议 owner「去查网关调度配置」← **完全错误的方向**
4. 直到 owner 质疑「确定不是 reasoning 的开销？」才回头做对照实验
5. 一次 `http.client` 对照就定位到代理

**如果第 2 步就补一个 `http.client` 对照，不需要 owner 来质疑。**

对应本仓既有纪律「数值异常先证明测量本身可信」（见
`Wiki/Concepts/numeric_inference_traps.md`，属 battlesandbox 仓）：
**测量工具本身也是被测对象。**

## 六、相关模型能力缺陷（同一轮评估，与网络无关）

`bonsai`（三值量化 Qwen3.5-9B）真实缺陷，绕代理后仍复现：

```
问：9.11 和 9.9 哪个大？只回答一个数字
答：9.11   ← 连错 3 次（0.07-0.44s，非超时）
```

⇒ **小数比较能力不可靠**。适合做检索相关性判断（4 选 1 实测正确）、
JSON 结构化输出（可直接 `json.loads`）、工具调用（参数提取准确）；
**不适合**数值推理与精确计算。

## Links Out

- [[子代理模型解析 / fallback 链 / 用量账本]] — 模型选择与用量账本
- `Wiki/Concepts/numeric_inference_traps.md`（battlesandbox 仓）— 数值推断陷阱总纲
