use std::{env, path::PathBuf, process::Command};
fn main() {
    println!("cargo:rerun-if-changed=app/assets/attack-shark.ico");
    println!("cargo:rerun-if-changed=app/assets/app-icon.rc");
    println!("cargo:rerun-if-env-changed=R2_LLVM_MINGW");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let root = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let output = PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("app-icon.o");
    let llvm = env::var_os("R2_LLVM_MINGW").map(PathBuf::from).unwrap_or_else(||
        root.join("tools/llvm-mingw/llvm-mingw-20260519-msvcrt-x86_64"));
    let tool = llvm.join("bin/x86_64-w64-mingw32-windres.exe");
    let status = Command::new(tool)
        .current_dir(root.join("app/assets"))
        .args(["-i", "app-icon.rc", "-O", "coff", "-o"])
        .arg(&output)
        .status()
        .expect("Windows resource compiler missing; see README.md");
    assert!(status.success(), "Could not compile the application icon");
    println!("cargo:rustc-link-arg={}", output.display());
}
