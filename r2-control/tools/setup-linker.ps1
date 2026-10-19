param([string]$LlvmMingwPath)
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
if (-not $LlvmMingwPath) {
    $LlvmMingwPath = if ($env:R2_LLVM_MINGW) { $env:R2_LLVM_MINGW } else { Join-Path $PSScriptRoot 'llvm-mingw\llvm-mingw-20260519-msvcrt-x86_64' }
}
$compiler = Join-Path $LlvmMingwPath 'bin\x86_64-w64-mingw32-gcc.exe'
$archiver = Join-Path $LlvmMingwPath 'bin\llvm-ar.exe'
$env:PATH = "$(Join-Path $LlvmMingwPath 'bin');$env:PATH"
if (-not (Test-Path -LiteralPath $compiler) -or -not (Test-Path -LiteralPath $archiver)) {
    throw 'LLVM-MinGW is missing. Follow README.md or set R2_LLVM_MINGW to its extracted directory.'
}
$stubDirectory = Join-Path $PSScriptRoot 'mingw-stubs'
New-Item -ItemType Directory -Path $stubDirectory -Force | Out-Null
$object = Join-Path $stubDirectory 'placeholder.o'
& $compiler -c (Join-Path $PSScriptRoot 'linker-stub.c') -o $object
if ($LASTEXITCODE -ne 0) { throw 'Linker placeholder compilation failed.' }
foreach ($name in @('libgcc.a', 'libgcc_eh.a')) {
    & $archiver rcs (Join-Path $stubDirectory $name) $object
    if ($LASTEXITCODE -ne 0) { throw "Could not create $name." }
}
