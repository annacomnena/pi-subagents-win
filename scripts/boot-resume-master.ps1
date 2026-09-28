<#
.SYNOPSIS
  开机恢复 global master 会话（计划步②）：三层 fail-closed 防重 → WT 直调 resume。

.DESCRIPTION
  依据 plans/0926_boot_autostart_plan.md §2/§3（B 方案：步① + 步②）：

    P1–P6  前置判据（attachment / transfer-window / session 文件存在 / header.id==sid /
            header.cwd==home / 审计基线），任一不满足 → skip，零副作用。
    G1     claim 锁 `state/boot-resume.lock`：wx 排他创建 + pid/cmdline 身份复核，
            镜像 daemon-lifecycle 的 stealStaleLock「可证死 / 可证 pid 复用才清 + 重读复核」。
    G2     进程扫描：node.exe 的 CommandLine 含目标 sessionId = 有活持有者；
            CommandLine 不可读 = 不确定（fail-closed）。
    G3     歧义交互 pi 扫描：`--session` 参数值先按 pi resolveSessionPath 语义分档（M1：
           路径含全长 sid / 精确等于 sid / sid 以它开头 = 就是我们；后缀、子串、通配符等
           无法确证指向别的会话的形态 → 一律 skip），再对裸 / `-c` / `-r` / `--session-dir`
           按 owner 文件是否 home 项目最新 jsonl 分档，**判不准一律 skip**。
    C      spawn 后 0→20s 轮询：恰好 1 个 holder 才回填 claim.pid 并记 ok；
           >1 = dup-detected（不 kill），0 = spawn-unconfirmed。

  三层任一「不确定」→ 不启动（skip + 落日志）。全程零 kill、零 attach
  （resume 同 sessionId，owner 门天然成立，generation 不变）。

  L4 后修正（plans/0926_boot_autostart_l4_review.md §2 必须修 B1/B2 + 建议修 S1/S2/S3/S7）：
    M1  G3 的 `--session` 参数值按 pi `dist/main.js::resolveSessionPath` 分档：路径形态比文件名
        是否含全长 sid、id 形态比精确等值/前缀 ⇒ ours；否则（后缀/子串/通配符/别人的 id）
        无法确证 → 一律 skip（fail-closed），杜绝「判成可证无害 → 双开双写」。
    M2  区分「正常 skip」与「异常 skip」：claim 损坏/不可解析/结构无效/判不准、pi 目录类 env
        覆盖 → phase=error + 可读 note + **exit 1**（Task Scheduler LastTaskResult 必须显示失败）；
        0 字节/半截 claim 另按文件 mtime≥120s 判崩溃残留后清除（否则永久卡死）。

  启动器（照 tab-launch-core.ts::spawnPiTab 姿势）：
    WindowsTerminal.exe 直调优先（Get-AppxPackage 解析）→ 别名仅作 --help 探针后兜底
    → 两者皆无 = launcher-unhealthy（exit 1）；
    .NET ProcessStartInfo + UseShellExecute=$false（无 shell 重解析）+ cwd=home；
    env 身份类全清（PI_SUBAGENT / PI_TAB_RUN_ID / PI_SESSION_ID / PI_SESSION_FILE /
    PI_SESSION_PROFILE / PI_TRACE_* / PI_PROVIDER / PI_MODEL / PI_REASONING_LEVEL /
    AI_AGENT / PI_CODING_AGENT）；不带 --tab-run-id、不带 prompt。

  目标 sessionId 运行时从 registry/attachments/agent___master_default.json 读（不硬编码）。

  退出码：0 = 成功 / **正常** skip-by-design（已有活持有者、另一次在 spawn 窗口内、交接在途、
              G3 判定可证无害或判不准的 session-flag…）；
          1 = 失败（launcher / spawn-unconfirmed / dup-detected，以及 **异常 skip：claim 不可解析、
              claim 结构无效、claim 判不准、pi 目录类 env 覆盖** —— 无人值守不可静默失效）；
          2 = 脚本内部异常。
  写日志 never-throw；日志 = <runtime>/state/boot-autostart.log（追加式 JSONL）。

.PARAMETER DelaySeconds
  触发后延迟秒数（默认 45 = 登录 +45s；计划任务把延迟写在脚本里，任务保持简单）。
.PARAMETER DryRun
  干跑：跑完 P + G1 + G2 + G3 + launcher 解析并落日志，但**不创建 claim、不 spawn**，
  输出拟发命令行后退出 0（自测/排障用，绝不真开窗口）。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File scripts\boot-resume-master.ps1 -DelaySeconds 45

.EXAMPLE
  # 手测/自测（不延迟、不开窗）：
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\boot-resume-master.ps1 -DelaySeconds 0 -DryRun
#>
param(
	[int]$DelaySeconds = 45,
	[string]$RuntimeDir = '',
	[string]$SessionsDir = '',
	[string]$HomeDir = '',
	[string]$NodeExe = '',
	[string]$CliPath = '',
	[string]$WtExe = '',
	[switch]$DryRun
)

# ── 日志（never-throw）────────────────────────────────────────────────
function Write-BootLog {
	param([string]$LogPath, [string]$Phase, [hashtable]$Fields)
	try {
		$payload = [ordered]@{ task = 'master-resume'; phase = $Phase }
		if ($Fields) { foreach ($k in $Fields.Keys) { $payload[$k] = $Fields[$k] } }
		$line = (Get-Date).ToString('o') + ' ' + ($payload | ConvertTo-Json -Compress -Depth 5)
		$dir = Split-Path -Parent $LogPath
		if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
		[System.IO.File]::AppendAllText($LogPath, $line + "`n", (New-Object System.Text.UTF8Encoding($false)))
	} catch { <# 日志不可写不阻断判定 #> }
}

# ── env 身份类清理名单（计划 §3.3：只删不加）─────────────────────────
function Get-BootEnvScrubKeys {
	@(
		'PI_SUBAGENT', 'PI_TAB_RUN_ID', 'PI_TAB_RUNS_DIR', 'PI_SESSION_PROFILE',
		'PI_TRACE_RUN_ID', 'PI_TRACE_LANE',
		'PI_SESSION_ID', 'PI_SESSION_FILE', 'PI_PROVIDER', 'PI_MODEL', 'PI_REASONING_LEVEL',
		'AI_AGENT', 'PI_CODING_AGENT'
	)
}

# ── S1：字面包含（`-like "*x*"` 是通配符模式，sid 含 [ ] * ? 时会漏判真持有者）────
function Test-CommandLineHasSid {
	param([string]$CommandLine, [string]$Sid)
	if ($null -eq $CommandLine -or -not $Sid) { return $false }
	return ([string]$CommandLine).IndexOf([string]$Sid, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
}

# ── M1：`--session` 参数值分档（照 pi dist/main.js::resolveSessionPath 语义）────────
# 'ours'    = 确定指向我方 session（路径文件名含全长 sid / 精确等值 / sid 以它开头）
# 'other'   = 可证指向别的会话（路径形态且不含全长 sid ⇒ pi 直接用该文件）
# 'uncertain' = 判不准（非路径又不是精确等值/前缀：后缀、子串、通配符、空值…）→ 一律 skip
function Get-SessionTargetVerdict {
	param([string]$Target, [string]$Sid)
	$t = ([string]$Target).Trim().Trim('"').Trim("'")
	if (-not $t -or -not $Sid) { return 'uncertain' }
	$pathish = ($t.IndexOf('/') -ge 0) -or ($t.IndexOf('\') -ge 0) -or
		$t.EndsWith('.jsonl', [System.StringComparison]::OrdinalIgnoreCase)
	if ($pathish) {
		# 路径形态：pi 原样用该文件；我方文件名恒为 <ts>_<sid>.jsonl（P3/P4 保证）⇒ 含全长 sid 才是「就是我们」
		if (Test-CommandLineHasSid -CommandLine $t -Sid $Sid) { return 'ours' }
		return 'other'
	}
	# id / 前缀形态：pi 只做 exact 或 startsWith（resolveSessionPath）
	if ($t.Equals($Sid, [System.StringComparison]::OrdinalIgnoreCase)) { return 'ours' }
	if ($Sid.StartsWith($t, [System.StringComparison]::OrdinalIgnoreCase)) { return 'ours' }
	return 'uncertain'
}

# ── 命令行是否「持有我方 session」（G2 全长 sid / C 层确认共用）────────────────
function Test-CommandLineHoldsSid {
	param([string]$CommandLine, [string]$Sid)
	if (Test-CommandLineHasSid -CommandLine $CommandLine -Sid $Sid) { return $true }
	$cl = [string]$CommandLine
	if ($cl -match '--session(?:-id)?(?:\s+|=)("[^"]+"|\S+)') {
		$target = $Matches[1].Trim('"')
		return ((Get-SessionTargetVerdict -Target $target -Sid $Sid) -eq 'ours')
	}
	return $false
}

# ── G1 claim 复核/释放（镜像 daemon-lifecycle：可证死/可证复用才清 + 重读复核）────
function Test-ClaimStale {
	<#
	  返回：'stale'（可证死/可证 pid 复用 → 调用方重读复核后清）、'held'（活持有者 → skip）、
	        'uncertain'（查询异常/读文件异常/重读不一致 → fail-closed）、'absent'（已不在）。
	#>
	param([string]$Path, [object]$Claim)
	if (-not (Test-Path -LiteralPath $Path)) { return 'absent' }
	# S2：claim.sid 缺失 = 身份证不出 → 绝不当「可证 pid 复用」（原 `-and` 短路会无证明就清锁）
	if (-not [string]$Claim.sid) { return 'uncertain' }
	if ($null -eq $Claim.pid -or $Claim.pid -eq '') {
		try {
			$age = ((Get-Date) - [datetime]$Claim.spawnAt).TotalSeconds
		} catch { return 'uncertain' }
		if ($age -lt 120) { return 'held' }   # 另一次正在 spawn 窗口内
		return 'stale'                        # pid=null 且 ≥120s = 崩溃残留
	}
	try {
		$cp = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$Claim.pid)"
	} catch { return 'uncertain' }
	if (-not $cp) { return 'stale' }                                  # 可证死
	if ($null -eq $cp.CommandLine) { return 'uncertain' }             # 身份不可读 = 证不出
	$claimSid = [string]$Claim.sid
	if ($claimSid -and (Test-CommandLineHasSid -CommandLine $cp.CommandLine -Sid $claimSid)) { return 'held' }  # 活且身份相符（字面包含，S1）
	return 'stale'                                                    # pid 复用 = 可证非持有者
}

function Remove-ClaimIfSame {
	# 重读复核：claimId 仍是调用方才删（releaseRuntimeLock 同款条件删）；否则 false = 不确定
	param([string]$Path, [string]$ClaimId)
	try {
		if (-not (Test-Path -LiteralPath $Path)) { return $true }
		$again = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
		if ($again.claimId -ne $ClaimId) { return $false }
		Remove-Item -LiteralPath $Path -Force
		return $true
	} catch { return $false }
}

function Release-OwnClaim {
	param([string]$Path, [string]$ClaimId)
	try {
		if (-not (Test-Path -LiteralPath $Path)) { return }
		$z = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
		if ($z.claimId -eq $ClaimId) { Remove-Item -LiteralPath $Path -Force }
	} catch { }
}

# ── 进程扫描（G2/G3/C 的共同取数口；自测可在 dot-source 后重定义为桩）────────
function Get-NodeProcessList {
	# 抛异常 → 调用方按「不确定」fail-closed
	Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId, CommandLine
}

# ── 启动器解析（直调优先；别名仅作 --help 探针后兜底；都不可用 = null）────────
function Test-WtAliasHealthy {
	param([string]$Exe)
	try {
		$psi = [Diagnostics.ProcessStartInfo]::new()
		$psi.FileName = $Exe
		$psi.Arguments = '--help'
		$psi.UseShellExecute = $false
		$psi.CreateNoWindow = $true
		$p = [Diagnostics.Process]::Start($psi)
		if (-not $p.WaitForExit(3000)) { try { $p.Kill() } catch { }; return $false }
		return ($p.ExitCode -eq 0)
	} catch { return $false }
}

function Resolve-WtLauncher {
	param([string]$Preferred)
	if ($Preferred) { if (Test-Path -LiteralPath $Preferred) { return $Preferred }; return $null }
	try {
		$pkg = Get-AppxPackage -Name Microsoft.WindowsTerminal | Select-Object -First 1
		if ($pkg -and $pkg.InstallLocation) {
			$cand = Join-Path $pkg.InstallLocation 'WindowsTerminal.exe'
			if (Test-Path -LiteralPath $cand) { return $cand }
		}
	} catch { }
	$alias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\wt.exe'
	if ((Test-Path -LiteralPath $alias) -and (Test-WtAliasHealthy $alias)) { return $alias }
	return $null
}

function Resolve-PiCli {
	# 照 index.ts::findPiCli 顺序：显式参数 → PI_CLI_PATH → node 同级 node_modules → where pi
	param([string]$NodePath, [string]$CliOverride)
	if ($CliOverride -and (Test-Path -LiteralPath $CliOverride)) { return $CliOverride }
	if ($env:PI_CLI_PATH -and (Test-Path -LiteralPath $env:PI_CLI_PATH)) { return $env:PI_CLI_PATH }
	if ($NodePath) {
		$base = Join-Path (Split-Path -Parent $NodePath) 'node_modules\@earendil-works\pi-coding-agent\dist'
		$direct = Join-Path $base 'cli.js'
		if (Test-Path -LiteralPath $direct) { return $direct }
		$bundle = Join-Path $base 'bundle\cli.js'
		if (Test-Path -LiteralPath $bundle) { return $bundle }
	}
	try {
		$shim = Get-Command pi -ErrorAction Stop | Select-Object -First 1
		if ($shim) {
			$src = if ($shim.Source) { $shim.Source } else { $shim.Path }
			if ($src -and (Test-Path -LiteralPath $src)) {
				$txt = Get-Content -LiteralPath $src -Raw
				if ($txt -match '(?i)([A-Za-z]:\\[^\s"'']+?\\cli\.js)') {
					$hit = $Matches[1]
					if (Test-Path -LiteralPath $hit) { return $hit }
				}
			}
		}
	} catch { }
	return $null
}

# ── spawn（桩点：自测 dot-source 后可重定义为记录器，确保不真开窗）──────────
function Start-PiWindow {
	param([string]$WtPath, [string]$Arguments, [string]$WorkingDir, [string[]]$ScrubKeys)
	$psi = [Diagnostics.ProcessStartInfo]::new()
	$psi.FileName = $WtPath
	$psi.Arguments = $Arguments
	$psi.UseShellExecute = $false
	$psi.WorkingDirectory = $WorkingDir
	foreach ($k in $ScrubKeys) { [void]$psi.EnvironmentVariables.Remove($k) }
	[void][Diagnostics.Process]::Start($psi)
}

# ── spawn 后确认 C（桩点同上）────────────────────────────────────────────
function Wait-HolderConfirmation {
	param([string]$Sid, [int]$Seconds = 20)
	$found = @()
	for ($i = 0; $i -lt $Seconds; $i++) {
		Start-Sleep -Seconds 1
		try { $found = @(Get-NodeProcessList | Where-Object { Test-CommandLineHoldsSid -CommandLine $_.CommandLine -Sid $Sid }) } catch { $found = @() }
		if ($found.Count -ge 1) { break }
	}
	return $found
}

# ══════════════════════════════════════════════════════════════════════
function Invoke-BootResume {
	[CmdletBinding()]
	param(
		[int]$DelaySeconds = 45,
		[string]$RuntimeDir = '',
		[string]$SessionsDir = '',
		[string]$HomeDir = '',
		[string]$NodeExe = '',
		[string]$CliPath = '',
		[string]$WtExe = '',
		[switch]$DryRun
	)
	$ErrorActionPreference = 'Stop'

	$homePath = if ($HomeDir) { $HomeDir } else { [Environment]::GetFolderPath('UserProfile') }
	$rt      = if ($RuntimeDir) { $RuntimeDir } else { Join-Path $homePath '.pi\agent\runtime' }
	$sessDir = if ($SessionsDir) { $SessionsDir } else { Join-Path $homePath '.pi\agent\sessions' }
	$log     = Join-Path $rt 'state\boot-autostart.log'
	$claim   = Join-Path $rt 'state\boot-resume.lock'
	$attPath = Join-Path $rt 'registry\attachments\agent___master_default.json'
	$twPath  = Join-Path $rt 'registry\transfer-window\agent___master_default.json'
	$claimId = [guid]::NewGuid().ToString('N')

	try {
		$stateDir = Split-Path -Parent $log
		if (-not (Test-Path -LiteralPath $stateDir)) { New-Item -ItemType Directory -Force -Path $stateDir | Out-Null }
	} catch {
		Write-BootLog -LogPath $log -Phase 'error' -Fields @{ reason = 'internal'; error = "state dir: $($_.Exception.Message)" }
		return 2
	}

	if ($DelaySeconds -gt 0) { Start-Sleep -Seconds $DelaySeconds }

	try {
		# ── S7：pi 目录类 env 覆盖 → 本脚本按默认路径校验出的判据不再成立，判不准不启动 ──
		$envHits = @()
		if (-not $RuntimeDir) {
			$v = [Environment]::GetEnvironmentVariable('PI_RUNTIME_DIR')
			if ($v -and $v.Trim()) { $envHits += "PI_RUNTIME_DIR=$v" }
		}
		if (-not $SessionsDir -or -not $RuntimeDir) {
			foreach ($k in @('PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR', 'PI_SESSIONS_DIR')) {
				$v = [Environment]::GetEnvironmentVariable($k)
				if ($v -and $v.Trim()) { $envHits += "$k=$v" }
			}
		}
		if ($envHits.Count -gt 0) {
			Write-BootLog -LogPath $log -Phase 'error' -Fields @{
				reason = 'env-override-uncertain'; envKeys = $envHits   # 注意：字段名不可叫 keys（PS 哈希表条目 keys 会遮蔽 .Keys 属性，日志会烂）
				note = 'pi 目录类 env 覆盖在位，脚本硬编码默认目录得到的 attachment/session 判据不可信 → 判不准不启动（异常 skip，非零退出）'
			}
			return 1
		}

		# ── P1 attachment ────────────────────────────────────────────────
		if (-not (Test-Path -LiteralPath $attPath)) {
			Write-BootLog -LogPath $log -Phase 'skip' -Fields @{ reason = 'no-attachment' }; return 0
		}
		$att = $null
		try { $att = Get-Content -LiteralPath $attPath -Raw | ConvertFrom-Json } catch {
			Write-BootLog -LogPath $log -Phase 'skip' -Fields @{ reason = 'no-attachment'; error = $_.Exception.Message }; return 0
		}
		$sid = [string]$att.sessionId
		if (-not $sid -or $sid -eq 'unknown') {
			Write-BootLog -LogPath $log -Phase 'skip' -Fields @{ reason = 'no-sid' }; return 0
		}

		# ── P2 transfer-window（交接在途不掺和）─────────────────────────
		if (Test-Path -LiteralPath $twPath) {
			$created = $null
			try { $tw = Get-Content -LiteralPath $twPath -Raw | ConvertFrom-Json; $created = [datetime]$tw.createdAt } catch { $created = $null }
			if (-not $created) {
				Write-BootLog -LogPath $log -Phase 'skip' -Fields @{ reason = 'uncertain-transfer'; sid = $sid }; return 0
			}
			if (((Get-Date) - $created).TotalHours -lt 24) {
				Write-BootLog -LogPath $log -Phase 'skip' -Fields @{ reason = 'transfer-in-flight'; sid = $sid }; return 0
			}
		}

		# ── P3 session 文件（最新 mtime，绝不自动 --session-id 建空会话）──
		$file = $null
		try {
			$file = Get-ChildItem -LiteralPath $sessDir -Recurse -File -Filter "*$sid*.jsonl" -ErrorAction SilentlyContinue |
				Sort-Object LastWriteTime -Descending | Select-Object -First 1
		} catch { $file = $null }
		if (-not $file) {
			Write-BootLog -LogPath $log -Phase 'skip' -Fields @{ reason = 'session-file-missing'; sid = $sid }; return 0
		}

		# ── P4/P5 header 复核（防「假 master」：文件缺失/异常时 pi 会造新 UUID）──
		$h = $null
		try {
			$fs = [System.IO.File]::Open($file.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
			$tr = New-Object System.IO.StreamReader($fs)
			try { $first = $tr.ReadLine() } finally { $tr.Close(); $fs.Close() }
			if ($first) { $h = $first | ConvertFrom-Json }
		} catch { $h = $null }
		if (-not $h -or $h.type -ne 'session' -or [string]$h.id -ne $sid) {
			Write-BootLog -LogPath $log -Phase 'skip' -Fields @{ reason = 'header-mismatch'; sid = $sid; headerId = $(if ($h) { $h.id } else { $null }) }
			return 0
		}
		if ([string]$h.cwd -ne $homePath) {
			Write-BootLog -LogPath $log -Phase 'skip' -Fields @{ reason = 'header-cwd-mismatch'; sid = $sid; cwd = $h.cwd }
			return 0
		}

		# P6 审计基线（fileSize + mtime）；ownerIsNewest 供 G3 的 --continue 分档
		$newest = Get-ChildItem -LiteralPath $file.DirectoryName -Filter '*.jsonl' -File -ErrorAction SilentlyContinue |
			Sort-Object LastWriteTime -Descending | Select-Object -First 1
		$ownerIsNewest = ($newest -and $newest.FullName -eq $file.FullName)
		Write-BootLog -LogPath $log -Phase 'checks' -Fields @{
			ok = $true; sid = $sid; gen = $att.generation; file = $file.FullName
			fileSize = [int64]$file.Length; mtime = $file.LastWriteTime.ToString('o'); ownerIsNewest = [bool]$ownerIsNewest
		}

		# ── G1 claim 锁（已存在：可证死/可证复用才清 + 重读复核）──────────
		# M2：正常 skip（活持有者 / 另一次在 spawn 窗口内 / 别人刚抢到 wx）→ exit 0；
		#     异常 skip（claim 不可解析、结构无效、判不准）→ phase=error + 可读 note + exit 1，
		#     让 Task Scheduler 的 LastTaskResult 显示失败，而不是「成功但什么都没做」。
		if (Test-Path -LiteralPath $claim) {
			$c = $null
			$readErr = $null
			try { $c = Get-Content -LiteralPath $claim -Raw | ConvertFrom-Json } catch { $readErr = $_.Exception.Message }

			if ($readErr -or -not $c) {
				# 0 字节 / 半截 JSON / 权限拒绝（读抛异常）/ 解析成假值（false、[]、''、null）
				$detail = if ($readErr) { "claim unreadable: $readErr" } else { 'claim parses to empty/falsy value (0 byte or non-object)' }
				$ageSec = $null
				$statOk = $true
				try { $ageSec = ((Get-Date) - (Get-Item -LiteralPath $claim).LastWriteTime).TotalSeconds } catch { $statOk = $false }
				if ($statOk -and $ageSec -ge 120) {
					# 与「pid=null 且 ≥120s」同语义：≥120s 没人再写它 = 可证崩溃残留 → 清掉继续（否则永久卡死）
					try {
						Remove-Item -LiteralPath $claim -Force
						Write-BootLog -LogPath $log -Phase 'warn' -Fields @{ reason = 'claim-residue-cleared'; detail = $detail; ageSec = [int]$ageSec; note = '损坏 claim 按文件 mtime≥120s 判为崩溃残留并清除，继续防重流程' }
					} catch {
						Write-BootLog -LogPath $log -Phase 'error' -Fields @{ reason = 'claim-unreadable'; detail = $detail; clearError = $_.Exception.Message; note = '损坏 claim 清除失败 → 异常 skip，非零退出' }
						return 1
					}
				} else {
					Write-BootLog -LogPath $log -Phase 'error' -Fields @{
						reason = 'claim-unreadable'; detail = $detail
						ageSec = $(if ($statOk) { [int]$ageSec } else { $null })
						note = 'claim 不可解析（0 字节 / 半截 JSON / 权限拒绝 / 非对象值）= 异常 skip，非零退出；mtime≥120s 后重跑会按崩溃残留清除'
					}
					return 1
				}
			} elseif (-not $c.claimId) {
				Write-BootLog -LogPath $log -Phase 'error' -Fields @{ reason = 'uncertain-claim'; detail = 'claimId missing'; note = 'claim 结构无效（可解析但没有 claimId）= 异常 skip，非零退出' }
				return 1
			} else {
				$state = Test-ClaimStale -Path $claim -Claim $c
				switch ($state) {
					'held' {
						$why = if ($null -eq $c.pid -or $c.pid -eq '') { 'claim-pending' } else { 'already-running' }
						$f = @{ reason = $why; via = 'claim'; sid = $sid }
						if ($c.pid) { $f.pid = $c.pid }
						Write-BootLog -LogPath $log -Phase 'skip' -Fields $f; return 0
					}
					'uncertain' {
						Write-BootLog -LogPath $log -Phase 'error' -Fields @{ reason = 'uncertain-claim'; detail = 'claim pid check inconclusive'; note = 'claim 持有者身份判不准（CIM 读不出 / claim 缺 sid）= 异常 skip，非零退出' }
						return 1
					}
					'stale' {
						if (-not (Remove-ClaimIfSame -Path $claim -ClaimId $c.claimId)) {
							Write-BootLog -LogPath $log -Phase 'error' -Fields @{ reason = 'uncertain-claim'; detail = 'claimId changed on re-read'; note = 'claim 在判定期间被改写 = 判不准，异常 skip，非零退出' }
							return 1
						}
					}
					default { }   # absent → 继续
				}
			}
		}

		# ── G2 进程扫描（命令行可见 sid = 活持有者；读不出 = 不确定）───────
		$nodes = @()
		try { $nodes = @(Get-NodeProcessList) } catch {
			Write-BootLog -LogPath $log -Phase 'skip' -Fields @{ reason = 'uncertain-unreadable'; error = $_.Exception.Message }
			return 0
		}
		foreach ($p in $nodes) {
			if ($null -eq $p.CommandLine) {
				Write-BootLog -LogPath $log -Phase 'skip' -Fields @{ reason = 'uncertain-unreadable'; pid = $p.ProcessId }
				return 0
			}
		}
		$holder = @($nodes | Where-Object { Test-CommandLineHasSid -CommandLine $_.CommandLine -Sid $sid })
		if ($holder.Count -gt 0) {
			Write-BootLog -LogPath $log -Phase 'skip' -Fields @{ reason = 'already-running'; via = 'process'; sid = $sid; pids = @($holder.ProcessId) }
			return 0
		}

		# ── G3 歧义交互 pi 扫描（判不准一律 skip）────────────────────────
		$piProcs = @($nodes | Where-Object {
				$_.CommandLine -match 'pi-coding-agent' -and $_.CommandLine -match 'cli\.js'
			})
		foreach ($p in $piProcs) {
			$cl = [string]$p.CommandLine
			# ① `--session`/`--session-id`：先按 M1 分档。**必须排在「可证无害形态」剔除表之前**，
			#    否则 `--session <我方 sid 前缀> --print` 之类会被排除表盖掉 → 判成无害 → 双开双写。
			if ($cl -match '--session(?:-id)?(?:\s+|=)("[^"]+"|\S+)') {
				$target = $Matches[1].Trim('"')
				$verdict = Get-SessionTargetVerdict -Target $target -Sid $sid
				if ($verdict -eq 'other') { continue }   # 可证指向别的会话
				if ($verdict -eq 'ours') {
					Write-BootLog -LogPath $log -Phase 'skip' -Fields @{ reason = 'already-running'; via = 'session-flag'; sid = $sid; pid = $p.ProcessId; target = $target }
					return 0
				}
				Write-BootLog -LogPath $log -Phase 'skip' -Fields @{
					reason = 'uncertain-session-flag'; sid = $sid; pid = $p.ProcessId; target = $target
					note = '--session 参数既不是含全长 sid 的路径、也不是精确等于/前缀于我方 sid（后缀/子串/通配符等无法确证）→ 判不准不启动'
				}
				return 0
			}
			# ② 无 session 旗标：可证无害形态直接剔除
			if ($cl -match '--no-session|--print|--export|--version|--list-models|--tab-run-id|--fork') { continue }
			if ($cl -match '--session-dir') {
				Write-BootLog -LogPath $log -Phase 'skip' -Fields @{ reason = 'uncertain-session-dir'; pid = $p.ProcessId }; return 0
			}
			if ($cl -match '(--resume|\s-r)(=|\s|$)') {
				Write-BootLog -LogPath $log -Phase 'skip' -Fields @{ reason = 'uncertain-resume-picker'; pid = $p.ProcessId }; return 0
			}
			if ($cl -match '(--continue|\s-c)(=|\s|$)') {
				if ($ownerIsNewest) {
					Write-BootLog -LogPath $log -Phase 'skip' -Fields @{ reason = 'uncertain-continue'; pid = $p.ProcessId }; return 0
				}
				Write-BootLog -LogPath $log -Phase 'warn' -Fields @{ reason = 'continue-not-ours'; pid = $p.ProcessId }
				continue
			}
			Write-BootLog -LogPath $log -Phase 'warn' -Fields @{ reason = 'bare-pi-observed'; pid = $p.ProcessId }
		}

		# ── launcher / node / cli 解析（缺任一在 spawn 前退出）─────────────
		$wt = Resolve-WtLauncher -Preferred $WtExe
		$nodePath = $NodeExe
		if (-not $nodePath) { try { $nodePath = (Get-Command node -ErrorAction Stop | Select-Object -First 1).Source } catch { $nodePath = $null } }
		$cliPath = Resolve-PiCli -NodePath $(if ($nodePath) { $nodePath } else { '' }) -CliOverride $CliPath

		if (-not $wt -or -not $nodePath -or -not (Test-Path -LiteralPath $nodePath) -or -not $cliPath) {
			$reason = if (-not $wt) { 'launcher-unhealthy' } elseif (-not $nodePath -or -not (Test-Path -LiteralPath "$nodePath")) { 'node-not-found' } else { 'pi-cli-not-found' }
			Write-BootLog -LogPath $log -Phase 'error' -Fields @{ reason = $reason; wt = $wt; node = $nodePath; cli = $cliPath }
			return 1
		}

		$argString = '-w 0 new-tab --title "pi master" --suppressApplicationTitle -d "' + $homePath +
		'" "' + $nodePath + '" "' + $cliPath + '" --session "' + $file.FullName + '"'

		# ── DryRun：不建 claim、不 spawn（自测干跑）───────────────────────
		if ($DryRun) {
			Write-BootLog -LogPath $log -Phase 'dry-run' -Fields @{ ok = $true; sid = $sid; wt = $wt; node = $nodePath; cli = $cliPath; args = $argString }
			return 0
		}

		# ── G1 落 claim（wx 排他创建；别人刚抢到 → fail-closed）────────────
		$init = @{
			version = 1; claimId = $claimId; sid = $sid; spawnAt = (Get-Date).ToString('o')
			file = $file.FullName; fileSize = [int64]$file.Length; wtExe = $wt; pid = $null
		} | ConvertTo-Json -Compress
		$created = $false
		$wxErr = $null
		$fs = $null
		try {
			$fs = [System.IO.File]::Open($claim, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
			$bytes = [System.Text.Encoding]::UTF8.GetBytes($init)
			$fs.Write($bytes, 0, $bytes.Length)
			$created = $true
		} catch { $created = $false; $wxErr = $_.Exception.Message }
		finally { if ($fs) { $fs.Close() } }
		if (-not $created) {
			Write-BootLog -LogPath $log -Phase 'skip' -Fields @{ reason = 'claim-pending'; via = 'wx'; sid = $sid; claimExists = [bool](Test-Path -LiteralPath $claim); error = $wxErr }
			return 0
		}

		# ── spawn（shell:false + env 身份类清理 + cwd=home，无 prompt）──────
		try {
			Start-PiWindow -WtPath $wt -Arguments $argString -WorkingDir $homePath -ScrubKeys (Get-BootEnvScrubKeys)
		} catch {
			Release-OwnClaim -Path $claim -ClaimId $claimId
			Write-BootLog -LogPath $log -Phase 'error' -Fields @{ reason = 'spawn-failed'; error = $_.Exception.Message }
			return 1
		}

		# ── C 确认（0→20s 找恰好一个 holder）────────────────────────────
		$found = @(Wait-HolderConfirmation -Sid $sid -Seconds 20)
		if ($found.Count -eq 1) {
			try {
				$c2 = Get-Content -LiteralPath $claim -Raw | ConvertFrom-Json
				if ($c2.claimId -eq $claimId) {
					$c2.pid = $found[0].ProcessId
					$c2.wtExe = $wt
					[System.IO.File]::WriteAllText($claim, ($c2 | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
				}
			} catch { }
			Write-BootLog -LogPath $log -Phase 'ok' -Fields @{ sid = $sid; pid = $found[0].ProcessId; file = $file.FullName; gen = $att.generation; claimId = $claimId }
			return 0
		}
		if ($found.Count -gt 1) {
			# 防重被绕过/竞态：告警留痕，不自动 kill（人工裁决）
			Write-BootLog -LogPath $log -Phase 'error' -Fields @{ reason = 'dup-detected'; sid = $sid; pids = @($found.ProcessId) }
			return 1
		}
		Write-BootLog -LogPath $log -Phase 'error' -Fields @{ reason = 'spawn-unconfirmed'; sid = $sid; claimId = $claimId }
		return 1   # claim 保留（下次按「可证死」清）
	} catch {
		Release-OwnClaim -Path $claim -ClaimId $claimId
		Write-BootLog -LogPath $log -Phase 'error' -Fields @{ reason = 'internal'; error = $_.Exception.Message }
		return 2
	}
}

# 直接执行才跑主流程；dot-source 仅供自测注入桩（Get-NodeProcessList / Start-PiWindow /
# Wait-HolderConfirmation 三点可在调用前重定义）。
if ($MyInvocation.InvocationName -ne '.') {
	exit (Invoke-BootResume -DelaySeconds $DelaySeconds -RuntimeDir $RuntimeDir -SessionsDir $SessionsDir `
			-HomeDir $HomeDir -NodeExe $NodeExe -CliPath $CliPath -WtExe $WtExe -DryRun:$DryRun)
}
