$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$env:RUSTUP_HOME = Join-Path $workspace 'tools\rustup'
$env:CARGO_HOME = Join-Path $workspace 'tools\cargo'
$installer = Join-Path $PSScriptRoot 'rustup-init.exe'
$url = 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-gnu/rustup-init.exe'
if (-not (Test-Path -LiteralPath $installer)) {
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $installer
}
$checksum = (Invoke-WebRequest -UseBasicParsing -Uri "$url.sha256").Content
if ($checksum -is [byte[]]) { $checksum = [System.Text.Encoding]::ASCII.GetString($checksum) }
$checksumMatch = [regex]::Match($checksum, '^([a-fA-F0-9]{64})\b')
if (-not $checksumMatch.Success) { throw 'The official Rust installer checksum could not be read.' }
if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ne $checksumMatch.Groups[1].Value) {
    throw 'Rust installer checksum mismatch. Remove tools/rustup-init.exe and rerun setup.'
}
& $installer -y --no-modify-path --profile minimal --default-host x86_64-pc-windows-gnu --default-toolchain stable
if ($LASTEXITCODE -ne 0) { throw 'Rust installation failed.' }
& (Join-Path $env:CARGO_HOME 'bin\rustc.exe') --version
