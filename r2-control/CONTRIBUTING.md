# Contributing

Keep changes focused and explain the device, Windows version, and steps needed to reproduce a problem. For hardware-related reports, include the app version and relevant diagnostics with personal information removed.

Do not upload personal macro or profile files, credentials, serial numbers, full device dumps, or other private data. Share only the smallest sanitized excerpt needed to describe an issue. Never ask another user to publish their macros or device data.

For code changes, describe the behavior before and after the change. Run relevant JavaScript or Rust checks when available, and state which checks you ran. Do not include the vendor helper or vendor application in source contributions.

Releases are published from main using the package version in Cargo.toml. Bump it before running the Publish R2 Control workflow; existing release versions are never overwritten. The initial 0.1.0 release is assembled locally using the original validated helper. Subsequent builds obtain that same SHA-256-pinned helper from the initial release asset, keeping it out of Git history. Do not remove that seed asset without replacing the helper acquisition path.
