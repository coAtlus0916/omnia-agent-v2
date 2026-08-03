param(
  [string]$FromVersion = '0.3.3',
  [string]$ToVersion = '0.3.4',
  [int]$ExpectedSequence = 7
)

$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$old = Join-Path $project ("remote-connector\releases\{0}\Omnia-Agent-v5-Remote-Connector-v{0}-Portable" -f $FromVersion)
$upgradeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('omnia-v5-auto-upgrade-' + [guid]::NewGuid().ToString('N'))
$installRoot = Join-Path $upgradeRoot 'install'
$dataRoot = Join-Path $upgradeRoot 'data'
$node = Join-Path $old 'runtime\node.exe'
$cli = Join-Path $old 'app\cli.cjs'
$started = $false
$succeeded = $false

try {
  $env:OMNIA_V5_REMOTE_CONNECTOR_INSTALL_ROOT = $installRoot
  $env:OMNIA_V5_REMOTE_CONNECTOR_DATA_ROOT = $dataRoot
  & $node $cli start
  if ($LASTEXITCODE -ne 0) { throw 'Old portable failed to start.' }
  $started = $true
  $statePath = Join-Path $dataRoot 'managed-state.json'
  $statusPath = Join-Path $dataRoot 'status.json'
  $upgraded = $false
  for ($attempt = 0; $attempt -lt 1200; $attempt += 1) {
    Start-Sleep -Milliseconds 500
    if (-not (Test-Path -LiteralPath $statePath) -or -not (Test-Path -LiteralPath $statusPath)) { continue }
    try {
      $state = Get-Content -Raw -Encoding UTF8 -LiteralPath $statePath | ConvertFrom-Json
      $status = Get-Content -Raw -Encoding UTF8 -LiteralPath $statusPath | ConvertFrom-Json
      if (
        $state.current -eq $ToVersion -and
        $state.previous -eq $FromVersion -and
        $state.highestSequence -eq $ExpectedSequence -and
        $status.version -eq $ToVersion
      ) {
        $upgraded = $true
        break
      }
    } catch { }
  }
  if (-not $upgraded) { throw "Automatic update did not promote $ToVersion within the acceptance window." }
  $succeeded = $true
  @{
    ok = $true
    from = $FromVersion
    to = $state.current
    previous = $state.previous
    highestSequence = $state.highestSequence
    pending = $state.pending
    activeOperations = $status.activeOperations
    uncertainOperations = $status.uncertainOperations
  } | ConvertTo-Json -Compress
} finally {
  if (-not $succeeded) {
    $supervisorLog = Join-Path $dataRoot 'logs\supervisor.jsonl'
    if (Test-Path -LiteralPath $supervisorLog) {
      Get-Content -Encoding UTF8 -LiteralPath $supervisorLog -Tail 20 | Write-Warning
    }
  }
  if ($started) {
    & $node $cli stop | Out-Null
    $lock = Join-Path $dataRoot 'supervisor.lock'
    for ($attempt = 0; $attempt -lt 60 -and (Test-Path -LiteralPath $lock); $attempt += 1) {
      Start-Sleep -Milliseconds 250
    }
  }
  $env:OMNIA_V5_REMOTE_CONNECTOR_INSTALL_ROOT = $null
  $env:OMNIA_V5_REMOTE_CONNECTOR_DATA_ROOT = $null
  $resolved = [System.IO.Path]::GetFullPath($upgradeRoot)
  $temp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  if (
    $resolved.StartsWith($temp, [StringComparison]::OrdinalIgnoreCase) -and
    (Split-Path -Leaf $resolved).StartsWith('omnia-v5-auto-upgrade-')
  ) {
    Remove-Item -Recurse -Force -LiteralPath $resolved -ErrorAction SilentlyContinue
  }
}
