<#
.SYNOPSIS
  把 dsh-memory-inherit 发布到 npm，让别人在 DSH 插件管理页里搜名字直接装。

.DESCRIPTION
  需要先有一个 npm 账号并登录。两种登录方式：
    - 跑一次  .\publish.ps1 -Login      （会打开浏览器走 npm 的登录流程）
    - 或者去 npmjs.com → Access Tokens 生成一个 Automation token，
      写进 %USERPROFILE%\.npmrc：  //registry.npmjs.org/:_authToken=npm_xxxxx

  脚本会先查这个版本有没有被占用（占了就停，免得白报错），发布完再回头查一次
  registry，确认真的能装上。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\publish.ps1 -Login

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\publish.ps1
  powershell -ExecutionPolicy Bypass -File .\scripts\publish.ps1 -Otp 123456
#>
param(
  [switch]$Login,
  [string]$Otp = '',
  [string]$Tag = 'latest'
)

$ErrorActionPreference = 'Stop'
$PackageName = 'dsh-memory-inherit'
$RegistryApi = "https://registry.npmjs.org/$PackageName"

function Say($message, $color = 'Gray') { Write-Host $message -ForegroundColor $color }

# --- 1. 找 node / pnpm ---
$homeGuess = if (-not [string]::IsNullOrWhiteSpace($env:DSH_HOME)) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$nodeExe = Join-Path $homeGuess 'dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$pnpmCjs = Join-Path $homeGuess 'dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs'
if (-not (Test-Path $nodeExe)) {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if ($null -eq $nodeCmd) { throw '找不到 node：DSH 自带的和 PATH 里的都没有' }
  $nodeExe = $nodeCmd.Source
}
if (-not (Test-Path $pnpmCjs)) {
  $pnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($null -eq $pnpmCmd) { throw '找不到 pnpm：DSH 自带的和 PATH 里的都没有' }
  $pnpmCjs = $null
}
function Invoke-Pnpm {
  param([string[]]$Arguments)
  if ($null -ne $pnpmCjs) { & $nodeExe $pnpmCjs @Arguments } else { & pnpm @Arguments }
}

# --- 2. 进包目录 ---
$pkgRoot = Split-Path $PSScriptRoot -Parent
if (-not (Test-Path (Join-Path $pkgRoot 'package.json'))) { throw "找不到 package.json：$pkgRoot" }
Push-Location $pkgRoot
try {
  $doc = [System.IO.File]::ReadAllText((Join-Path $pkgRoot 'package.json'), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
  Say "包：$($doc.name)@$($doc.version)" 'Cyan'

  # --- 3. 登录 ---
  if ($Login) {
    Say '打开 npm 登录流程…' 'Cyan'
    Invoke-Pnpm @('login')
  }
  $who = (Invoke-Pnpm @('whoami') 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $who -eq '' -or $who -match 'ERR_') {
    Say ''
    Say '还没登录 npm。两种办法：' 'Yellow'
    Say '  1) 重新跑：.\publish.ps1 -Login'
    Say '  2) 去 https://www.npmjs.com/settings/~/tokens → Generate New Token（Automation）'
    Say '     然后把这个新文件写好： %USERPROFILE%\.npmrc'
    Say '     //registry.npmjs.org/:_authToken=npm_你的token'
    exit 1
  }
  Say "已登录：$who" 'Green'

  # --- 4. 这个版本有没有被占 ---
  $probe = & $nodeExe -e "fetch('$RegistryApi').then(r=>r.json()).then(j=>{const v=process.argv[1];const b=j.versions&&j.versions[v];console.log(b?'TAKEN':'FREE')}).catch(()=>console.log('UNKNOWN'))" $doc.version
  if ($probe -eq 'TAKEN') {
    Say "版本 $($doc.version) 已经发布过了。要发新的就先改 package.json 里的 version（比如 0.1.1）。" 'Yellow'
    exit 1
  }
  Say "版本 $($doc.version) 在 registry 上：$probe" 'Green'

  # --- 5. 发布 ---
  $publishArgs = @('publish', '--no-git-checks', '--access', 'public', '--tag', $Tag)
  if (-not [string]::IsNullOrWhiteSpace($Otp)) { $publishArgs += @('--otp', $Otp) }
  Say "发布中：$($publishArgs -join ' ')" 'Cyan'
  Invoke-Pnpm $publishArgs
  if ($LASTEXITCODE -ne 0) {
    Say ''
    Say '发布失败。常见原因：' 'Yellow'
    Say '  - 需要 2FA：加 -Otp <6位验证码> 再跑一次'
    Say '  - token 没有 publish 权限'
    Say '  - 名字/版本被占'
    exit $LASTEXITCODE
  }

  # --- 6. 回头验证 ---
  Say ''
  Say '回头查一下 registry…' 'Cyan'
  $verify = & $nodeExe -e "const t=Date.now();(async()=>{for(let i=0;i<10;i++){const j=await (await fetch('$RegistryApi',{cache:'no-store'})).json();if(j.versions&&j.versions[process.argv[1]]){console.log('OK');return}await new Promise(r=>setTimeout(r,1500))}console.log('TIMEOUT')})()" $doc.version
  if ($verify -eq 'OK') {
    Say "发布成功：https://www.npmjs.com/package/$PackageName" 'Green'
    Say ''
    Say '别人现在可以这样装：' 'Green'
    Say "  插件管理页里搜 $PackageName"
    Say "  或者  pnpm add $PackageName"
    Say ''
    Say '记得提醒一句：还要装 dsh-persona-select，历史对话才会真的被注入。'
  } else {
    Say "registry 还没反应过来（$verify）。npm 有时要几十秒，稍后自己打开 https://www.npmjs.com/package/$PackageName 看看。" 'Yellow'
  }
} finally {
  Pop-Location
}
