<#
.SYNOPSIS
  Runtime Daemon G0 存活/身份验证（plans/0923_runtime_daemon_final_plan.md §8）。

.DESCRIPTION
  save/check 两阶段：
    save  — 拉起 daemon 后、关闭 WT 标签前运行：记录 host.json + OS 创建时间 +
            /v1/health + 静态首页快照，写入 EvidenceDir/round-<NN>.json。
    check — 关闭触发 daemon 的最后一个 WT 标签（或整个窗口）后，从【新开终端】
            执行：在 30s / 120s / 600s 三个时间点重检同一 pid + OS 创建时间 +
            instanceId + runtimeId + releaseId + 静态页，任一改变即 G0 失败。

  身份挑战（Assert-IdentityChallenge）：真实 nonce challenge 的断言接口。
  本切片脚本只做存活/页面/进程身份采样；挑战通道未接线前该函数显式返回
  INCONCLUSIVE（绝不用匿名 /v1/health 冒充通过——health 无 token、无 HMAC，
  不能证明服务端持有实例秘钥）。

调用范例：
  powershell -NoProfile -File scripts/verify-runtime-g0.ps1 -Phase save -HostInfo C:\隔离runtime\host.json -Run 1
  # …关闭最后一个 WT 标签/整个窗口，从新终端运行：
  powershell -NoProfile -File scripts/verify-runtime-g0.ps1 -Phase check -HostInfo C:\隔离runtime\host.json -Run 1

  每轮开始前显式受控 stop，保证 fresh pid；10 轮（各 5 轮「最后 tab」「整个窗口」）
  全过 + 空壳 WT=0 + 生产 vite/esbuild 孙进程=0 才算 G0 通过（窗口/进程树人工核对
  与本脚本合并才构成完整 G0，不能只跑本脚本自称通过）。
#>
param(
  [ValidateSet('save', 'check')][string]$Phase,
  [Parameter(Mandatory = $true)][string]$HostInfo,
  [Parameter(Mandatory = $true)][int]$Run,
  [string]$EvidenceDir = "$env:TEMP\pi-daemon-g0"
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $EvidenceDir | Out-Null
$base = Join-Path $EvidenceDir ("round-{0:d2}.json" -f $Run)

function Get-HostJson {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { throw "host.json 不存在：$Path" }
  $h = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
  foreach ($k in @('instanceId', 'pid', 'port')) {
    if (-not $h.PSObject.Properties[$k]) { throw "host.json 缺字段：$k" }
  }
  return $h
}

function Get-ProcessCreation([int]$TargetPid) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$TargetPid"
  if (-not $p) { throw "daemon pid $TargetPid 不存在" }
  return [string]$p.CreationDate
}

function Assert-IdentityChallenge {
  <#
  .SYNOPSIS
    真实 nonce challenge 断言接口（待接线）。
  .DESCRIPTION
    完整断言 = 从 host.json 读 token → POST /v1/challenge {nonce} →
    本地 HMAC 重算 + instanceId/runtimeId/releaseId/schemaVersion/
    processStartIdentity 全等（对标 extensions/runtime-host/identity.ts
    runLocalChallenge）。本函数当前返回 INCONCLUSIVE（不抛错、不计通过），
    调用方必须把该状态记入证据表，绝不能用匿名 health 的 instanceId 相等
    冒充挑战通过。
  #>
  param([string]$HostInfoPath, [int]$Port)
  Write-Warning "Assert-IdentityChallenge：挑战通道断言尚未接线 → INCONCLUSIVE（不计入通过；禁止用匿名 health 冒充）"
  return "INCONCLUSIVE"
}

function Snapshot {
  $h = Get-HostJson -Path $HostInfo
  $created = Get-ProcessCreation -Pid ([int]$h.pid)
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($h.port)/v1/health" -TimeoutSec 5
  $page = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$($h.port)/" -TimeoutSec 5
  if ($page.StatusCode -ne 200 -or $page.Content -notmatch '<html') { throw '静态页面不可达（GET / 非 200 或无 <html）' }
  $assetProbe = $false
  try {
    $assets = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$($h.port)/assets/" -TimeoutSec 5
    if ($assets.StatusCode -eq 404) { $assetProbe = $true }  # /assets/ 目录本身 404 = 无 SPA 误托管（预期）
  } catch {
    $resp = $_.Exception.Response
    if ($resp -and [int]$resp.StatusCode -eq 404) { $assetProbe = $true }
  }
  if (-not $assetProbe) { throw '静态路由异常：/assets/ 应 404（无目录误托管）' }
  # /v1/* 永不回 HTML（SPA fallback 禁止）：未知 API 路径必须是 JSON 404
  try {
    $nope = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$($h.port)/v1/does-not-exist-g0" -TimeoutSec 5
    throw "/v1/* 未知路径应 404，实际 $($nope.StatusCode)"
  } catch {
    $resp = $_.Exception.Response
    if (-not $resp -or [int]$resp.StatusCode -ne 404) { throw "/v1/* 未知路径非 404（可能 SPA fallback 泄漏）" }
  }
  if ($health.instanceId -ne $h.instanceId) { throw 'health 身份不匹配（instanceId）' }
  if ($h.processStartIdentity) {
    # 格式契约（生成侧 extensions/runtime-host/identity.ts::captureProcessStartIdentity）：
    # `<pid>@<ISO启动时刻>`（如 `1234@2026-09-23T10:00:00.000Z`）。消费侧解析取 `@` 后一段
    # 转 DateTime；兼容纯 ISO（无 `@`，取整串）。与 Win32_Process.CreationDate 比对。
    # 精度说明：ISO 为毫秒精度，WMI CreationDate 为微秒精度，且两侧时钟采样点不同
    # （生成侧 startedAt 在进程启动逻辑内取值，OS CreationDate 为内核调度时刻），故用
    # 120s 容差比对而非严格相等；超容差 = pid 复用或身份伪造 → throw。解析失败同样
    # throw（fail-closed），绝不静默降级为仅告警。
    try {
      $raw = [string]$h.processStartIdentity
      $iso = ($raw -split '@')[-1]
      if ([string]::IsNullOrWhiteSpace($iso)) { throw "processStartIdentity 为空段：$raw" }
      try { $a = ([DateTime]$iso).ToUniversalTime() }
      catch { throw "processStartIdentity 无法解析为日期：$raw（解析段：$iso）" }
      $b = ([Management.ManagementDateTimeConverter]::ToDateTime($created)).ToUniversalTime()
      if ([Math]::Abs(($a - $b).TotalSeconds) -gt 120) { throw 'pid 复用或创建时间不匹配（>120s）' }
    } catch {
      if ($_.Exception.Message -match 'pid 复用|无法解析|为空段') { throw }
      throw
    }
  }
  $challenge = Assert-IdentityChallenge -HostInfoPath $HostInfo -Port ([int]$h.port)
  [pscustomobject]@{
    pid                  = [int]$h.pid
    created              = $created
    instanceId           = [string]$h.instanceId
    runtimeId            = [string]$health.runtimeId
    releaseId            = [string]$health.releaseId
    port                 = [int]$h.port
    processStartIdentity = [string]$h.processStartIdentity
    challenge            = $challenge
  }
}

if ($Phase -eq 'save') {
  (Snapshot) | ConvertTo-Json | Set-Content -LiteralPath $base -Encoding UTF8
  Write-Host "已留基线 $base；现在关闭最后一个 WT 标签/整个窗口；从新终端运行 -Phase check。"
}
else {
  $before = Get-Content -Raw -LiteralPath $base | ConvertFrom-Json
  foreach ($delay in @(30, 120, 600)) {
    # check 由新终端立即开始；在各时间点重检同一进程，而非仅等待 600 秒最后检查。
    $wait = if ($delay -eq 30) { 30 } elseif ($delay -eq 120) { 90 } else { 480 }
    Start-Sleep -Seconds $wait
    $now = Snapshot
    foreach ($k in @('pid', 'created', 'instanceId', 'runtimeId', 'releaseId', 'port')) {
      if ([string]$before.$k -ne [string]$now.$k) { throw "第 $Run 轮 ${delay}s: $k 改变（before=$([string]$before.$k)，now=$([string]$now.$k)）" }
    }
    if ($now.challenge -eq 'PASS') {
      Write-Host "PASS round=$Run t=${delay}s pid=$($now.pid) instance=$($now.instanceId) challenge=PASS"
    }
    else {
      Write-Host "PASS round=$Run t=${delay}s pid=$($now.pid) instance=$($now.instanceId) challenge=$($now.challenge)（存活/页面/进程身份通过；挑战待接线，不冒充）"
    }
  }
}
