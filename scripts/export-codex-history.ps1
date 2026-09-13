param(
  [Parameter(Mandatory = $true)]
  [string]$SourcePath,
  [string]$OutputDirectory = "docs/ai-history"
)

$ErrorActionPreference = "Stop"
$sourcePathResolved = (Resolve-Path -LiteralPath $SourcePath).Path
$outputRoot = (Resolve-Path -LiteralPath $OutputDirectory).Path
$exportsDirectory = Join-Path $outputRoot "exports"
New-Item -ItemType Directory -Force -Path $exportsDirectory | Out-Null

$stream = [System.IO.File]::Open(
  $sourcePathResolved,
  [System.IO.FileMode]::Open,
  [System.IO.FileAccess]::Read,
  [System.IO.FileShare]::ReadWrite
)
try {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hash = ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
} finally {
  $stream.Dispose()
}
$sessionId = [System.IO.Path]::GetFileNameWithoutExtension($sourcePathResolved)
$messages = New-Object System.Collections.Generic.List[object]

foreach ($line in Get-Content -Encoding UTF8 -LiteralPath $sourcePathResolved) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  try {
    $row = $line | ConvertFrom-Json
  } catch {
    continue
  }
  if ($row.type -ne "response_item") { continue }
  $payload = $row.payload
  if ($payload.type -ne "message" -or ($payload.role -ne "user" -and $payload.role -ne "assistant")) { continue }

  $parts = @()
  foreach ($part in @($payload.content)) {
    if ($part.text) { $parts += [string]$part.text }
  }
  $text = ($parts -join "`n").Trim()
  if (-not $text) { continue }

  if ($payload.role -eq "user") {
    if ($text -match '^<environment_context>') { continue }
    if ($text -match '^<subagent_notification>') { continue }
    if ($text.Length -lt 10) { continue }
  } else {
    if ($text.Length -lt 180) { continue }
    if ($text -match '^I (will|am going to|continue)' -and $text.Length -lt 350) { continue }
    if ($text -match '^Status:') { continue }
  }

  $messages.Add([pscustomobject]@{
    session_id = $sessionId
    timestamp = [string]$row.timestamp
    role = [string]$payload.role
    text = $text
  })
}

$jsonlPath = Join-Path $exportsDirectory "codex-session-curated.jsonl"
$jsonLines = $messages | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 20 }
[System.IO.File]::WriteAllLines($jsonlPath, $jsonLines, [System.Text.UTF8Encoding]::new($false))

$markdownPath = Join-Path $outputRoot "0016-codex-conversation-export.md"
$markdown = New-Object System.Collections.Generic.List[string]
$markdown.Add("# Codex AI Collaboration Conversation Export")
$markdown.Add("")
$markdown.Add("> Source: Codex Desktop session JSONL")
$markdown.Add("> Session ID: ``$sessionId``")
$markdown.Add("> SHA-256: ``$hash``")
$markdown.Add("> Export script: ``scripts/export-codex-history.ps1``")
$markdown.Add("")
$markdown.Add("This export keeps substantive user and assistant messages related to product design, architecture, implementation, bug fixes, tests, and commits. System context, tool output, repeated status messages, greetings, and sub-agent notifications are filtered out.")
$markdown.Add("")

$index = 0
foreach ($message in $messages) {
  $index++
  $role = if ($message.role -eq "user") { "USER" } else { "AI" }
  $markdown.Add("## $index. $role - $($message.timestamp)")
  $markdown.Add("")
  $markdown.Add($message.text)
  $markdown.Add("")
}
[System.IO.File]::WriteAllLines($markdownPath, $markdown, [System.Text.UTF8Encoding]::new($false))

Write-Output "source=$sourcePathResolved"
Write-Output "sha256=$hash"
Write-Output "messages=$($messages.Count)"
Write-Output "jsonl=$jsonlPath"
Write-Output "markdown=$markdownPath"