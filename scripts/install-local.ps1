<#
.SYNOPSIS
  dsh-memory-inherit 一键本地安装（Windows）。

.DESCRIPTION
  把插件装进指定的 DSH profile：加依赖、加进 dsh.profile.bundles、把文件放进 node_modules。
  不会碰你的会话、配置或其它插件；改 package.json 之前会先备份。

.EXAMPLE
  # 解压 zip 之后，在解压出来的目录里直接跑（不用给参数）
  powershell -ExecutionPolicy Bypass -File .\install-local.ps1

.EXAMPLE
  # 拿到的是 .tgz
  powershell -ExecutionPolicy Bypass -File .\install-local.ps1 -Tarball .\dsh-memory-inherit-0.1.0.tgz

.EXAMPLE
  # 拿到的是源码目录
  powershell -ExecutionPolicy Bypass -File .\install-local.ps1 -Source D:\code\dsh-memory-inherit

.NOTES
  装完要重启 DSH 才会加载。卸载：删掉 node_modules\dsh-memory-inherit、
  从 package.json 里去掉依赖和 bundles 里那一项。
#>
[CmdletBinding(DefaultParameterSetName = 'Tarball')]
param(
  [Parameter(ParameterSetName = 'Tarball')]
  [string]$Tarball = '',

  [Parameter(ParameterSetName = 'Source')]
  [string]$Source = '',

  [string]$DshHome = '',
  [string]$Profile = 'desktop'
)

$ErrorActionPreference = 'Stop'
$PackageName = 'dsh-memory-inherit'

function Write-Step($message) { Write-Host "==> $message" -ForegroundColor Cyan }
function Write-Ok($message) { Write-Host "  OK  $message" -ForegroundColor Green }
function Write-Warn2($message) { Write-Host "  !!  $message" -ForegroundColor Yellow }

# --- 1. 定位 DSH_HOME 与 profile ---
if ([string]::IsNullOrWhiteSpace($DshHome)) {
  if (-not [string]::IsNullOrWhiteSpace($env:DSH_HOME)) { $DshHome = $env:DSH_HOME }
  else { $DshHome = Join-Path $env:USERPROFILE '.dsh' }
}
$profileDir = Join-Path $DshHome "profiles\$Profile"
$pkgPath = Join-Path $profileDir 'package.json'
Write-Step "DSH_HOME = $DshHome"
if (-not (Test-Path $pkgPath)) {
  throw "找不到 profile：$pkgPath`n（先用 DSH 打开一次，或加 -Profile <名字> 指定别的 profile）"
}
Write-Ok "找到 profile: $profileDir"

# --- 2. 确认来源：显式参数 > 脚本自己所在的目录 > 当前目录里的 tgz ---
$EffectiveSource = $Source
$EffectiveTarball = $Tarball
if ([string]::IsNullOrWhiteSpace($EffectiveSource) -and [string]::IsNullOrWhiteSpace($EffectiveTarball)) {
  if (Test-Path (Join-Path $PSScriptRoot 'package.json')) {
    $EffectiveSource = $PSScriptRoot
    Write-Ok '没给参数：按脚本自己所在的目录安装'
  } else {
    $guess = Get-ChildItem -Path (Get-Location) -Filter "$PackageName-*.tgz" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $guess) { throw '没给 -Tarball / -Source，当前目录也没有 dsh-memory-inherit-*.tgz' }
    $EffectiveTarball = $guess.FullName
  }
}

if (-not [string]::IsNullOrWhiteSpace($EffectiveSource)) {
  if (-not (Test-Path (Join-Path $EffectiveSource 'package.json'))) { throw " -Source 目录里没有 package.json：$EffectiveSource" }
  $SourceDir = (Resolve-Path $EffectiveSource).Path
  $Spec = "link:$($SourceDir -replace '\\','/')"
  Write-Ok "来源：源码目录 $SourceDir"
} else {
  if (-not (Test-Path $EffectiveTarball)) { throw "找不到文件：$EffectiveTarball" }
  $TarballPath = (Resolve-Path $EffectiveTarball).Path
  $Spec = "file:$($TarballPath -replace '\\','/')"
  Write-Ok "来源：$TarballPath"
}

# --- 3. 备份 package.json，读出来 ---
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item $pkgPath "$pkgPath.bak-$stamp" -Force
Write-Ok "已备份 package.json.bak-$stamp"
$doc = [System.IO.File]::ReadAllText($pkgPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json

# --- 4. 用 pnpm 装（有的话），否则手动铺文件 ---
$pnpmDir = Join-Path $DshHome 'dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs'
$nodeExe = Join-Path $DshHome 'dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$usedPnpm = $false
if ((Test-Path $nodeExe) -and (Test-Path $pnpmDir)) {
  Write-Step '用 DSH 自带的 pnpm 安装…'
  Push-Location $profileDir
  try {
    & $nodeExe $pnpmDir add $Spec --config.confirmModulesPurge=false 2>&1 | ForEach-Object { Write-Host "     $_" }
    if ($LASTEXITCODE -eq 0) { $usedPnpm = $true }
  } finally {
    Pop-Location
  }
} elseif (Get-Command pnpm -ErrorAction SilentlyContinue) {
  Write-Step '用 PATH 里的 pnpm 安装…'
  Push-Location $profileDir
  try {
    & pnpm add $Spec 2>&1 | ForEach-Object { Write-Host "     $_" }
    if ($LASTEXITCODE -eq 0) { $usedPnpm = $true }
  } finally {
    Pop-Location
  }
}

if (-not $usedPnpm) {
  Write-Warn2 '没找到可用的 pnpm，改为手动铺文件。'
  if (-not [string]::IsNullOrWhiteSpace($EffectiveSource)) {
    $target = Join-Path $profileDir "node_modules\$PackageName"
    if (Test-Path $target) { Remove-Item $target -Recurse -Force }
    New-Item -ItemType Junction -Path $target -Target $SourceDir | Out-Null
    Write-Ok "已建 junction → $SourceDir"
  } else {
    $temp = Join-Path ([System.IO.Path]::GetTempPath()) "$PackageName-$stamp"
    New-Item -ItemType Directory -Force -Path $temp | Out-Null
    & tar -xzf $TarballPath -C $temp
    if ($LASTEXITCODE -ne 0) { throw '解压 tgz 失败' }
    $target = Join-Path $profileDir "node_modules\$PackageName"
    if (Test-Path $target) { Remove-Item $target -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    Copy-Item (Join-Path $temp 'package\*') $target -Recurse -Force
    Remove-Item $temp -Recurse -Force
    Write-Ok "已解压到 node_modules\$PackageName"
  }
  # 手动补依赖条目
  $doc = [System.IO.File]::ReadAllText($pkgPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
  if ($null -eq $doc.dependencies) { $doc | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) }
  if ($doc.dependencies.PSObject.Properties.Name -notcontains $PackageName) {
    $doc.dependencies | Add-Member -NotePropertyName $PackageName -NotePropertyValue $Spec
  }
  $json = $doc | ConvertTo-Json -Depth 12
  [System.IO.File]::WriteAllText($pkgPath, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
}

# --- 5. 确保在 dsh.profile.bundles 里 ---
$doc = [System.IO.File]::ReadAllText($pkgPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
if ($null -eq $doc.dsh -or $null -eq $doc.dsh.profile -or $null -eq $doc.dsh.profile.bundles) {
  throw 'profile 的 package.json 里没有 dsh.profile.bundles，这个 profile 结构不对，先别装'
}
$bundles = @($doc.dsh.profile.bundles)
if ($bundles -notcontains $PackageName) {
  $doc.dsh.profile.bundles = $bundles + $PackageName
  $json = $doc | ConvertTo-Json -Depth 12
  [System.IO.File]::WriteAllText($pkgPath, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
  Write-Ok "已加进 dsh.profile.bundles"
} else {
  Write-Ok 'dsh.profile.bundles 里已经有了'
}

# --- 6. 自检 ---
$installed = Join-Path $profileDir "node_modules\$PackageName\index.js"
if (-not (Test-Path $installed)) { throw "装完没找到 $installed" }
Write-Ok "文件就位：node_modules\$PackageName"

Write-Host ''
Write-Host '装好了。剩下两件事：' -ForegroundColor Green
Write-Host '  1. 重启 DSH'
Write-Host '  2. 还要有 dsh-persona-select（github.com/gosutry/dsh-persona-select），历史对话才会真的被注入'
Write-Host ''
Write-Host ('出问题回滚：把 package.json.bak-{0} 改回 package.json，再删掉 node_modules\{1}' -f $stamp, $PackageName)
