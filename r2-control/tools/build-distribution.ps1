param([switch]$SkipBuild, [string]$HelperPath, [string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $workspace 'dist\release' }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
# Keep the maintainer's local source/cache paths out of distributable binaries.
if ($env:USERPROFILE) {
    $remap = '--remap-path-prefix=' + $env:USERPROFILE + '=C:\build'
    $env:CARGO_ENCODED_RUSTFLAGS = if ($env:CARGO_ENCODED_RUSTFLAGS) { $env:CARGO_ENCODED_RUSTFLAGS + [char]31 + $remap } else { $remap }
}
$package = Join-Path $workspace 'dist\R2Control'
$arguments = @{OutputDirectory=$package}
if ($SkipBuild) { $arguments.SkipBuild=$true }
if ($HelperPath) { $arguments.HelperPath=$HelperPath }
& (Join-Path $PSScriptRoot 'package.ps1') @arguments
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'uninstall-package.ps1') -Destination (Join-Path $package 'Uninstall.ps1') -Force
Copy-Item -LiteralPath (Join-Path $workspace 'THIRD_PARTY_NOTICES.md') -Destination $package -Force
Copy-Item -LiteralPath (Join-Path $workspace 'LICENSE') -Destination $package -Force
$manifest = Get-Content -LiteralPath (Join-Path $workspace 'Cargo.toml') -Raw
if ($manifest -notmatch '(?m)^version = "(\d+\.\d+\.\d+)"$') { throw 'Package version is missing.' }
$Matches[1] | Set-Content -LiteralPath (Join-Path $package 'VERSION.txt') -Encoding ascii
& (Join-Path $PSScriptRoot 'collect-notices.ps1') -OutputPath (Join-Path $package 'THIRD-PARTY-LICENSES.txt')
Get-ChildItem -LiteralPath $package -File | Where-Object Name -ne 'SHA256SUMS.txt' | ForEach-Object {
    '{0}  {1}' -f (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(), $_.Name
} | Set-Content -LiteralPath (Join-Path $package 'SHA256SUMS.txt') -Encoding ascii
$zip = Join-Path $OutputDirectory 'R2Control-Windows-x64.zip'
Compress-Archive -LiteralPath @(Get-ChildItem -LiteralPath $package -File | ForEach-Object FullName) -DestinationPath $zip -Force
$llvm = if ($env:R2_LLVM_MINGW) { $env:R2_LLVM_MINGW } else { Join-Path $PSScriptRoot 'llvm-mingw\llvm-mingw-20260519-msvcrt-x86_64' }
$bin = Join-Path $llvm 'bin'
$env:PATH = "$bin;$env:PATH"
$resource = Join-Path $OutputDirectory 'installer.rc'
$object = Join-Path $OutputDirectory 'installer.o'
$resourceText = '101 RCDATA "' + $zip.Replace('\','\\') + '"' + "`n" + '102 RCDATA "' + (Join-Path $PSScriptRoot 'install-package.ps1').Replace('\','\\') + '"' + "`n" + '1 ICON "' + (Join-Path $workspace 'app\assets\attack-shark.ico').Replace('\','\\') + '"'
[IO.File]::WriteAllText($resource, $resourceText, [Text.UTF8Encoding]::new($false))
& (Join-Path $bin 'x86_64-w64-mingw32-windres.exe') -i $resource -O coff -o $object
if ($LASTEXITCODE -ne 0) { throw 'Installer resource compilation failed.' }
$installer = Join-Path $OutputDirectory 'R2Control-Setup.exe'
& (Join-Path $bin 'x86_64-w64-mingw32-clang.exe') -Os -Wall -Wextra -Werror -municode -mwindows (Join-Path $PSScriptRoot 'installer.c') $object -lole32 -o $installer
if ($LASTEXITCODE -ne 0) { throw 'Installer compilation failed.' }
@($installer, $zip) | ForEach-Object { '{0}  {1}' -f (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant(), [IO.Path]::GetFileName($_) } | Set-Content -LiteralPath (Join-Path $OutputDirectory 'SHA256SUMS.txt') -Encoding ascii
Write-Output "Release assets: $OutputDirectory"
