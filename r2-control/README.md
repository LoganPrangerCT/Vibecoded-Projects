# R2 Control

A Rust rewrite of the Attack Shark R2 configuration software, with a completely rebuilt UI replacing the broken, clunky ATK interface. It provides DPI stages and colors, polling rate, button mappings, macros, profiles, battery reporting and diagnostics.

[![Windows checks](https://github.com/LoganPrangerCT/Vibecoded-Projects/actions/workflows/r2-control-ci.yml/badge.svg)](https://github.com/LoganPrangerCT/Vibecoded-Projects/actions/workflows/r2-control-ci.yml)

## Download and install

Download **[R2Control-Setup.exe](https://github.com/LoganPrangerCT/Vibecoded-Projects/releases/download/r2-control-v0.1.0/R2Control-Setup.exe)** and run it. The installer adds R2 Control to the Start Menu and Windows Apps list. It checks for WebView2 and the Visual C++ x86 runtime and installs them from Microsoft if missing; that step needs internet access and may request Windows administrator approval.

For a portable install, download **[R2Control-Windows-x64.zip](https://github.com/LoganPrangerCT/Vibecoded-Projects/releases/download/r2-control-v0.1.0/R2Control-Windows-x64.zip)**, extract the entire archive, and run `R2Control.exe`. Keep the extracted files together. The portable version requires WebView2 and the Visual C++ x86 runtime to already be installed. Release downloads are on the [Releases page](https://github.com/LoganPrangerCT/Vibecoded-Projects/releases/tag/r2-control-v0.1.0); GitHub's **Source code ZIP** contains developer files rather than the runnable app.

Both packages include the original validated hardware helper and required app DLLs. No Rust, Python, Node.js or compiler is needed to run them. They are built for Windows x64. Connect the R2 over 2.4 GHz wireless and make sure it is awake. Review settings and assignments before selecting **Apply**. Selecting an onboard profile switches it immediately.

The installer uses `%LOCALAPPDATA%\Programs\R2Control`. Settings and macros stay in its `data/` folder during updates and uninstall. Close R2 Control before updating or uninstalling. The executables are not code-signed; Windows may show an unknown-publisher prompt. Release SHA-256 checksums are provided alongside the downloads.

## Scope and limitations

R2 Control configures settings through the original vendor hardware helper. It does not flash firmware. The helper is a closed vendor component; its behavior and trust boundaries remain local to that component, and this project cannot guarantee every device or setting will behave correctly. Keep backups of important settings and verify changes on your device.

The helper's local service is unauthenticated and has permissive CORS behavior on the tested version endpoint. This replacement UI does not fix that vendor-server limitation. Compatibility with every firmware revision and physical macro playback sequence has not been established.

This is an independent project and is not officially affiliated with or endorsed by Attack Shark. Product names and marks belong to their respective owners. See [Third-party notices](THIRD_PARTY_NOTICES.md).

## Development build

Source builds are for developers. The validated toolchain is Rust 1.99.1 and LLVM-MinGW 20260519 (MSVCRT, x86_64), on Windows x64 with PowerShell 5.1+. The original helper is not tracked in Git; setup obtains the exact validated build from the initial release and checks its SHA-256 before use.

From this directory, prepare the toolchain and dependencies:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/setup.ps1
```

Then package:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/package.ps1
```

The release distribution is assembled with:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/build-distribution.ps1
```

The distribution script produces the installer and portable archive for release. Do not publish private profiles, macros, credentials, or captured device data. See [Contributing](CONTRIBUTING.md) for issue and patch guidance.

To use an existing helper, pass `-HelperPath 'C:\path\to\iot_driver.exe'` to the packaging script. For toolchain-only setup use `tools/setup.ps1 -SkipHelper`; `-Offline` reuses cached build dependencies. Rust libraries are managed by `Cargo.toml` and `Cargo.lock`; there are no Python or npm package dependencies.

Tests:

```powershell
node --test
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/cargo.ps1 test --locked
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/test-desktop.ps1
```

Node.js 22+ is used in CI for JavaScript tests. The desktop check runs hidden and intercepts hardware mutations. One Rust physical-write test remains ignored by default. GitHub Actions runs Windows regression checks on changes; the **Publish R2 Control** workflow builds releases after the package version is bumped.

## License

Original R2 Control code is [MIT licensed](LICENSE). The vendor helper, product imagery and third-party libraries retain their own terms; they are not relicensed by the MIT grant. The release includes dependency license texts and third-party notices.
