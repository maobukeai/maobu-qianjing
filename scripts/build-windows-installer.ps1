[CmdletBinding()]
param([string]$OutputDirectory = "")
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-installer-artifact.ps1')
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$config = Get-Content -LiteralPath (Join-Path $projectRoot 'src-tauri\tauri.conf.json') -Raw -Encoding UTF8 | ConvertFrom-Json

if (-not $OutputDirectory) {
  $OutputDirectory = "dist/rc-$($config.version)"
}

$sourceFile = New-TemporaryFile
$publisherVariableNames = @(
  'MAOBU_UPDATE_PUBLIC_KEY', 'MAOBU_UPDATE_ENDPOINT', 'TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
  'MAOBU_WINDOWS_CERTIFICATE_THUMBPRINT', 'MAOBU_WINDOWS_TIMESTAMP_URL', 'MAOBU_WINDOWS_TIMESTAMP_PROTOCOL'
)
$publisherEnvironment = @{}
foreach ($variable in $publisherVariableNames) {
  $publisherEnvironment[$variable] = [Environment]::GetEnvironmentVariable($variable, 'Process')
}

Push-Location $projectRoot
try {
  $source = & node scripts/candidate-build.mjs source --project $projectRoot --output $OutputDirectory
  if ($LASTEXITCODE -ne 0) { throw 'Candidate version, source, or output preflight failed' }
  $validatedVersion = ($source | ConvertFrom-Json).version
  if ($validatedVersion -ne [string]$config.version) {
    throw 'Candidate configuration changed before compilation'
  }
  [IO.File]::WriteAllText($sourceFile.FullName, ($source -join "`n"), [Text.UTF8Encoding]::new($false))

  # Candidate builds cannot inherit publisher credentials or a live update channel.
  foreach ($variable in $publisherVariableNames) {
    [Environment]::SetEnvironmentVariable($variable, $null, 'Process')
  }
  $targetRoot = Get-MaobuCargoTargetDirectory $projectRoot

  & bun --no-env-file run desktop:prepare
  if ($LASTEXITCODE -ne 0) { throw 'Local desktop resource preparation failed' }
  $builtVersion = (Get-Content -LiteralPath 'src-tauri/generated/VERSION.txt' -Raw).Trim()
  if ($builtVersion -ne $validatedVersion) { throw 'Bundled backend version differs from the candidate version' }
  $browserMetadata = Get-Content -LiteralPath 'src-tauri/generated/browser.json' -Raw | ConvertFrom-Json
  $browserEngines = if ($null -eq $browserMetadata.firefox) { 'on-demand' } else { 'bundled-firefox' }

  $packagingStarted = [DateTime]::UtcNow
  & node node_modules/@tauri-apps/cli/tauri.js build --bundles nsis --no-sign
  if ($LASTEXITCODE -ne 0) { throw 'Local Windows installer build failed' }
  $installer = Get-MaobuFreshWindowsInstaller $targetRoot $config.productName $validatedVersion $packagingStarted
  if ((Get-AuthenticodeSignature -LiteralPath $installer.FullName).Status -ne 'NotSigned') { throw 'The candidate builder requires an unsigned Windows installer' }

  & node scripts/candidate-build.mjs record --project $projectRoot --output $OutputDirectory --installer $installer.FullName --source $sourceFile.FullName --browser-engines $browserEngines
  if ($LASTEXITCODE -ne 0) { throw 'Candidate output verification failed' }
} finally {
  try {
    foreach ($variable in $publisherVariableNames) {
      [Environment]::SetEnvironmentVariable($variable, $publisherEnvironment[$variable], 'Process')
    }
  } finally {
    Pop-Location
    Remove-Item -LiteralPath $sourceFile.FullName -ErrorAction SilentlyContinue
  }
}
