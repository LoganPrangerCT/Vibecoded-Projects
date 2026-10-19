use crate::{driver::DriverClient, protocol::*};
use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};
use std::{sync::{atomic::{AtomicBool, Ordering}, Arc}, time::Duration};
struct PreparedChanges {
    profile: u8,
    options: Option<Vec<u8>>,
    dpi: Option<Vec<u8>>,
    mappings: Vec<(u8, Vec<u8>)>,
}
pub struct R2Service {
    pub path: String,
    pub device: Value,
    client: Arc<DriverClient>,
    dangle: u64,
    valid: AtomicBool,
}
impl R2Service {
    pub fn new(client: Arc<DriverClient>, device: Value) -> Self {
        Self {
            path: device["path"].as_str().unwrap_or("").into(),
            dangle: if device["kind"] == "receiver" { 2 } else { 0 },
            device,
            client,
            valid: AtomicBool::new(true),
        }
    }
    /// Invalidate this captured device identity before publishing a replacement.
    pub fn invalidate(&self) {
        self.valid.store(false, Ordering::SeqCst);
    }
    #[cfg(test)]
    pub(crate) fn is_valid(&self) -> bool {
        self.valid.load(Ordering::SeqCst)
    }
    fn ensure_valid(&self) -> Result<()> {
        if !self.valid.load(Ordering::SeqCst) {
            bail!("Selected device identity changed; stopped device operation before further I/O")
        }
        Ok(())
    }
    async fn send_command(&self, packet: &[u8]) -> Result<()> {
        self.ensure_valid()?;
        let result = self.client.send(&self.path, packet, self.dangle).await;
        self.ensure_valid()?;
        result
    }
    async fn exchange_command(&self, packet: &[u8]) -> Result<Vec<u8>> {
        self.ensure_valid()?;
        let result = self.client.exchange(&self.path, packet, self.dangle).await;
        self.ensure_valid()?;
        result
    }
    async fn query(&self, command: u8, profile: Option<u8>) -> Result<Vec<u8>> {
        let mut p = packet(command);
        if let Some(profile) = profile {
            p[1] = profile;
        }
        let mut last = anyhow!("No response");
        for _ in 0..3 {
            self.ensure_valid()?;
            match self.exchange_command(&p).await {
                Ok(b) => {
                    let good = b.len() == 64
                        && if command == GET_KEYS {
                            ![GET_KEYS, GET_OPTIONS, GET_DPI, GET_PROFILE].contains(&b[0])
                        } else {
                            b[0] == command
                        };
                    if good {
                        return Ok(b);
                    }
                    last = anyhow!("Unexpected response to 0x{:02x}", command);
                }
                Err(e) => {
                    if e.to_string().contains("not online") {
                        return Err(e);
                    }
                    last = e;
                }
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        Err(last)
    }
    async fn read_inner_once(&self) -> Result<(Value, Vec<u8>, Vec<u8>)> {
        let p = self.query(GET_PROFILE, None).await?;
        let profile = p[1];
        let options = self.query(GET_OPTIONS, None).await?;
        if options[8] != profile {
            bail!("Profile changed while reading options")
        }
        let dpi = self.query(GET_DPI, Some(profile)).await?;
        if dpi[1] != profile {
            bail!("DPI profile mismatch")
        }
        let keys = self.query(GET_KEYS, Some(profile)).await?;
        let mappings: Vec<Vec<u8>> = keys.chunks_exact(4).map(|b| b.to_vec()).collect();
        Ok((
            json!({"profile":profile,"options":parse_options(&options)?,"dpi":parse_dpi(&dpi)?,"keyMappings":mappings,"capabilities":r2_capabilities(&self.device)}),
            options,
            dpi,
        ))
    }
    async fn read_inner(&self) -> Result<(Value, Vec<u8>, Vec<u8>)> {
        for attempt in 0..3 {
            match self.read_inner_once().await {
                Ok(value) => return Ok(value),
                Err(error) => {
                    let message = error.to_string();
                    if !message.contains("Profile changed")
                        && !message.contains("DPI profile mismatch")
                    {
                        return Err(error);
                    }
                    if attempt == 2 {
                        bail!("The active onboard profile kept changing during the read. Close other mouse configuration software and retry.")
                    }
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
            }
        }
        unreachable!()
    }
    pub async fn read_settings(&self) -> Result<Value> {
        let _guard = self.client.operation_lock.lock().await;
        Ok(self.read_inner().await?.0)
    }
    pub async fn update_options(&self, changes: &Value) -> Result<Value> {
        self.apply_changes(&json!({"options":changes})).await
    }
    pub async fn update_dpi(&self, changes: &Value) -> Result<Value> {
        self.apply_changes(&json!({"dpi":changes})).await
    }
    fn prepare_changes(
        &self,
        before: &Value,
        raw_options: &[u8],
        raw_dpi: &[u8],
        changes: &Value,
    ) -> Result<PreparedChanges> {
        let groups = changes
            .as_object()
            .ok_or_else(|| anyhow!("Expected settings object"))?;
        if groups.is_empty()
            || groups
                .keys()
                .any(|k| !["options", "dpi", "buttonMappings"].contains(&k.as_str()))
        {
            bail!("Unsupported settings group")
        }
        let profile = before["profile"]
            .as_u64()
            .filter(|p| *p < 8)
            .ok_or_else(|| anyhow!("Invalid active profile"))? as u8;
        let caps = self.capabilities();
        let options = if let Some(request) = changes.get("options") {
            let packet = patch_options(raw_options, request)?;
            if packet[8] != profile {
                bail!("Use onboard profile switching to change the active profile")
            }
            if request
                .get("deBounce")
                .is_some_and(|v| v.as_u64().unwrap_or(255) > 10)
            {
                bail!("R2 debounce must be0–10ms")
            }
            if let Some(level) = request.get("liftCutOff") {
                if !caps["liftOffLevels"].as_array().unwrap().contains(level) {
                    bail!("Lift-off level unsupported by this sensor")
                }
            }
            if let Some(rate) = request.get("rate") {
                if !caps["pollingRates"].as_array().unwrap().contains(rate) {
                    bail!("Polling rate unsupported in this connection mode")
                }
            }
            if let Some(sleep) = request.get("sleepTime") {
                for (key, value) in sleep.as_object().unwrap() {
                    let max = caps["sleep"][key]["max"].as_u64().unwrap_or(0);
                    if value.as_u64().unwrap_or(u64::MAX) > max {
                        bail!(
                            "Sleep timer {} exceeds this model's {} second maximum",
                            key,
                            max
                        )
                    }
                }
            }
            Some(packet)
        } else {
            None
        };
        let dpi = if let Some(request) = changes.get("dpi") {
            let packet = patch_dpi(raw_dpi, request)?;
            let parsed = parse_dpi(&packet)?;
            let count = caps["dpiStages"].as_u64().unwrap() as u8;
            let maximum = caps["dpiMax"].as_u64().unwrap();
            if packet[3] > count
                || packet[2] >= packet[3]
                || parsed["dpiArr"][packet[2] as usize].as_u64().unwrap_or(0) == 0
            {
                bail!("Select an enabled DPI stage within the model stage count")
            }
            if parsed["dpiArr"]
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v.as_u64().unwrap_or(0) > maximum)
            {
                bail!("DPI exceeds sensor maximum {}", maximum)
            }
            Some(packet)
        } else {
            None
        };
        let mut mappings = vec![];
        if let Some(rows) = changes.get("buttonMappings") {
            let rows = rows
                .as_array()
                .ok_or_else(|| anyhow!("Expected button mappings"))?;
            if rows.len() > 6 {
                bail!("Update up to six physical buttons")
            }
            for row in rows {
                let index = row["index"]
                    .as_u64()
                    .filter(|n| *n < 6)
                    .ok_or_else(|| anyhow!("Invalid physical button index"))?
                    as u8;
                if mappings.iter().any(|(previous, _)| *previous == index) {
                    bail!("Duplicate button index")
                }
                let mapping = row["mapping"]
                    .as_array()
                    .ok_or_else(|| anyhow!("Expected mapping byte array"))?
                    .iter()
                    .map(|v| {
                        v.as_u64()
                            .filter(|n| *n < 256)
                            .map(|n| n as u8)
                            .ok_or_else(|| anyhow!("Invalid mapping byte"))
                    })
                    .collect::<Result<Vec<u8>>>()?;
                key_packet(profile, index, &mapping)?;
                mappings.push((index, mapping));
            }
        }
        Ok(PreparedChanges {
            profile,
            options,
            dpi,
            mappings,
        })
    }
    /// Read and validate the full effective request without changing any device setting.
    pub async fn preflight(&self, changes: &Value) -> Result<()> {
        let _guard = self.client.operation_lock.lock().await;
        let (before, options, dpi) = self.read_inner().await?;
        self.prepare_changes(&before, &options, &dpi, changes)?;
        Ok(())
    }
    async fn send_setting(&self, packet: &[u8]) -> Result<()> {
        self.send_command(packet).await?;
        tokio::time::sleep(Duration::from_millis(10)).await;
        Ok(())
    }
    async fn rollback_changes(
        &self,
        before: &Value,
        options: &[u8],
        dpi: &[u8],
        attempted_options: bool,
        attempted_dpi: bool,
        attempted_mappings: &[u8],
    ) -> Result<()> {
        let profile = before["profile"]
            .as_u64()
            .ok_or_else(|| anyhow!("Invalid backup profile"))? as u8;
        let mut failures = vec![];
        // Restore uncertain writes too: an RPC error does not prove the device rejected the packet.
        for index in attempted_mappings.iter().rev() {
            // Once identity changes, the old receiver path may route to a different mouse.
            self.ensure_valid().map_err(|_| anyhow!("Selected device changed; unsafe restoration stopped before further writes"))?;
            let mut packet = packet(0x50);
            packet[1] = profile;
            packet[2] = *index;
            let mapping = before["keyMappings"][*index as usize]
                .as_array()
                .ok_or_else(|| anyhow!("Invalid backup mapping"))?;
            if mapping.len() != 4 {
                bail!("Invalid backup mapping length")
            }
            for (i, value) in mapping.iter().enumerate() {
                packet[8 + i] = value
                    .as_u64()
                    .ok_or_else(|| anyhow!("Invalid backup mapping byte"))?
                    as u8;
            }
            if let Err(error) = self.send_setting(&packet).await {
                failures.push(format!("button {}: {}", index, error));
            }
        }
        if attempted_dpi {
            self.ensure_valid().map_err(|_| anyhow!("Selected device changed; unsafe restoration stopped before further writes"))?;
            if let Err(error) = self.send_setting(&patch_dpi(dpi, &json!({}))?).await {
                failures.push(format!("DPI: {}", error));
            }
        }
        if attempted_options {
            self.ensure_valid().map_err(|_| anyhow!("Selected device changed; unsafe restoration stopped before further writes"))?;
            if let Err(error) = self
                .send_setting(&patch_options(options, &json!({}))?)
                .await
            {
                failures.push(format!("options: {}", error));
            }
        }
        let verified: Result<()> = async {
            self.ensure_valid()?;
            let (restored, restored_options, restored_dpi) = self.read_inner().await?;
            if restored["profile"] != before["profile"] {
                bail!("active profile differs from the backup")
            }
            if attempted_options && restored_options[8..] != options[8..] {
                bail!("option bytes differ from the backup")
            }
            if attempted_dpi && (restored_dpi[1..4] != dpi[1..4] || restored_dpi[8..] != dpi[8..]) {
                bail!("DPI bytes differ from the backup")
            }
            for index in attempted_mappings {
                if restored["keyMappings"][*index as usize]
                    != before["keyMappings"][*index as usize]
                {
                    bail!("button {} differs from the backup", index)
                }
            }
            Ok(())
        }
        .await;
        // Readback is authoritative even if a restoration response itself was lost.
        if let Err(error) = verified {
            if failures.is_empty() {
                return Err(error);
            }
            bail!("{}; restoration RPC errors: {}", error, failures.join("; "))
        }
        Ok(())
    }
    /// Serialize validation, all writes, readback and any required verified rollback under one lock.
    pub async fn apply_changes(&self, changes: &Value) -> Result<Value> {
        let _guard = self.client.operation_lock.lock().await;
        let (before, options, dpi) = self.read_inner().await?;
        let plan = self.prepare_changes(&before, &options, &dpi, changes)?;
        let mut attempted_options = false;
        let mut attempted_dpi = false;
        let mut attempted_mappings = vec![];
        let update: Result<Value> = async {
            if let Some(packet) = &plan.options {
                attempted_options = true;
                self.send_setting(packet).await?;
            }
            if let Some(packet) = &plan.dpi {
                attempted_dpi = true;
                self.send_setting(packet).await?;
            }
            for (index, mapping) in &plan.mappings {
                attempted_mappings.push(*index);
                self.send_setting(&key_packet(plan.profile, *index, mapping)?)
                    .await?;
            }
            let result = self.read_inner().await?.0;
            if result["profile"] != plan.profile {
                bail!("Active profile changed during settings update; refresh before retrying")
            }
            if let Some(request) = changes.get("options") {
                verify_requested(&result["options"], request)?
            }
            if let Some(request) = changes.get("dpi") {
                verify_requested(&result["dpi"], request)?
            }
            for (index, mapping) in &plan.mappings {
                verify_requested(&result["keyMappings"][*index as usize], &json!(mapping))?;
            }
            Ok(result)
        }
        .await;
        match update {
            Ok(result) => Ok(result),
            Err(error) => {
                match self.rollback_changes(&before,&options,&dpi,attempted_options,attempted_dpi,&attempted_mappings).await{
    Ok(())=>bail!("Settings update failed: {}. Previous settings were restored and verified.",error),
    Err(restore)=>bail!("Settings update failed: {}. RESTORATION FAILED: {}. Device settings may be partially changed; restore the saved backup after reconnecting.",error,restore),
   }
            }
        }
    }
    pub async fn set_profile(&self, profile: u8) -> Result<Value> {
        if profile > 7 {
            bail!("Profile must be 0–7")
        }
        let _guard = self.client.operation_lock.lock().await;
        let mut p = packet(5);
        p[1] = profile;
        self.send_command(&p).await?;
        let result = self.read_inner().await?.0;
        if result["profile"] != profile {
            bail!("Profile readback mismatch")
        }
        Ok(result)
    }
    pub async fn set_key(&self, profile: u8, index: u8, mapping: &[u8]) -> Result<Value> {
        let _guard = self.client.operation_lock.lock().await;
        self.send_command(&key_packet(profile, index, mapping)?).await?;
        let b = self.query(GET_KEYS, Some(profile)).await?;
        if b[index as usize * 4..index as usize * 4 + 4] != *mapping {
            bail!("Key mapping readback mismatch")
        }
        Ok(json!({"ok":true,"profile":profile,"index":index,"mapping":mapping}))
    }
    async fn macro_inner(&self, index: u8) -> Result<Vec<u8>> {
        if index >= 20 {
            bail!("Macro slot must be 0–19")
        }
        let mut out = vec![];
        for page in 0..4 {
            let mut p = packet(GET_MACRO);
            p[1] = index;
            p[2] = page;
            let b = self.exchange_command(&p).await?;
            if b.len() != 64 {
                bail!("Short macro response")
            }
            out.extend(b);
        }
        Ok(out)
    }
    pub async fn get_macro(&self, index: u8) -> Result<Value> {
        let _guard = self.client.operation_lock.lock().await;
        let raw = self.macro_inner(index).await?;
        let decoded = decode_macro(&raw);
        Ok(
            json!({"index":index,"erased":raw.iter().all(|b|*b==255),"raw":raw,"decoded":decoded.as_ref().ok(),"decodeError":decoded.as_ref().err().map(|e|e.to_string())}),
        )
    }
    pub async fn set_raw_macro(&self, index: u8, raw: &[u8]) -> Result<Value> {
        let _guard = self.client.operation_lock.lock().await;
        for p in macro_packets(index, raw)? {
            self.send_command(&p).await?;
        }
        self.ensure_valid()?;
        tokio::time::sleep(Duration::from_millis(500)).await;
        let actual = self.macro_inner(index).await?;
        let verified_bytes = verify_macro_upload(index, raw, &actual)?;
        Ok(
            json!({"index":index,"raw":actual,"verified":true,"verifiedBytes":verified_bytes,"decoded":decode_macro(&actual).ok()}),
        )
    }
    pub async fn bind_macro(
        &self,
        profile: u8,
        key_index: u8,
        mode: &str,
        index: u8,
    ) -> Result<Value> {
        self.set_key(profile, key_index, &macro_binding(mode, index)?)
            .await
    }
    pub fn capabilities(&self) -> Value {
        r2_capabilities(&self.device)
    }
    pub async fn update_stages(&self, stages: &Value, current: usize) -> Result<Value> {
        let count = self.capabilities()["dpiStages"].as_u64().unwrap_or(6) as usize;
        self.update_dpi(&compile_dpi_stages(stages, current, count)?)
            .await
    }
    pub async fn read_profile(&self, profile: u8) -> Result<Value> {
        if profile > 7 {
            bail!("Profile must be0–7")
        }
        let _guard = self.client.operation_lock.lock().await;
        let dpi = self.query(GET_DPI, Some(profile)).await?;
        if dpi[1] != profile {
            bail!("DPI profile mismatch")
        }
        let keys = self.query(GET_KEYS, Some(profile)).await?;
        let mappings: Vec<Vec<u8>> = keys.chunks_exact(4).map(|b| b.to_vec()).collect();
        Ok(json!({"profile":profile,"dpi":parse_dpi(&dpi)?,"keyMappings":mappings}))
    }
    pub async fn list_macros(&self) -> Result<Value> {
        let _guard = self.client.operation_lock.lock().await;
        let mut slots = vec![];
        for index in 0..20 {
            let raw = self.macro_inner(index).await?;
            let decoded = decode_macro(&raw);
            slots.push(json!({"index":index,"erased":raw.iter().all(|b|*b==255),"raw":raw,"decoded":decoded.as_ref().ok(),"decodeError":decoded.as_ref().err().map(|e|e.to_string())}));
        }
        Ok(json!({"slots":slots}))
    }
    /// Read every key matrix by explicit profile selector. This deliberately does not
    /// change the mouse's active profile while building allocation reservations.
    pub async fn read_macro_references(&self) -> Result<Vec<u8>> {
        let _guard = self.client.operation_lock.lock().await;
        let mut referenced = Vec::new();
        for profile in 0..8 {
            let keys = self.query(GET_KEYS, Some(profile)).await?;
            if keys.len() % 4 != 0 { bail!("Short key matrix for profile {}", profile); }
            for mapping in keys.chunks_exact(4) {
                if mapping[0] == 9 && mapping[2] < 20 && !referenced.contains(&mapping[2]) {
                    referenced.push(mapping[2]);
                }
            }
        }
        Ok(referenced)
    }
    pub async fn set_macro(&self, index: u8, value: &Value) -> Result<Value> {
        self.set_raw_macro(index, &encode_macro(value)?).await
    }
}
#[cfg(test)]
mod readback_tests {
    use super::*;
    use crate::driver::{bytes, field_bytes, fields};
    use base64::{engine::general_purpose::STANDARD, Engine};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        sync::Mutex,
    };
    async fn mock_driver(ignore_writes: bool) -> (Arc<DriverClient>, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let keys = Arc::new(Mutex::new(vec![0u8; 64]));
        let pending = Arc::new(Mutex::new(vec![0u8; 64]));
        let task = tokio::spawn(async move {
            loop {
                let (socket, _) = listener.accept().await.unwrap();
                let keys = keys.clone();
                let pending = pending.clone();
                tokio::spawn(async move {
                    let mut socket = socket;
                    let mut raw = vec![];
                    let header_end = loop {
                        let mut b = [0; 4096];
                        let n = socket.read(&mut b).await.unwrap();
                        if n == 0 {
                            return;
                        }
                        raw.extend_from_slice(&b[..n]);
                        if let Some(i) = raw.windows(4).position(|b| b == b"\r\n\r\n") {
                            break i + 4;
                        }
                    };
                    let header = String::from_utf8_lossy(&raw[..header_end]).into_owned();
                    let length = header
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|n| n.trim().parse::<usize>().ok())
                        })
                        .unwrap();
                    while raw.len() < header_end + length {
                        let mut b = [0; 4096];
                        let n = socket.read(&mut b).await.unwrap();
                        if n == 0 {
                            return;
                        }
                        raw.extend_from_slice(&b[..n]);
                    }
                    let request = STANDARD
                        .decode(&raw[header_end..header_end + length])
                        .unwrap();
                    let request = fields(&request[5..]).unwrap();
                    let response = if header.starts_with("POST /driver.DriverGrpc/sendMsg ") {
                        let command = bytes(&request, 2);
                        if command[0] == 0x50 && !ignore_writes {
                            let index = command[2] as usize;
                            keys.lock().await[index * 4..index * 4 + 4]
                                .copy_from_slice(&command[8..12]);
                        }
                        if command[0] == GET_KEYS {
                            *pending.lock().await = keys.lock().await.clone();
                        }
                        vec![]
                    } else if header.starts_with("POST /driver.DriverGrpc/readMsg ") {
                        field_bytes(2, &pending.lock().await.clone())
                    } else {
                        panic!("unexpected mock RPC")
                    };
                    let mut frame = vec![0];
                    frame.extend((response.len() as u32).to_be_bytes());
                    frame.extend(response);
                    let body = STANDARD.encode(frame);
                    let response=format!("HTTP/1.1 200 OK\r\ncontent-type: application/grpc-web-text\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",body.len(),body);
                    socket.write_all(response.as_bytes()).await.unwrap();
                });
            }
        });
        (
            Arc::new(DriverClient::with_endpoint(format!("http://{}", address))),
            task,
        )
    }
    fn mock_service(client: Arc<DriverClient>) -> R2Service {
        R2Service::new(
            client,
            json!({"path":"mock-hid","kind":"receiver","mouseId":2147485541u64}),
        )
    }
    #[tokio::test]
    async fn macro_modes_are_written_and_verified_through_rpc() {
        let (client, task) = mock_driver(false).await;
        let service = mock_service(client);
        for mode in ["repeat_times", "on_off", "touch_repeat"] {
            let result = service.bind_macro(0, 2, mode, 19).await.unwrap();
            let mapping: Vec<u8> = result["mapping"]
                .as_array()
                .unwrap()
                .iter()
                .map(|n| n.as_u64().unwrap() as u8)
                .collect();
            assert_eq!(decode_key_mapping(&mapping).unwrap()["mode"], mode);
        }
        task.abort();
    }
    #[tokio::test]
    async fn ignored_hardware_binding_fails_readback() {
        let (client, task) = mock_driver(true).await;
        let service = mock_service(client);
        let error = service.bind_macro(0, 2, "on_off", 19).await.unwrap_err();
        assert!(error.to_string().contains("readback mismatch"));
        task.abort();
    }
    #[tokio::test]
    async fn replaced_services_share_hardware_transaction_lock() {
        let (client, task) = mock_driver(false).await;
        let old = mock_service(client.clone());
        let new = mock_service(client);
        let (a, b) = tokio::join!(
            old.bind_macro(0, 2, "repeat_times", 18),
            new.bind_macro(0, 2, "touch_repeat", 19)
        );
        a.unwrap();
        b.unwrap();
        task.abort();
    }
}
#[cfg(test)]
mod live_macro_test {
    use super::*;
    /// Explicit opt-in only. Never runs in ordinary cargo test and never binds or executes the fixture.
    #[tokio::test]
    #[ignore = "requires root-coordinated exclusive helper access and an online R2"]
    async fn erased_unbound_slot19_fixture_restore() {
        let client = Arc::new(DriverClient::new());
        let list = client.discover().await.unwrap();
        let device = list["devices"]
            .as_array()
            .unwrap()
            .iter()
            .find(|d| {
                crate::driver::is_r2(d)
                    && if d["kind"] == "receiver" {
                        d["mouse"]["isOnline"] == true
                    } else {
                        d["isOnline"] == true
                    }
            })
            .expect("R2 offline; no write attempted")
            .clone();
        let service = R2Service::new(client, device.clone());
        let baseline = service.read_settings().await.unwrap();
        assert!(
            !baseline["keyMappings"]
                .as_array()
                .unwrap()
                .iter()
                .any(|m| m[0] == 9 && m[2] == 19),
            "Slot19 bound; no write attempted"
        );
        let backup = service.get_macro(19).await.unwrap();
        assert_eq!(
            backup["erased"], true,
            "Slot19 not erased; no write attempted"
        );
        let raw: Vec<u8> = backup["raw"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as u8)
            .collect();
        tokio::fs::create_dir_all("research/evidence")
            .await
            .unwrap();
        tokio::fs::write(
            "research/evidence/rust-macro19-parity-backup.json",
            serde_json::to_vec_pretty(&backup).unwrap(),
        )
        .await
        .unwrap();
        let fixture = compile_ui_macro(
            &json!({"steps":[{"type":"key","value":"A"},{"type":"delay","value":25}]}),
        )
        .unwrap();
        let test = service.set_raw_macro(19, &fixture).await;
        let observed = service.get_macro(19).await;
        let mut evidence = json!({"device":device,"baseline":baseline,"backup":backup,"fixture":fixture,"testVerified":test.is_ok(),"testResult":test.as_ref().ok(),"testError":test.as_ref().err().map(|e|e.to_string()),"actualBeforeRestore":observed.as_ref().ok(),"actualError":observed.as_ref().err().map(|e|e.to_string())});
        let captured = tokio::fs::write(
            "research/evidence/rust-macro19-parity-result.json",
            serde_json::to_vec_pretty(&evidence).unwrap(),
        )
        .await;
        // Restore even if upload/readback or evidence capture failed.
        let restored = service.set_raw_macro(19, &raw).await;
        evidence["restoredVerified"] = json!(restored.is_ok());
        evidence["restoreResult"] = json!(restored.as_ref().ok());
        evidence["restoreError"] = json!(restored.as_ref().err().map(|e| e.to_string()));
        tokio::fs::write(
            "research/evidence/rust-macro19-parity-result.json",
            serde_json::to_vec_pretty(&evidence).unwrap(),
        )
        .await
        .unwrap();
        restored.expect("RESTORE FAILED: see saved slot19 backup before any further macro work");
        captured.unwrap();
        test.unwrap();
    }
}

#[cfg(test)]
mod preflight_tests {
    use super::*;
    fn reports() -> (Value, Vec<u8>, Vec<u8>) {
        let options = packet(GET_OPTIONS);
        let mut dpi = packet(GET_DPI);
        dpi[3] = 6;
        dpi[8..10].copy_from_slice(&1600u16.to_le_bytes());
        dpi[24..26].copy_from_slice(&1600u16.to_le_bytes());
        (json!({"profile":0}), options, dpi)
    }
    #[tokio::test]
    async fn mixed_request_is_compiled_before_any_write() {
        let service = R2Service::new(
            Arc::new(DriverClient::new()),
            json!({"kind":"receiver","mouseId":2147485541u64}),
        );
        let (before, options, dpi) = reports();
        assert!(service
            .prepare_changes(
                &before,
                &options,
                &dpi,
                &json!({"options":{"rate":2000},"dpi":{"dpiArr":[0]}})
            )
            .is_err());
        assert!(service.prepare_changes(&before,&options,&dpi,&json!({"options":{"rate":2000},"buttonMappings":[{"index":2,"mapping":[9,0,255,0]}]})).is_err());
        assert!(service
            .prepare_changes(
                &before,
                &options,
                &dpi,
                &json!({"options":{"sleepTime":{"deepTime_24":60}}})
            )
            .is_err());
        let plan=service.prepare_changes(&before,&options,&dpi,&json!({"options":{"rate":2000},"buttonMappings":[{"index":2,"mapping":[1,0,242,0]}]})).unwrap();
        assert_eq!(plan.options.unwrap()[9], 132);
        assert_eq!(plan.mappings.len(), 1);
    }
}
#[cfg(test)]
mod rollback_tests {
    use super::*;
    use crate::driver::{bytes, field_bytes, fields};
    use base64::{engine::general_purpose::STANDARD, Engine};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        sync::{Mutex, Notify},
    };
    #[derive(Clone, Copy)]
    enum Fault {
        DpiResponseLost,
        SecondButtonResponseLost,
        ReadbackMismatch,
        ButtonRestorationRejected,
    }
    struct Device {
        options: Vec<u8>,
        dpi: Vec<u8>,
        keys: Vec<u8>,
        pending: Vec<u8>,
        writes: Vec<Vec<u8>>,
        fault: Fault,
        fired: bool,
        option_writes: usize,
        macro_data: Vec<u8>,
    }
    fn report(mut packet: Vec<u8>, command: u8) -> Vec<u8> {
        packet[0] = command;
        packet[7] = !packet[..7].iter().fold(0u8, |sum, v| sum.wrapping_add(*v));
        packet
    }
    impl Device {
        fn new(fault: Fault) -> Self {
            let mut options = packet(GET_OPTIONS);
            options[9] = 1;
            options[10] = 1;
            options[12] = 128;
            options[23] = 0xa5;
            options[50] = 100;
            options[51] = 100;
            options[52] = 1;
            options = report(options, GET_OPTIONS);
            let mut dpi = packet(GET_DPI);
            dpi[3] = 6;
            dpi[8..10].copy_from_slice(&1600u16.to_le_bytes());
            dpi[24..26].copy_from_slice(&1600u16.to_le_bytes());
            dpi[40] = 255;
            dpi = report(dpi, GET_DPI);
            let mut keys = vec![0; 64];
            keys[..16].copy_from_slice(&[1, 0, 240, 0, 1, 0, 241, 0, 1, 0, 242, 0, 1, 0, 244, 0]);
            Self {
                options,
                dpi,
                keys,
                pending: vec![],
                writes: vec![],
                fault,
                fired: false,
                option_writes: 0,
                macro_data: vec![0; 256],
            }
        }
        fn command(&mut self, p: &[u8]) -> Option<String> {
            match p[0] {
                GET_PROFILE => {
                    let mut b = packet(GET_PROFILE);
                    b[1] = self.options[8];
                    self.pending = report(b, GET_PROFILE);
                }
                GET_OPTIONS => self.pending = self.options.clone(),
                GET_DPI => self.pending = self.dpi.clone(),
                GET_KEYS => self.pending = self.keys.clone(),
                0x53 => {
                    self.writes.push(p.to_vec());
                    self.option_writes += 1;
                    self.options = report(p.to_vec(), GET_OPTIONS);
                    if matches!(self.fault, Fault::ReadbackMismatch) && self.option_writes == 1 {
                        self.options[9] = 2;
                    }
                }
                0x54 => {
                    self.writes.push(p.to_vec());
                    self.dpi = report(p.to_vec(), GET_DPI);
                    if matches!(self.fault, Fault::DpiResponseLost) && !self.fired {
                        self.fired = true;
                        return Some(
                            "injected DPI response lost after device accepted write".into(),
                        );
                    }
                }
                0x50 => {
                    self.writes.push(p.to_vec());
                    let index = p[2] as usize;
                    if matches!(self.fault, Fault::ButtonRestorationRejected)
                        && self.fired
                        && index == 3
                    {
                        return Some("injected button restoration rejection".into());
                    }
                    self.keys[index * 4..index * 4 + 4].copy_from_slice(&p[8..12]);
                    if matches!(
                        self.fault,
                        Fault::SecondButtonResponseLost | Fault::ButtonRestorationRejected
                    ) && !self.fired
                        && index == 3
                    {
                        self.fired = true;
                        return Some(
                            "injected button response lost after device accepted write".into(),
                        );
                    }
                }
                0x16 => {
                    self.writes.push(p.to_vec());
                    let start = p[2] as usize * 56;
                    let end = (start + 56).min(self.macro_data.len());
                    self.macro_data[start..end].copy_from_slice(&p[8..8 + end - start]);
                }
                GET_MACRO => {
                    let start = p[2] as usize * 64;
                    self.pending = vec![0; 64];
                    let end = (start + 64).min(self.macro_data.len());
                    if start < end {
                        self.pending[..end - start]
                            .copy_from_slice(&self.macro_data[start..end]);
                    }
                }
                _ => panic!("unexpected mocked command {}", p[0]),
            }
            None
        }
    }
    async fn mock(
        fault: Fault,
    ) -> (
        Arc<DriverClient>,
        Arc<Mutex<Device>>,
        tokio::task::JoinHandle<()>,
    ) {
        mock_with_gate(fault, None).await
    }
    struct WriteGate {
        command: u8,
        page: Option<u8>,
        fired: std::sync::atomic::AtomicBool,
        reached: Notify,
        release: Notify,
    }
    impl WriteGate {
        fn pause(&self, packet: &[u8]) -> bool {
            packet.first() == Some(&self.command)
                && self.page.is_none_or(|page| packet.get(2) == Some(&page))
                && self
                    .fired
                    .compare_exchange(
                        false,
                        true,
                        std::sync::atomic::Ordering::SeqCst,
                        std::sync::atomic::Ordering::SeqCst,
                    )
                    .is_ok()
        }
    }
    async fn mock_with_gate(
        fault: Fault,
        gate: Option<Arc<WriteGate>>,
    ) -> (
        Arc<DriverClient>,
        Arc<Mutex<Device>>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let device = Arc::new(Mutex::new(Device::new(fault)));
        let shared = device.clone();
        let task = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let shared = shared.clone();
                let gate = gate.clone();
                tokio::spawn(async move {
                    let mut raw = vec![];
                    let end = loop {
                        let mut buffer = [0; 4096];
                        let n = socket.read(&mut buffer).await.unwrap();
                        if n == 0 {
                            return;
                        }
                        raw.extend_from_slice(&buffer[..n]);
                        if let Some(i) = raw.windows(4).position(|b| b == b"\r\n\r\n") {
                            break i + 4;
                        }
                    };
                    let header = String::from_utf8_lossy(&raw[..end]).into_owned();
                    let length = header
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|n| n.trim().parse::<usize>().ok())
                        })
                        .unwrap();
                    while raw.len() < end + length {
                        let mut buffer = [0; 4096];
                        let n = socket.read(&mut buffer).await.unwrap();
                        if n == 0 {
                            return;
                        }
                        raw.extend_from_slice(&buffer[..n]);
                    }
                    let input = STANDARD.decode(&raw[end..end + length]).unwrap();
                    let request = fields(&input[5..]).unwrap();
                    let (response, should_pause) = {
                        let mut device = shared.lock().await;
                        if header.starts_with("POST /driver.DriverGrpc/sendMsg ") {
                            let command = bytes(&request, 2);
                            let should_pause = gate.as_ref().is_some_and(|g| g.pause(&command));
                            let response = match device.command(&command) {
                                Some(error) => field_bytes(1, error.as_bytes()),
                                None => vec![],
                            };
                            (response, should_pause)
                        } else if header.starts_with("POST /driver.DriverGrpc/readMsg ") {
                            (field_bytes(2, &device.pending), false)
                        } else {
                            panic!("unexpected mock RPC")
                        }
                    };
                    if should_pause {
                        let gate = gate.as_ref().unwrap();
                        gate.reached.notify_one();
                        gate.release.notified().await;
                    }
                    let mut wire = vec![0];
                    wire.extend((response.len() as u32).to_be_bytes());
                    wire.extend(response);
                    let body = STANDARD.encode(wire);
                    socket.write_all(format!("HTTP/1.1 200 OK\r\ncontent-type: application/grpc-web-text\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",body.len(),body).as_bytes()).await.unwrap();
                });
            }
        });
        (
            Arc::new(DriverClient::with_endpoint(format!("http://{}", address))),
            device,
            task,
        )
    }
    fn service(client: Arc<DriverClient>) -> R2Service {
        R2Service::new(
            client,
            json!({"path":"mock-only","kind":"receiver","mouseId":2147485541u64}),
        )
    }
    fn changes() -> Value {
        json!({"options":{"rate":2000},"dpi":{"dpiArr":[800]},"buttonMappings":[{"index":2,"mapping":[1,0,243,0]},{"index":3,"mapping":[1,0,241,0]}]})
    }
    async fn snapshot(device: &Arc<Mutex<Device>>) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
        let d = device.lock().await;
        (d.options.clone(), d.dpi.clone(), d.keys.clone())
    }
    #[tokio::test]
    async fn uncertain_dpi_failure_restores_fresh_raw_originals() {
        let (client, device, task) = mock(Fault::DpiResponseLost).await;
        let original = snapshot(&device).await;
        let error = service(client)
            .apply_changes(&changes())
            .await
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("Previous settings were restored and verified"),
            "{}",
            error
        );
        assert_eq!(snapshot(&device).await, original);
        let commands: Vec<u8> = device.lock().await.writes.iter().map(|p| p[0]).collect();
        assert_eq!(commands, vec![0x53, 0x54, 0x54, 0x53]);
        task.abort();
    }
    #[tokio::test]
    async fn uncertain_second_button_failure_restores_both_mappings_and_groups() {
        let (client, device, task) = mock(Fault::SecondButtonResponseLost).await;
        let original = snapshot(&device).await;
        let error = service(client)
            .apply_changes(&changes())
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("restored and verified"), "{}", error);
        assert_eq!(snapshot(&device).await, original);
        let written_indices: Vec<u8> = device
            .lock()
            .await
            .writes
            .iter()
            .filter(|p| p[0] == 0x50)
            .map(|p| p[2])
            .collect();
        assert_eq!(written_indices, vec![2, 3, 3, 2]);
        task.abort();
    }
    #[tokio::test]
    async fn readback_mismatch_triggers_verified_rollback() {
        let (client, device, task) = mock(Fault::ReadbackMismatch).await;
        let original = snapshot(&device).await;
        let error = service(client)
            .apply_changes(&changes())
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("readback mismatch"), "{}", error);
        assert!(error.contains("restored and verified"), "{}", error);
        assert_eq!(snapshot(&device).await, original);
        task.abort();
    }
    #[tokio::test]
    async fn rejected_rollback_reports_failure_but_continues_other_restorations() {
        let (client, device, task) = mock(Fault::ButtonRestorationRejected).await;
        let original = snapshot(&device).await;
        let error = service(client)
            .apply_changes(&changes())
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("RESTORATION FAILED"), "{}", error);
        assert!(error.contains("button 3"), "{}", error);
        let actual = snapshot(&device).await;
        assert_eq!(actual.0, original.0);
        assert_eq!(actual.1, original.1);
        assert_eq!(&actual.2[8..12], &original.2[8..12]);
        assert_ne!(&actual.2[12..16], &original.2[12..16]);
        task.abort();
    }
    fn gated_write(command: u8, page: Option<u8>) -> Arc<WriteGate> {
        Arc::new(WriteGate {
            command,
            page,
            fired: std::sync::atomic::AtomicBool::new(false),
            reached: Notify::new(),
            release: Notify::new(),
        })
    }
    #[tokio::test]
    async fn invalidation_during_settings_write_stops_followup_and_rollback() {
        let gate = gated_write(0x53, None);
        let (client, device, task) = mock_with_gate(Fault::DpiResponseLost, Some(gate.clone())).await;
        let service = Arc::new(service(client));
        let operation_service = service.clone();
        let operation = tokio::spawn(async move { operation_service.apply_changes(&changes()).await });

        gate.reached.notified().await;
        service.invalidate();
        gate.release.notify_one();

        let error = operation.await.unwrap().unwrap_err().to_string();
        assert!(error.contains("RESTORATION FAILED"), "{error}");
        assert!(error.contains("unsafe restoration stopped"), "{error}");
        let commands: Vec<u8> = device.lock().await.writes.iter().map(|p| p[0]).collect();
        assert_eq!(commands, vec![0x53]);
        task.abort();
    }
    #[tokio::test]
    async fn invalidation_during_macro_page_stops_remaining_pages() {
        let gate = gated_write(0x16, Some(0));
        let (client, device, task) = mock_with_gate(Fault::DpiResponseLost, Some(gate.clone())).await;
        let service = Arc::new(service(client));
        let operation_service = service.clone();
        let operation = tokio::spawn(async move {
            operation_service.set_raw_macro(19, &[0xA5; 256]).await
        });

        gate.reached.notified().await;
        service.invalidate();
        gate.release.notify_one();

        let error = operation.await.unwrap().unwrap_err().to_string();
        assert!(error.contains("Selected device identity changed"), "{error}");
        let pages: Vec<u8> = device
            .lock()
            .await
            .writes
            .iter()
            .filter(|p| p[0] == 0x16)
            .map(|p| p[2])
            .collect();
        assert_eq!(pages, vec![0]);
        task.abort();
    }
    #[tokio::test]
    async fn unsupported_sensor_lift_off_is_rejected_before_any_write() {
        for (id, level, allowed) in [
            (2147485469u64, 2, false),
            (2147485561, 2, false),
            (2147485470, 2, true),
            (2147485541, 2, true),
        ] {
            let (client, device, task) = mock(Fault::DpiResponseLost).await;
            let service = R2Service::new(
                client,
                json!({"path":"mock-only","kind":"receiver","mouseId":id}),
            );
            let result = service
                .preflight(&json!({"options":{"liftCutOff":level}}))
                .await;
            assert_eq!(result.is_ok(), allowed);
            assert!(device.lock().await.writes.is_empty());
            task.abort();
        }
    }
}
