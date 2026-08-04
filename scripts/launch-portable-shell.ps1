param(
  [Parameter(Mandatory = $true)]
  [string]$ProductRoot,
  [switch]$ResolveOnly
)

$ErrorActionPreference = 'Stop'

try {
  $root = [System.IO.Path]::GetFullPath($ProductRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
  $markerPath = Join-Path $root 'portable-root.json'
  $marker = Get-Content -Raw -LiteralPath $markerPath | ConvertFrom-Json
  if (
    $marker.schemaVersion -ne 'omnia.portable-product-root/v1' -or
    $marker.product -ne 'omnia-agent-v5' -or
    [int]$marker.formatVersion -ne 1
  ) {
    throw "The selected directory is not an Omnia Agent v5 portable root: $root"
  }

  $currentPath = Join-Path $root 'current'
  $current = Get-Content -Raw -LiteralPath $currentPath | ConvertFrom-Json
  if ($current.schemaVersion -ne 'omnia.active-release/v1' -or [string]::IsNullOrWhiteSpace([string]$current.version)) {
    throw "The active release pointer is invalid: $currentPath"
  }

  $releaseRelativePath = [string]$current.relativePath
  if ([string]::IsNullOrWhiteSpace($releaseRelativePath)) {
    throw "The active release pointer does not contain a relativePath: $currentPath"
  }
  $releaseRoot = [System.IO.Path]::GetFullPath((Join-Path $root $releaseRelativePath))
  $rootPrefix = $root + [System.IO.Path]::DirectorySeparatorChar
  if (-not $releaseRoot.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "The active release pointer escapes the portable root: $releaseRelativePath"
  }

  $manifestPath = Join-Path $releaseRoot 'release-manifest.json'
  $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
  if (
    $manifest.schemaVersion -ne 'omnia.shell-release/v1' -or
    $manifest.product -ne 'omnia-agent-v5-shell' -or
    [string]$manifest.version -ne [string]$current.version
  ) {
    throw "The active release manifest does not match current: $manifestPath"
  }

  $executable = Join-Path $releaseRoot 'Omnia Agent v5.exe'
  if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw "The active Omnia Agent executable is missing: $executable"
  }

  # Development/product hot path: the launcher is stable while the current
  # workspace dist and builtin Feature packages are rebuilt in place. The
  # active packaged runtime keeps the same Windows data-protection identity.
  $sourceRoot = [System.IO.Path]::GetFullPath((Join-Path $root '..'))
  $sourcePackagePath = Join-Path $sourceRoot 'package.json'
  $buildScript = Join-Path $sourceRoot 'scripts\build.mjs'
  $hotSourceAvailable = $false
  if (
    (Test-Path -LiteralPath $sourcePackagePath -PathType Leaf) -and
    (Test-Path -LiteralPath $buildScript -PathType Leaf)
  ) {
    $sourcePackage = Get-Content -Raw -LiteralPath $sourcePackagePath | ConvertFrom-Json
    $hotSourceAvailable = [string]$sourcePackage.name -eq 'omnia-agent-v5-shell'
  }

  if ($hotSourceAvailable) {
    if ($ResolveOnly) {
      Write-Output $executable
      exit 0
    }
    $node = Get-Command node.exe -ErrorAction Stop
    Push-Location $sourceRoot
    try {
      & $node.Source $buildScript
      if ($LASTEXITCODE -ne 0) { throw "Current workspace build failed with exit code $LASTEXITCODE." }
    } finally {
      Pop-Location
    }
    $env:OMNIA_AGENT_PRODUCT_ROOT = $root
    $env:OMNIA_AGENT_HOT_ROOT = $sourceRoot
    Start-Process -FilePath $executable -WorkingDirectory $root | Out-Null
    exit 0
  }

  if ($ResolveOnly) {
    Write-Output $executable
    exit 0
  }

  $env:OMNIA_AGENT_PRODUCT_ROOT = $root
  Start-Process -FilePath $executable -WorkingDirectory $root | Out-Null
  exit 0
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
