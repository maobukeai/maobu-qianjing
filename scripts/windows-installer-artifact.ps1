function Resolve-MaobuInstallerTargetPath([object]$Path) {
  if ($Path -isnot [string] -or [string]::IsNullOrWhiteSpace($Path) -or
      -not [IO.Path]::IsPathRooted($Path) -or [IO.Path]::GetPathRoot($Path).Length -le 2 -or
      $Path -match '^[\\/]{2}[?.][\\/]') {
    throw 'Cargo returned an invalid build directory'
  }
  [IO.Path]::GetFullPath($Path)
}

function Get-MaobuCargoTargetDirectory([string]$ProjectRoot) {
  $metadata = & cargo metadata --locked --no-deps --format-version 1 --manifest-path (Join-Path $ProjectRoot 'src-tauri/Cargo.toml')
  if ($LASTEXITCODE -ne 0) { throw 'Could not resolve the Cargo build directory' }
  Resolve-MaobuInstallerTargetPath ($metadata | ConvertFrom-Json).target_directory
}

function Get-MaobuFreshWindowsInstaller(
  [string]$TargetDirectory,
  [string]$ProductName,
  [string]$Version,
  [datetime]$PackagingStarted
) {
  $name = "$($ProductName)_$($Version)_x64-setup.exe"
  if ([string]::IsNullOrWhiteSpace($ProductName) -or [string]::IsNullOrWhiteSpace($Version) -or
      $name.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0) {
    throw 'The expected Windows installer name is invalid'
  }

  $target = Resolve-MaobuInstallerTargetPath $TargetDirectory
  $bundle = Join-Path $target 'release/bundle'
  $nsis = Join-Path $bundle 'nsis'
  foreach ($path in @($target, (Join-Path $target 'release'), $bundle, $nsis)) {
    $section = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    if ($section -isnot [IO.DirectoryInfo] -or ($section.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw 'The Cargo installer path must use ordinary directories'
    }
  }
  $installer = Get-Item -LiteralPath (Join-Path $nsis $name) -Force -ErrorAction Stop
  if ($installer -isnot [IO.FileInfo] -or $installer.Length -le 0 -or $installer.LinkType -or
      ($installer.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'The Windows installer must be a regular file without links'
  }
  if ($installer.LastWriteTimeUtc -lt $PackagingStarted.ToUniversalTime()) {
    throw 'Tauri did not write a fresh Windows x64 installer to the Cargo build directory'
  }
  if ($installer.VersionInfo.ProductVersion -cne $Version) {
    throw 'The Windows installer product version differs from the requested version'
  }
  $installer
}
