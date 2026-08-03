param(
  [string]$SshTarget = 'ubuntu@35.77.146.49',
  [string]$SshKey = "$env:USERPROFILE\.ssh\LightsailDefaultKey-ap-northeast-1.pem",
  [string]$BridgeUrl = 'https://agent.labcaspian.com/v5-bridge/'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$stable = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $projectRoot 'remote-connector\public\stable.json') | ConvertFrom-Json
$packageRoot = Join-Path $projectRoot ("remote-connector\releases\{0}\Omnia-Agent-v5-Remote-Connector-v{0}-Portable" -f $stable.version)
$canaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('omnia-v5-prod-canary-' + [guid]::NewGuid().ToString('N'))
$installRoot = Join-Path $canaryRoot 'install'
$dataRoot = Join-Path $canaryRoot 'data'
$node = Join-Path $packageRoot 'runtime\node.exe'
$cli = Join-Path $packageRoot 'app\cli.cjs'
$statusPath = Join-Path $dataRoot 'status.json'
$lockPath = Join-Path $dataRoot 'supervisor.lock'
$started = $false

function Invoke-ConnectorCli {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
  & $node $cli @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Portable Remote Connector CLI failed: $($Arguments[0])."
  }
}

try {
  New-Item -ItemType Directory -Path $installRoot, $dataRoot -Force | Out-Null
  $env:OMNIA_V5_REMOTE_CONNECTOR_INSTALL_ROOT = $installRoot
  $env:OMNIA_V5_REMOTE_CONNECTOR_DATA_ROOT = $dataRoot

  Invoke-ConnectorCli start
  $started = $true

  $identityPath = Join-Path $dataRoot 'device-identity.json'
  for ($attempt = 0; $attempt -lt 60 -and -not (Test-Path -LiteralPath $identityPath); $attempt += 1) {
    Start-Sleep -Milliseconds 250
  }
  if (-not (Test-Path -LiteralPath $identityPath)) {
    throw 'Remote Connector did not create its isolated v5 device identity.'
  }
  $identity = Get-Content -Raw -Encoding UTF8 -LiteralPath $identityPath | ConvertFrom-Json

  $env:CANARY_BRIDGE = $BridgeUrl
  $env:CANARY_CONNECTOR_ID = $identity.connectorId
  & (Join-Path $projectRoot 'node_modules\.bin\tsx.cmd') `
    (Join-Path $projectRoot 'scripts\production-remote-shell-canary.ts')
  if ($LASTEXITCODE -ne 0) {
    throw 'Shell production discovery/WSS transport call failed.'
  }

  $connected = $false
  for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
    Start-Sleep -Milliseconds 500
    if (-not (Test-Path -LiteralPath $statusPath)) {
      continue
    }
    try {
      $status = Get-Content -Raw -Encoding UTF8 -LiteralPath $statusPath | ConvertFrom-Json
      if ($status.bridgeState -eq 'connected') {
        $connected = $true
        break
      }
    } catch {
      # The worker replaces this JSON atomically; retry a transient read race.
    }
  }
  if (-not $connected) {
    throw 'Remote Connector did not establish the production WSS session.'
  }

  $credential = Get-Content -Raw -Encoding UTF8 `
    -LiteralPath (Join-Path $dataRoot 'bridge-credential.json') | ConvertFrom-Json
  if ([string]::IsNullOrWhiteSpace($credential.tokenCiphertext)) {
    throw 'DPAPI credential ciphertext was not persisted.'
  }
  if ($credential.PSObject.Properties.Name -contains 'token') {
    throw 'A plaintext token was persisted.'
  }

  Write-Output '{"productionBridgeCanary":true,"portableConnectorPaired":true,"dpapiPersisted":true,"shellRemoteStatusCall":true}'
} finally {
  $env:CANARY_CONNECTOR_ID = $null
  $env:CANARY_BRIDGE = $null
  if ($started) {
    try {
      Invoke-ConnectorCli stop
      for ($attempt = 0; $attempt -lt 60 -and (Test-Path -LiteralPath $lockPath); $attempt += 1) {
        Start-Sleep -Milliseconds 500
      }
    } catch {
      Write-Warning $_
    }
  }

  $env:OMNIA_V5_REMOTE_CONNECTOR_INSTALL_ROOT = $null
  $env:OMNIA_V5_REMOTE_CONNECTOR_DATA_ROOT = $null
  $resolvedCanary = [System.IO.Path]::GetFullPath($canaryRoot)
  $resolvedTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  if (
    $resolvedCanary.StartsWith($resolvedTemp, [System.StringComparison]::OrdinalIgnoreCase) -and
    (Split-Path -Leaf $resolvedCanary).StartsWith('omnia-v5-prod-canary-')
  ) {
    Remove-Item -Recurse -Force -LiteralPath $resolvedCanary -ErrorAction SilentlyContinue
  }
}
