param(
  [Parameter(Position = 0)]
  [string]$PortableRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Resolve-ValidatedPortableRoot {
  param([string]$Candidate)

  if ([string]::IsNullOrWhiteSpace($Candidate)) {
    throw '便携包目录不能为空。'
  }
  $resolved = [System.IO.Path]::GetFullPath($Candidate)
  if (-not (Test-Path -LiteralPath $resolved -PathType Container)) {
    throw "便携包目录不存在：$resolved"
  }
  $sentinelPath = Join-Path $resolved 'portable-root.json'
  if (-not (Test-Path -LiteralPath $sentinelPath -PathType Leaf)) {
    throw "所选目录不是 Omnia Agent v5 便携包根目录（缺少 portable-root.json）：$resolved"
  }
  try {
    $sentinel = Get-Content -LiteralPath $sentinelPath -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    throw "portable-root.json 无法读取：$($_.Exception.Message)"
  }
  if (
    $sentinel.schemaVersion -ne 'omnia.portable-product-root/v1' -or
    $sentinel.product -ne 'omnia-agent-v5' -or
    [int]$sentinel.formatVersion -ne 1
  ) {
    throw "所选目录不是受支持的 Omnia Agent v5 便携包：$resolved"
  }
  return $resolved
}

function Find-PortableRoot {
  $searchBases = @(
    $PSScriptRoot,
    (Split-Path -Parent $PSScriptRoot),
    (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
  )
  $candidatePaths = [System.Collections.Generic.List[string]]::new()
  foreach ($base in $searchBases) {
    if ([string]::IsNullOrWhiteSpace($base) -or -not (Test-Path -LiteralPath $base -PathType Container)) {
      continue
    }
    $candidatePaths.Add($base)
    $matchingChildren = @(Get-ChildItem -LiteralPath $base -Directory -Filter 'omnia-agent-v5-portable-*' -ErrorAction SilentlyContinue)
    foreach ($matchingChild in $matchingChildren) {
      $candidatePaths.Add($matchingChild.FullName)
      # Windows "Extract All" may add a directory around the ZIP's own top-level directory.
      Get-ChildItem -LiteralPath $matchingChild.FullName -Directory -Filter 'omnia-agent-v5-portable-*' -ErrorAction SilentlyContinue |
        ForEach-Object { $candidatePaths.Add($_.FullName) }
    }
  }

  $valid = [System.Collections.Generic.List[string]]::new()
  foreach ($candidate in $candidatePaths) {
    try {
      $resolved = Resolve-ValidatedPortableRoot -Candidate $candidate
      if (-not ($valid | Where-Object { $_.Equals($resolved, [System.StringComparison]::OrdinalIgnoreCase) })) {
        $valid.Add($resolved)
      }
    } catch {
      # Discovery ignores unrelated directories. Explicit paths still fail loudly.
    }
  }

  if ($valid.Count -eq 0) {
    throw '没有在安装包旁找到 Omnia Agent v5 便携包。请把两个 ZIP 解压到同一目录，或把便携包根目录作为参数传给 InstallFeature.cmd。'
  }
  if ($valid.Count -gt 1) {
    $choices = $valid -join [Environment]::NewLine
    throw "找到多个 Omnia Agent v5 便携包，无法安全判断安装目标。请把目标根目录作为参数传给 InstallFeature.cmd：$([Environment]::NewLine)$choices"
  }
  return $valid[0]
}

function Assert-AgentClosed {
  param([string]$Root)

  $rootPrefix = $Root.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
  $possiblyRunning = @(Get-Process -Name 'Omnia Agent v5' -ErrorAction SilentlyContinue)
  foreach ($process in $possiblyRunning) {
    $processPath = $null
    try { $processPath = $process.Path } catch { }
    if (
      [string]::IsNullOrWhiteSpace($processPath) -or
      $processPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)
    ) {
      throw 'Omnia Agent v5 仍在运行。请先完全关闭程序，再重新运行安装脚本。'
    }
  }
}

function Resolve-ActiveRelease {
  param([string]$Root)

  $currentPath = Join-Path $Root 'current'
  if (-not (Test-Path -LiteralPath $currentPath -PathType Leaf)) {
    throw "便携包缺少当前版本指针：$currentPath"
  }
  try {
    $current = Get-Content -LiteralPath $currentPath -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    throw "当前版本指针无法读取：$($_.Exception.Message)"
  }
  if ($current.schemaVersion -ne 'omnia.active-release/v1' -or [string]::IsNullOrWhiteSpace([string]$current.relativePath)) {
    throw '便携包当前版本指针格式不受支持。'
  }

  $release = [System.IO.Path]::GetFullPath((Join-Path $Root ([string]$current.relativePath)))
  $rootPrefix = $Root.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
  if (-not $release.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw '便携包当前版本指针越出了便携包目录。'
  }
  if (-not (Test-Path -LiteralPath $release -PathType Container)) {
    throw "便携包当前版本不存在：$release"
  }
  return $release
}

function Invoke-EmbeddedFeatureInstaller {
  param(
    [string]$Electron,
    [string]$Installer,
    [string]$Root,
    [string]$FeaturePackage
  )

  # PowerShell 5 can leave $LASTEXITCODE unset for this GUI-subsystem executable,
  # so read the child process ExitCode directly and never infer success from output.
  $arguments = @($Installer, '--root', $Root, 'install', $FeaturePackage) |
    ForEach-Object { '"' + ([string]$_).Replace('"', '\"') + '"' }
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $Electron
  $startInfo.Arguments = $arguments -join ' '
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  if (-not $process.Start()) {
    throw '无法启动便携包内置 Feature 安装器。'
  }
  try {
    $process.WaitForExit()
    return $process.ExitCode
  } finally {
    $process.Dispose()
  }
}

try {
  $targetRoot = if ([string]::IsNullOrWhiteSpace($PortableRoot)) {
    Find-PortableRoot
  } else {
    Resolve-ValidatedPortableRoot -Candidate $PortableRoot
  }

  Assert-AgentClosed -Root $targetRoot
  $activeRelease = Resolve-ActiveRelease -Root $targetRoot
  $electron = Join-Path $activeRelease 'Omnia Agent v5.exe'
  $installer = Join-Path $activeRelease 'resources\app\dist\tools\feature-installer.cjs'
  $featurePackage = Join-Path $PSScriptRoot 'delete-elements-__FEATURE_VERSION__.ofp'
  foreach ($requiredFile in @($electron, $installer, $featurePackage)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
      throw "安装所需文件不存在：$requiredFile"
    }
  }

  $hadElectronRunAsNode = Test-Path Env:ELECTRON_RUN_AS_NODE
  $previousElectronRunAsNode = $env:ELECTRON_RUN_AS_NODE
  try {
    $env:ELECTRON_RUN_AS_NODE = '1'
    $installerExitCode = Invoke-EmbeddedFeatureInstaller `
      -Electron $electron `
      -Installer $installer `
      -Root $targetRoot `
      -FeaturePackage $featurePackage
  } finally {
    if ($hadElectronRunAsNode) {
      $env:ELECTRON_RUN_AS_NODE = $previousElectronRunAsNode
    } else {
      Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    }
  }
  if ($installerExitCode -ne 0) {
    throw "便携包内置 Feature 安装器返回错误码 $installerExitCode。删除元素 Feature 未安装。"
  }

  Write-Host "[安装成功] 删除元素 Feature __FEATURE_VERSION__ 已安装到：$targetRoot"
  exit 0
} catch {
  [Console]::Error.WriteLine("[安装失败] $($_.Exception.Message)")
  exit 1
}
