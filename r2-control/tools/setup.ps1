[CmdletBinding()]
param([switch]$Offline)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitOperatingSystem) {
    throw 'R2 Control requires x64 Windows.'
}
$workspace = Split-Path -Parent $PSScriptRoot
$env:RUSTUP_HOME = if ($env:R2_RUSTUP_HOME) { $env:R2_RUSTUP_HOME } else { Join-Path $PSScriptRoot 'rustup' }
$env:CARGO_HOME = if ($env:R2_CARGO_HOME) { $env:R2_CARGO_HOME } else { Join-Path $PSScriptRoot 'cargo' }
$llvmName = 'llvm-mingw-20260519-msvcrt-x86_64'
$llvmRoot = if ($env:R2_LLVM_MINGW) { $env:R2_LLVM_MINGW } else { Join-Path $PSScriptRoot "llvm-mingw\$llvmName" }
$compiler = Join-Path $llvmRoot 'bin\x86_64-w64-mingw32-gcc.exe'
if (-not (Test-Path -LiteralPath $compiler)) {
    if ($Offline) { throw 'LLVM-MinGW is missing; run setup without -Offline to download it.' }
    if ($env:R2_LLVM_MINGW) { throw 'R2_LLVM_MINGW does not contain the expected compiler. Correct it or clear it to download the default toolchain.' }
    $downloadDirectory = Join-Path $PSScriptRoot 'llvm-mingw'
    New-Item -ItemType Directory -Path $downloadDirectory -Force | Out-Null
    $archive = Join-Path $downloadDirectory "$llvmName.zip"
    $url = "https://github.com/mstorsjo/llvm-mingw/releases/download/20260519/$llvmName.zip"
    if (-not (Test-Path -LiteralPath $archive)) {
        Write-Output 'Downloading LLVM-MinGW (approximately 170 MB)...'
        Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $archive
    }
    # SHA-256 published in the official GitHub release asset metadata.
    $expectedHash = '2fa481d30909cbdcf740c6dce11a3f1e72224070cde76c0683289f0bb44f4dd9'
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expectedHash) {
        throw "LLVM archive checksum mismatch. Remove the cached archive at $archive and rerun setup."
    }
    Expand-Archive -LiteralPath $archive -DestinationPath $downloadDirectory -Force
    if (-not (Test-Path -LiteralPath $compiler)) { throw 'LLVM-MinGW extraction did not produce the expected compiler.' }
}
$cargo = Join-Path $env:CARGO_HOME 'bin\cargo.exe'
$rustc = Join-Path $env:RUSTUP_HOME 'toolchains\stable-x86_64-pc-windows-gnu\bin\rustc.exe'
if (-not (Test-Path -LiteralPath $cargo) -or -not (Test-Path -LiteralPath $rustc)) {
    if ($Offline) { throw 'The portable GNU Rust toolchain is missing; run setup without -Offline to install it.' }
    if ($env:R2_RUSTUP_HOME -or $env:R2_CARGO_HOME) { throw 'The configured R2 Rust cache is incomplete. Correct its path or clear the R2_RUSTUP_HOME/R2_CARGO_HOME overrides.' }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'install-rust.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'Rust toolchain installation failed.' }
}
Push-Location $workspace
try {
    $fetchArguments = @('fetch', '--locked', '--target', 'x86_64-pc-windows-gnu')
    if ($Offline) { $fetchArguments += '--offline' }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'cargo.ps1') @fetchArguments
    if ($LASTEXITCODE -ne 0) { throw 'Cargo dependency installation failed.' }
} finally { Pop-Location }
Write-Output 'Build dependencies are ready. See README.md to supply the vendor helper and package the app.'
