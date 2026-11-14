[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$ReleaseVersion,
  [Parameter(Mandatory=$true)][string]$Repository,
  [string]$NotesFile = "",
  [string]$OutputDirectory = ""
)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if ($ReleaseVersion -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$') { throw 'A semantic release version without leading v is required' }
if (-not $env:MAOBU_UPDATE_PUBLIC_KEY -or -not $env:MAOBU_UPDATE_ENDPOINT) { throw 'Configure MAOBU_UPDATE_PUBLIC_KEY and MAOBU_UPDATE_ENDPOINT before building a signed release' }
if (-not $env:TAURI_SIGNING_PRIVATE_KEY) { throw 'TAURI_SIGNING_PRIVATE_KEY is missing. No signing key is generated automatically.' }
if (-not $OutputDirectory) { $OutputDirectory = "dist/release-$ReleaseVersion" }
$outputRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot $OutputDirectory))
if (-not $outputRoot.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Release output must stay inside the project directory' }
$configurationPath = Join-Path $projectRoot 'node_modules/.cache/release/tauri.signed.conf.json'
Push-Location $projectRoot
try {
  & bun scripts/release-config.mjs --version $ReleaseVersion --output $configurationPath --require-private-key true
  if ($LASTEXITCODE -ne 0) { throw 'Signed publisher configuration or source version validation failed' }
  $releaseConfiguration = Get-Content -LiteralPath $configurationPath -Raw | ConvertFrom-Json
  $certificateThumbprint = $releaseConfiguration.bundle.windows.certificateThumbprint
  if ($certificateThumbprint) {
    $certificate = Get-Item -LiteralPath "Cert:\CurrentUser\My\$certificateThumbprint" -ErrorAction SilentlyContinue
    if (-not $certificate -or -not $certificate.HasPrivateKey) {
      throw 'The configured Windows code-signing certificate and private key must be available in the current user personal certificate store.'
    }
  }
  # Runtime preparation does not need access to the signing identity.
  $publisherSigningKey = $env:TAURI_SIGNING_PRIVATE_KEY
  $publisherSigningPassword = $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
  try {
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
    & bun run desktop:prepare
    if ($LASTEXITCODE -ne 0) { throw 'Desktop resource preparation failed' }
  } finally {
    $env:TAURI_SIGNING_PRIVATE_KEY = $publisherSigningKey
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $publisherSigningPassword
    $publisherSigningKey = $null
    $publisherSigningPassword = $null
  }
  & node node_modules/@tauri-apps/cli/tauri.js build --bundles nsis --config $configurationPath
  if ($LASTEXITCODE -ne 0) { throw 'Signed Windows installer build failed' }
  $configuration = Get-Content -LiteralPath (Join-Path $projectRoot 'src-tauri/tauri.conf.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $builtName = "$($configuration.productName)_${ReleaseVersion}_x64-setup.exe"
  $installer = Get-Item -LiteralPath (Join-Path $projectRoot "src-tauri/target/release/bundle/nsis/$builtName") -ErrorAction Stop
  New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
  $destination = Join-Path $outputRoot "MaobuBrowser_${ReleaseVersion}_x64-setup.exe"
  Copy-Item -LiteralPath $installer.FullName -Destination $destination -Force
  $authenticodeVerified = $false
  if ($certificateThumbprint) {
    $authenticode = Get-AuthenticodeSignature -LiteralPath $destination
    if ($authenticode.Status -ne 'Valid' -or $authenticode.SignatureType -ne 'Authenticode' -or
        $authenticode.SignerCertificate.Thumbprint -ne $certificateThumbprint -or -not $authenticode.TimeStamperCertificate) {
      throw 'The final installer must have a valid embedded Authenticode signature from the configured certificate and a timestamp.'
    }
    $authenticodeVerified = $true
  }
  # Sign after assigning the public filename: Tauri authenticates this name in its trusted comment.
  & node node_modules/@tauri-apps/cli/tauri.js signer sign $destination
  if ($LASTEXITCODE -ne 0) { throw 'Official Tauri artifact signing failed' }
  $manifestArguments = @('scripts/release-manifest.mjs', '--assets-dir', $outputRoot, '--repository', $Repository, '--version', $ReleaseVersion)
  if ($NotesFile) { $manifestArguments += @('--notes-file', [IO.Path]::GetFullPath($NotesFile)) }
  & bun @manifestArguments
  if ($LASTEXITCODE -ne 0) { throw 'Release manifest generation failed' }
  & bun scripts/release-manifest.mjs --verify true --assets-dir $outputRoot --repository $Repository --version $ReleaseVersion
  if ($LASTEXITCODE -ne 0) { throw 'Release manifest/checksum verification failed' }
  & cargo run --locked --release --manifest-path src-tauri/Cargo.toml --features release-tools --bin maobu-release-verify -- $destination $ReleaseVersion
  if ($LASTEXITCODE -ne 0) { throw 'Release signature does not match the publisher public key' }
  Copy-Item -LiteralPath (Join-Path $projectRoot 'LICENSE'), (Join-Path $projectRoot 'NOTICE') -Destination $outputRoot -Force
  [ordered]@{ version=$ReleaseVersion; output=$outputRoot; signed=$true; updaterSigned=$true; authenticodeVerified=$authenticodeVerified; uploaded=$false } | ConvertTo-Json -Compress
} finally { Pop-Location }
