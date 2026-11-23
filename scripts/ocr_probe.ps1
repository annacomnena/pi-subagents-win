# Windows 内置 OCR 验证（Windows PowerShell 5.1 + WinRT）
# 实测要点：
#   1) 必须用 Windows PowerShell 5.1（pwsh 7 的 WinRT 投影已坏，AsTask 反射直接抛 not supported）
#   2) 目录/文件路径不要踩 PS 5.1 类型解析的坑：**不要**用 New-Object Windows.Globalization.Language，
#      实测在 PS 5.1 里那一行会让后续 [Windows.Media.Ocr.OcrEngine] 解析失败（TypeNotFound）。
#      改用 TryCreateFromUserProfileLanguages()（本机语言已是 zh-Hans-CN）。
# 用法: powershell -ExecutionPolicy Bypass -File ocr_probe.ps1 -ImagePath <png> [-OutFile <txt>]
param([string]$ImagePath, [string]$OutFile = "")

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.FileAccessMode, Windows.Foundation, ContentType = WindowsRuntime]

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($op, $resultType) {
    $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($op))
    $task.Wait(-1) | Out-Null
    $task.Result
}

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (-not $engine) { Write-Output 'ENGINE_FAIL'; exit 1 }

$file    = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
$stream  = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap  = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine("LANG=" + $engine.RecognizerLanguage.LanguageTag)
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
[void]$sb.AppendLine("LINES=" + $result.Lines.Count)
foreach ($line in $result.Lines) { [void]$sb.AppendLine("T|" + $line.Text) }

$text = $sb.ToString()
if ($OutFile -ne "") {
    [System.IO.File]::WriteAllText($OutFile, $text, (New-Object System.Text.UTF8Encoding $false))
    Write-Output ("WROTE=" + $OutFile + " BYTES=" + (Get-Item $OutFile).Length)
} else {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    Write-Output $text
}
