<#
.SYNOPSIS
  开机自启诊断（只读）：一条命令回答「开机自启失败了吗」。

.DESCRIPTION
  依据 plans/0926_boot_autostart_plan.md §5-3：逐项只读汇总 →
    [host]      host.json pid 是否活 + /v1/health 是否 200
    [attach]    owner attachment（sid / gen）
    [process]   目标 sid 的 node 进程数（==1 单实例；>1 = 双开 FAIL）
    [claim]     state/boot-resume.lock 状态（持有者 pid 是否活 / spawnAt 龄）
    [log]       state/boot-autostart.log 尾 N 行
    [task]      两条计划任务是否注册 + LastTaskResult
  末行 SUMMARY: OK | WARN | FAIL。

  退出码：0 = OK / WARN；1 = FAIL（只读，不改任何系统设置、不 kill 任何进程）。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\boot-autostart-status.ps1
#>
param(
	[string]$RuntimeDir = '',
	[string]$HomeDir = '',
	[string[]]$TaskName = @('pi-runtime-host-boot', 'pi-master-resume-boot'),
	[int]$LogTail = 10
)
$ErrorActionPreference = 'Continue'

$homePath = if ($HomeDir) { $HomeDir } else { [Environment]::GetFolderPath('UserProfile') }
$rt = if ($RuntimeDir) { $RuntimeDir } else { Join-Path $homePath '.pi\agent\runtime' }
$hostJson = Join-Path $rt 'host.json'
$attPath = Join-Path $rt 'registry\attachments\agent___master_default.json'
$claimPath = Join-Path $rt 'state\boot-resume.lock'
$logPath = Join-Path $rt 'state\boot-autostart.log'

$level = 'OK'
function Raise([string]$NewLevel) {
	if ($NewLevel -eq 'FAIL') { $script:level = 'FAIL'; return }
	if ($NewLevel -eq 'WARN' -and $script:level -ne 'FAIL') { $script:level = 'WARN' }
}

# ── host ──────────────────────────────────────────────────────────────
$hostState = 'DEAD'
if (Test-Path -LiteralPath $hostJson) {
	try {
		$h = Get-Content -LiteralPath $hostJson -Raw | ConvertFrom-Json
		$alive = $null -ne (Get-Process -Id $h.pid -ErrorAction SilentlyContinue)
		$health = $null
		try {
			$r = Invoke-WebRequest -Uri "http://127.0.0.1:$($h.port)/v1/health" -UseBasicParsing -TimeoutSec 2
			$health = [int]$r.StatusCode
		} catch { $health = $null }
		if ($alive -and $health -eq 200) { $hostState = 'ALIVE' }
		elseif ($alive) { $hostState = 'DEGRADED(pid-alive-health-fail)' }
		else { $hostState = 'DEAD(pid-gone)' }
		"[host] pid=$($h.pid) port=$($h.port) health=$health state=$hostState start=$($h.startedAt)"
	} catch { "[host] host.json 读取失败：$($_.Exception.Message)"; $hostState = 'UNREADABLE' }
} else { "[host] host.json 不存在：$hostJson" }
if ($hostState -ne 'ALIVE') { Raise 'FAIL' }

# ── attachment ────────────────────────────────────────────────────────
$sid = $null
if (Test-Path -LiteralPath $attPath) {
	try {
		$att = Get-Content -LiteralPath $attPath -Raw | ConvertFrom-Json
		$sid = [string]$att.sessionId
		"[attach] sid=$sid gen=$($att.generation) attempt=$($att.attemptId)"
		if (-not $sid -or $sid -eq 'unknown') { "[attach] sid 无效（未 attach）"; Raise 'WARN' }
	} catch { "[attach] attachment 读取失败：$($_.Exception.Message)"; Raise 'WARN' }
} else { "[attach] attachment 不存在（master 未 attach，需人工 /master-attach）"; Raise 'WARN' }

# ── 目标 sid 进程数（A4 单实例）──────────────────────────────────────
if ($sid) {
	$holder = @()
	try {
		$holder = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { [string]$_.CommandLine -and ([string]$_.CommandLine).IndexOf($sid, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 })
	} catch { "[process] 扫描失败：$($_.Exception.Message)"; Raise 'WARN' }
	$state = if ($holder.Count -eq 0) { 'not-running' } elseif ($holder.Count -eq 1) { 'running(1)' } else { "DUP($($holder.Count))" }
	"[process] sid holders=$($holder.Count) state=$state pids=$(@($holder.ProcessId) -join ',')"
	if ($holder.Count -gt 1) { Raise 'FAIL' }
}

# ── claim（boot-resume.lock）──────────────────────────────────────────
if (Test-Path -LiteralPath $claimPath) {
	try {
		$c = Get-Content -LiteralPath $claimPath -Raw | ConvertFrom-Json
		if (-not $c -or -not $c.claimId) {
			# M2 对应态：0 字节 / 假值 / 无 claimId = 损坏（resume 会 phase=error + 非零退出）
			"[claim] claim 结构无效（0 字节 / 解析成假值 / 无 claimId）= 崩溃残留或损坏 → resume 会按 claim-unreadable 异常 skip 并非零退出"
			$c = $null
			Raise 'FAIL'
		} else {
			$claimPid = $c.pid
			$alive = $null
			if ($null -ne $claimPid -and $claimPid -ne '') { $alive = $null -ne (Get-Process -Id $claimPid -ErrorAction SilentlyContinue) }
			$age = $null
			try { $age = [int]((Get-Date) - [datetime]$c.spawnAt).TotalSeconds } catch { }
			$st = if ($null -eq $claimPid -or $claimPid -eq '') { 'pending(pid=null)' } elseif ($alive) { 'held(pid-alive)' } else { 'stale(pid-dead)' }
			"[claim] claimId=$($c.claimId) sid=$($c.sid) pid=$claimPid ageSec=$age state=$st"
			if ($st -eq 'pending(pid=null)' -and $age -ne $null -and $age -ge 120) { "[claim] 超 120s 的 pending = 崩溃残留（下次 resume 会按可证死清掉）"; Raise 'WARN' }
		}
	} catch {
		# M2：claim 不可解析 = resume 会 phase=error + 非零退出 → 这里必须 FAIL（不能只 WARN）
		"[claim] claim 读取失败/损坏（0 字节、半截 JSON、权限拒绝）：$($_.Exception.Message)"
		"[claim] → resume 会判 claim-unreadable 异常 skip、退出码非 0（Task Scheduler LastTaskResult 应为失败）"
		Raise 'FAIL'
	}
} else { "[claim] 无 claim（未在 spawn 窗口内 / 已释放）" }

# ── 日志尾 ────────────────────────────────────────────────────────────
if (Test-Path -LiteralPath $logPath) {
	$tail = @(Get-Content -LiteralPath $logPath -Tail $LogTail -Encoding UTF8 -ErrorAction SilentlyContinue)   # 日志是 UTF-8 无 BOM（含中文 note），不加 -Encoding 会乱码
	"[log] $logPath（尾 $($tail.Count) 行）"
	foreach ($l in $tail) { "      $l" }
	$errLines = @($tail | Where-Object { $_ -match '"phase":"error"' })
	$skipLines = @($tail | Where-Object { $_ -match '"phase":"skip"' })
	if ($errLines.Count -gt 0) { "[log] 尾 $($tail.Count) 行内有 $($errLines.Count) 行 phase=error（最后一条：$($errLines[-1])"; Raise 'FAIL' }
	elseif ($skipLines.Count -gt 0) { "[log] 尾 $($tail.Count) 行内有 $($skipLines.Count) 行 phase=skip（上次为正常/设计内 skip）"; Raise 'WARN' }
} else { "[log] 日志不存在（两条任务从未跑过）：$logPath"; Raise 'WARN' }

# ── 计划任务 ──────────────────────────────────────────────────────────
foreach ($t in $TaskName) {
	try {
		$task = Get-ScheduledTask -TaskName $t -ErrorAction Stop
		$info = Get-ScheduledTaskInfo -TaskName $t -ErrorAction Stop
		$res = $info.LastTaskResult
		$st = if ($res -eq 0) { 'OK' } else { "LastTaskResult=$res" }
		"[task] $t registered state=$($task.State) last=$st lastRun=$($info.LastRunTime)"
		if ($res -ne 0) { Raise 'WARN' }
	} catch { "[task] $t 未注册（尚未粘贴注册命令）"; Raise 'WARN' }
}

"SUMMARY: $level"
if ($level -eq 'FAIL') { exit 1 } else { exit 0 }
