# R2 Control

A Rust rewrite of the Attack Shark R2 configuration software, with a completely rebuilt UI replacing the broken, clunky ATK interface. Rust handles device communication, validation, local storage and the native window; HTML/CSS/JavaScript provides the embedded WebView2 interface. Hardware access still uses the original vendor helper.

## Features

- DPI stages and colors, polling rate and supported sensor options.
- One button-mapping workspace with the R2 photo, named macro actions and automatic onboard slot allocation.
- Keyboard/mouse recording, editable event timeline, playback modes and JSON import/export.
- Eight onboard profiles, local profiles, reported battery and diagnostics.
- Explicit Apply, readback verification, backups and device-identity checks.

The app configures existing firmware through the original hardware helper. It does not flash firmware. Known packet fields follow inspected original behavior; other mouse variants, physical macro playback and battery-cycle accuracy still need hardware testing.

## What is in this folder

Only application source, required UI assets, regression tests, dependency manifests and small build/test scripts. No personal macros/profiles, credentials, captured device data, recovered vendor application, prebuilt app, compiler distribution or hardware-helper binary is included. This is a source project, not a ready-to-run download.

## Windows build

Use x64 Windows with PowerShell 5.1+. From this project's `r2-control` directory, install the build dependencies with:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/setup.ps1
```

This installs portable Rust/Cargo and LLVM-MinGW under `tools/` when missing, then downloads the Rust libraries specified by `Cargo.toml` and `Cargo.lock`. LLVM's archive is checked against its pinned official SHA-256; the Rust installer is checked against its official checksum before execution. This project has no Python or npm package dependencies, so no `pip install` step is needed. For library downloads alone after toolchain setup, run `tools/cargo.ps1 fetch --locked --target x86_64-pc-windows-gnu`.

The tested build uses Rust 1.99.1 and LLVM-MinGW 20260519 (MSVCRT, x86_64). Setup uses the stable GNU Rust toolchain and the pinned [official LLVM-MinGW release](https://github.com/mstorsjo/llvm-mingw/releases/tag/20260519). Set `R2_LLVM_MINGW` to an existing extracted LLVM toolchain directory (containing `bin`) to reuse it. `tools/setup.ps1 -Offline` reuses cached tools/libraries and fails if anything required is missing.

Before running the app, install the [Microsoft WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) if it is missing. Supply your local copy of the hardware helper, build183, as `vendor/iot_driver.exe`. It must have SHA-256 `73bad815658fa9aed3fa4d18a5123004afe4b263eb8c38c7b636f0b821f31aad`. Packaging verifies this identity. The helper is a separate dependency and is not uploaded or downloaded by setup.

Then test and package:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/cargo.ps1 test --locked
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/package.ps1
```

For a helper stored elsewhere, pass `-HelperPath 'C:\path\to\iot_driver.exe'` to `tools/package.ps1`, or set `R2_HELPER_PATH`. Packaging produces `dist/R2Control/` plus the root `R2Control.exe` launcher. Keep the packaged executable, DLLs and helper together. The adjacent `data/` directory stores local settings and is excluded from Git.

`tools/cargo.ps1` creates two tiny linker compatibility libraries from `tools/linker-stub.c` when needed. The setup uses LLVM-MinGW instead of the Rust self-contained GNU linker because the latter produced startup crashes in the tested build. Do not substitute that linker without runtime verification. Optional `R2_RUSTUP_HOME` and `R2_CARGO_HOME` reuse existing compatible portable Rust caches.

## JavaScript tests

Node.js 20+ or Bun is sufficient; no npm packages are required:

```powershell
node --test backend/*.test.mjs
# or
bun test backend
```

The original-vendor-source extraction test is intentionally omitted because it requires the excluded recovered application and extraction tooling. Its retained packet fixtures still feed the Rust parity tests. The native UI runner embedded in the executable is included because the desktop build references it.

After packaging, `tools/test-desktop.ps1` runs the app in an isolated, hidden, unfocused test mode. Hardware writes are not part of the default suites; one explicit physical-write Rust test remains ignored. New state/recording regressions use synthetic DOM input and intercepted mutation routes.

## Asset provenance

The R2 product photo came from the original vendor interface; Attack Shark names and product imagery remain third-party material. The coral shark app mark is an AI-generated design created for this project. The vendor helper and recovered vendor application are not bundled in this source upload. No project-wide license grant is added by this export.
