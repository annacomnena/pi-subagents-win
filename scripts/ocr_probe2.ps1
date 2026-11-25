# Windows 内置 OCR v2：带词边界框（供表格结构重建用）
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File ocr_probe2.ps1 -ImagePath <png> -OutFile <txt>
# 输出格式（TSV）: L<TAB>lineIndex<TAB>x<TAB>y<TAB>w<TAB>h<TAB>text
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

$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine("# LANG=" + $engine.RecognizerLanguage.LanguageTag + " LINES=" + $result.Lines.Count)
$li = 0
foreach ($line in $result.Lines) {
    foreach ($w in $line.Words) {
        $r = $w.BoundingRect
        [void]$sb.AppendLine("L`t$li`t" + [int]$r.X + "`t" + [int]$r.Y + "`t" + [int]$r.Width + "`t" + [int]$r.Height + "`t" + $w.Text)
    }
    $li++
}

$text = $sb.ToString()
if ($OutFile -ne "") {
    [System.IO.File]::WriteAllText($OutFile, $text, (New-Object System.Text.UTF8Encoding $false))
    Write-Output ("WROTE=" + $OutFile + " BYTES=" + (Get-Item $OutFile).Length + " WORDS_ROWS=" + ($li))
} else {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    Write-Output $text
}
