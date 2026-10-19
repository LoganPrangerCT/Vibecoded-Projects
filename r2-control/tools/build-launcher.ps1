param([switch]$Force)
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$llvmRoot = if ($env:R2_LLVM_MINGW) { $env:R2_LLVM_MINGW } else { Join-Path $PSScriptRoot 'llvm-mingw\llvm-mingw-20260519-msvcrt-x86_64' }
$compilerDirectory = Join-Path $llvmRoot 'bin'
$env:PATH = "$compilerDirectory;$env:PATH"
$launcher = Join-Path $workspace 'R2Control.exe'
$inputs = @((Join-Path $PSScriptRoot 'launcher.c'), (Join-Path $compilerDirectory 'x86_64-w64-mingw32-clang.exe'), (Join-Path $workspace 'app\assets\app-icon.rc'), (Join-Path $workspace 'app\assets\attack-shark.ico'))
$newestInput = ($inputs | Get-Item | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1).LastWriteTimeUtc
if (-not $Force -and (Test-Path -LiteralPath $launcher) -and (Get-Item -LiteralPath $launcher).LastWriteTimeUtc -ge $newestInput) {
    Write-Output ('Native launcher is current: ' + $launcher)
    return
}
$resourceObject = Join-Path $workspace 'target\launcher-icon.o'
New-Item -ItemType Directory -Path (Join-Path $workspace 'target') -Force | Out-Null
Push-Location (Join-Path $workspace 'app\assets')
try {
    & (Join-Path $compilerDirectory 'x86_64-w64-mingw32-windres.exe') -i app-icon.rc -O coff -o $resourceObject
    if ($LASTEXITCODE -ne 0) { throw 'Launcher icon compilation failed.' }
} finally { Pop-Location }
& (Join-Path $compilerDirectory 'x86_64-w64-mingw32-clang.exe') -Os -Wall -Wextra -Werror -municode -mwindows (Join-Path $PSScriptRoot 'launcher.c') $resourceObject -o (Join-Path $workspace 'target\launcher.exe')
if ($LASTEXITCODE -ne 0) { throw 'Native launcher build failed.' }
if ((Test-Path -LiteralPath $launcher) -and (Get-FileHash -LiteralPath $launcher).Hash -eq (Get-FileHash -LiteralPath (Join-Path $workspace 'target\launcher.exe')).Hash) {
    Write-Output ('Native launcher is unchanged: ' + $launcher)
    return
}
Copy-Item -LiteralPath (Join-Path $workspace 'target\launcher.exe') -Destination $launcher -Force
Write-Output ('Native launcher: ' + (Join-Path $workspace 'R2Control.exe'))
