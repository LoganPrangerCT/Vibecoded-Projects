use crate::application::Application;
use anyhow::Result;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    borrow::Cow,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tao::{
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder},
    window::WindowBuilder,
};
use tray_icon::{
    menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem},
    TrayIconBuilder, TrayIconEvent,
};
use wry::{
    http::{Request, Response},
    NewWindowResponse, PermissionResponse, WebContext, WebViewBuilder,
};

const TITLE: &str = "Attack Shark · R2 Control";
#[derive(Debug)]
enum UserEvent {
    Script(String),
    Show,
    Menu(String),
    Exit,
    TestFinished(bool),
    Capture(u64, String),
    TestViewport(u64, u32, u32),
}
#[derive(Deserialize)]
struct Ipc {
    id: u64,
    method: String,
    path: String,
    #[serde(default)]
    data: Value,
}

fn trusted_document(url: &str) -> bool {
    let Ok(uri) = url.parse::<wry::http::Uri>() else { return false; };
    let local = matches!((uri.scheme_str(), uri.authority().map(|a| a.as_str())),
        (Some("r2"), Some("localhost")) | (Some("http"), Some("r2.localhost")));
    local && matches!(uri.path(), "/" | "/index.html")
}

fn local_export(url: &str) -> bool {
    url.starts_with("blob:http://r2.localhost/") || url.starts_with("blob:r2://localhost/")
}

fn asset(path: &str) -> (&'static str, &'static [u8]) {
    match path {
        "/" | "/index.html" => ("text/html", include_bytes!("../app/index.html")),
        "/style.css" => ("text/css", include_bytes!("../app/style.css")),
        "/macro.css" => ("text/css", include_bytes!("../app/macro.css")),
        "/interactions.css" => ("text/css", include_bytes!("../app/interactions.css")),
        "/interactions.js" => ("text/javascript", include_bytes!("../app/interactions.js")),
        "/assignments.css" => ("text/css", include_bytes!("../app/assignments.css")),
        "/assignments.js" => ("text/javascript", include_bytes!("../app/assignments.js")),
        "/main.js" => ("text/javascript", include_bytes!("../app/main.js")),
        "/dashboard.js" => ("text/javascript", include_bytes!("../app/dashboard.js")),
        "/recorder.js" => ("text/javascript", include_bytes!("../app/recorder.js")),
        "/manual-events.js" => ("text/javascript", include_bytes!("../app/manual-events.js")),
        "/assets/r2-mouse.png" => ("image/png", include_bytes!("../app/assets/r2-mouse.png")),
        "/assets/attack-shark-mark.png" => (
            "image/png",
            include_bytes!("../app/assets/attack-shark-mark.png"),
        ),
        "/assets/favicon.png" => ("image/png", include_bytes!("../app/assets/favicon.png")),
        "/assets/attack-shark.ico" => (
            "image/x-icon",
            include_bytes!("../app/assets/attack-shark.ico"),
        ),
        _ => ("text/plain", b"Not found"),
    }
}
pub fn run(app: Arc<Application>, runtime: tokio::runtime::Runtime) -> Result<()> {
    let hidden =
        std::env::args().any(|a| a == "--hidden" || a == "--background" || a == "--ui-smoke");
    let test = std::env::args().any(|a| a == "--ui-smoke");
    let _instance = SingleInstance::acquire(hidden, test)?;
    if !_instance.primary {
        return Ok(());
    }
    let test_done = Arc::new(AtomicBool::new(false));
    if test {
        std::fs::write(
            app.root.join("data/ui-smoke-result.json"),
            b"{\"ok\":false,\"pending\":true}",
        )?;
    }
    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let pixels = include_bytes!("../app/assets/icon-64.rgba").to_vec();
    let icon = tao::window::Icon::from_rgba(pixels.clone(), 64, 64)?;
    let monitor = event_loop.primary_monitor();
    let (width, height) = monitor
        .map(|m| {
            let s = m.size().to_logical::<f64>(m.scale_factor());
            ((s.width * 0.85).min(1280.0), (s.height * 0.85).min(840.0))
        })
        .unwrap_or((1200.0, 788.0));
    let window = WindowBuilder::new()
        .with_title(TITLE)
        .with_inner_size(tao::dpi::LogicalSize::new(width, height))
        .with_min_inner_size(tao::dpi::LogicalSize::new(800.0, 560.0))
        .with_window_icon(Some(icon))
        .with_theme(Some(tao::window::Theme::Dark))
        .with_visible(!hidden)
        .with_focused(false)
        .build(&event_loop)?;
    let menu = Menu::new();
    let show = MenuItem::new("Open R2 Control", true, None);
    let quit = MenuItem::new("Quit", true, None);
    menu.append_items(&[&show, &PredefinedMenuItem::separator(), &quit])?;
    let show_id = show.id().as_ref().to_string();
    let quit_id = quit.id().as_ref().to_string();
    let _tray = TrayIconBuilder::new()
        .with_tooltip("R2 Control")
        .with_menu(Box::new(menu))
        .with_icon(tray_icon::Icon::from_rgba(pixels, 64, 64)?)
        .build()?;
    let menu_proxy = proxy.clone();
    MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
        let _ = menu_proxy.send_event(UserEvent::Menu(event.id.as_ref().to_string()));
    }));
    let tray_proxy = proxy.clone();
    TrayIconEvent::set_event_handler(Some(move |event: TrayIconEvent| {
        if matches!(event, TrayIconEvent::DoubleClick { .. }) {
            let _ = tray_proxy.send_event(UserEvent::Show);
        }
    }));
    let mut context = WebContext::new(Some(app.root.join("data/webview")));
    let ipc_app = app.clone();
    let ipc_proxy = proxy.clone();
    let handle = runtime.handle().clone();
    let test_root = app.root.clone();
    let ipc_done = test_done.clone();
    let view=WebViewBuilder::new_with_web_context(&mut context)
        .with_background_color((17,20,22,255)).with_focused(false).with_devtools(cfg!(debug_assertions))
        .with_initialization_script(include_str!("../app/bridge.js"))
        .with_custom_protocol("r2".into(),|_,request:Request<Vec<u8>>|{
            let (kind,bytes)=asset(request.uri().path());
            Response::builder().header("Content-Type",kind)
                .header("Content-Security-Policy","default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; script-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'")
                .body(Cow::Borrowed(bytes)).unwrap()
        })
        .with_navigation_handler(|url| trusted_document(&url))
        .with_new_window_req_handler(|_, _| NewWindowResponse::Deny)
        .with_permission_handler(|_| PermissionResponse::Deny)
        .with_download_started_handler(|url, _| local_export(&url))
        .with_ipc_handler(move|request:Request<String>| {
            if !trusted_document(&request.uri().to_string()) { return; }
            if request.body().len()>1024*1024{return;}
            let Ok(message)=serde_json::from_str::<Ipc>(request.body()) else{return;};
            let app=ipc_app.clone();let proxy=ipc_proxy.clone();let root=test_root.clone();let done=ipc_done.clone();
            handle.spawn(async move {
                if message.path=="/desktop/close" {let _=proxy.send_event(UserEvent::Exit);return;}
                if message.path=="/desktop/show" {
                    let _=proxy.send_event(UserEvent::Show);
                    let _=proxy.send_event(UserEvent::Script(format!("window.__r2Resolve({});",json!({"id":message.id,"ok":true,"data":null}))));
                    return;
                }
                if test&&message.path=="/test/capture" {
                    let name=message.data["name"].as_str().unwrap_or("overview");
                    if ["overview","performance","buttons","macros","profiles","diagnostics","macros-compact","overview-compact","macros-preview","macro-editor","macro-assignment"].contains(&name) {
                        let _=proxy.send_event(UserEvent::Capture(message.id,name.to_string()));
                        return;
                    }
                }
                if test&&message.path=="/test/viewport" {
                    if let (Some(width),Some(height))=(message.data["width"].as_u64(),message.data["height"].as_u64()) {
                        if (800..=1920).contains(&width)&&(560..=1200).contains(&height) {
                            let _=proxy.send_event(UserEvent::TestViewport(message.id,width as u32,height as u32));
                            return;
                        }
                    }
                }
                if test&&message.path=="/test/result" {
                    let pass=message.data["ok"]==true;
                    let saved=tokio::fs::write(root.join("data/ui-smoke-result.json"),serde_json::to_vec_pretty(&message.data).unwrap()).await.is_ok();
                    done.store(true,Ordering::SeqCst);
                    let _=proxy.send_event(UserEvent::TestFinished(pass&&saved));return;
                }
                let response=match app.request(&message.method,&message.path,message.data).await {
                    Ok(data)=>json!({"id":message.id,"ok":true,"data":data}),
                    Err(error)=>json!({"id":message.id,"ok":false,"error":error.to_string()})
                };
                let _=proxy.send_event(UserEvent::Script(format!("window.__r2Resolve({response});")));
            });
        }).with_url("r2://localhost/").build(&window)?;
    let status_app = app.clone();
    let status_proxy = proxy.clone();
    runtime.spawn(async move {
        let mut events=status_app.subscribe();
        loop {match events.recv().await {
            Ok(status)=>{if status_proxy.send_event(UserEvent::Script(format!("window.dispatchEvent(new CustomEvent('r2-status',{{detail:{status}}}));"))).is_err(){break;}},
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_))=>continue,
            Err(_)=>break
        }}
    });
    let start = app.clone();
    runtime.spawn(async move {
        start.start().await;
    });
    if test {
        let proxy = proxy.clone();
        let root = app.root.clone();
        runtime.spawn(async move {
            tokio::time::sleep(Duration::from_secs(4)).await;
            let local_test = std::env::var_os("R2_SMOKE_LOCAL_WRITES").is_some();
            let _ = proxy.send_event(UserEvent::Script(format!(
                "window.__r2SmokeAllowLocalWrites={local_test};{}",
                include_str!("../tools/ui-smoke.js")
            )));
            tokio::time::sleep(Duration::from_secs(35)).await;
            if !test_done.swap(true, Ordering::SeqCst) {
                let _ = tokio::fs::write(
                    root.join("data/ui-smoke-result.json"),
                    b"{\"ok\":false,\"failures\":[\"Hidden WebView test timed out\"]}",
                )
                .await;
                let _ = proxy.send_event(UserEvent::TestFinished(false));
            }
        });
    }
    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(UserEvent::Script(script)) => {
                let _ = view.evaluate_script(&script);
            }
            Event::UserEvent(UserEvent::Show) => {
                window.set_visible(true);
                window.set_minimized(false);
                window.set_focus();
            }
            Event::UserEvent(UserEvent::Menu(id)) if id == show_id => {
                window.set_visible(true);
                window.set_minimized(false);
                window.set_focus();
            }
            Event::UserEvent(UserEvent::Menu(id)) if id == quit_id => {
                let _ = view
                    .evaluate_script("window.dispatchEvent(new CustomEvent('r2-close-request')); ");
            }
            Event::UserEvent(UserEvent::Exit) => {
                runtime.block_on(app.shutdown());
                *control_flow = ControlFlow::Exit;
            }
            Event::UserEvent(UserEvent::TestFinished(ok)) => {
                runtime.block_on(app.shutdown());
                *control_flow = ControlFlow::ExitWithCode(if ok { 0 } else { 1 });
            }
            Event::UserEvent(UserEvent::Capture(id, name)) => {
                if let Err(error) = capture(
                    &view,
                    app.root.join(format!("data/ui-{name}.png")),
                    id,
                    proxy.clone(),
                ) {
                    let response = json!({"id":id,"ok":false,"error":error.to_string()});
                    let _ = view.evaluate_script(&format!("window.__r2Resolve({response});"));
                }
            }
            Event::UserEvent(UserEvent::TestViewport(id, width, height)) => {
                // Test-only resizing never changes visibility or focus.
                window.set_inner_size(tao::dpi::LogicalSize::new(width as f64, height as f64));
                let response = json!({"id":id,"ok":true,"data":null});
                let _ = view.evaluate_script(&format!("window.__r2Resolve({response});"));
            }
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                let prefs = runtime.block_on(app.preferences()).unwrap_or(Value::Null);
                if prefs["runInBackground"] == true {
                    window.set_visible(false);
                } else {
                    let _ = view.evaluate_script(
                        "window.dispatchEvent(new CustomEvent('r2-close-request')); ",
                    );
                }
            }
            _ => {}
        }
    })
}

#[cfg(test)]
mod security_tests {
    use super::*;
    #[test]
    fn only_embedded_app_document_can_navigate_or_call_ipc() {
        for url in ["r2://localhost/", "http://r2.localhost/", "http://r2.localhost/index.html?local=1#macros"] {
            assert!(trusted_document(url), "{url}");
        }
        for url in ["https://r2.localhost/", "http://r2.localhost:80/", "http://r2.localhost.evil/", "http://r2.localhost@evil/", "http://evil@r2.localhost/", "r2://localhost/main.js", "http://r2.localhost/other.html", "file:///index.html", "data:text/html,hello", "about:blank"] {
            assert!(!trusted_document(url), "{url}");
        }
    }
    #[test]
    fn downloads_are_limited_to_local_blob_exports() {
        assert!(local_export("blob:http://r2.localhost/abc"));
        assert!(local_export("blob:r2://localhost/abc"));
        for url in ["https://example.org/file.exe", "http://r2.localhost/file", "blob:http://r2.localhost.evil/abc", "file:///secret", "data:application/octet-stream,abc"] {
            assert!(!local_export(url), "{url}");
        }
    }
}
#[cfg(windows)]
fn capture(
    view: &wry::WebView,
    path: std::path::PathBuf,
    id: u64,
    proxy: tao::event_loop::EventLoopProxy<UserEvent>,
) -> Result<()> {
    use base64::Engine;
    use windows::core::w;
    use wry::WebViewExtWindows;
    let handler = webview2_com::CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
        move |code, result| {
            let saved: Result<()> = (|| {
                code?;
                let value: Value = serde_json::from_str(&result)?;
                let bytes = base64::engine::general_purpose::STANDARD.decode(
                    value["data"]
                        .as_str()
                        .ok_or_else(|| anyhow::anyhow!("Screenshot was empty"))?,
                )?;
                std::fs::write(path, &bytes)?;
                Ok(())
            })();
            let response = match saved {
                Ok(()) => json!({"id":id,"ok":true,"data":{"saved":true}}),
                Err(e) => json!({"id":id,"ok":false,"error":e.to_string()}),
            };
            let _ = proxy.send_event(UserEvent::Script(format!(
                "window.__r2Resolve({response});"
            )));
            Ok(())
        },
    ));
    unsafe {
        view.webview().CallDevToolsProtocolMethod(
            w!("Page.captureScreenshot"),
            w!("{\"format\":\"png\",\"captureBeyondViewport\":false}"),
            &handler,
        )?;
    }
    Ok(())
}
struct SingleInstance {
    primary: bool,
    #[cfg(windows)]
    handle: *mut std::ffi::c_void,
}
impl SingleInstance {
    fn acquire(silent: bool, test: bool) -> Result<Self> {
        #[cfg(windows)]
        {
            use std::ffi::c_void;
            #[link(name = "kernel32")]
            extern "system" {
                fn CreateMutexW(a: *const c_void, owner: i32, name: *const u16) -> *mut c_void;
                fn GetLastError() -> u32;
            }
            #[link(name = "user32")]
            extern "system" {
                fn FindWindowW(class: *const u16, title: *const u16) -> *mut c_void;
                fn ShowWindow(window: *mut c_void, mode: i32) -> i32;
                fn SetForegroundWindow(window: *mut c_void) -> i32;
            }
            // Isolated, hidden smoke tests must neither activate an existing app
            // nor silently exit without exercising their own embedded interface.
            let instance_name = if test {
                format!("Local\\R2ControlSmoke-{}", std::process::id())
            } else {
                "Local\\R2ControlNative".into()
            };
            let name: Vec<u16> = instance_name
                .encode_utf16()
                .chain(Some(0))
                .collect();
            let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
            if handle.is_null() {
                anyhow::bail!("Could not establish the application instance.");
            }
            let primary = unsafe { GetLastError() } != 183;
            if !primary && !silent {
                let title: Vec<u16> = TITLE.encode_utf16().chain(Some(0)).collect();
                unsafe {
                    let window = FindWindowW(std::ptr::null(), title.as_ptr());
                    if !window.is_null() {
                        ShowWindow(window, 9);
                        SetForegroundWindow(window);
                    }
                }
            }
            Ok(Self { primary, handle })
        }
        #[cfg(not(windows))]
        {
            let _ = (silent, test);
            Ok(Self { primary: true })
        }
    }
}
#[cfg(windows)]
impl Drop for SingleInstance {
    fn drop(&mut self) {
        #[link(name = "kernel32")]
        extern "system" {
            fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
        }
        unsafe {
            CloseHandle(self.handle);
        }
    }
}
