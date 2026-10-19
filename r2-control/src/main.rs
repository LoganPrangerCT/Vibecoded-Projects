#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod application;
mod desktop;
mod device;
mod driver;
#[cfg(test)]
#[allow(dead_code, unused_imports)]
mod hid;
mod protocol;
#[cfg(test)]
#[path = "../backend/protocol-source-fixtures.rs"]
mod protocol_source_fixtures;
mod smoke;

use std::path::PathBuf;
fn workspace() -> anyhow::Result<PathBuf> {
    if let Some(root) = std::env::var_os("R2_HOME") {
        return Ok(PathBuf::from(root));
    }
    let executable = std::env::current_exe()?;
    let folder = executable.parent().unwrap();
    if folder
        .file_name()
        .is_some_and(|n| n == "debug" || n == "release")
        && folder
            .parent()
            .is_some_and(|p| p.file_name().is_some_and(|n| n == "target"))
    {
        return Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")));
    }
    Ok(folder.into())
}
fn main() {
    if let Err(error) = run() {
        let message = format!("R2 Control: {error:#}");
        eprintln!("{message}");
        if let Ok(root) = workspace() {
            let _ = std::fs::create_dir_all(root.join("data"));
            let _ = std::fs::write(root.join("data/startup-error.log"), message);
        }
        std::process::exit(1);
    }
}
fn run() -> anyhow::Result<()> {
    let root = workspace()?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?;
    if std::env::args().any(|a| a == "--smoke") {
        return runtime.block_on(smoke::run(std::sync::Arc::new(driver::DriverClient::new())));
    }
    let application = runtime.block_on(application::Application::new(root))?;
    desktop::run(application, runtime)
}
