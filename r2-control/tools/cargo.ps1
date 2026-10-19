# 2026-10-16: Toolchain workaround for a DEP crash (0xC0000005) in any Rust binary
# linking crates like tokio/reqwest when built with the self-contained GNU
# (gcc/binutils) linker. Diagnosis: crash originates in std's Windows compat
# import-shim path right after startup; triggered only with larger links.
# Fix verified empirically on the probe project (tokio + reqwest + anyhow):
# link with llvm-mingw 20260519's clang-driver (x86_64-w64-mingw32-gcc.exe),
# which uses ld.lld and msvcrt runtime. rustc still passes -lgcc/-lgcc_eh on
# its linker line; llvm-mingw has no libgcc, so tiny stub archives satisfy the
# name lookup and the real unwind ABI comes from llvm-mingw's libunwind.
#   - libgcc.a/libgcc_eh.a stubs live in tools\mingw-stubs
#   - unwind is added via -C link-arg=-lunwind below
# If a future rust/llvm update changes this, re-test with the token probe:
#   cargo build in a project containing tokio/reqwest/anyhow and RUN the exe.
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$env:RUSTUP_HOME = if ($env:R2_RUSTUP_HOME) { $env:R2_RUSTUP_HOME } else { Join-Path $workspace 'tools\rustup' }
$env:CARGO_HOME = if ($env:R2_CARGO_HOME) { $env:R2_CARGO_HOME } else { Join-Path $workspace 'tools\cargo' }
$targetBin = Join-Path $env:RUSTUP_HOME 'toolchains\stable-x86_64-pc-windows-gnu\lib\rustlib\x86_64-pc-windows-gnu\bin'
$llvmRoot = if ($env:R2_LLVM_MINGW) { $env:R2_LLVM_MINGW } else { Join-Path $PSScriptRoot 'llvm-mingw\llvm-mingw-20260519-msvcrt-x86_64' }
$llvmBin = Join-Path $llvmRoot 'bin'
$stubs     = Join-Path $workspace 'tools\mingw-stubs'

# llvm-mingw's bin must be on PATH so its clang/ld.lld/llvm-ar children resolve,
# and so rustc's implicit dlltool lookup prefers the working llvm dlltool.
# ORDER MATTERS: llvmBin comes before targetBin so plain 'dlltool.exe' resolves
# to llvm's (the rust-bundled self-contained dlltool.exe fails with CreateProcess).
$env:PATH = "$env:CARGO_HOME\bin;$llvmBin;$targetBin\self-contained;$targetBin;$env:PATH"
if (-not (Test-Path -LiteralPath (Join-Path $stubs 'libgcc.a')) -or -not (Test-Path -LiteralPath (Join-Path $stubs 'libgcc_eh.a'))) {
    & (Join-Path $PSScriptRoot 'setup-linker.ps1') -LlvmMingwPath $llvmRoot
}

# Linker = llvm-mingw's gcc (clang) driver; it routes to ld.lld + msvcrt.
$env:CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER = Join-Path $llvmBin 'x86_64-w64-mingw32-gcc.exe'

# Encoded flags (\x1f-separated) keep the space-containing paths as single args.
$stubFlag  = '-C' + [char]31 + "link-arg=-L$stubs"
$unwindFlag = '-C' + [char]31 + 'link-arg=-lunwind'
$flags = $stubFlag + [char]31 + $unwindFlag
$env:CARGO_TARGET_X86_64_PC_WINDOWS_GNU_RUSTFLAGS = $flags
$env:CARGO_ENCODED_RUSTFLAGS = ($env:CARGO_ENCODED_RUSTFLAGS, $flags)[!$env:CARGO_ENCODED_RUSTFLAGS]

& (Join-Path $env:CARGO_HOME 'bin\cargo.exe') @args
exit $LASTEXITCODE
