# =============================================================
# rename-dsh-think-splice.ps1
# 将 DSH 插件仓库 dsh-think-splice 重命名为 dsh-think-summary，
# 并同步更新 DSH 的所有引用（junction / workspace / 会话 / 配置），
# 保留工作区与会话归属。
#
# 用法（PowerShell 7 / pwsh，默认 UTF-8）：
#   pwsh -ExecutionPolicy Bypass -File .\rename-dsh-think-splice.ps1
#
# 前提：执行前请先【关闭正在运行的 dsh】（文件夹被 junction 占用无法重命名）。
# =============================================================
$ErrorActionPreference = 'Stop'

# ---------- 路径常量（如你的环境不同，改这里） ----------
$OLD_NAME = 'dsh-think-splice'
$NEW_NAME = 'dsh-think-summary'
$PLUGINS_ROOT = 'D:\Files\zzj\Programs\webs\dsh-plugins'
$OLD_REPO = Join-Path $PLUGINS_ROOT $OLD_NAME
$NEW_REPO = Join-Path $PLUGINS_ROOT $NEW_NAME

$DshHome = Join-Path $env:USERPROFILE '.dsh'
$ProfileWeb = Join-Path $DshHome 'profiles\web'
$LINK_DIR = Join-Path $ProfileWeb 'node_modules\dsh-think-summary'
$WORKSPACE_JSON = Join-Path $DshHome 'storages\workspace.json'
$PROJCACHE_JSON = Join-Path $DshHome 'storages\session_projcache.json'
$PROFILE_PKG = Join-Path $ProfileWeb 'package.json'
$OLD_SESS_DIR = Join-Path $DshHome "sessions\--D-Files-zzj-Programs-webs-dsh-think-splice--"
$NEW_SESS_DIR = Join-Path $DshHome "sessions\--D-Files-zzj-Programs-webs-dsh-think-summary--"

# ---------- 0. 预检 ----------
Write-Host '== 0/9 预检 ==' -ForegroundColor Cyan

if (-not (Test-Path $OLD_REPO)) { Write-Error "找不到仓库: $OLD_REPO"; exit 1 }
if (Test-Path $NEW_REPO) { Write-Error "新路径已存在: $NEW_REPO（可能已改过名？）"; exit 1 }

$dshRunning = $false
try {
  $conn = Get-NetTCPConnection -LocalPort 3081 -State Listen -ErrorAction SilentlyContinue
  if ($conn) { $dshRunning = $true }
} catch { }
if ($dshRunning) {
  Write-Host '检测到 dsh 正在运行（端口 3081 被监听）。' -ForegroundColor Yellow
  Write-Host '请先【完全退出 dsh】，再重新运行本脚本。' -ForegroundColor Yellow
  exit 1
}
Write-Host '  OK: dsh 未运行，仓库与目标路径就绪。'

# ---------- 1. 备份 ----------
Write-Host '== 1/9 备份关键文件 ==' -ForegroundColor Cyan
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
foreach ($j in @($WORKSPACE_JSON, $PROJCACHE_JSON)) {
  if (Test-Path $j) {
    Copy-Item $j "$j.bak-$stamp" -Force
    Write-Host "  备份: $(Split-Path $j -Leaf) -> .bak-$stamp"
  }
}

# ---------- 2. 重命名仓库文件夹 ----------
Write-Host '== 2/9 重命名仓库文件夹 ==' -ForegroundColor Cyan
Rename-Item -Path $OLD_REPO -NewName $NEW_NAME
Write-Host "  已重命名 -> $NEW_REPO"

# ---------- 3. 重建 junction ----------
Write-Host '== 3/9 重建 node_modules junction ==' -ForegroundColor Cyan
if (Test-Path $LINK_DIR) {
  Remove-Item $LINK_DIR -Force   # 只删链接本身，不删目标
  Write-Host '  已删除失效 junction'
}
New-Item -ItemType Junction -Path $LINK_DIR -Target $NEW_REPO | Out-Null
Write-Host "  已重建 junction -> $NEW_REPO"

# ---------- 4. 更新 profile package.json 的 link 路径 ----------
Write-Host '== 4/9 更新 profile package.json ==' -ForegroundColor Cyan
if (Test-Path $PROFILE_PKG) {
  $pkg = Get-Content $PROFILE_PKG -Raw -Encoding UTF8
  $pkg = $pkg -replace [regex]::Escape("link:D:/Files/zzj/Programs/webs/dsh-plugins/$OLD_NAME"), "link:D:/Files/zzj/Programs/webs/dsh-plugins/$NEW_NAME"
  Set-Content -Path $PROFILE_PKG -Value $pkg -Encoding UTF8 -NoNewline
  Write-Host '  已更新 link 路径'
} else {
  Write-Host '  跳过（package.json 不存在）' -ForegroundColor Yellow
}

# ---------- 5. 更新 workspace.json（保留 id/session 归属） ----------
Write-Host '== 5/9 更新 workspace.json ==' -ForegroundColor Cyan
if (Test-Path $WORKSPACE_JSON) {
  # 只做精准字符串替换（path 字段值），不重新序列化整个文件。
  $wsText = Get-Content $WORKSPACE_JSON -Raw -Encoding UTF8
  $oldPathJson = '"D:\\Files\\zzj\\Programs\\webs\\dsh-plugins\\' + $OLD_NAME + '"'
  $newPathJson = '"D:\\Files\\zzj\\Programs\\webs\\dsh-plugins\\' + $NEW_NAME + '"'
  if ($wsText.Contains($oldPathJson)) {
    $wsText = $wsText.Replace($oldPathJson, $newPathJson)
    Set-Content -Path $WORKSPACE_JSON -Value $wsText -Encoding UTF8 -NoNewline
    Write-Host '  已更新 workspace 的 path（原格式保留）'
  } else {
    Write-Host '  (未找到旧路径引用，跳过)' -ForegroundColor Yellow
  }
} else {
  Write-Host '  跳过（workspace.json 不存在）' -ForegroundColor Yellow
}

# ---------- 6. 更新 session_projcache.json 的 cwd ----------
Write-Host '== 6/9 更新 session_projcache.json ==' -ForegroundColor Cyan
if (Test-Path $PROJCACHE_JSON) {
  $pcText = Get-Content $PROJCACHE_JSON -Raw -Encoding UTF8
  $oldCwdJson = '"D:\\Files\\zzj\\Programs\\webs\\dsh-plugins\\' + $OLD_NAME + '"'
  $newCwdJson = '"D:\\Files\\zzj\\Programs\\webs\\dsh-plugins\\' + $NEW_NAME + '"'
  if ($pcText.Contains($oldCwdJson)) {
    $pcText = $pcText.Replace($oldCwdJson, $newCwdJson)
    Set-Content -Path $PROJCACHE_JSON -Value $pcText -Encoding UTF8 -NoNewline
    Write-Host '  已更新会话 cwd（原格式保留）'
  } else {
    Write-Host '  (未找到旧 cwd 引用，跳过)' -ForegroundColor Yellow
  }
} else {
  Write-Host '  跳过（session_projcache.json 不存在）' -ForegroundColor Yellow
}

# ---------- 7. 重命名 sessions 归档目录 ----------
Write-Host '== 7/9 重命名 sessions 归档目录 ==' -ForegroundColor Cyan
if (Test-Path $OLD_SESS_DIR) {
  if (Test-Path $NEW_SESS_DIR) { Write-Host '  跳过（新目录已存在）' -ForegroundColor Yellow }
  else {
    Rename-Item -Path $OLD_SESS_DIR -NewName (Split-Path $NEW_SESS_DIR -Leaf)
    Write-Host "  已重命名 -> $NEW_SESS_DIR"
  }
} else {
  Write-Host '  跳过（旧目录不存在）' -ForegroundColor Yellow
}

# ---------- 8. 重新安装依赖（更新 pnpm-lock.yaml） ----------
Write-Host '== 8/9 重新安装依赖 ==' -ForegroundColor Cyan
if (Get-Command pnpm -ErrorAction SilentlyContinue) {
  Push-Location $ProfileWeb
  pnpm install
  Pop-Location
  Write-Host '  pnpm install 完成'
} else {
  Write-Host '  未找到 pnpm，跳过（依赖路径可能仍指向旧目录，需手动更新 lock）' -ForegroundColor Yellow
}

# ---------- 9. 验证 ----------
Write-Host '== 9/9 验证 ==' -ForegroundColor Cyan
$ok = $true
if (-not (Test-Path $NEW_REPO)) { Write-Host "  [x] 仓库不存在: $NEW_REPO"; $ok = $false }
if (-not (Test-Path $LINK_DIR)) { Write-Host "  [x] junction 不存在: $LINK_DIR"; $ok = $false }
elseif ((Get-Item $LINK_DIR).Target -ne $NEW_REPO) { Write-Host "  [x] junction 目标不对: $((Get-Item $LINK_DIR).Target)"; $ok = $false }
$pkgCheck = Get-Content $PROFILE_PKG -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
if ($pkgCheck -and $pkgCheck -match $OLD_NAME) { Write-Host '  [x] package.json 仍含旧名'; $ok = $false }
$wsCheck = Get-Content $WORKSPACE_JSON -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
if ($wsCheck -and $wsCheck -match [regex]::Escape('dsh-think-splice')) { Write-Host '  [x] workspace.json 仍含旧路径'; $ok = $false }
$pcCheck = Get-Content $PROJCACHE_JSON -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
if ($pcCheck -and $pcCheck -match [regex]::Escape('dsh-think-splice')) { Write-Host '  [x] session_projcache.json 仍含旧路径'; $ok = $false }

if ($ok) {
  Write-Host ''
  Write-Host '全部完成！现在可以启动 dsh。' -ForegroundColor Green
  Write-Host '   侧边栏应显示 dsh-think-summary 与 vscode bug修复 两个工作区，会话保留。'
} else {
  Write-Host ''
  Write-Host '有验证项未通过，请检查上方输出。' -ForegroundColor Yellow
}
