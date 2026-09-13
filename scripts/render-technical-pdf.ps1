param(
  [string]$InputHtml = "docs/submission/technical-document.html",
  [string]$OutputPdf = "artifacts/submission/Nexus-Decision-Arena-Technical-Document.pdf"
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$inputPath = (Resolve-Path (Join-Path $repoRoot $InputHtml)).Path
$outputPath = Join-Path $repoRoot $OutputPdf
$outputDirectory = Split-Path -Parent $outputPath

if (-not (Test-Path $outputDirectory)) {
  New-Item -ItemType Directory -Path $outputDirectory | Out-Null
}

$browserCandidates = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
)

$browser = $browserCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) {
  throw "Chrome or Edge was not found. Install one browser and rerun this script."
}

$htmlUri = [System.Uri]::new($inputPath).AbsoluteUri
$browserArguments = @(
  "--headless=new",
  "--disable-gpu",
  "--allow-file-access-from-files",
  "--no-pdf-header-footer",
  "--virtual-time-budget=5000",
  "--print-to-pdf=$outputPath",
  $htmlUri
)

& $browser @browserArguments | Out-Null

if (-not (Test-Path $outputPath)) {
  throw "PDF rendering failed: output file was not created."
}

$pdf = Get-Item $outputPath
Write-Output "Rendered: $($pdf.FullName)"
Write-Output "Size: $($pdf.Length) bytes"
