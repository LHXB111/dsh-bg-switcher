# ============================================================================
# dsh-bg-switcher —— Windows 卸载脚本（PowerShell 5.1 兼容）
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1 -Purge
#   powershell -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1 -Profile web
#
# 默认保留图库与设置；-Purge 连 data\dsh-bg-switcher 一起删。
# ============================================================================
#Requires -Version 5.1
[CmdletBinding()]
param(
	[string]$Profile,
	[switch]$Purge
)

$ErrorActionPreference = 'Stop'
$Name = 'dsh-bg-switcher'

function Write-Step($text) { Write-Host "    $text" }

$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$ProfilesDir = Join-Path $DshHome 'profiles'

function Resolve-ProfileName {
	param([string]$Requested)
	if ($Requested) { return $Requested }
	if ($env:DSH_DESKTOP_PROFILE) { return $env:DSH_DESKTOP_PROFILE }
	if (Test-Path (Join-Path $ProfilesDir 'desktop\package.json')) { return 'desktop' }
	return 'web'
}

$ProfileName = Resolve-ProfileName -Requested $Profile
$ProfileDir = Join-Path $ProfilesDir $ProfileName
$ManifestPath = Join-Path $ProfileDir 'package.json'

if (-not (Test-Path $ManifestPath)) { throw "找不到 profile：$ProfileDir" }

Write-Host "==> 卸载 $Name ← $ProfileDir"

# ── package.json：摘掉依赖与 bundles ────────────────────────────────────────
$manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
if ($manifest.dependencies -and $manifest.dependencies.PSObject.Properties[$Name]) {
	$manifest.dependencies.PSObject.Properties.Remove($Name)
}
if ($manifest.dsh -and $manifest.dsh.profile -and $manifest.dsh.profile.bundles) {
	$kept = @($manifest.dsh.profile.bundles | Where-Object { $_ -ne $Name })
	$manifest.dsh.profile.bundles = $kept
}
$json = $manifest | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($ManifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Step '已从 dependencies / bundles 移除'

# ── pnpm-lock.yaml：删掉 importer 条目 ──────────────────────────────────────
$lockPath = Join-Path $ProfileDir 'pnpm-lock.yaml'
if (Test-Path $lockPath) {
	$lines = [System.IO.File]::ReadAllText($lockPath) -split "`n"
	$kept = New-Object System.Collections.Generic.List[string]
	$skipping = $false
	foreach ($line in $lines) {
		$trim = $line.Trim()
		if ($trim -eq "${Name}:" -or $trim -eq "`"${Name}`":") { $skipping = $true; continue }
		if ($skipping) {
			if ($line -match '^ {8}(specifier|version):') { continue }
			$skipping = $false
		}
		$kept.Add($line)
	}
	[System.IO.File]::WriteAllText($lockPath, ($kept -join "`n"), (New-Object System.Text.UTF8Encoding($false)))
	Write-Step '已清理 pnpm-lock.yaml 条目'
}

# ── 文件与链接 ──────────────────────────────────────────────────────────────
$linkPath = Join-Path $ProfileDir "node_modules\$Name"
if (Test-Path $linkPath) { Remove-Item -LiteralPath $linkPath -Recurse -Force }
$targetDir = Join-Path $ProfileDir ".local-plugins\$Name"
if (Test-Path $targetDir) { Remove-Item -LiteralPath $targetDir -Recurse -Force }
Write-Step '已删除插件文件与 node_modules 链接'

$dataDir = Join-Path $ProfileDir "data\$Name"
if ($Purge) {
	if (Test-Path $dataDir) { Remove-Item -LiteralPath $dataDir -Recurse -Force }
	Write-Step "已删除图库与设置（data\$Name）"
} else {
	Write-Step "图库与设置保留在：$dataDir"
}

Write-Host ''
Write-Host '✔ 已卸载。退出并重开 DeepSeek Harness 后生效。'
Write-Host "  想恢复安装前的配置：Copy-Item `"$ManifestPath.bak-before-$Name`" `"$ManifestPath`" -Force"
