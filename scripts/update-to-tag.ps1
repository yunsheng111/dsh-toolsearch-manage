# update-to-tag.ps1 — 把已安装的 dsh-toolsearch-manage 升级到指定 tag 并校验结果。
#
# 为什么必须让 DSH 完全退出：安装过程会改名 profile 的 package.json，而运行中的
# DSH 锁着这个文件，pnpm 会报 [EPERM] operation not permitted。
# 这不是权限配置问题，是进程占用。
#
# 用法（在 DSH 之外的 PowerShell 窗口里）：
#     & ".\update-to-tag.ps1"
#     & ".\update-to-tag.ps1" -Tag v0.1.0 -Profile desktop
#
# 直接双击 .ps1 不行：Windows 默认用记事本打开，且执行策略可能拦截。
# 在资源管理器地址栏输入 powershell 回车，即可在当前目录打开一个窗口。

[CmdletBinding()]
param(
  [string]$Tag = 'v0.1.0',
  [string]$Profile,
  [string]$Repo = 'yunsheng111/dsh-toolsearch-manage',
  [switch]$Force,
  [switch]$NoPause
)

$ErrorActionPreference = 'Stop'

# ── 输出到控制台的同时写日志，双击运行也留得下证据 ──────────────────────────
$logDir = Join-Path $env:USERPROFILE '.dsh\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logPath = Join-Path $logDir ("toolsearch-manage-update-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
$transcriptStarted = $false
try {
  Start-Transcript -Path $logPath -Force | Out-Null
  $transcriptStarted = $true
} catch {
  # 没有 transcript 也能继续，只是少了日志文件。
}

function Write-Step($text) { Write-Host "`n=== $text ===" -ForegroundColor Cyan }
function Write-Ok($text)   { Write-Host "  $text" -ForegroundColor Green }
function Write-Warn2($text){ Write-Host "  $text" -ForegroundColor Yellow }
function Write-Bad($text)  { Write-Host "  $text" -ForegroundColor Red }

function Finish([int]$code) {
  Write-Host ''
  if ($code -eq 0) {
    Write-Host '完成。' -ForegroundColor Green
  } else {
    Write-Host "失败（退出码 $code）。日志：$logPath" -ForegroundColor Red
  }
  if ($transcriptStarted) { try { Stop-Transcript | Out-Null } catch {} }
  if (-not $NoPause) {
    # Without this the window closes the instant the script ends, which is exactly
    # how the first report arrived: "一闪而过" with no output to act on.
    Write-Host ''
    try { [void](Read-Host '按回车关闭此窗口') } catch {}
  }
  exit $code
}

Write-Step '环境'
Write-Host "  tag      : $Tag"
Write-Host "  profile  : $(if ($Profile) { $Profile } else { '(自动检测)' })"
Write-Host "  repo     : $Repo"
Write-Host "  日志     : $logPath"

# ── 定位 DSH home 与 profile ────────────────────────────────────────────────
$home_ = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profilesRoot = Join-Path $home_ 'profiles'

if (-not (Test-Path $profilesRoot)) {
  Write-Bad "找不到 profiles 目录：$profilesRoot"
  Finish 2
}

if (-not $Profile) {
  if ($env:DSH_PROFILE) {
    $Profile = $env:DSH_PROFILE
  } else {
    $candidates = Get-ChildItem $profilesRoot -Directory -ErrorAction SilentlyContinue |
      Where-Object { Test-Path (Join-Path $_.FullName 'package.json') }
    if ($candidates.Count -eq 1) {
      $Profile = $candidates[0].Name
    } elseif ($candidates.Count -eq 0) {
      Write-Bad "在 $profilesRoot 下找不到任何带 package.json 的 profile"
      Finish 2
    } else {
      Write-Bad '存在多个 profile，请用 -Profile 指定：'
      $candidates | ForEach-Object { Write-Host "    -Profile $($_.Name)" }
      Finish 2
    }
  }
}

$profileDir = Join-Path $profilesRoot $Profile
$pkgPath    = Join-Path $profileDir 'package.json'
if (-not (Test-Path $pkgPath)) {
  Write-Bad "profile 目录不完整（缺 package.json）：$profileDir"
  Finish 2
}
Write-Ok "profile 目录：$profileDir"

# ── 安装前必须确认 DSH 未运行 ───────────────────────────────────────────────
Write-Step '检查 DSH 是否仍在运行'
$running = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    $_.CommandLine -and
    $_.CommandLine -like '*dsh-desktop-host*' -and
    $_.CommandLine -notmatch 'pwsh|Get-CimInstance'
  })

if ($running.Count -gt 0 -and -not $Force) {
  Write-Bad ('DSH 仍在运行（PID: {0}）。' -f (($running | ForEach-Object { $_.ProcessId }) -join ', '))
  Write-Host ''
  Write-Host '  安装会改名 profile 的 package.json，运行中的 DSH 锁着它，' -ForegroundColor Yellow
  Write-Host '  pnpm 会报 [EPERM] operation not permitted。' -ForegroundColor Yellow
  Write-Host ''
  Write-Host '  请先完全退出 DSH：' -ForegroundColor Yellow
  Write-Host '    - 托盘图标右键退出，或' -ForegroundColor Yellow
  Write-Host '    - 任务管理器结束进程（关窗口可能只是隐藏）' -ForegroundColor Yellow
  Write-Host ''
  Write-Host '  ⚠ 不要从 DSH 的终端面板里运行本脚本——那时 DSH 必然在运行。' -ForegroundColor Yellow
  Write-Host '    请在 Windows 开始菜单里单独打开 PowerShell。' -ForegroundColor Yellow
  Write-Host ''
  Write-Host '  若确定要强制继续（不推荐）：加 -Force' -ForegroundColor Yellow
  Finish 3
}
if ($running.Count -gt 0) {
  Write-Warn2 '检测到 DSH 在运行，但指定了 -Force，继续。'
} else {
  Write-Ok 'DSH 未运行'
}

# ── 备份 ────────────────────────────────────────────────────────────────────
Write-Step '备份'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
foreach ($name in @('package.json', 'pnpm-lock.yaml', 'cordis.patch.yml')) {
  $src = Join-Path $profileDir $name
  if (Test-Path $src) {
    Copy-Item $src "$src.bak-$stamp" -Force
    Write-Ok "$name.bak-$stamp"
  }
}

# ── 安装 ────────────────────────────────────────────────────────────────────
Write-Step "安装 $Tag"
$spec = "github:$Repo#$Tag"
Write-Host "  pnpm add `"$spec`""
Push-Location $profileDir
try {
  & pnpm add $spec --ignore-scripts
  if ($LASTEXITCODE -ne 0) {
    Write-Bad "pnpm add 失败，退出码 $LASTEXITCODE"
    Write-Host "  回滚：Copy-Item `"$profileDir\package.json.bak-$stamp`" `"$profileDir\package.json`" -Force" -ForegroundColor Yellow
    Finish 4
  }
} finally {
  Pop-Location
}

# ── 校验 ────────────────────────────────────────────────────────────────────
Write-Step '校验'
$failures = @()

$specNow = (Get-Content $pkgPath -Raw | ConvertFrom-Json).dependencies.'dsh-toolsearch-manage'
Write-Host "  依赖声明   : $specNow"
if ($specNow -notlike "*#$Tag*") { $failures += "依赖声明不含 #$Tag" }

$lock = Get-Content (Join-Path $profileDir 'pnpm-lock.yaml') -Raw
$m = [regex]::Match($lock, 'dsh-toolsearch-manage/tar\.gz/([0-9a-f]{40})')
if ($m.Success) {
  $commit = $m.Groups[1].Value
  Write-Host "  锁定 commit : $($commit.Substring(0,7))"
} else {
  $failures += 'lockfile 中找不到解析到的 commit'
}

$installed = Join-Path $profileDir 'node_modules\dsh-toolsearch-manage'
if (Test-Path $installed) {
  $firstLine = Get-Content (Join-Path $installed 'lib\store.js') -TotalCount 1
  $hasHeader = $firstLine -like '// Ported from*'
  Write-Host "  许可证署名 : $hasHeader"
  if (-not $hasHeader) { $failures += 'lib/store.js 缺许可证署名行（装的是旧版本）' }

  $hasNotice = Test-Path (Join-Path $installed 'NOTICE')
  Write-Host "  NOTICE     : $hasNotice"
  if (-not $hasNotice) { $failures += '缺 NOTICE' }

  $ver = (Get-Content (Join-Path $installed 'package.json') -Raw | ConvertFrom-Json).version
  Write-Host "  版本       : $ver"
} else {
  $failures += "未安装到 $installed"
}

Write-Host ''
if ($failures.Count -eq 0) {
  Write-Host '=== 全部校验通过 ===' -ForegroundColor Green
  Write-Host ''
  Write-Host '  重新打开 DSH。启动后应看到：' -ForegroundColor Green
  Write-Host '    - 左侧栏出现放大镜图标'
  Write-Host '    - 设置 → 工具检索，五个页签（能力/市场/导入/技能/设置）'
  Write-Host '    - 工具表里出现 tool_search / mcp_register / mcp_load / mcp_call'
  Finish 0
} else {
  Write-Bad '校验未通过：'
  $failures | ForEach-Object { Write-Host "    - $_" -ForegroundColor Red }
  Write-Host ''
  Write-Host "  回滚：Copy-Item `"$profileDir\package.json.bak-$stamp`" `"$profileDir\package.json`" -Force" -ForegroundColor Yellow
  Write-Host "        Copy-Item `"$profileDir\pnpm-lock.yaml.bak-$stamp`" `"$profileDir\pnpm-lock.yaml`" -Force" -ForegroundColor Yellow
  Finish 5
}
