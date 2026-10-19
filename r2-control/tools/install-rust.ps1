$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$env:RUSTUP_HOME = Join-Path $workspace 'tools\rustup'
$env:CARGO_HOME = Join-Path $workspace 'tools\cargo'
$installer = Join-Path $PSScriptRoot 'rustup-init.exe'
if (-not (Test-Path -LiteralPath $installer)) {
    Invoke-WebRequest 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-gnu/rustup-init.exe' -OutFile $installer
}
& $installer -y --no-modify-path --profile minimal --default-host x86_64-pc-windows-gnu --default-toolchain stable
if ($LASTEXITCODE -ne 0) { throw 'Rust installation failed.' }
& (Join-Path $env:CARGO_HOME 'bin\rustc.exe') --version
