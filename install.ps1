# ============================================================================
# dsh-bg-switcher —— Windows 安装脚本（PowerShell 5.1 兼容）
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Profile desktop
#
# 做的事和 install.sh 一致：
#   ① 备份 profile 的 package.json / pnpm-lock.yaml（只备份一次）
#   ② 拷贝插件到 <profile>\.local-plugins\dsh-bg-switcher（排除 test/tools）
#   ③ 让 Node 能找到它：优先建 junction（不需要管理员），失败则复制一份到 node_modules
#   ④ package.json 加 dependencies 条目 + 把包名放进 dsh.profile.bundles
#   ⑤ 补 pnpm-lock.yaml 的 importer 条目
#   ⑥ 自检：找个 node 把装好的模块 import 一次
# ============================================================================
#Requires -Version 5.1
[CmdletBinding()]
param(
	[string]$Profile,
	[switch]$NoSelfCheck
)

$ErrorActionPreference = 'Stop'
$Name = 'dsh-bg-switcher'
$Src = Split-Path -Parent $MyInvocation.MyCommand.Path

function Write-Step($text) { Write-Host "    $text" }

# ── 定位 DSH home 与 profile ────────────────────────────────────────────────
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
$TargetDir = Join-Path $ProfileDir ".local-plugins\$Name"
$LinkPath = Join-Path $ProfileDir "node_modules\$Name"
$BackupSuffix = '.bak-before-dsh-bg-switcher'

Write-Host "==> 安装 $Name → $ProfileDir"

if (-not (Test-Path $ManifestPath)) {
	throw "找不到 profile：$ProfileDir`n  先启动一次 DSH（会初始化 profile），或用 -Profile 指定名字。"
}

# 自保：别在已安装目录里跑（会把源目录删掉，等于自毁）
$srcFull = (Resolve-Path -LiteralPath $Src).Path.TrimEnd('\')
$targetFull = if (Test-Path $TargetDir) { (Resolve-Path -LiteralPath $TargetDir).Path.TrimEnd('\') } else { '' }
if ($targetFull -and $srcFull -ieq $targetFull) {
	throw "这个脚本正在已安装目录里运行（源 == 安装目标）。`n  想改插件请直接改这里的 lib\ 与 assets\，改完退出并重开 DSH；`n  想重新安装请从插件源码目录运行 install.ps1。"
}

# ── ① 备份 ─────────────────────────────────────────────────────────────────
$manifestBackup = "$ManifestPath$BackupSuffix"
if (-not (Test-Path $manifestBackup)) {
	Copy-Item -LiteralPath $ManifestPath -Destination $manifestBackup
	Write-Step "备份 package.json → package.json$BackupSuffix"
}
$lockPath = Join-Path $ProfileDir 'pnpm-lock.yaml'
$lockBackup = "$lockPath$BackupSuffix"
if ((Test-Path $lockPath) -and -not (Test-Path $lockBackup)) {
	Copy-Item -LiteralPath $lockPath -Destination $lockBackup
	Write-Step "备份 pnpm-lock.yaml → pnpm-lock.yaml$BackupSuffix"
}

# ── ② 拷贝插件本体 ──────────────────────────────────────────────────────────
if (Test-Path $TargetDir) { Remove-Item -LiteralPath $TargetDir -Recurse -Force }
New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
$exclude = @('test', 'tools', 'node_modules', '.git', '.DS_Store')
Get-ChildItem -LiteralPath $Src -Force | Where-Object { $exclude -notcontains $_.Name } | ForEach-Object {
	Copy-Item -LiteralPath $_.FullName -Destination $TargetDir -Recurse -Force
}
Write-Step "插件文件 → $TargetDir"

# ── ③ node_modules：先 junction，失败则复制 ─────────────────────────────────
$nodeModules = Join-Path $ProfileDir 'node_modules'
if (-not (Test-Path $nodeModules)) { New-Item -ItemType Directory -Path $nodeModules -Force | Out-Null }
if (Test-Path $LinkPath) { Remove-Item -LiteralPath $LinkPath -Recurse -Force }
$linked = $false
try {
	New-Item -ItemType Junction -Path $LinkPath -Target $TargetDir -ErrorAction Stop | Out-Null
	$linked = $true
	Write-Step "junction → node_modules\$Name"
} catch {
	Write-Step "建 junction 失败（$($_.Exception.Message)），改为复制一份到 node_modules"
}
if (-not $linked) {
	$copyDir = Join-Path $nodeModules $Name
	New-Item -ItemType Directory -Path $copyDir -Force | Out-Null
	Get-ChildItem -LiteralPath $TargetDir -Force | ForEach-Object {
		Copy-Item -LiteralPath $_.FullName -Destination $copyDir -Recurse -Force
	}
	Write-Step "复制 → node_modules\$Name"
}

# ── ④ package.json：依赖 + bundles ──────────────────────────────────────────
$manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
if (-not $manifest.PSObject.Properties['dependencies'] -or $null -eq $manifest.dependencies) {
	$manifest | Add-Member -MemberType NoteProperty -Name dependencies -Value ([pscustomobject]@{}) -Force
}
$spec = "link:.local-plugins/$Name"
$depNames = @($manifest.dependencies.PSObject.Properties.Name)
if ($depNames -contains $Name) {
	$manifest.dependencies.$Name = $spec
} else {
	$manifest.dependencies | Add-Member -MemberType NoteProperty -Name $Name -Value $spec -Force
}

$bundles = @()
if ($manifest.dsh -and $manifest.dsh.profile -and $manifest.dsh.profile.bundles) {
	$bundles = @($manifest.dsh.profile.bundles)
}
if ($bundles -notcontains $Name) { $bundles += $Name }

if (-not $manifest.PSObject.Properties['dsh'] -or $null -eq $manifest.dsh) {
	$manifest | Add-Member -MemberType NoteProperty -Name dsh -Value ([pscustomobject]@{}) -Force
}
if (-not $manifest.dsh.PSObject.Properties['profile'] -or $null -eq $manifest.dsh.profile) {
	$manifest.dsh | Add-Member -MemberType NoteProperty -Name profile -Value ([pscustomobject]@{}) -Force
}
if ($manifest.dsh.profile.PSObject.Properties['bundles']) {
	$manifest.dsh.profile.bundles = $bundles
} else {
	$manifest.dsh.profile | Add-Member -MemberType NoteProperty -Name bundles -Value $bundles -Force
}

# PowerShell 5.1 的 Out-File/Set-Content -Encoding UTF8 会写 BOM，而宿主用 JSON.parse 读它 ⇒ 必须无 BOM
$json = $manifest | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($ManifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Step ("bundles: " + ($bundles -join ', '))

# ── ⑤ pnpm-lock.yaml importer 条目 ──────────────────────────────────────────
if (Test-Path $lockPath) {
	$lockText = [System.IO.File]::ReadAllText($lockPath)
	if ($lockText -match [regex]::Escape("link:.local-plugins/$Name")) {
		Write-Step 'pnpm-lock.yaml 已有条目，跳过'
	} else {
		$lines = $lockText -split "`n"
		$at = -1
		for ($i = 0; $i -lt $lines.Count; $i++) {
			if ($lines[$i] -eq '    dependencies:') { $at = $i; break }
		}
		if ($at -ge 0) {
			$entry = @(
				"      ${Name}:",
				"        specifier: link:.local-plugins/$Name",
				"        version: link:.local-plugins/$Name"
			)
			$new = @()
			$new += $lines[0..$at]
			$new += $entry
			if ($at + 1 -lt $lines.Count) { $new += $lines[($at + 1)..($lines.Count - 1)] }
			[System.IO.File]::WriteAllText($lockPath, ($new -join "`n"), (New-Object System.Text.UTF8Encoding($false)))
			Write-Step 'pnpm-lock.yaml 已补 importer 条目'
		} else {
			Write-Step 'pnpm-lock.yaml 结构不认识，跳过（不影响启动）'
		}
	}
}

# ── ⑥ 自检：import 一次装好的模块 ───────────────────────────────────────────
if (-not $NoSelfCheck) {
	$nodeCandidates = @()
	if ($env:DSH_BG_NODE) { $nodeCandidates += $env:DSH_BG_NODE }
	$cmd = Get-Command node -ErrorAction SilentlyContinue
	if ($cmd) { $nodeCandidates += $cmd.Source }
	if ($env:DSH_DESKTOP_NODE_EXECUTABLE) {
		$runtime = Join-Path (Split-Path $env:DSH_DESKTOP_NODE_EXECUTABLE -Parent) '..\Resources\runtime\bin\node.cmd'
		if (Test-Path $runtime) { $nodeCandidates += (Resolve-Path $runtime).Path }
	}
	$node = $nodeCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
	if (-not $node) {
		Write-Step '没找到 node，跳过自检（宿主的依赖解析不依赖它，可忽略）'
	} else {
		$entry = Join-Path $TargetDir 'lib\index.js'
		$uri = 'file:///' + ($entry -replace '\\', '/')
		$code = "const m = await import('$uri'); if (m.name !== '$Name' || typeof m.apply !== 'function') { throw new Error('导出形状不对') }; console.log('ok')"
		$out = & $node --input-type=module -e $code 2>&1
		if ($LASTEXITCODE -eq 0) {
			Write-Step "自检通过：$Name 可导入，apply 是函数"
		} else {
			Write-Step "自检未通过（不影响安装，可先重启 DSH 再看）：$out"
		}
	}
}

Write-Host ''
Write-Host '✔ 已安装。接下来：'
Write-Host '  · 退出并重开 DeepSeek Harness（官方桌面端没有 ⌘R，也没有“重新加载”菜单项）'
Write-Host "  · 图库目录：$(Join-Path $ProfileDir "data\$Name\backgrounds")（面板里的「图库」按钮可直接打开）"
Write-Host '  · 卸载：powershell -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1'
