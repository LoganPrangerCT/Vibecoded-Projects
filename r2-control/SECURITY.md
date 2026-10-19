# Security review

Reviewed October 18, 2026 (America/New_York), before the initial source upload. This is a source review with targeted regression and read-only transport checks, not an independent penetration-test certification.

## Result

No new exploitable first-party app flaw was confirmed in this review. A **confirmed third-party helper CORS weakness** remains, described below. This project does not claim zero vulnerabilities, perfect firmware compatibility or zero risk of device damage.

Three parallel reviews covered the native shell/IPC/helper boundary, the complete renderer/import/recorder flow, and device/storage/protocol validation. The coordinating review additionally checked packaging scripts, dependency advisories, publication contents and the actual local helper listener.

## Threat model and boundaries

The relevant untrusted inputs are imported JSON, user/device labels, helper responses and web content attempting to reach native functionality. An attacker already executing code as the same Windows user can replace a portable app, modify its plain JSON data or contact the vendor helper directly. No administrator isolation, signed installer or authenticated helper protocol is supplied here.

| Area | Controls inspected and tested |
| --- | --- |
| WebView and native IPC | Exact parsed document origin/path gate; 1 MiB request bound; fixed method/path dispatch; serialized JSON responses. Navigation, new windows and permissions are restricted. CSP blocks foreign scripts, frames, objects, forms and base changes. Release DevTools are disabled. |
| Renderer and imported files | No HTML/eval injection sink found in the production renderer. Names and diagnostics use text nodes/textContent. Imports have file/item/shape bounds, fresh local IDs and allowlisted settings; imported upload-association claims are discarded. Export filenames are sanitized and downloads restricted to local blob URLs. Importing does not itself change mouse settings. |
| Macro recorder | Input is captured only after recording starts in its capture area. Stop, Escape, blur and cancellation paths release tracked inputs. Valid macros can intentionally generate repeated or held input; validation cannot determine the user's intent. |
| Files and startup | Collection filenames are fixed internally; imported IDs/names do not become paths. Persistence uses serialized updates, temporary files and backups. Startup uses a fixed HKCU value and quoted executable path without a command shell. Data remains unencrypted local JSON. |
| Helper client | Fixed loopback endpoint, system proxies disabled, redirects disabled, deadlines and response-size bounds. Protobuf parsing rejects overflowing integers and invalid tags/lengths. Helper bytes are SHA-256 checked before the app launches them. |
| Device mutations | Model/connection and numeric limits, selected-device checks, serialized operations, fresh-state preflight, backups, readback and attempted rollback. Only reviewed configuration commands are exposed; this app has no firmware-flashing route. Direct HID code is test-only. |
| Build and publication | Cargo versions/checksums are retained in Cargo.lock; no npm dependencies. Helper identity is checked before packaging. Toolchains, prebuilt executables/DLLs, recovered vendor code, captures, personal collections and credentials are excluded. Build tools and native dependencies remain trusted inputs. |

The native app serves embedded assets through a WebView custom protocol; it does not start a separate HTTP server for the UI. The vendor helper still starts its own service.

## Confirmed third-party issue: permissive helper CORS

The inspected helper is build183 with SHA-256 `73bad815658fa9aed3fa4d18a5123004afe4b263eb8c38c7b636f0b821f31aad`. Its listener was bound to `127.0.0.1:3814`, not a LAN address.

A harmless OPTIONS request and a `getVersion` POST carrying an unrelated HTTPS Origin both returned HTTP 200. The response echoed that Origin in `Access-Control-Allow-Origin` and enabled credentials. The version request required no authentication. No configuration, macro, OTA or other device-write RPC was exercised for this check.

This confirms the helper does not use CORS as an origin allowlist on the tested endpoint. A web page able to make requests to local services may therefore reach it. Browser local-network permissions and other browser policies can restrict that access; this review did not demonstrate browser exploitation or establish which write endpoints accept such requests. Loopback binding alone does not authenticate callers.

The app's restrictive WebView origin gate does not change this external vendor service. Full remediation requires a hardened/replaced helper or removing that service from the transport architecture. Its binary and recovered source are not published with this project. Merely checking its hash does not fix its server behavior.

## Other residual risks

- An already-running helper is reused after a successful version request. Its listening process is not authenticated on each connection, so another local process can impersonate it. Hash validation before launching the app's own helper is a separate control.
- Device invalidation stops later commands but cannot retract an RPC already handed to the helper. Receiver re-pairing/path reuse during an in-flight write remains a narrow wrong-device risk. The protocol does not provide an atomic authenticated mouse-identity check per command.
- Interrupted physical writes, opaque firmware/helper behavior, other processes using the receiver and untested firmware revisions remain outside a source-only proof. Rollback is attempted and checked where implemented; it is not guaranteed to succeed after disconnection.
- The helper, WebView2, Windows, compiler distributions and native DLL internals were not exhaustively audited. A same-user replacement of binaries/DLLs or local files is not prevented by this portable app. Run it without elevation and keep its external runtime/toolchains updated.

## Known dependency advisories

A fresh [OSV](https://google.github.io/osv.dev/api/) query checked all **364 registry packages** in Cargo.lock, including inactive target and build dependencies. Two package versions matched:

- `glib 0.18.5`: [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html), unsound VariantStrIter implementation; GHSA-wrw7-89jp-8q8g is an alias.
- `proc-macro-error 1.0.4`: [RUSTSEC-2024-0370](https://rustsec.org/advisories/RUSTSEC-2024-0370.html), an unmaintained-package notice.

Neither appears in the active Windows GNU dependency graph: inverse `cargo tree --target x86_64-pc-windows-gnu -i <package>` queries returned no path. No matching advisory was returned for the other locked versions. Database silence is not proof of safety, and other operating systems are not supported by this app.

Repeat the advisory lookup with Node.js 20+ or Bun:

```powershell
node tools/audit-dependencies.mjs
```

The script sends only public package names/versions to OSV and saves the timestamped lock hash and full results in ignored `data/dependency-advisories.json`. It fails on incomplete or paginated results rather than treating them as clean. It is a reporting tool; matched advisories need review for platform and reachability.

## Executed checks on the clean source copy

- JavaScript: 105 passed, zero failed.
- Rust: 75 unit checks and 32 integration checks passed; one explicit physical-write check remained ignored.
- Release packaging succeeded. The packaged app passed 163 hidden UI checks with no visible window or focus activation; hardware mutation routes were intercepted. The live DPI-stage check was skipped because no verified device configuration was available during this run.
- Security regressions include hostile origins, malformed/oversized inputs, markup-like labels, redirects, system proxy bypass, oversized responses, malformed protobuf and device-service invalidation.
- Publication scan found no high-confidence token/private-key patterns or private workspace paths in staged text files; excluded-path checks verified no personal/generated/vendor binaries were staged. Automated pattern scans cannot prove the absence of every possible secret.

No mouse configuration or firmware writes were performed for this review. The report distinguishes inspected controls, executed checks and remaining unproven behavior.

Design references: [Microsoft WebView2 security guidance](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/security), [RustSec advisory database](https://rustsec.org/), and the linked OSV API documentation.
