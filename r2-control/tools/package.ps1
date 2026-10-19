param([switch]$SkipBuild, [string]$OutputDirectory, [string]$HelperPath)
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$targetDirectory = if ($env:CARGO_TARGET_DIR) { [System.IO.Path]::GetFullPath($env:CARGO_TARGET_DIR) } else { Join-Path $workspace 'target' }
$llvmRoot = if ($env:R2_LLVM_MINGW) { $env:R2_LLVM_MINGW } else { Join-Path $PSScriptRoot 'llvm-mingw\llvm-mingw-20260519-msvcrt-x86_64' }
$helper = if ($HelperPath) { $HelperPath } elseif ($env:R2_HELPER_PATH) { $env:R2_HELPER_PATH } else { Join-Path $workspace 'vendor\iot_driver.exe' }
if (-not (Test-Path -LiteralPath $helper)) { throw 'Supply the hardware helper locally with -HelperPath, R2_HELPER_PATH, or vendor/iot_driver.exe. See README.md.' }
if ((Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash -ne '73BAD815658FA9AED3FA4D18A5123004AFE4B263EB8C38C7B636F0B821F31AAD') { throw 'Original hardware helper identity does not match.' }
function Copy-PackageFile([string]$Source, [string]$Destination) {
    if ((Test-Path -LiteralPath $Destination) -and (Get-FileHash -LiteralPath $Source).Hash -eq (Get-FileHash -LiteralPath $Destination).Hash) { return }
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
}
& (Join-Path $PSScriptRoot 'build-launcher.ps1')
if (-not $SkipBuild) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'cargo.ps1') build --release --locked
    if ($LASTEXITCODE -ne 0) { throw 'Release build failed.' }
}
$output = if ($OutputDirectory) { [System.IO.Path]::GetFullPath($OutputDirectory) } else { Join-Path $workspace 'dist\R2Control' }
New-Item -ItemType Directory -Path $output -Force | Out-Null
Copy-PackageFile (Join-Path $targetDirectory 'release\r2-control.exe') (Join-Path $output 'R2Control.exe')
Copy-PackageFile (Join-Path $llvmRoot 'bin\libunwind.dll') (Join-Path $output 'libunwind.dll')
$loader = Get-ChildItem -Path (Join-Path $targetDirectory 'release\build\webview2-com-sys-*\out\x64\WebView2Loader.dll') | Select-Object -First 1
if (-not $loader) { throw 'WebView2Loader.dll was not produced by the build.' }
Copy-PackageFile $loader.FullName (Join-Path $output 'WebView2Loader.dll')
Copy-PackageFile $helper (Join-Path $output 'iot_driver.exe')
Copy-Item -LiteralPath (Join-Path $workspace 'README.md') -Destination $output -Force
Copy-Item -LiteralPath (Join-Path $workspace 'app\assets\attack-shark.ico') -Destination $output -Force
Get-ChildItem -LiteralPath $output -File | Where-Object Name -ne 'SHA256SUMS.txt' | ForEach-Object {
    '{0}  {1}' -f (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(), $_.Name
} | Set-Content -LiteralPath (Join-Path $output 'SHA256SUMS.txt') -Encoding ascii
Write-Output "Packaged desktop app: $output"
