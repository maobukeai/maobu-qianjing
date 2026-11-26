import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");
const testParent = join(projectRoot, "node_modules", ".cache", "windows-installer-artifact-tests");
const psString = (value: string) => "'" + value.replaceAll("'", "''") + "'";

function checkWindowsArtifact(script: string) {
  const executable = Bun.which("pwsh") ?? Bun.which("powershell.exe");
  if (!executable) throw new Error("PowerShell is required for Windows installer verification");
  mkdirSync(testParent, { recursive: true });
  const fixture = mkdtempSync(join(testParent, "artifact-"));
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$fixture = " + psString(fixture),
    ". " + psString(join(import.meta.dir, "windows-installer-artifact.ps1")),
    String.raw`
function Assert-Rejected([scriptblock]$Check, [string]$Reason) {
  try { $null = & $Check } catch {
    if ($_.Exception.Message.Contains($Reason)) { return }
    throw
  }
  throw "Expected failure containing $Reason"
}
`,
    script,
  ].join("\n");
  try {
    const result = Bun.spawnSync(
      [executable, "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")],
      { cwd: projectRoot, stdout: "pipe", stderr: "pipe", windowsHide: true },
    );
    if (result.exitCode !== 0) throw new Error(result.stderr.toString() || result.stdout.toString());
    expect(result.stdout.toString().trim()).toBe("verified");
  } finally {
    const actual = realpathSync(fixture);
    if (relative(realpathSync(testParent), dirname(actual)) !== "") throw new Error("Unsafe installer test cleanup");
    rmSync(actual, { recursive: true, force: true });
  }
}

test.skipIf(process.platform !== "win32")("selects the fresh installer from Cargo metadata and rejects stale or mismatched artifacts", () => {
  checkWindowsArtifact(String.raw`
foreach ($script in @('windows-installer-artifact.ps1', 'build-windows-installer.ps1', 'release-build-windows.ps1')) {
  $tokens = $null
  $errors = $null
  $null = [Management.Automation.Language.Parser]::ParseFile(
    (Join-Path (Get-Location).Path "scripts/$script"), [ref]$tokens, [ref]$errors
  )
  if ($errors.Length) { throw ($errors | Out-String) }
}

# Use a framework DLL only as an inert file with embedded Win32 version metadata.
$source = Get-Item -LiteralPath ([object].Assembly.Location)
$version = $source.VersionInfo.ProductVersion
$product = 'Maobu installer fixture'
$override = Join-Path $fixture 'custom target'
function cargo {
  $global:LASTEXITCODE = 0
  @{ target_directory = $override } | ConvertTo-Json -Compress
}
$target = Get-MaobuCargoTargetDirectory $fixture
if ($target -cne $override) { throw 'Ignored the actual Cargo target directory' }
$bundle = Join-Path $target 'release/bundle/nsis'
New-Item -ItemType Directory -Path $bundle -Force | Out-Null
$file = Join-Path $bundle "$($product)_$($version)_x64-setup.exe"
Copy-Item -LiteralPath $source.FullName -Destination $file
$started = [DateTime]::UtcNow.AddSeconds(-10)
[IO.File]::SetLastWriteTimeUtc($file, $started.AddSeconds(-10))
Assert-Rejected { Get-MaobuFreshWindowsInstaller $target $product $version $started } 'fresh Windows x64 installer'
[IO.File]::SetLastWriteTimeUtc($file, $started.AddSeconds(2))
$selected = Get-MaobuFreshWindowsInstaller $target $product $version $started
if ($selected.FullName -cne $file) { throw 'Selected the wrong installer' }

Copy-Item -LiteralPath $file -Destination (Join-Path $bundle "$($product)_0.0.0_x64-setup.exe")
Assert-Rejected { Get-MaobuFreshWindowsInstaller $target $product '0.0.0' $started } 'product version differs'
Assert-Rejected { Get-MaobuFreshWindowsInstaller 'C:relative' $product $version $started } 'invalid build directory'
Assert-Rejected { Get-MaobuFreshWindowsInstaller $target '../escape' $version $started } 'expected Windows installer name is invalid'
'verified'
`);
});

test.skipIf(process.platform !== "win32")("rejects redirected installer folders and hard-linked inputs", () => {
  checkWindowsArtifact(String.raw`
$target = Join-Path $fixture 'cargo target'
$release = Join-Path $target 'release'
$outside = Join-Path $fixture 'other files'
New-Item -ItemType Directory -Path $release, (Join-Path $outside 'nsis') -Force | Out-Null
$started = [DateTime]::UtcNow.AddSeconds(-10)
New-Item -ItemType Junction -Path (Join-Path $release 'bundle') -Target $outside | Out-Null
Assert-Rejected { Get-MaobuFreshWindowsInstaller $target 'Maobu fixture' '1.0.0' $started } 'ordinary directories'

$clean = Join-Path $fixture 'regular target'
$nsis = Join-Path $clean 'release/bundle/nsis'
New-Item -ItemType Directory -Path $nsis -Force | Out-Null
$original = Join-Path $outside 'inert.bin'
[IO.File]::WriteAllText($original, 'Only inert data')
New-Item -ItemType HardLink -Path (Join-Path $nsis 'Maobu fixture_1.0.0_x64-setup.exe') -Target $original | Out-Null
Assert-Rejected { Get-MaobuFreshWindowsInstaller $clean 'Maobu fixture' '1.0.0' $started } 'regular file without links'
'verified'
`);
});
