param([Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
Push-Location $workspace
try {
    $json = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'cargo.ps1') metadata --locked --offline --filter-platform x86_64-pc-windows-gnu --format-version 1
    if ($LASTEXITCODE -ne 0) { throw 'Cannot collect dependency license metadata.' }
    $metadata = ($json -join "`n") | ConvertFrom-Json
    $active = @{}
    foreach ($node in $metadata.resolve.nodes) { $active[$node.id] = $true }
    $text = [Text.StringBuilder]::new()
    [void]$text.AppendLine('R2 Control third-party dependency notices')
    [void]$text.AppendLine('This file retains license texts distributed with active Windows Cargo dependencies, including development/build tools. Inclusion does not imply every tool is linked into the executable.')
    foreach ($package in ($metadata.packages | Sort-Object name,version)) {
        if (-not $package.source -or -not $active.ContainsKey($package.id)) { continue }
        [void]$text.AppendLine("`n=== $($package.name) $($package.version) ===")
        [void]$text.AppendLine("Declared license: $($package.license)")
        $directory = Split-Path -Parent $package.manifest_path
        $files = @(Get-ChildItem -LiteralPath $directory -File | Where-Object Name -Match '^(LICENSE|LICENCE|COPYING|NOTICE|UNLICENSE)(\.|-|$)')
        if ($package.license_file) { $files += Get-Item -LiteralPath (Join-Path $directory $package.license_file) }
        foreach ($file in ($files | Sort-Object FullName -Unique)) { [void]$text.AppendLine("--- $($file.Name) ---"); [void]$text.AppendLine([IO.File]::ReadAllText($file.FullName)) }
    }
    $llvm = if ($env:R2_LLVM_MINGW) { $env:R2_LLVM_MINGW } else { Join-Path $PSScriptRoot 'llvm-mingw\llvm-mingw-20260519-msvcrt-x86_64' }
    [void]$text.AppendLine("`n=== LLVM-MinGW / libunwind ===")
    [void]$text.AppendLine([IO.File]::ReadAllText((Join-Path $llvm 'LICENSE.TXT')))
    [void]$text.AppendLine("`n=== Microsoft WebView2Loader ===`nMicrosoft WebView2 SDK: https://www.nuget.org/packages/Microsoft.Web.WebView2/ (Microsoft's SDK/runtime terms apply).")
    [IO.File]::WriteAllText([IO.Path]::GetFullPath($OutputPath), $text.ToString(), [Text.UTF8Encoding]::new($false))
} finally { Pop-Location }
