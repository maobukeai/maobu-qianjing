[CmdletBinding()]
param([string]$OutputDirectory = "")
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$config = Get-Content -LiteralPath (Join-Path $projectRoot 'src-tauri\tauri.conf.json') -Raw -Encoding UTF8 | ConvertFrom-Json

Push-Location $projectRoot
try {
  # Enforce 6-file version parity before compiling any candidate installer.
  $versionCheckScript = "import { validateProjectVersions } from './scripts/release-utils.mjs'; process.stdout.write(validateProjectVersions(process.cwd()));"
  $validatedVersion = (& bun --eval $versionCheckScript)
  if ($LASTEXITCODE -ne 0 -or -not $validatedVersion) {
    throw 'Source version validation failed. Align version.ts, package.json, src-tauri/tauri.conf.json, Cargo.toml, Cargo.lock, and agent/runtime-client.mjs before building.'
  }
  $validatedVersion = ($validatedVersion | Out-String).Trim()
  if ($validatedVersion -ne [string]$config.version) {
    throw "Validated version ($validatedVersion) does not match src-tauri/tauri.conf.json ($($config.version))."
  }

  $gitCommit = 'unknown'
  try {
    $resolvedCommit = (& git rev-parse HEAD 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -eq 0 -and $resolvedCommit -match '^[0-9a-fA-F]{40}$') {
      $gitCommit = $resolvedCommit.ToLowerInvariant()
    }
  } catch {
    $gitCommit = 'unknown'
  }

  if (-not $OutputDirectory) {
    $OutputDirectory = "dist/rc-$validatedVersion"
  }
  $outputRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot $OutputDirectory))
  if (-not $outputRoot.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Candidate build output must stay inside the project directory.'
  }

  & bun run desktop:prepare
  if ($LASTEXITCODE -ne 0) { throw 'Local desktop resource preparation failed' }
  & node node_modules/@tauri-apps/cli/tauri.js build --bundles nsis --no-sign
  if ($LASTEXITCODE -ne 0) { throw 'Local Windows installer build failed' }
} finally {
  Pop-Location
}

$bundleRoot = Join-Path $projectRoot 'src-tauri\target\release\bundle\nsis'
$expectedName = "$($config.productName)_${validatedVersion}_x64-setup.exe"
$installer = Get-Item -LiteralPath (Join-Path $bundleRoot $expectedName) -ErrorAction Stop
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null

$artifactName = "MaobuBrowser_${validatedVersion}_x64-setup.exe"
$destination = Join-Path $outputRoot $artifactName
Copy-Item -LiteralPath $installer.FullName -Destination $destination -Force

$hash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
$bytes = (Get-Item -LiteralPath $destination).Length
$utf8NoBom = [Text.UTF8Encoding]::new($false)

[IO.File]::WriteAllText(
  (Join-Path $outputRoot 'SHA256SUMS.txt'),
  "$hash  $artifactName`n",
  $utf8NoBom
)
Copy-Item -LiteralPath (Join-Path $projectRoot 'LICENSE'), (Join-Path $projectRoot 'NOTICE') -Destination $outputRoot -Force

$candidateManifestPath = Join-Path $outputRoot 'CANDIDATE-BUILD.json'
$candidateRecord = [ordered]@{
  version              = $validatedVersion
  artifact             = $artifactName
  bytes                = $bytes
  sha256               = $hash
  signed               = $false
  updaterSigned        = $false
  authenticodeVerified = $false
  browserEngines       = 'on-demand'
  gitCommit            = $gitCommit
  builtAt              = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  signingNote          = 'Unsigned release candidate for local/QA acceptance. Inject MAOBU_UPDATE_PUBLIC_KEY, MAOBU_UPDATE_ENDPOINT, TAURI_SIGNING_PRIVATE_KEY, and optional MAOBU_WINDOWS_CERTIFICATE_THUMBPRINT + MAOBU_WINDOWS_TIMESTAMP_URL via scripts/release-build-windows.ps1 for a signed release.'
}
[IO.File]::WriteAllText(
  $candidateManifestPath,
  (($candidateRecord | ConvertTo-Json -Depth 4) + "`n"),
  $utf8NoBom
)

[ordered]@{
  version              = $validatedVersion
  output               = $outputRoot
  path                 = $destination
  bytes                = $bytes
  sha256               = $hash
  signed               = $false
  updaterSigned        = $false
  authenticodeVerified = $false
  gitCommit            = $gitCommit
  candidateManifest    = $candidateManifestPath
  browserEngines       = 'on-demand'
} | ConvertTo-Json -Compress
