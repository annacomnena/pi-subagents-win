<#
open-master.ps1 —— 一键打开 / 切回 global Master 会话（给「双击」用，不需要手写命令）

行为（幂等 + **fail-closed**，绝不双开）：
  1) 先在「master 是否已在运行」上做多重取证（见下）；
  2) 有任一证据 → 判定在运行：把它的 Windows Terminal 窗口切到前台（找不到就报证据）；
  3) 全无证据 → 复用 scripts\boot-resume-master.ps1（含 P1-P6 + G1/G2/G3 三层防重）
     在新 WT 标签（标题 pi master）里恢复 master 会话。

为什么不用「进程命令行含 sid」单条判据：
  `--session` 启动的会话，sid 在命令行里；但 **launch-tabs 派发的标签页会话不会把 sid 写进命令行**
  （命令行只有 `--tab-run-id <runId>` + 提示文件），且 pi 也不长期持有会话文件句柄
  → 单靠命令行/sessionAlive 会**假阴性并双开**。故本脚本叠加了 claim 锁、心跳、tab-run 记录三类取证。

取证项（任一命中即认为在运行）：
  E1 node.exe 命令行含 master sid（覆盖 `--session` 形态）
  E2 state\boot-resume.lock 存在且其 pid 仍活着（脚本自己 spawn 的形态）
  E3 timers\sessions\<sid>.json 心跳新鲜（默认 <60s；覆盖非标签页活跃形态）
  E4 tab-runs 里存在「cwd=home 且 title 以 master/… 开头」且 paired state 非终态的标签页记录
     （覆盖本题的**标签页型 master** —— 命令行里看不到 sid 的那种）

参数：
  -DelaySeconds <int>  未运行时，boot-resume 的延迟秒数（默认 0 = 立即）
  -DryRun              只取证并报告「会做什么」，不切窗口、不启动
  -NoPopup             不弹窗，改写标准输出
  -ForceSpawn          跳过取证强行 spawn（**危险**：可能双开；仅在确认 master 没在跑时用）
  -RuntimeDir/-TabRunsDir/-HomeDir  测试/排障注入

退出码：0 = 成功 / 已在运行（已切窗口）；1 = 失败（缺 attachment / 缺脚本 / spawn 失败）；
        3 = 取证判定「疑似已在运行」→ 拒绝 spawn（fail-closed）
#>
param(
	[int]$DelaySeconds = 0,
	[string]$RuntimeDir = '',
	[string]$TabRunsDir = '',
	[string]$HomeDir = '',
	[switch]$DryRun,
	[switch]$NoPopup,
	[switch]$ForceSpawn
)

$ErrorActionPreference = 'Continue'

$root   = Split-Path -Parent $PSScriptRoot
$userPf = if ($HomeDir) { $HomeDir } else { [Environment]::GetFolderPath('UserProfile') }
$rt     = if ($RuntimeDir) { $RuntimeDir } else { Join-Path $userPf '.pi\agent\runtime' }
$tabs   = if ($TabRunsDir) { $TabRunsDir } else { Join-Path $userPf '.pi\agent\tab-runs' }
$att    = Join-Path $rt 'registry\attachments\agent___master_default.json'
$log    = Join-Path $rt 'state\boot-autostart.log'
$claim  = Join-Path $rt 'state\boot-resume.lock'
$resume = Join-Path $PSScriptRoot 'boot-resume-master.ps1'
$hbDir  = Join-Path $userPf '.pi\agent\timers\sessions'

function Say([string]$text, [int]$icon = 64) {
	if ($NoPopup) { Write-Output $text; return }
	try {
		$ws = New-Object -ComObject WScript.Shell
		[void]$ws.Popup($text, 25, '打开 Master', $icon)
	} catch { Write-Output $text }
}

# ── 1. attachment → master sid（不硬编码）────────────────────────────
$sid = $null
try {
	if (Test-Path -LiteralPath $att) {
		$sid = [string](Get-Content -LiteralPath $att -Raw -Encoding UTF8 | ConvertFrom-Json).sessionId
	}
} catch { }
if (-not $sid -or $sid -eq 'unknown') {
	Say "找不到 master 归属：attachment 缺失或尚未 attach。`n`n文件：$att`n`n请先在有权限的会话里执行 /master-attach 接管。" 48
	exit 1
}
$sidShort = $sid.Substring(0, [Math]::Min(12, $sid.Length))

# ── 2. 多重取证 ──────────────────────────────────────────────────────
$ev = New-Object System.Collections.ArrayList

# E1：node.exe 命令行含 sid
$holderPids = @()
try {
	$holderPids = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
		Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($sid, [StringComparison]::OrdinalIgnoreCase) -ge 0 } |
		ForEach-Object { $_.ProcessId })
} catch { }
if ($holderPids.Count -gt 0) { [void]$ev.Add("E1 进程命令行含 sid（pid $($holderPids -join ', ')）") }

# E2：boot-resume claim 且 pid 活着
try {
	if (Test-Path -LiteralPath $claim) {
		$c = Get-Content -LiteralPath $claim -Raw -Encoding UTF8 | ConvertFrom-Json
		if ($c.pid -and (Get-Process -Id $c.pid -ErrorAction SilentlyContinue)) {
			[void]$ev.Add("E2 boot-resume.lock 的 pid $($c.pid) 仍存活")
		}
	}
} catch { }

# E3：心跳新鲜
try {
	$hb = Join-Path $hbDir "$sid.json"
	if (Test-Path -LiteralPath $hb) {
		$h = Get-Content -LiteralPath $hb -Raw -Encoding UTF8 | ConvertFrom-Json
		if ($h.lastActiveAt) {
			$age = ([DateTime]::UtcNow - [DateTime]::Parse($h.lastActiveAt).ToUniversalTime()).TotalSeconds
			if ($age -lt 60) { [void]$ev.Add(("E3 心跳新鲜（{0:N0}s 前）" -f $age)) }
		}
	}
} catch { }

# E4：tab-runs 里的「标签页型 master」（cwd=home 且标题以 master- 开头，paired state 非终态）
try {
	if (Test-Path -LiteralPath $tabs) {
		foreach ($f in @(Get-ChildItem -LiteralPath $tabs -Filter '*.json' -File -ErrorAction SilentlyContinue)) {
			if ($f.Name -like '*.state.json' -or $f.Name -like '*.result.json') { continue }
			try {
				$m = Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
				if (-not $m.cwd -or -not $m.title) { continue }
				if ([string]$m.cwd -ne $userPf) { continue }
				if ([string]$m.title -notmatch '(?i)^(master|pi master|transfer|succession)') { continue }
				$stPath = $f.FullName -replace '\.json$', '.state.json'
				$terminal = $false
				if (Test-Path -LiteralPath $stPath) {
					$st = Get-Content -LiteralPath $stPath -Raw -Encoding UTF8 | ConvertFrom-Json
					$terminal = [bool]$st.terminal
				}
				if (-not $terminal) { [void]$ev.Add("E4 tab-run $($f.BaseName) 是非终态标签页且标题以 master 开头（$($m.title)）") }
			} catch { }
		}
	}
} catch { }

# ── 3. 判定 ──────────────────────────────────────────────────────────
if ($ev.Count -gt 0 -and -not $ForceSpawn) {
	$txt = ($ev -join "`n  • ")
	if ($DryRun) {
		Say "[dry-run] 取证判定 master **疑似已在运行**（sid=$sidShort）：`n  • $txt`n`n→ 会尝试把它的 WT 窗口切到前台，不新开。"
		exit 0
	}

	$script:omFound = [IntPtr]::Zero
	$focused = $false
	try {
		Add-Type @'
using System;using System.Text;using System.Runtime.InteropServices;
public class OmWin {
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
 public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int c);
}
'@
		$cb = [OmWin+EnumWindowsProc] {
			param($h, $l)
			try {
				if ([OmWin]::IsWindowVisible($h)) {
					$c = New-Object Text.StringBuilder 128
					[void][OmWin]::GetClassNameW($h, $c, 128)
					if ($c.ToString() -eq 'CASCADIA_HOSTING_WINDOW_CLASS') {
						$t = New-Object Text.StringBuilder 256
						[void][OmWin]::GetWindowTextW($h, $t, 256)
						if ($t.ToString() -match '(?i)master') { $script:omFound = $h; return $false }
					}
				}
			} catch { }
			return $true
		}
		[void][OmWin]::EnumWindows($cb, [IntPtr]::Zero)
		if ($script:omFound -ne [IntPtr]::Zero) {
			[void][OmWin]::ShowWindowAsync($script:omFound, 9)   # SW_RESTORE
			[void][OmWin]::SetForegroundWindow($script:omFound)
			$focused = $true
		}
	} catch { }

	if ($focused) {
		Say "master 已在运行（没有重复打开）。`n已切到它的窗口。`n`n取证：`n  • $txt"
	} else {
		Say "master 疑似已在运行（没有重复打开）。`n`n取证：`n  • $txt`n`n没找到可切换的窗口 —— 请在 Windows Terminal 里找标题含 pi master 或 master- 的标签。`n若确认它其实已经关了，可用 -ForceSpawn 强制打开。" 48
	}
	exit 0
}

# ── 4. 无证据 → 复用 boot-resume 打开 ────────────────────────────────
if (-not (Test-Path -LiteralPath $resume)) {
	Say "缺少启动脚本：`n$resume" 16
	exit 1
}
if ($DryRun) {
	Say ("[dry-run] 取证均无命中 → master 未运行（sid=$sidShort）。会执行：`n`n" +
		"powershell -NoProfile -ExecutionPolicy Bypass -File " + $resume + " -DelaySeconds $DelaySeconds" +
		"`n`n（在新 WT 标签 pi master 里恢复该会话）")
	exit 0
}

$before = 0
try { $before = @(Get-Content -LiteralPath $log -Encoding UTF8 -ErrorAction SilentlyContinue).Count } catch { }

$code = 1
try {
	$psArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $resume, '-DelaySeconds', "$DelaySeconds")
	$p = Start-Process -FilePath 'powershell.exe' -ArgumentList $psArgs -WindowStyle Hidden -PassThru -Wait
	$code = $p.ExitCode
} catch {
	Say "启动失败：$($_.Exception.Message)" 16
	exit 1
}

$newLines = @()
try { $newLines = @(Get-Content -LiteralPath $log -Encoding UTF8 -ErrorAction SilentlyContinue | Select-Object -Skip $before) } catch { }
$last = if ($newLines.Count -gt 0) { $newLines[-1] } else { '(日志无新增)' }

if ($code -eq 0 -and $last -match '"phase":"ok"') {
	Say "已打开 master —— 请在 Windows Terminal 里看标题为 pi master 的标签。"
} elseif ($code -eq 0) {
	Say "没有新开窗口（按设计跳过）。`n`n$last" 48
} else {
	Say "打开失败（exit $code）。`n`n$last" 16
}
exit $code
