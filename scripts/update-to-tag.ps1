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
  # Path to a pnpm entry script (.mjs) or executable. When omitted, one that
  # matches the profile's existing store is chosen automatically.
  [string]$PnpmPath,
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
    # "The only profile with a package.json" is the wrong test: a machine that has
    # ever run both web and desktop has two, and neither is more likely than the
    # other. What actually identifies the target is `dependencies` naming THIS
    # package — a profile that does not depend on it has nothing to update.
    $all = @(Get-ChildItem $profilesRoot -Directory -ErrorAction SilentlyContinue | Where-Object {
      Test-Path (Join-Path $_.FullName 'package.json')
    })

    $installed = @($all | Where-Object {
      $pkg = Join-Path $_.FullName 'package.json'
      try {
        $json = Get-Content $pkg -Raw | ConvertFrom-Json
        $null -ne $json.dependencies.'dsh-toolsearch-manage'
      } catch { $false }
    })

    if ($installed.Count -eq 1) {
      $Profile = $installed[0].Name
      Write-Ok "自动选中 profile：$Profile（只有它依赖 dsh-toolsearch-manage）"
    } elseif ($installed.Count -eq 0) {
      Write-Bad "没有任何 profile 依赖 dsh-toolsearch-manage，无从升级。"
      if ($all.Count -gt 0) {
        Write-Host '  现有 profile：' -NoNewline
        Write-Host (($all | ForEach-Object { $_.Name }) -join ', ')
        Write-Host '  先按 README 的安装步骤装一次，再回来用本脚本升级。'
      }
      Finish 2
    } else {
      Write-Bad '多个 profile 都依赖 dsh-toolsearch-manage，请用 -Profile 指定：'
      $installed | ForEach-Object { Write-Host "    -Profile $($_.Name)" }
      Write-Host ''
      Write-Host '  （本脚本一次只处理一个 profile，避免装到一半失败时留下不一致状态）' -ForegroundColor Yellow
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

# An explicit -Profile can still point at a profile that does not depend on this
# package — `web` on a machine where only `desktop` has it. Say so before the DSH
# check, so the operator is not told to quit DSH for an install that would only
# fail later.
$depNow = $null
try {
  $depNow = (Get-Content $pkgPath -Raw | ConvertFrom-Json).dependencies.'dsh-toolsearch-manage'
} catch {
  Write-Bad "无法解析 $pkgPath"
  Finish 2
}
if ($null -eq $depNow) {
  Write-Bad "profile `"$Profile`" 未安装 dsh-toolsearch-manage，没有可升级的东西。"
  $with = @(Get-ChildItem $profilesRoot -Directory -ErrorAction SilentlyContinue | Where-Object {
    try { $null -ne ((Get-Content (Join-Path $_.FullName 'package.json') -Raw | ConvertFrom-Json).dependencies.'dsh-toolsearch-manage') } catch { $false }
  } | ForEach-Object { $_.Name })
  if ($with.Count -gt 0) {
    Write-Host "  装了这个包的 profile：" -NoNewline
    Write-Host ($with -join ', ')
    Write-Host "  改用：-Profile $($with[0])"
  } else {
    Write-Host '  没有任何 profile 装过它，先按 README 的安装步骤装一次。'
  }
  Finish 2
}
Write-Host "  当前依赖   : $depNow"

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

# ── 选择 pnpm ───────────────────────────────────────────────────────────────
# A profile's node_modules is tied to the pnpm major that created it: v10 and v11
# use different store layouts, and using the wrong one fails with
# ERR_PNPM_UNEXPECTED_STORE — the store path is recorded in node_modules/.modules.yaml.
# The `pnpm` on PATH is whatever the user installed globally, which need not be the
# one DSH used. So the version is chosen from the profile itself, not from PATH.
Write-Step '选择 pnpm'

function Get-PnpmStoreMajor([string]$dir) {
  $mods = Join-Path $dir 'node_modules\.modules.yaml'
  if (-not (Test-Path $mods)) { return $null }
  $raw = Get-Content $mods -Raw
  # storeDir is a JSON string, so a Windows path appears with doubled backslashes
  # ("…\\store\\v11"). Match either form; requiring a single separator silently
  # failed to parse the real file.
  $m = [regex]::Match($raw, 'store[\\/]{1,2}v(\d+)')
  if ($m.Success) { return [int]$m.Groups[1].Value }
  return $null
}

$needMajor = Get-PnpmStoreMajor $profileDir
if ($needMajor) {
  Write-Host "  profile 的 node_modules 使用 store v$needMajor"
} else {
  Write-Warn2 '读不到 .modules.yaml，无法判断需要的 pnpm 版本'
}

# Candidate invocations, tried in order: explicit -PnpmPath, the DSH-bundled pnpm
# (guaranteed to match what the profile was installed with), then PATH pnpm.
$candidates = @()
if ($PnpmPath) {
  if ($PnpmPath -like '*.mjs') {
    $candidates += [pscustomobject]@{ Kind = 'mjs'; Path = $PnpmPath; Label = $PnpmPath }
  } else {
    $candidates += [pscustomobject]@{ Kind = 'exe'; Path = $PnpmPath; Label = $PnpmPath }
  }
}

# The DSH runtime ships the exact pnpm the host uses. Its location is derived from
# this machine's install, not hardcoded.
$dshRoots = @()
foreach ($drive in (Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue)) {
  $dshRoots += @(Get-ChildItem $drive.Root -Directory -Force -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName 'resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs') } |
    ForEach-Object { $_.FullName })
}
foreach ($root in $dshRoots) {
  $mjs = Join-Path $root 'resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs'
  $candidates += [pscustomobject]@{ Kind = 'mjs'; Path = $mjs; Label = "DSH bundled ($mjs)" }
}

foreach ($name in @('pnpm', 'pnpm.cmd')) {
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if ($cmd) { $candidates += [pscustomobject]@{ Kind = 'exe'; Path = $cmd.Source; Label = "PATH ($($cmd.Source))" }; break }
}

$pnpmKind = $null
$pnpmExe  = $null
$chosen   = $null

foreach ($c in $candidates) {
  $ver = $null
  try {
    if ($c.Kind -eq 'mjs') {
      $out = & node $c.Path --version 2>&1
    } else {
      $out = & $c.Path --version 2>&1
    }
    if ($LASTEXITCODE -eq 0) { $ver = "$out".Trim() }
  } catch { }

  if (-not $ver) {
    Write-Host "  ✗ $($c.Label) — 无法运行" -ForegroundColor DarkGray
    continue
  }

  $major = [int]($ver -split '\.')[0]
  if ($needMajor -and $major -ne $needMajor) {
    Write-Host "  ✗ $($c.Label) — v$ver，需要 v$needMajor" -ForegroundColor DarkGray
    continue
  }

  $chosen   = $c
  $pnpmKind = $c.Kind
  $pnpmExe  = $c.Path
  Write-Ok "$($c.Label) — v$ver  匹配"
  break
}

if (-not $chosen) {
  Write-Bad '找不到与 profile 的 store 版本匹配的 pnpm。'
  Write-Host ''
  if ($needMajor) {
    Write-Host "  profile 需要 pnpm v$needMajor 的 store 布局。" -ForegroundColor Yellow
  }
  Write-Host '  可选做法：' -ForegroundColor Yellow
  Write-Host '    1. 用 -PnpmPath 指定一个匹配版本的 pnpm 入口' -ForegroundColor Yellow
  Write-Host '       例：-PnpmPath "D:\...\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs"' -ForegroundColor Yellow
  Write-Host '    2. 或者改用 DSH 的插件管理器安装（它自带匹配的 pnpm）' -ForegroundColor Yellow
  Write-Host '    3. 或者先统一 store：pnpm config set store-dir <路径> --global 后用 pnpm install 重建' -ForegroundColor Yellow
  Finish 6
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
if ($pnpmKind -eq 'mjs') {
  Write-Host "  node `"$(Split-Path -Leaf $pnpmExe)`" add `"$spec`""
} else {
  Write-Host "  pnpm add `"$spec`""
}
Push-Location $profileDir
try {
  if ($pnpmKind -eq 'mjs') {
    & node $pnpmExe add $spec --ignore-scripts
  } else {
    & $pnpmExe add $spec --ignore-scripts
  }
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
