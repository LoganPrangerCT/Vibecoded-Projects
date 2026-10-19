use crate::{
    device::R2Service,
    driver::{self, DriverClient},
    protocol,
};
use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{broadcast, mpsc, Mutex, RwLock};

pub struct Application {
    pub root: PathBuf,
    pub client: Arc<DriverClient>,
    status: RwLock<Value>,
    service: RwLock<Option<Arc<R2Service>>>,
    events: broadcast::Sender<String>,
    helper: Mutex<Option<Child>>,
    writes: Mutex<()>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
// A receiver path survives re-pairing. Include the selected mouse and transport,
// rather than treating the receiver's path alone as a device generation.
fn device_identity(device: &Value) -> Value {
    json!([
        device["path"],
        device["kind"],
        if device["kind"] == "receiver" {
            &device["mouseId"]
        } else {
            &device["id"]
        },
        device["vid"],
        device["pid"],
        device["is24"]
    ])
}
fn blank_status() -> Value {
    json!({"connected":false,"devices":[],"device":null,"settings":null,
        "helper":{"running":false,"version":null,"error":null},
        "capabilities":{"dpi":false,"polling":false,"options":false,"buttons":false,"macros":false,"battery":false},
        "activity":[],"updatedAt":now(),"backend":"Rust","shell":"Windows desktop"})
}
impl Application {
    pub async fn new(root: PathBuf) -> Result<Arc<Self>> {
        tokio::fs::create_dir_all(root.join("data/backups")).await?;
        let (events, _) = broadcast::channel(64);
        Ok(Arc::new(Self {
            root,
            client: Arc::new(DriverClient::new()),
            status: RwLock::new(blank_status()),
            service: RwLock::new(None),
            events,
            helper: Mutex::new(None),
            writes: Mutex::new(()),
        }))
    }
    pub fn subscribe(&self) -> broadcast::Receiver<String> {
        self.events.subscribe()
    }
    pub async fn status(&self) -> Value {
        self.status.read().await.clone()
    }
    async fn publish(&self) {
        let mut s = self.status.write().await;
        s["updatedAt"] = json!(now());
        let _ = self.events.send(s.to_string());
    }
    async fn log(&self, message: impl Into<String>, kind: &str) {
        let mut s = self.status.write().await;
        let rows = s["activity"].as_array_mut().unwrap();
        rows.insert(
            0,
            json!({"message":message.into(),"type":kind,"time":now()}),
        );
        rows.truncate(50);
    }
    pub async fn start(self: &Arc<Self>) {
        if let Err(e) = self.start_helper().await {
            self.log(format!("Device service: {e}"), "error").await;
        }
        tokio::spawn(monitor(self.clone()));
    }
    pub async fn shutdown(&self) {
        let _guard = self.writes.lock().await;
        if let Some(mut child) = self.helper.lock().await.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    async fn selected(&self) -> Result<Arc<R2Service>> {
        self.service
            .read()
            .await
            .clone()
            .ok_or_else(|| anyhow!("Wake or connect the R2 first."))
    }
    async fn ensure_selected(&self, selected: &Arc<R2Service>) -> Result<()> {
        let service = self.service.read().await;
        if !service
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, selected))
            || self.status.read().await["connected"] != true
        {
            bail!("The selected mouse changed or disconnected while this operation was waiting. Refresh and try again.");
        }
        Ok(())
    }
    async fn device_operation(
        &self,
        selected: &Arc<R2Service>,
    ) -> Result<tokio::sync::MutexGuard<'_, ()>> {
        let guard = self.writes.lock().await;
        self.ensure_selected(selected).await?;
        Ok(guard)
    }
    async fn store_settings(&self, selected: &Arc<R2Service>, settings: Value) -> Result<Value> {
        let guard = self.service.read().await;
        if !guard.as_ref().is_some_and(|s| Arc::ptr_eq(s, selected)) {
            bail!("The mouse disconnected. Reconnect and refresh its settings.");
        }
        let mut status = self.status.write().await;
        if status["connected"] != true {
            bail!("The mouse disconnected.");
        }
        status["settings"] = settings.clone();
        for key in ["dpi", "polling", "options", "buttons"] {
            status["capabilities"][key] = json!(true);
        }
        // Upload uses a backup, reads back every byte, and reports failure explicitly.
        status["capabilities"]["macros"] = json!(true);
        drop(status);
        drop(guard);
        self.publish().await;
        Ok(settings)
    }
    async fn refresh(&self) -> Result<Value> {
        let selected = self.selected().await?;
        let _guard = self.device_operation(&selected).await?;
        let settings = selected.read_settings().await?;
        self.store_settings(&selected, settings).await?;
        Ok(self.status().await)
    }
    // A failed acknowledgement can follow a successful device write. Show a
    // fresh read, or clear the stale snapshot if the hardware cannot be read.
    async fn recover_settings(&self, service: &Arc<R2Service>) {
        if self.ensure_selected(service).await.is_err() {
            return;
        }
        match service.read_settings().await {
            Ok(settings) => {
                let _ = self.store_settings(service, settings).await;
            }
            Err(_) => {
                let current = self.service.read().await;
                if current.as_ref().is_some_and(|s| Arc::ptr_eq(s, service)) {
                    let mut status = self.status.write().await;
                    status["settings"] = Value::Null;
                    for key in ["dpi", "polling", "options", "buttons", "macros"] {
                        status["capabilities"][key] = json!(false);
                    }
                }
            }
        }
    }
    async fn apply_list(self: &Arc<Self>, list: Value) {
        let devices = list["devices"].as_array().cloned().unwrap_or_default();
        let online = |d: &Value| {
            if d["kind"] == "receiver" {
                d["mouse"]["isOnline"].as_bool().unwrap_or(false)
            } else {
                d["isOnline"].as_bool().unwrap_or(false)
            }
        };
        let selected = devices
            .iter()
            .filter(|d| driver::is_r2(d))
            .find(|d| online(d))
            .or_else(|| devices.iter().find(|d| driver::is_r2(d)))
            .cloned();
        let connected = selected.as_ref().is_some_and(online);
        // Match store_settings' lock order and publish service/status as one transition.
        let mut service = self.service.write().await;
        let changed = service.as_ref().map(|s| device_identity(&s.device))
            != selected.as_ref().map(device_identity);
        let was_connected;
        {
            let mut status = self.status.write().await;
            was_connected = status["connected"] == true;
            if !connected || changed || !was_connected {
                if let Some(previous) = service.as_ref() {
                    // Invalidate before publishing a replacement/disconnect so an in-flight
                    // Arc stops before its next device RPC, including rollback and macro pages.
                    previous.invalidate();
                }
            }
            if !connected {
                *service = None;
            } else if changed || !was_connected {
                *service = Some(Arc::new(R2Service::new(
                    self.client.clone(),
                    selected.as_ref().unwrap().clone(),
                )));
            }
            status["devices"] = json!(devices);
            status["connected"] = json!(connected);
            status["device"] = selected.as_ref().map(|d| {
                let receiver = d["kind"] == "receiver";
                let caps = protocol::r2_capabilities(d);
                json!({"model":"R2","variant":caps["variant"],"id":if receiver {d["mouseId"].clone()}else{d["id"].clone()},
                    "path":d["path"],"kind":d["kind"],"connection":if receiver||d["is24"]==true{"2.4 GHz"}else{"USB"},
                    "battery":if connected {if receiver {d["mouse"]["battery"].clone()}else{d["battery"].clone()}}else{Value::Null},"online":connected})
            }).unwrap_or(Value::Null);
            if !connected {
                status["capabilities"] = blank_status()["capabilities"].clone();
                status["settings"] = Value::Null;
            } else if changed || !was_connected {
                let caps = protocol::r2_capabilities(selected.as_ref().unwrap());
                let mut combined = blank_status()["capabilities"].clone();
                if let Some(fields) = caps.as_object() {
                    for (key, value) in fields {
                        combined[key] = value.clone();
                    }
                }
                combined["battery"] = json!(true);
                status["capabilities"] = combined;
                status["settings"] = Value::Null;
            }
        }
        drop(service);
        if !connected {
            if was_connected {
                self.log(
                    "Mouse is asleep or disconnected. Waiting for it to wake.",
                    "info",
                )
                .await;
            }
        } else if changed || !was_connected {
            self.log("R2 connected. Reading onboard settings.", "info")
                .await;
            let app = self.clone();
            tokio::spawn(async move {
                if let Err(e) = app.refresh().await {
                    app.log(format!("Settings read failed: {e}"), "error").await;
                    app.publish().await;
                }
            });
        }
        self.publish().await;
    }
    async fn start_helper(&self) -> Result<()> {
        if self.client.get_version().await.is_ok() {
            return self.client.start_wireless_polling().await;
        }
        let mut child = self.helper.lock().await;
        if let Some(process) = child.as_mut() {
            if process.try_wait()?.is_none() {
                return Ok(());
            }
        }
        let packaged = self.root.join("iot_driver.exe");
        let exe = if packaged.exists() {
            packaged
        } else {
            self.root.join("research/original-app/iot_driver.exe")
        };
        let bytes = tokio::fs::read(&exe).await?;
        if format!("{:x}", Sha256::digest(&bytes))
            != "73bad815658fa9aed3fa4d18a5123004afe4b263eb8c38c7b636f0b821f31aad"
        {
            bail!("The device helper changed. Refusing to launch it.");
        }
        let cwd = self.root.join("data/helper");
        tokio::fs::create_dir_all(&cwd).await?;
        let mut command = Command::new(exe);
        command
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        *child = Some(command.spawn()?);
        drop(child);
        for _ in 0..20 {
            tokio::time::sleep(Duration::from_millis(150)).await;
            if self.client.get_version().await.is_ok() {
                return self.client.start_wireless_polling().await;
            }
        }
        bail!("The device service did not start.")
    }
    async fn load(&self, key: &str) -> Result<Value> {
        let filename = self.root.join(format!("data/{key}.json"));
        let backup = filename.with_extension("json.bak");
        match tokio::fs::read(&filename).await {
            Ok(bytes) => match serde_json::from_slice(&bytes) {
                Ok(value) => Ok(value),
                Err(primary_error) => match tokio::fs::read(&backup).await {
                    Ok(bytes) => serde_json::from_slice(&bytes).map_err(|backup_error| {
                        anyhow!("Could not load {} ({primary_error}); its backup {} is also invalid ({backup_error})", filename.display(), backup.display())
                    }),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        Err(anyhow!("Could not load {} ({primary_error}); no backup is available", filename.display()))
                    }
                    Err(error) => Err(anyhow!("Could not load {} ({primary_error}); could not read backup {} ({error})", filename.display(), backup.display())),
                },
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(match key {
                "preferences" => json!({"runInBackground":false,"openAtLogin":false}),
                _ => {
                    let mut value = json!({});
                    value[key] = json!([]);
                    value
                }
            }),
            Err(e) => Err(e.into()),
        }
    }
    async fn persist(&self, key: &str, value: &Value) -> Result<()> {
        let filename = self.root.join(format!("data/{key}.json"));
        let tmp = filename.with_extension("json.tmp");
        let existing = match tokio::fs::read(&filename).await {
            Ok(bytes) => serde_json::from_slice::<Value>(&bytes).ok().map(|_| bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        tokio::fs::write(&tmp, serde_json::to_vec_pretty(value)?).await?;
        if let Some(bytes) = existing {
            tokio::fs::write(filename.with_extension("json.bak"), bytes).await?;
        }
        tokio::fs::rename(tmp, filename).await?;
        Ok(())
    }
    async fn save_collection(&self, key: &str, value: Value) -> Result<Value> {
        let entries = value[key]
            .as_array()
            .ok_or_else(|| anyhow!("Expected a list of {key}."))?;
        if entries.len() > 100 {
            bail!("Save up to 100 {key}.");
        }
        for entry in entries {
            let name = entry["name"].as_str().unwrap_or("");
            if name.trim().is_empty() || name.chars().count() > 100 {
                bail!("Each entry needs a name of 1–100 characters.");
            }
            if key == "macros" {
                if let Some(steps) = entry.get("steps") {
                    if !steps.is_array() || steps.as_array().unwrap().len() > 500 {
                        bail!("A macro can contain up to 500 local steps.");
                    }
                }
            }
        }
        let _guard = self.writes.lock().await;
        self.persist(key, &value).await?;
        self.log(
            format!(
                "{} saved on this PC.",
                if key == "macros" {
                    "Macro library"
                } else {
                    "Profiles"
                }
            ),
            "info",
        )
        .await;
        self.publish().await;
        Ok(value)
    }
    async fn update_settings_expected(&self, changes: Value, expected_device: &str, prepared: &[Value]) -> Result<Value> {
        let service = self.selected().await?;
        let _guard = self.device_operation(&service).await?;
        if self.ui_device_identity().await != expected_device {
            bail!("The selected device changed before this operation. Refresh and try again.");
        }
        if prepared.len() > 6 { bail!("Prepare at most six macros per Apply operation."); }
        for item in prepared {
            let slot = item["slot"].as_u64().filter(|n| *n < 20).ok_or_else(|| anyhow!("Invalid prepared macro slot."))? as u8;
            let wanted = protocol::preview_macro(&item["macro"])?["canonical"].clone();
            let actual = service.get_macro(slot).await?;
            if actual["decoded"] != wanted {
                bail!("Prepared macro slot {} changed before Apply. Prepare the named macro again.", slot + 1);
            }
        }
        let groups = changes
            .as_object()
            .ok_or_else(|| anyhow!("Expected settings object."))?;
        if groups.is_empty()
            || groups
                .keys()
                .any(|key| !["options", "dpi", "buttonMappings"].contains(&key.as_str()))
        {
            bail!("Unsupported settings group.");
        }
        if let Some(options) = changes.get("options") {
            protocol::validate_options(options)?;
        }
        if let Some(dpi) = changes.get("dpi") {
            protocol::validate_dpi(dpi)?;
        }
        if let Some(rate) = changes["options"].get("rate") {
            if !service.capabilities()["pollingRates"]
                .as_array()
                .is_some_and(|rates| rates.contains(rate))
            {
                bail!("Polling rate is unsupported in this connection mode.");
            }
        }
        let mut mappings = Vec::new();
        if let Some(rows) = changes.get("buttonMappings") {
            let rows = rows
                .as_array()
                .ok_or_else(|| anyhow!("Expected button mappings."))?;
            if rows.len() > 6 {
                bail!("Update up to six physical buttons.");
            }
            for row in rows {
                let index = row["index"]
                    .as_u64()
                    .filter(|n| *n < 6)
                    .ok_or_else(|| anyhow!("Invalid button index."))?
                    as u8;
                let bytes = mapping_bytes(&row["mapping"])?;
                protocol::validate_key_mapping(0, index, &bytes)?;
                mappings.push((index, bytes));
            }
        }
        let before = service.read_settings().await?;
        self.persist(
            "last-device-backup",
            &json!({"time":now(),"device":service.device,"settings":before}),
        )
        .await?;
        let _ = mappings;
        self.ensure_selected(&service).await?;
        let result = match service.apply_changes(&changes).await {
            Ok(result) => result,
            Err(error) => {
                // The service restores failed mixed writes. Re-read instead of leaving
                // an optimistic/stale snapshot visible after an unsuccessful transaction.
                self.recover_settings(&service).await;
                self.log(format!("Settings update failed: {error}"), "error")
                    .await;
                self.publish().await;
                return Err(error);
            }
        };
        self.store_settings(&service, result.clone()).await?;
        self.log("Settings applied and verified by device readback.", "info")
            .await;
        self.publish().await;
        Ok(json!({"ok":true,"settings":result}))
    }
    async fn upload(&self, value: Value) -> Result<Value> {
        let slot = value["slot"]
            .as_u64()
            .filter(|n| *n < 20)
            .ok_or_else(|| anyhow!("Choose a macro slot from 0 to 19."))? as u8;
        let raw = if value["macro"].get("macro").is_some() {
            protocol::encode_macro(&value["macro"])?
        } else {
            protocol::compile_ui_macro(&value["macro"])?
        };
        let service = self.selected().await?;
        let _guard = self.device_operation(&service).await?;
        let expected = value["device"].as_str().ok_or_else(|| anyhow!("Missing selected device identity."))?;
        if self.ui_device_identity().await != expected {
            bail!("The selected device changed. Refresh and upload again.");
        }
        self.upload_locked(&service, slot, &raw, None).await?;
        self.log(
            format!("Macro uploaded to slot {} and verified. Button bindings are unchanged.", slot + 1),
            "info",
        ).await;
        self.publish().await;
        Ok(json!({"ok":true,"slot":slot,"verified":true}))
    }
    async fn upload_locked(&self, service: &Arc<R2Service>, slot: u8, raw: &[u8], expected_fingerprint: Option<&str>) -> Result<()> {
        let backup = service.get_macro(slot).await?;
        let previous = protocol::macro_restore_payload(&mapping_bytes(&backup["raw"])?)?;
        if let Some(expected) = expected_fingerprint {
            let actual = format!("{:x}", Sha256::digest(&mapping_bytes(&backup["raw"])?));
            if actual != expected { bail!("SLOT_FINGERPRINT_CHANGED"); }
        }
        let filename = self
            .root
            .join(format!("data/backups/macro-{slot}-{}.json", now()));
        tokio::fs::write(&filename, serde_json::to_vec_pretty(&backup)?).await?;
        self.ensure_selected(&service).await?;
        if let Err(error) = service.set_raw_macro(slot, raw).await {
            if self.ensure_selected(&service).await.is_err() {
                bail!("Upload failed: {error}. The selected mouse changed or disconnected, so restoration was not sent to another mouse. Backup: {}", filename.display());
            }
            if let Err(restore) = service.set_raw_macro(slot, &previous).await {
                bail!(
                    "Upload failed: {error}. Restoration failed: {restore}. Backup: {}",
                    filename.display()
                );
            }
            bail!("Upload failed and the previous macro was restored: {error}");
        }
        Ok(())
    }
    async fn ui_device_identity(&self) -> String {
        let status = self.status.read().await;
        let device = &status["device"];
        json!([device["path"], device["kind"], device["id"], device["connection"]]).to_string()
    }
    async fn macro_slots_locked(&self, service: &Arc<R2Service>, requested_reserved: &[u8], stop_when_available: Option<&Value>) -> Result<Vec<Value>> {
        let references = service.read_macro_references().await?;
        let reserved: std::collections::HashSet<u8> = references.into_iter().collect();
        let protected: std::collections::HashSet<u8> = requested_reserved.iter().copied().collect();
        let mut slots = Vec::new();
        for index in 0..20 {
            let mut slot = service.get_macro(index).await?;
            let index = slot["index"].as_u64().unwrap_or(255) as u8;
            let raw: Vec<u8> = slot["raw"].as_array().into_iter().flatten().filter_map(Value::as_u64).map(|v| v as u8).collect();
            let empty = raw.iter().all(|b| *b == 0) || raw.iter().all(|b| *b == 255);
            let decoded = slot["decoded"].is_object();
            let fingerprint = format!("{:x}", Sha256::digest(&raw));
            slot["fingerprint"] = json!(fingerprint);
            slot["reserved"] = json!(reserved.contains(&index));
            slot["protected"] = json!(protected.contains(&index));
            slot["replaceable"] = json!(empty || decoded);
            slot["empty"] = json!(empty);
            let available = stop_when_available.is_some_and(|canonical|
                slot["decoded"] == *canonical || empty && !reserved.contains(&index) && !protected.contains(&index));
            slots.push(slot);
            if available { break; }
        }
        Ok(slots)
    }
    async fn macro_slots(&self, value: Value) -> Result<Value> {
        let service = self.selected().await?;
        let _guard = self.device_operation(&service).await?;
        let identity = self.ui_device_identity().await;
        let requested: Vec<u8> = value["reservedSlots"].as_array().into_iter().flatten().filter_map(Value::as_u64).filter(|n| *n < 20).map(|n| n as u8).collect();
        let slots = self.macro_slots_locked(&service, &requested, None).await?;
        self.ensure_selected(&service).await?;
        Ok(json!({"slots":slots,"device":identity}))
    }
    async fn prepare_macro(&self, value: Value) -> Result<Value> {
        let canonical = protocol::preview_macro(&value["macro"])?["canonical"].clone();
        let raw = protocol::encode_macro(&canonical)?;
        let service = self.selected().await?;
        let _guard = self.device_operation(&service).await?;
        let identity = self.ui_device_identity().await;
        if value["device"].as_str() != Some(identity.as_str()) {
            bail!("The selected device changed. Refresh and prepare the macro again.");
        }
        let requested: Vec<u8> = value["reservedSlots"].as_array().into_iter().flatten().filter_map(Value::as_u64).filter(|n| *n < 20).map(|n| n as u8).collect();
        let preferred = value["preferredSlot"].as_u64().filter(|n| *n < 20).map(|n| n as usize);
        let replace = value["replaceSlot"].as_u64().filter(|n| *n < 20).map(|n| n as u8);
        // Reuse the known slot with one read. Never rewrite its contents merely
        // because a local name was selected again.
        if let Some(slot) = preferred {
            let existing = service.get_macro(slot as u8).await?;
            self.ensure_selected(&service).await?;
            if existing["decoded"] == canonical {
                return Ok(json!({"needsSlot":false,"slot":slot,"canonical":canonical,"verified":true,"reused":true,"device":identity}));
            }
        }
        for _ in 0..3 {
            // Scan in order only until a match/free slot. A complete inventory
            // is needed only for the full-storage picker and advanced view.
            let slots = self.macro_slots_locked(&service, &requested, Some(&canonical)).await?;
            self.ensure_selected(&service).await?;
            if let Some(matched) = slots.iter().filter(|s| s["decoded"] == canonical).min_by_key(|s| if Some(s["index"].as_u64().unwrap_or(255) as usize) == preferred {0} else {1}) {
                self.ensure_selected(&service).await?;
                return Ok(json!({"needsSlot":false,"slot":matched["index"],"canonical":canonical,"verified":true,"reused":true,"device":identity}));
            }
            let free = slots.iter().find(|s| {
                let i = s["index"].as_u64().unwrap_or(255) as usize;
                Some(i) == preferred && s["empty"] == true && s["reserved"] != true && s["protected"] != true
            }).or_else(|| slots.iter().find(|s| s["empty"] == true && s["reserved"] != true && s["protected"] != true));
            let chosen = if let Some(s) = free { Some(s) } else if let Some(index) = replace {
                let current = slots.iter().find(|s| s["index"] == index);
                current.filter(|s| s["replaceable"] == true && s["protected"] != true && value["replaceFingerprint"].as_str() == s["fingerprint"].as_str())
            } else { None };
            let Some(chosen) = chosen else {
                self.ensure_selected(&service).await?;
                return Ok(json!({"needsSlot":true,"slots":slots,"device":identity}));
            };
            let slot = chosen["index"].as_u64().unwrap() as u8;
            let fingerprint = chosen["fingerprint"].as_str().unwrap_or("").to_owned();
            self.ensure_selected(&service).await?;
            match self.upload_locked(&service, slot, &raw, Some(&fingerprint)).await {
                Ok(()) => {
                    self.ensure_selected(&service).await?;
                    self.log(format!("Macro prepared in slot {} and verified.", slot + 1), "info").await;
                    self.publish().await;
                    return Ok(json!({"needsSlot":false,"slot":slot,"canonical":canonical,"verified":true,"reused":false,"device":identity}));
                }
                Err(error) if error.to_string().contains("SLOT_FINGERPRINT_CHANGED") => continue,
                Err(error) => return Err(error),
            }
        }
        bail!("Macro slots kept changing while preparing. Refresh the slot list and try again.")
    }
    pub async fn preferences(&self) -> Result<Value> {
        self.load("preferences").await
    }
    async fn save_preferences_using(
        &self,
        value: Value,
        startup: &impl StartupStore,
    ) -> Result<Value> {
        let background = value["runInBackground"]
            .as_bool()
            .ok_or_else(|| anyhow!("Invalid background preference."))?;
        let login = value["openAtLogin"]
            .as_bool()
            .ok_or_else(|| anyhow!("Invalid startup preference."))?;
        let result = json!({"runInBackground":background,"openAtLogin":login});
        let _guard = self.writes.lock().await;
        let previous = startup.read()?;
        let next = if login { Some(startup_value()?) } else { None };
        startup.write(next.as_ref())?;
        if let Err(error) = self.persist("preferences", &result).await {
            if let Err(restore) = startup.write(previous.as_ref()) {
                bail!("Desktop preferences were not saved: {error}. Restoring the previous Windows startup setting also failed: {restore}");
            }
            bail!("Desktop preferences were not saved; the previous Windows startup setting was restored: {error}");
        }
        Ok(result)
    }
    pub async fn request(&self, method: &str, path: &str, value: Value) -> Result<Value> {
        let (route, query) = path.split_once('?').unwrap_or((path, ""));
        match (method, route) {
            ("GET", "/api/status") => Ok(self.status().await),
            ("POST", "/api/helper/start") => {
                self.start_helper().await?;
                Ok(json!({"ok":true}))
            }
            ("POST", "/api/settings/refresh") => self.refresh().await,
            ("POST", "/api/settings") => {
                let expected = value["device"].as_str().ok_or_else(|| anyhow!("Missing selected device identity."))?.to_owned();
                let mut changes = value.as_object().cloned().ok_or_else(|| anyhow!("Expected settings object."))?;
                changes.remove("device");
                self.update_settings_expected(Value::Object(changes), &expected, &[]).await
            }
            ("POST", "/api/macros/bind") => {
                let expected = value["device"].as_str().ok_or_else(|| anyhow!("Missing prepared device identity."))?.to_owned();
                let changes = json!({"buttonMappings":value["buttonMappings"]});
                let prepared = value["prepared"].as_array().cloned().unwrap_or_default();
                self.update_settings_expected(changes, &expected, &prepared).await
            }
            ("GET", "/api/macros") => self.load("macros").await,
            ("PUT", "/api/macros") => self.save_collection("macros", value).await,
            ("POST", "/api/macros/preview") => protocol::preview_macro(&value["macro"]),
            ("GET", "/api/profiles") => self.load("profiles").await,
            ("PUT", "/api/profiles") => self.save_collection("profiles", value).await,
            ("GET", "/api/macros/slot") => {
                let slot = query
                    .strip_prefix("slot=")
                    .and_then(|v| v.parse::<u8>().ok())
                    .filter(|n| *n < 20)
                    .ok_or_else(|| anyhow!("Choose a macro slot from 0 to 19."))?;
                let selected = self.selected().await?;
                let _guard = self.device_operation(&selected).await?;
                selected.get_macro(slot).await
            }
            ("GET", "/api/macros/slots") => self.macro_slots(value).await,
            ("POST", "/api/macros/prepare") => self.prepare_macro(value).await,
            ("POST", "/api/macros/upload") => self.upload(value).await,
            ("POST", "/api/profile") => {
                let expected = value["device"].as_str().ok_or_else(|| anyhow!("Missing selected device identity."))?.to_owned();
                let profile = value["profile"]
                    .as_u64()
                    .filter(|n| *n < 8)
                    .ok_or_else(|| anyhow!("Choose an onboard profile from 0 to 7."))?
                    as u8;
                let selected = self.selected().await?;
                let _guard = self.device_operation(&selected).await?;
                if self.ui_device_identity().await != expected {
                    bail!("The selected device changed. Refresh and switch profile again.");
                }
                let settings = match selected.set_profile(profile).await {
                    Ok(settings) => settings,
                    Err(error) => {
                        self.recover_settings(&selected).await;
                        self.log(format!("Profile switch failed: {error}"), "error")
                            .await;
                        self.publish().await;
                        return Err(error);
                    }
                };
                self.store_settings(&selected, settings.clone()).await?;
                self.log(
                    format!("Switched to onboard profile {}.", profile + 1),
                    "info",
                )
                .await;
                self.publish().await;
                Ok(json!({"ok":true,"settings":settings}))
            }
            ("POST", "/api/key/compile") => Ok(
                json!({"mapping":protocol::compile_key_combo(value["combo"].as_str().unwrap_or(""))?}),
            ),
            ("GET", "/api/preferences") => self.preferences().await,
            ("PUT", "/api/preferences") => {
                self.save_preferences_using(value, &WindowsStartup).await
            }
            ("GET", "/api/research") => Ok(
                json!({"recovery":{"electronSources":199,"webpackModules":882,"backend":"Rust","shell":"Native Windows / WebView2","helper":"Original hardware service, build 183"},
                "limitations":["Battery readings come from the device; full discharge-cycle accuracy remains unverified.","This build uses the original hardware helper. Its replacement is a separate interoperability task.","Firmware flashing is not included."]}),
            ),
            _ => bail!("Unknown application command: {method} {route}"),
        }
    }
}
fn mapping_bytes(value: &Value) -> Result<Vec<u8>> {
    value
        .as_array()
        .ok_or_else(|| anyhow!("Expected byte array."))?
        .iter()
        .map(|v| {
            v.as_u64()
                .filter(|n| *n < 256)
                .map(|n| n as u8)
                .ok_or_else(|| anyhow!("Invalid byte value."))
        })
        .collect()
}
#[derive(Clone, Debug, PartialEq)]
struct StartupValue {
    kind: u32,
    bytes: Vec<u8>,
}
trait StartupStore: Sync {
    fn read(&self) -> Result<Option<StartupValue>>;
    fn write(&self, value: Option<&StartupValue>) -> Result<()>;
}
struct WindowsStartup;
fn startup_value() -> Result<StartupValue> {
    let command = format!("\"{}\" --background", std::env::current_exe()?.display());
    Ok(StartupValue {
        kind: 1,
        bytes: command
            .encode_utf16()
            .chain(Some(0))
            .flat_map(u16::to_le_bytes)
            .collect(),
    })
}
impl StartupStore for WindowsStartup {
    fn read(&self) -> Result<Option<StartupValue>> {
        #[cfg(windows)]
        {
            startup_registry::read()
        }
        #[cfg(not(windows))]
        {
            Ok(None)
        }
    }
    fn write(&self, value: Option<&StartupValue>) -> Result<()> {
        #[cfg(windows)]
        {
            startup_registry::write(value)
        }
        #[cfg(not(windows))]
        {
            let _ = value;
            Ok(())
        }
    }
}
#[cfg(windows)]
mod startup_registry {
    use super::*;
    use std::ffi::c_void;
    type Key = *mut c_void;
    const NOT_FOUND: i32 = 2;
    #[link(name = "advapi32")]
    extern "system" {
        fn RegOpenKeyExW(
            key: Key,
            sub: *const u16,
            options: u32,
            access: u32,
            out: *mut Key,
        ) -> i32;
        fn RegCreateKeyExW(
            key: Key,
            sub: *const u16,
            reserved: u32,
            class: *mut u16,
            options: u32,
            access: u32,
            security: *const c_void,
            out: *mut Key,
            disposition: *mut u32,
        ) -> i32;
        fn RegQueryValueExW(
            key: Key,
            name: *const u16,
            reserved: *mut u32,
            kind: *mut u32,
            data: *mut u8,
            size: *mut u32,
        ) -> i32;
        fn RegSetValueExW(
            key: Key,
            name: *const u16,
            reserved: u32,
            kind: u32,
            data: *const u8,
            size: u32,
        ) -> i32;
        fn RegDeleteValueW(key: Key, name: *const u16) -> i32;
        fn RegCloseKey(key: Key) -> i32;
    }
    struct OwnedKey(Key);
    impl Drop for OwnedKey {
        fn drop(&mut self) {
            unsafe {
                RegCloseKey(self.0);
            }
        }
    }
    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }
    fn check(code: i32) -> Result<()> {
        if code != 0 {
            bail!(
                "Windows startup setting: {}",
                std::io::Error::from_raw_os_error(code)
            );
        }
        Ok(())
    }
    fn open(access: u32, create: bool) -> Result<Option<OwnedKey>> {
        let sub = wide(r"Software\Microsoft\Windows\CurrentVersion\Run");
        let mut key = std::ptr::null_mut();
        let hkcu = 0x80000001u32 as i32 as isize as Key;
        let code = unsafe {
            if create {
                RegCreateKeyExW(
                    hkcu,
                    sub.as_ptr(),
                    0,
                    std::ptr::null_mut(),
                    0,
                    access,
                    std::ptr::null(),
                    &mut key,
                    std::ptr::null_mut(),
                )
            } else {
                RegOpenKeyExW(hkcu, sub.as_ptr(), 0, access, &mut key)
            }
        };
        if code == NOT_FOUND {
            return Ok(None);
        }
        check(code)?;
        Ok(Some(OwnedKey(key)))
    }
    pub fn read() -> Result<Option<StartupValue>> {
        let Some(key) = open(1, false)? else {
            return Ok(None);
        };
        let name = wide("R2Control");
        for _ in 0..3 {
            let mut kind = 0;
            let mut size = 0;
            let code = unsafe {
                RegQueryValueExW(
                    key.0,
                    name.as_ptr(),
                    std::ptr::null_mut(),
                    &mut kind,
                    std::ptr::null_mut(),
                    &mut size,
                )
            };
            if code == NOT_FOUND {
                return Ok(None);
            }
            check(code)?;
            if size > 65536 {
                bail!("Windows startup value is unexpectedly large.");
            }
            let mut bytes = vec![0; size as usize];
            let code = unsafe {
                RegQueryValueExW(
                    key.0,
                    name.as_ptr(),
                    std::ptr::null_mut(),
                    &mut kind,
                    bytes.as_mut_ptr(),
                    &mut size,
                )
            };
            if code == NOT_FOUND {
                return Ok(None);
            }
            if code == 234 {
                continue;
            } // External modification: retry the size/read pair.
            check(code)?;
            bytes.truncate(size as usize);
            return Ok(Some(StartupValue { kind, bytes }));
        }
        bail!("Windows startup value kept changing. Retry saving preferences.")
    }
    pub fn write(value: Option<&StartupValue>) -> Result<()> {
        let Some(key) = open(2, value.is_some())? else {
            return Ok(());
        };
        let name = wide("R2Control");
        let code = unsafe {
            if let Some(value) = value {
                RegSetValueExW(
                    key.0,
                    name.as_ptr(),
                    0,
                    value.kind,
                    value.bytes.as_ptr(),
                    value.bytes.len() as u32,
                )
            } else {
                RegDeleteValueW(key.0, name.as_ptr())
            }
        };
        // Deleting an absent value is already the desired state. Other errors
        // (including access denied) must not be mistaken for successful disable.
        if value.is_none() {
            deletion_result(code)
        } else {
            check(code)
        }
    }
    pub(super) fn deletion_result(code: i32) -> Result<()> {
        if code == NOT_FOUND {
            Ok(())
        } else {
            check(code)
        }
    }
}
async fn monitor(app: Arc<Application>) {
    loop {
        match app.client.get_version().await {
            Ok(version) => {
                app.status.write().await["helper"] =
                    json!({"running":true,"version":version["version"],"error":null});
                app.publish().await;
                let (tx, mut rx) = mpsc::channel(16);
                let client = app.client.clone();
                let worker = tokio::spawn(async move {
                    // A restarted helper begins with its wireless loop locked.
                    // Repeat the idempotent vendor handshake on every reconnect.
                    client.start_wireless_polling().await?;
                    client.watch_devices(tx).await
                });
                while let Some(list) = rx.recv().await {
                    app.apply_list(list).await;
                }
                let error = match worker.await {
                    Ok(Err(e)) => e.to_string(),
                    Err(e) => e.to_string(),
                    _ => "Device service connection closed.".into(),
                };
                app.status.write().await["helper"] =
                    json!({"running":false,"version":null,"error":error});
            }
            Err(_) => {
                app.status.write().await["helper"] = json!({"running":false,"version":null,"error":"The device service is stopped."});
            }
        }
        app.apply_list(json!({"devices":[]})).await;
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}

#[cfg(test)]
mod application_tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    struct TempRoot(PathBuf);
    impl TempRoot {
        fn new() -> Self {
            use std::sync::atomic::{AtomicU64, Ordering};
            static NEXT_ROOT: AtomicU64 = AtomicU64::new(0);
            // Windows wall-clock readings can repeat across test threads. An
            // exclusive directory plus a process-wide counter prevents one test
            // from sharing (or deleting) another test's temporary files.
            loop {
                let root = std::env::temp_dir().join(format!(
                    "r2-app-test-{}-{}-{}",
                    std::process::id(),
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap()
                        .as_nanos(),
                    NEXT_ROOT.fetch_add(1, Ordering::Relaxed)
                ));
                match std::fs::create_dir(&root) {
                    Ok(()) => return Self(root),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(error) => panic!("Cannot create test root {}: {error}", root.display()),
                }
            }
        }
    }
    impl Drop for TempRoot {
        fn drop(&mut self) {
            // Only remove this test's explicitly named, immediate temporary directory.
            assert_eq!(self.0.parent(), Some(std::env::temp_dir().as_path()));
            assert!(self
                .0
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("r2-app-test-"));
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn temporary_roots_are_unique_under_parallel_creation() {
        let roots = std::thread::scope(|scope| {
            let workers: Vec<_> = (0..16)
                .map(|_| scope.spawn(|| (0..64).map(|_| TempRoot::new()).collect::<Vec<_>>()))
                .collect();
            workers.into_iter().flat_map(|worker| worker.join().unwrap()).collect::<Vec<_>>()
        });
        let unique: std::collections::HashSet<_> = roots.iter().map(|root| &root.0).collect();
        assert_eq!(unique.len(), roots.len(), "parallel tests must never share temporary directories");
    }
    #[derive(Default)]
    struct FakeStartup {
        state: StdMutex<Option<StartupValue>>,
        calls: StdMutex<Vec<&'static str>>,
        fail: bool,
    }
    impl StartupStore for FakeStartup {
        fn read(&self) -> Result<Option<StartupValue>> {
            self.calls.lock().unwrap().push("read");
            Ok(self.state.lock().unwrap().clone())
        }
        fn write(&self, value: Option<&StartupValue>) -> Result<()> {
            self.calls.lock().unwrap().push("write");
            if self.fail {
                bail!("Registry access denied");
            }
            *self.state.lock().unwrap() = value.cloned();
            Ok(())
        }
    }
    fn mouse(id: u64) -> Value {
        json!({"path":"same-receiver", "kind":"receiver", "mouseId":id, "vid":12625, "pid":16429})
    }
    #[tokio::test]
    async fn macro_preview_is_available_without_a_device_or_helper() {
        let root = TempRoot::new();
        let app = Application::new(root.0.clone()).await.unwrap();
        assert!(app.selected().await.is_err());
        let result=app.request("POST","/api/macros/preview",json!({"macro":{"repeatCount":1,"steps":[
            {"type":"click","value":"left"},{"type":"delay","value":20},{"type":"key","value":"A"}
        ]}})).await.unwrap();
        assert_eq!(result["durationMs"], 20);
        assert_eq!(result["usedBytes"], 14);
        assert_eq!(result["canonical"]["macro"].as_array().unwrap().len(), 5);
        assert!(app.request("POST","/api/macros/preview",json!({"macro":{"repeatCount":1,"steps":vec![json!({"type":"click","value":"left"});40]}})).await.is_err());
        assert!(app.selected().await.is_err());
    }
    #[test]
    fn receiver_identity_includes_paired_model_and_ignores_battery() {
        let first = mouse(2147485541);
        let mut battery = first.clone();
        battery["mouse"] = json!({"battery":30,"isOnline":true});
        assert_eq!(device_identity(&first), device_identity(&battery));
        assert_ne!(device_identity(&first), device_identity(&mouse(2147485470)));
        let mut wired = first.clone();
        wired["kind"] = json!("device");
        wired["id"] = json!(1893);
        assert_ne!(device_identity(&first), device_identity(&wired));
    }
    #[tokio::test]
    async fn observed_replacement_and_disconnect_invalidate_captured_service() {
        let root = TempRoot::new();
        let app = Application::new(root.0.clone()).await.unwrap();
        let old = Arc::new(R2Service::new(app.client.clone(), mouse(2147485541)));
        *app.service.write().await = Some(old.clone());
        app.status.write().await["connected"] = json!(true);

        app.apply_list(json!({"devices":[{
            "path":"same-receiver", "kind":"receiver", "mouseId":2147485470i64,
            "vid":12625, "pid":16429,
            "mouse":{"isOnline":true,"battery":80}
        }]})).await;
        assert!(!old.is_valid(), "paired mouse replacement must invalidate old Arc");
        let replacement = app.selected().await.unwrap();
        assert!(replacement.is_valid());

        app.apply_list(json!({"devices":[]})).await;
        assert!(!replacement.is_valid(), "observed disconnect must invalidate service");
        assert!(app.selected().await.is_err());
    }
    #[tokio::test]
    async fn waiting_operation_rejects_replaced_service_even_when_path_is_reused() {
        let root = TempRoot::new();
        let app = Application::new(root.0.clone()).await.unwrap();
        let old = Arc::new(R2Service::new(app.client.clone(), mouse(2147485541)));
        *app.service.write().await = Some(old.clone());
        app.status.write().await["connected"] = json!(true);
        let guard = app.writes.lock().await;
        let worker_app = app.clone();
        let worker = tokio::spawn(async move { worker_app.device_operation(&old).await.is_err() });
        *app.service.write().await = Some(Arc::new(R2Service::new(
            app.client.clone(),
            mouse(2147485470),
        )));
        drop(guard);
        assert!(worker.await.unwrap());
        let current = app.selected().await.unwrap();
        assert!(app.device_operation(&current).await.is_ok());
        app.status.write().await["connected"] = json!(false);
        assert!(app.device_operation(&current).await.is_err());
    }
    #[tokio::test]
    async fn uncertain_profile_switch_clears_stale_settings_when_recovery_cannot_read() {
        let root = TempRoot::new();
        let app = Application::new(root.0.clone()).await.unwrap();
        // Port zero cannot be a live helper: this failure path never touches HID.
        let client = Arc::new(DriverClient::with_endpoint("http://127.0.0.1:0".into()));
        let service = Arc::new(R2Service::new(client, mouse(2147485541)));
        *app.service.write().await = Some(service);
        {
            let mut status = app.status.write().await;
            status["connected"] = json!(true);
            status["settings"] = json!({"profile":0});
            for key in ["dpi", "polling", "options", "buttons", "macros"] {
                status["capabilities"][key] = json!(true);
            }
        }
        assert!(app
            .request("POST", "/api/profile", json!({"profile":1,"device":app.ui_device_identity().await}))
            .await
            .is_err());
        let status = app.status().await;
        assert!(status["settings"].is_null());
        for key in ["dpi", "polling", "options", "buttons", "macros"] {
            assert_eq!(status["capabilities"][key], false);
        }
        assert!(status["activity"][0]["message"]
            .as_str()
            .unwrap()
            .contains("Profile switch failed"));
    }
    #[tokio::test]
    async fn failed_operation_recovery_preserves_replacement_device_snapshot() {
        let root = TempRoot::new();
        let app = Application::new(root.0.clone()).await.unwrap();
        let old = Arc::new(R2Service::new(app.client.clone(), mouse(2147485541)));
        let current = Arc::new(R2Service::new(app.client.clone(), mouse(2147485470)));
        *app.service.write().await = Some(current);
        app.status.write().await["connected"] = json!(true);
        app.status.write().await["settings"] = json!({"profile":3});
        app.recover_settings(&old).await;
        assert_eq!(app.status().await["settings"], json!({"profile":3}));
    }
    #[tokio::test]
    async fn preference_disk_failure_restores_exact_previous_registry_value() {
        let root = TempRoot::new();
        let app = Application::new(root.0.clone()).await.unwrap();
        let previous = StartupValue {
            kind: 2,
            bytes: vec![1, 2, 3, 0],
        };
        let startup = FakeStartup {
            state: StdMutex::new(Some(previous.clone())),
            ..Default::default()
        };
        // Make only the preference temp-file path unwritable; no registry or hardware is used.
        tokio::fs::create_dir(root.0.join("data/preferences.json.tmp"))
            .await
            .unwrap();
        let error = app
            .save_preferences_using(
                json!({"runInBackground":true,"openAtLogin":false}),
                &startup,
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("restored"));
        assert_eq!(*startup.state.lock().unwrap(), Some(previous));
        assert!(!root.0.join("data/preferences.json").exists());
        assert_eq!(
            *startup.calls.lock().unwrap(),
            vec!["read", "write", "write"]
        );
    }
    #[tokio::test]
    async fn registry_failure_does_not_persist_successful_preferences() {
        let root = TempRoot::new();
        let app = Application::new(root.0.clone()).await.unwrap();
        let startup = FakeStartup {
            fail: true,
            ..Default::default()
        };
        assert!(app
            .save_preferences_using(
                json!({"runInBackground":false,"openAtLogin":false}),
                &startup
            )
            .await
            .is_err());
        assert!(!root.0.join("data/preferences.json").exists());
    }
    #[tokio::test]
    async fn preference_saves_serialize_registry_and_file_state() {
        let root = TempRoot::new();
        let app = Application::new(root.0.clone()).await.unwrap();
        let startup = FakeStartup::default();
        let (first, second) = tokio::join!(
            app.save_preferences_using(
                json!({"runInBackground":true,"openAtLogin":true}),
                &startup
            ),
            app.save_preferences_using(
                json!({"runInBackground":false,"openAtLogin":false}),
                &startup
            )
        );
        first.unwrap();
        second.unwrap();
        let saved = app.preferences().await.unwrap();
        assert_eq!(
            startup.state.lock().unwrap().is_some(),
            saved["openAtLogin"].as_bool().unwrap()
        );
        assert_eq!(
            *startup.calls.lock().unwrap(),
            vec!["read", "write", "read", "write"]
        );
    }
    #[derive(Clone)]
    struct MacroMock {
        raw: Vec<u8>,
        keys: Vec<Vec<u8>>,
        writes: Vec<(u8, u8)>,
        commands: Vec<u8>,
        macro_reads: Vec<u8>,
        pending: Vec<u8>,
        fail_macro_write: bool,
    }
    async fn macro_mock() -> (Arc<DriverClient>, Arc<tokio::sync::Mutex<MacroMock>>, tokio::task::JoinHandle<()>) {
        use base64::{engine::general_purpose::STANDARD, Engine};
        use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::TcpListener, sync::Mutex};
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let state = Arc::new(Mutex::new(MacroMock { raw: vec![255; 20 * 256], keys: vec![vec![0; 64]; 8], writes: vec![], commands: vec![], macro_reads: vec![], pending: vec![0;64], fail_macro_write:false }));
        let shared = state.clone();
        let task = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let shared = shared.clone();
                tokio::spawn(async move {
                    let mut raw = vec![];
                    let end = loop {
                        let mut b = [0; 4096]; let n = socket.read(&mut b).await.unwrap();
                        if n == 0 { return; }
                        raw.extend_from_slice(&b[..n]);
                        if let Some(i) = raw.windows(4).position(|x| x == b"\r\n\r\n") { break i + 4; }
                    };
                    let header = String::from_utf8_lossy(&raw[..end]).into_owned();
                    let length = header.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").and_then(|n| n.trim().parse::<usize>().ok())).unwrap();
                    while raw.len() < end + length { let mut b=[0;4096]; let n=socket.read(&mut b).await.unwrap(); if n==0{return;} raw.extend_from_slice(&b[..n]); }
                    let input = STANDARD.decode(&raw[end..end+length]).unwrap();
                    let req = crate::driver::fields(&input[5..]).unwrap();
                    let command = crate::driver::bytes(&req, 2);
                    let response = {
                        let mut d = shared.lock().await;
                        if header.contains("/sendMsg ") {
                            if let Some(opcode) = command.first() { d.commands.push(*opcode); }
                        }
                        match (header.contains("/sendMsg "), command.first().copied()) {
                            (true, Some(0xd0)) => { let p=command.get(1).copied().unwrap_or(0) as usize; d.pending=d.keys[p].clone(); vec![] },
                            (true, Some(0x96)) => { let slot=command[1] as usize; let page=command[2] as usize; d.macro_reads.push(slot as u8); d.pending=d.raw[slot*256+page*64..slot*256+(page+1)*64].to_vec(); vec![] },
                            (true, Some(0x16)) => {
                                let slot=command[1] as usize; let page=command[2] as usize;
                                d.writes.push((0x16, slot as u8));
                                let start=slot*256+page*56; let used=(command[3] as usize).max(1);
                                let count=(used+55)/56; let size=if page+1==count {used-page*56} else {56};
                                d.raw[start..start+size].copy_from_slice(&command[8..8+size]);
                                if command[4]==1 { let tail=start+size; let end=(slot+1)*256; d.raw[tail..end].fill(0); }
                                if d.fail_macro_write { d.fail_macro_write=false; crate::driver::field_bytes(1,b"injected macro write failure") } else { vec![] }
                            }
                            (true, Some(0x05)) => { d.writes.push((0x05, command.get(1).copied().unwrap_or(0))); vec![] },
                            (true, Some(0x53 | 0x54)) => { d.writes.push((command[0], command.get(1).copied().unwrap_or(0))); vec![] },
                            (true, Some(0x50)) => { d.writes.push((0x50, command[2])); vec![] }
                            (true, Some(_)) => vec![],
                            (false, _) if header.contains("/readMsg ") => crate::driver::field_bytes(2, &d.pending),
                            _ => vec![],
                        }
                    };
                    let mut wire=vec![0]; wire.extend((response.len() as u32).to_be_bytes()); wire.extend(response);
                    let body=STANDARD.encode(wire);
                    socket.write_all(format!("HTTP/1.1 200 OK\r\ncontent-type: application/grpc-web-text\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",body.len(),body).as_bytes()).await.unwrap();
                });
            }
        });
        (Arc::new(DriverClient::with_endpoint(format!("http://{address}"))), state, task)
    }
    async fn macro_app() -> (TempRoot, Arc<Application>, Arc<tokio::sync::Mutex<MacroMock>>, tokio::task::JoinHandle<()>, String) {
        let root=TempRoot::new();
        let (client,state,server)=macro_mock().await;
        let mut app=Application::new(root.0.clone()).await.unwrap();
        Arc::get_mut(&mut app).unwrap().client=client.clone();
        let device=mouse(2147485541);
        *app.service.write().await=Some(Arc::new(R2Service::new(client,device)));
        *app.status.write().await=json!({"connected":true,"device":{"id":2147485541u64,"path":"same-receiver","kind":"receiver","connection":"2.4 GHz"},"activity":[],"capabilities":{"dpi":true,"buttons":true,"macros":true}});
        let identity=json!(["same-receiver","receiver",2147485541u64,"2.4 GHz"]).to_string();
        (root,app,state,server,identity)
    }
    fn test_macro(name: &str) -> Value { json!({"repeatCount":1,"steps":[{"type":"delay","value":23},{"type":"key","value":name}]}) }
    #[tokio::test]
    async fn prepare_chooses_first_unreserved_unprotected_erased_slot_and_reuses_semantic_match() {
        let (_root,app,state,server,device)=macro_app().await;
        { let mut d=state.lock().await; d.keys[7][8..12].copy_from_slice(&[9,0,5,0]); }
        let m=test_macro("A");
        let out=app.request("POST","/api/macros/prepare",json!({"macro":m,"device":device,"preferredSlot":5,"reservedSlots":[0]})).await.unwrap();
        assert_eq!(out["slot"],1,"preferred/reference/protected slots must be skipped");
        assert_eq!(out["reused"],false);
        let writes=state.lock().await.writes.clone(); assert!(!writes.is_empty()); assert!(writes.iter().all(|(_,slot)|*slot==1));
        assert!(state.lock().await.macro_reads.iter().all(|slot|[0,1,5].contains(slot)),"allocation should stop at first free slot, not read all twenty");
        state.lock().await.writes.clear();state.lock().await.macro_reads.clear();
        let again=app.request("POST","/api/macros/prepare",json!({"macro":m,"device":device,"preferredSlot":1})).await.unwrap();
        assert_eq!(again["slot"],1); assert_eq!(again["reused"],true); assert!(state.lock().await.writes.is_empty());
        assert_eq!(state.lock().await.macro_reads,vec![1;4],"known macro reuse should read only its four pages");
        server.abort();
    }
    #[tokio::test]
    async fn full_inventory_prompts_without_writes_and_replacement_checks_fingerprint_and_protection() {
        let (_root,app,state,server,device)=macro_app().await;
        let a=crate::protocol::compile_ui_macro(&test_macro("A")).unwrap();
        let b=crate::protocol::compile_ui_macro(&test_macro("B")).unwrap();
        { let mut d=state.lock().await; for slot in 0..20 { d.raw[slot*256..(slot+1)*256].copy_from_slice(if slot==8 {&a} else {&b}); } d.keys[0][0..4].copy_from_slice(&[9,0,8,0]); }
        let request=json!({"macro":test_macro("C"),"device":device});
        let full=app.request("POST","/api/macros/prepare",request.clone()).await.unwrap();
        assert_eq!(full["needsSlot"],true); assert!(state.lock().await.writes.is_empty());
        let fingerprint=full["slots"][8]["fingerprint"].as_str().unwrap().to_owned();
        let protected=app.request("POST","/api/macros/prepare",json!({"macro":test_macro("C"),"device":device,"reservedSlots":[8],"replaceSlot":8,"replaceFingerprint":fingerprint})).await.unwrap();
        assert_eq!(protected["needsSlot"],true); assert!(state.lock().await.writes.is_empty());
        let replaced=app.request("POST","/api/macros/prepare",json!({"macro":test_macro("C"),"device":device,"replaceSlot":8,"replaceFingerprint":fingerprint})).await.unwrap();
        assert_eq!(replaced["needsSlot"],false); assert_eq!(replaced["slot"],8); assert!(state.lock().await.writes.iter().any(|(_,slot)|*slot==8));
        server.abort();
    }
    #[tokio::test]
    async fn prepare_and_bind_reject_stale_device_or_changed_prepared_macro() {
        let (_root,app,state,server,device)=macro_app().await;
        let macro_a=test_macro("A");
        assert!(app.request("POST","/api/macros/prepare",json!({"macro":macro_a,"device":"[]"})).await.is_err());
        assert!(state.lock().await.writes.is_empty());
        let macro_b=test_macro("B"); let raw=crate::protocol::compile_ui_macro(&macro_b).unwrap();
        { let mut d=state.lock().await; d.raw[..256].copy_from_slice(&raw); }
        let before=state.lock().await.writes.len();
        let bind=app.request("POST","/api/macros/bind",json!({"device":"[]","buttonMappings":[{"index":0,"mapping":[9,0,0,0]}]})).await;
        assert!(bind.is_err()); assert_eq!(state.lock().await.writes.len(),before);
        let wanted=test_macro("A");
        let changed=app.request("POST","/api/macros/bind",json!({"device":device,"buttonMappings":[{"index":0,"mapping":[9,0,0,0]}],"prepared":[{"slot":0,"macro":wanted}]})).await;
        assert!(changed.is_err()); assert_eq!(state.lock().await.writes.len(),before);
        server.abort();
    }
    #[tokio::test]
    async fn automatic_upload_uses_backed_up_verified_rollback_path() {
        let (root,app,state,server,device)=macro_app().await;
        let previous=crate::protocol::compile_ui_macro(&test_macro("B")).unwrap();
        { let mut d=state.lock().await; d.raw[3*256..4*256].copy_from_slice(&previous); d.fail_macro_write=true; }
        let result=app.request("POST","/api/macros/upload",json!({"slot":3,"macro":test_macro("C"),"device":device})).await;
        assert!(result.unwrap_err().to_string().contains("previous macro was restored"));
        let d=state.lock().await;
        assert_eq!(&d.raw[3*256..4*256],previous.as_slice());
        assert!(d.writes.iter().filter(|(_,slot)|*slot==3).count()>=2,"failed upload and rollback should both use verified macro writes");
        assert!(std::fs::read_dir(root.0.join("data/backups")).unwrap().next().is_some(),"upload should preserve the raw pre-write backup");
        server.abort();
    }
    #[tokio::test]
    async fn ui_device_writes_reject_missing_or_stale_identity_before_any_device_write() {
        let (_root,app,state,server,device)=macro_app().await;
        let bad = "[]";
        for route_and_body in [
            ("/api/settings", json!({"device":bad,"options":{"rate":1000}})),
            ("/api/settings", json!({"options":{"rate":1000}})),
            ("/api/profile", json!({"profile":1,"device":bad})),
            ("/api/profile", json!({"profile":1})),
            ("/api/macros/upload", json!({"slot":3,"macro":test_macro("C"),"device":bad})),
            ("/api/macros/upload", json!({"slot":3,"macro":test_macro("C")})),
        ] {
            let before = state.lock().await.writes.len();
            let command_count = state.lock().await.commands.len();
            assert!(app.request("POST", route_and_body.0, route_and_body.1).await.is_err());
            assert_eq!(state.lock().await.writes.len(), before, "{} must reject before sending a write", route_and_body.0);
            assert_eq!(state.lock().await.commands.len(), command_count, "{} must reject before any device RPC", route_and_body.0);
        }
        let matched_settings = app.request("POST", "/api/settings", json!({"device":device,"unsupported":true})).await.unwrap_err().to_string();
        assert!(matched_settings.contains("Unsupported settings group"), "matching identity should proceed to normal settings validation: {matched_settings}");
        let before_commands = state.lock().await.commands.len();
        let matched_settings = app.request("POST", "/api/settings", json!({"device":device,"options":{"rate":1000}})).await.unwrap_err().to_string();
        assert!(!matched_settings.contains("selected device changed"), "matching identity should reach the mock device: {matched_settings}");
        assert!(state.lock().await.commands.len() > before_commands, "matching settings should proceed to device readback");
        let before_commands = state.lock().await.commands.len();
        let _ = app.request("POST", "/api/profile", json!({"profile":1,"device":device})).await;
        assert!(state.lock().await.commands[before_commands..].contains(&0x05), "matching profile identity should reach the mocked profile-write opcode");
        // A valid identity reaches the upload/readback path and retains its existing behavior.
        let before = state.lock().await.macro_reads.len();
        app.request("POST", "/api/macros/upload", json!({"slot":3,"macro":test_macro("C"),"device":device})).await.unwrap();
        assert!(state.lock().await.macro_reads.len() > before);
        server.abort();
    }

    #[tokio::test]
    async fn corrupt_primary_loads_valid_backup_and_preserves_it_on_save() {
        let root = TempRoot::new();
        let app = Application::new(root.0.clone()).await.unwrap();
        let primary = root.0.join("data/profiles.json");
        let backup = root.0.join("data/profiles.json.bak");
        tokio::fs::write(&primary, b"{broken").await.unwrap();
        let known_good = json!({"profiles":[{"name":"Safe copy"}]});
        tokio::fs::write(&backup, serde_json::to_vec(&known_good).unwrap()).await.unwrap();
        assert_eq!(app.load("profiles").await.unwrap(), known_good);
        assert_eq!(tokio::fs::read(&primary).await.unwrap(), b"{broken", "fallback reads must not rewrite the corrupt primary");
        app.persist("profiles", &json!({"profiles":[]})).await.unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&tokio::fs::read(&backup).await.unwrap()).unwrap(), known_good);
        assert_eq!(app.load("profiles").await.unwrap(), json!({"profiles":[]}));
    }
    #[tokio::test]
    async fn corrupt_primary_and_backup_report_both_failures() {
        let root = TempRoot::new();
        let app = Application::new(root.0.clone()).await.unwrap();
        tokio::fs::write(root.0.join("data/macros.json"), b"primary corrupt").await.unwrap();
        tokio::fs::write(root.0.join("data/macros.json.bak"), b"backup corrupt").await.unwrap();
        let error = app.load("macros").await.unwrap_err().to_string();
        assert!(error.contains("macros.json"));
        assert!(error.contains("backup"));
    }
    #[tokio::test]
    async fn missing_data_uses_defaults_and_valid_primary_rotates_to_backup() {
        let root = TempRoot::new();
        let app = Application::new(root.0.clone()).await.unwrap();
        assert_eq!(app.load("macros").await.unwrap(), json!({"macros":[]}));
        let first = json!({"profiles":[{"name":"First"}]});
        let second = json!({"profiles":[{"name":"Second"}]});
        app.persist("profiles", &first).await.unwrap();
        app.persist("profiles", &second).await.unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&tokio::fs::read(root.0.join("data/profiles.json.bak")).await.unwrap()).unwrap(), first);
        assert_eq!(app.load("profiles").await.unwrap(), second);
    }
    #[cfg(windows)]
    #[test]
    fn absent_startup_value_is_idempotent_but_delete_failure_is_not() {
        assert!(startup_registry::deletion_result(2).is_ok());
        assert!(startup_registry::deletion_result(5).is_err());
    }
}
