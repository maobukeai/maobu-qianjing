[CmdletBinding()]
param([string]$OutputDirectory = "dist")
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$config = Get-Content -LiteralPath (Join-Path $projectRoot 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
Push-Location $projectRoot
try {
  & bun run desktop:prepare
  if ($LASTEXITCODE -ne 0) { throw 'Local desktop resource preparation failed' }
  & node node_modules/@tauri-apps/cli/tauri.js build --bundles nsis --no-sign
  if ($LASTEXITCODE -ne 0) { throw 'Local Windows installer build failed' }
} finally { Pop-Location }
$bundleRoot = Join-Path $projectRoot 'src-tauri\target\release\bundle\nsis'
$expectedName = "$($config.productName)_$($config.version)_x64-setup.exe"
$installer = Get-Item -LiteralPath (Join-Path $bundleRoot $expectedName) -ErrorAction Stop
$outputRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot $OutputDirectory))
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
$destination = Join-Path $outputRoot ("MaobuBrowser_" + $config.version + "_x64-setup.exe")
Copy-Item -LiteralPath $installer.FullName -Destination $destination -Force
$hash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
"$hash  $([IO.Path]::GetFileName($destination))" | Set-Content -LiteralPath (Join-Path $outputRoot 'SHA256SUMS.txt') -Encoding utf8
Copy-Item -LiteralPath (Join-Path $projectRoot 'LICENSE'),(Join-Path $projectRoot 'NOTICE') -Destination $outputRoot -Force
[ordered]@{ version=$config.version; path=$destination; bytes=(Get-Item -LiteralPath $destination).Length; sha256=$hash; browserEngines='on-demand' } | ConvertTo-Json -Compress
