use anyhow::{anyhow, bail, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::{collections::BTreeMap, time::Duration};
use tokio::sync::{mpsc, Mutex};

const MAX_GRPC_FRAME: usize = 16 * 1024 * 1024;
// Base64 plus framing/trailers for a maximum-size helper response.
const MAX_UNARY_BODY: usize = 24 * 1024 * 1024;

#[derive(Clone, Debug)]
pub enum Pb {
    Num(u64),
    Bytes(Vec<u8>),
}
pub type Fields = BTreeMap<u32, Vec<Pb>>;
pub fn varint(mut n: u64) -> Vec<u8> {
    let mut b = Vec::new();
    loop {
        let v = (n & 127) as u8;
        n >>= 7;
        b.push(v | if n > 0 { 128 } else { 0 });
        if n == 0 {
            break;
        }
    }
    b
}
pub fn field_num(n: u32, v: u64) -> Vec<u8> {
    let mut b = varint((n as u64) * 8);
    b.extend(varint(v));
    b
}
pub fn field_bytes(n: u32, v: &[u8]) -> Vec<u8> {
    let mut b = varint((n as u64) * 8 + 2);
    b.extend(varint(v.len() as u64));
    b.extend(v);
    b
}
pub fn fields(b: &[u8]) -> Result<Fields> {
    fn read(b: &[u8], p: &mut usize) -> Result<u64> {
        let mut n = 0;
        for i in 0..10 {
            let v = *b.get(*p).ok_or_else(|| anyhow!("Truncated protobuf"))?;
            *p += 1;
            if i == 9 && v > 1 {
                bail!("Overflowing protobuf varint")
            }
            n |= ((v & 127) as u64) << (i * 7);
            if v & 128 == 0 {
                return Ok(n);
            }
        }
        bail!("Invalid varint")
    }
    let mut out = Fields::new();
    let mut p = 0;
    while p < b.len() {
        let tag = read(b, &mut p)?;
        let field = tag >> 3;
        if field == 0 || field > 0x1fff_ffff {
            bail!("Invalid protobuf tag")
        };
        let num = field as u32;
        let value = match tag & 7 {
            0 => Pb::Num(read(b, &mut p)?),
            2 => {
                let len = read(b, &mut p)? as usize;
                let end = p
                    .checked_add(len)
                    .ok_or_else(|| anyhow!("Invalid protobuf length"))?;
                let v = b
                    .get(p..end)
                    .ok_or_else(|| anyhow!("Truncated protobuf bytes"))?
                    .to_vec();
                p = end;
                Pb::Bytes(v)
            }
            1 | 5 => {
                let end = p + if tag & 7 == 1 { 8 } else { 4 };
                let v = b
                    .get(p..end)
                    .ok_or_else(|| anyhow!("Truncated fixed field"))?
                    .to_vec();
                p = end;
                Pb::Bytes(v)
            }
            _ => bail!("Unsupported protobuf wire type"),
        };
        out.entry(num).or_default().push(value);
    }
    Ok(out)
}
pub fn num(f: &Fields, n: u32) -> u64 {
    match f.get(&n).and_then(|v| v.first()) {
        Some(Pb::Num(n)) => *n,
        _ => 0,
    }
}
pub fn bytes(f: &Fields, n: u32) -> Vec<u8> {
    match f.get(&n).and_then(|v| v.first()) {
        Some(Pb::Bytes(b)) => b.clone(),
        _ => vec![],
    }
}
pub fn string(f: &Fields, n: u32) -> String {
    String::from_utf8_lossy(&bytes(f, n)).into_owned()
}
fn status(data: &[u8]) -> Result<Value> {
    let f = fields(data)?;
    if !f.contains_key(&2) {
        return Ok(Value::Null);
    }
    let s = fields(&bytes(&f, 2))?;
    Ok(json!({"battery":num(&s,1),"isOnline":num(&s,2)!=0}))
}
pub fn decode_devices(data: &[u8]) -> Result<Value> {
    let f = fields(data)?;
    let mut devices = vec![];
    for item in f.get(&1).into_iter().flatten() {
        if let Pb::Bytes(b) = item {
            let dj = fields(b)?;
            if dj.contains_key(&1) {
                let d = fields(&bytes(&dj, 1))?;
                devices.push(json!({"kind":"device","devtype":num(&d,1),"is24":num(&d,2)!=0,"path":string(&d,3),"id":num(&d,4)as i32,"battery":num(&d,5),"isOnline":num(&d,6)!=0,"vid":num(&d,7),"pid":num(&d,8)}));
            } else {
                let d = fields(&bytes(&dj, 2))?;
                devices.push(json!({"kind":"receiver","path":string(&d,3),"keyboardId":num(&d,5),"mouseId":num(&d,6),"vid":num(&d,7),"pid":num(&d,8),"keyboard":if d.contains_key(&1){status(&bytes(&d,1))?}else{Value::Null},"mouse":if d.contains_key(&2){status(&bytes(&d,2))?}else{Value::Null}}));
            }
        }
    }
    Ok(json!({"type":num(&f,2),"devices":devices}))
}
pub fn is_r2(d: &Value) -> bool {
    if d["vid"].as_u64() != Some(12625) {
        return false;
    }
    let id = if d["kind"] == "receiver" {
        d["mouseId"].as_i64().unwrap_or(0)
    } else {
        d["id"].as_i64().unwrap_or(0).abs()
    };
    [1821, 1822, 1893, 1913].contains(&id) || [1821, 1822, 1893, 1913].contains(&(id - 2147483648))
}
fn frame(b: &[u8]) -> Vec<u8> {
    let mut v = vec![0];
    v.extend((b.len() as u32).to_be_bytes());
    v.extend(b);
    v
}
#[derive(Default)]
struct Decoder {
    text: String,
    data: Vec<u8>,
}
impl Decoder {
    fn push(&mut self, input: &[u8], text: bool) -> Result<Vec<Vec<u8>>> {
        if text {
            if !input.is_ascii() {
                bail!("Non-ASCII byte in gRPC-web text response")
            }
            // gRPC-web text is ASCII. Reject malformed bytes before appending so
            // byte-based quartet slicing below can never split a UTF-8 codepoint.
            self.text.push_str(std::str::from_utf8(input)?);
            self.text.retain(|c| !c.is_whitespace());
            while self.text.len() >= 4 {
                let n = match self.text.find('=') {
                    Some(i) => (i + 4) / 4 * 4,
                    None => self.text.len() / 4 * 4,
                };
                if n > self.text.len() {
                    break;
                }
                self.data.extend(STANDARD.decode(&self.text[..n])?);
                self.text.drain(..n);
            }
        } else {
            self.data.extend(input)
        }
        let mut out = vec![];
        while self.data.len() >= 5 {
            let flags = self.data[0];
            let n = u32::from_be_bytes(self.data[1..5].try_into()?) as usize;
            if n > MAX_GRPC_FRAME {
                bail!("Oversized gRPC frame")
            }
            if self.data.len() < 5 + n {
                break;
            }
            let p = self.data[5..5 + n].to_vec();
            self.data.drain(..5 + n);
            if flags & 128 != 0 {
                let t = String::from_utf8_lossy(&p);
                for line in t.lines() {
                    if let Some(status) = line.strip_prefix("grpc-status:") {
                        if status.trim() != "0" {
                            bail!("Driver gRPC error: {}", t)
                        }
                    }
                }
            } else {
                if flags & 1 != 0 {
                    bail!("Compressed gRPC frame unsupported")
                }
                out.push(p)
            }
        }
        Ok(out)
    }
    fn finish(&self) -> Result<()> {
        if !self.data.is_empty() || !self.text.is_empty() {
            bail!("Truncated gRPC response")
        }
        Ok(())
    }
}
pub struct DriverClient {
    http: reqwest::Client,
    endpoint: String,
    exchange_lock: Mutex<()>,
    pub operation_lock: Mutex<()>,
}
impl Default for DriverClient {
    fn default() -> Self {
        Self::new()
    }
}
impl DriverClient {
    pub fn new() -> Self {
        Self {
            // The hardware helper is local. System proxy settings and HTTP
            // redirects must never send device packets to another endpoint.
            http: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(3))
                .build()
                .expect("Cannot initialize local hardware client"),
            endpoint: "http://127.0.0.1:3814".into(),
            exchange_lock: Mutex::new(()),
            operation_lock: Mutex::new(()),
        }
    }
    pub fn with_endpoint(endpoint: String) -> Self {
        Self {
            endpoint,
            ..Self::new()
        }
    }
    async fn request(&self, method: &str, payload: &[u8]) -> Result<reqwest::Response> {
        let r = tokio::time::timeout(Duration::from_secs(5), self
            .http
            .post(format!("{}/driver.DriverGrpc/{}", self.endpoint, method))
            .header("content-type", "application/grpc-web-text")
            .header("accept", "application/grpc-web-text")
            .header("x-grpc-web", "1")
            .body(STANDARD.encode(frame(payload)))
            .send())
            .await??;
        if !r.status().is_success() {
            bail!("Driver HTTP {}", r.status())
        }
        Ok(r)
    }
    async fn unary(&self, method: &str, payload: &[u8]) -> Result<Vec<u8>> {
        tokio::time::timeout(Duration::from_secs(5), async {
            let r = self.request(method, payload).await?;
            let text = r
                .headers()
                .get("content-type")
                .and_then(|s| s.to_str().ok())
                .unwrap_or("")
                .contains("text");
            if r.content_length().is_some_and(|n| n > MAX_UNARY_BODY as u64) {
                bail!("Oversized driver response")
            }
            let mut data = Vec::new();
            let mut stream = r.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk?;
                if chunk.len() > MAX_UNARY_BODY - data.len() {
                    bail!("Oversized driver response")
                }
                data.extend_from_slice(&chunk);
            }
            let mut decoder = Decoder::default();
            let mut out = decoder.push(&data, text)?;
            decoder.finish()?;
            if out.is_empty() {
                bail!("Empty driver response")
            }
            Ok(out.remove(0))
        })
        .await?
    }
    pub async fn get_version(&self) -> Result<Value> {
        let f = fields(&self.unary("getVersion", &[]).await?)?;
        Ok(json!({"version":string(&f,1),"timestamp":string(&f,2)}))
    }
    /// Match the vendor startup handshake: unlock the helper's wireless polling
    /// loop before subscribing. This changes helper runtime state, not mouse settings.
    pub async fn start_wireless_polling(&self) -> Result<()> {
        // WirelessLoopStatus.lock is a proto3 bool; false is encoded as an empty message.
        self.unary("changeWirelessLoopStatus", &[]).await?;
        Ok(())
    }
    pub async fn discover(&self) -> Result<Value> {
        tokio::time::timeout(Duration::from_secs(3), async {
            let r = self.request("watchDevList", &[]).await?;
            let text = r
                .headers()
                .get("content-type")
                .and_then(|s| s.to_str().ok())
                .unwrap_or("")
                .contains("text");
            let mut stream = r.bytes_stream();
            let mut decoder = Decoder::default();
            while let Some(chunk) = stream.next().await {
                for b in decoder.push(&chunk?, text)? {
                    return decode_devices(&b);
                }
            }
            bail!("No device list received")
        })
        .await?
    }
    pub async fn watch_devices(&self, tx: mpsc::Sender<Value>) -> Result<()> {
        let r = self.request("watchDevList", &[]).await?;
        let text = r
            .headers()
            .get("content-type")
            .and_then(|s| s.to_str().ok())
            .unwrap_or("")
            .contains("text");
        let mut stream = r.bytes_stream();
        let mut decoder = Decoder::default();
        while let Some(chunk) = stream.next().await {
            for b in decoder.push(&chunk?, text)? {
                if tx.send(decode_devices(&b)?).await.is_err() {
                    return Ok(());
                }
            }
        }
        decoder.finish()?;
        Ok(())
    }
    pub async fn send(&self, path: &str, msg: &[u8], dangle: u64) -> Result<()> {
        let mut p = field_bytes(1, path.as_bytes());
        p.extend(field_bytes(2, msg));
        p.extend(field_num(3, 0));
        p.extend(field_num(4, dangle));
        let f = fields(&self.unary("sendMsg", &p).await?)?;
        let e = string(&f, 1);
        if !e.is_empty() {
            bail!("{}", e)
        }
        Ok(())
    }
    pub async fn read(&self, path: &str) -> Result<Vec<u8>> {
        let f = fields(
            &self
                .unary("readMsg", &field_bytes(1, path.as_bytes()))
                .await?,
        )?;
        let e = string(&f, 1);
        if !e.is_empty() {
            bail!("{}", e)
        }
        Ok(bytes(&f, 2))
    }
    pub async fn exchange(&self, path: &str, msg: &[u8], dangle: u64) -> Result<Vec<u8>> {
        let _lock = self.exchange_lock.lock().await;
        self.send(path, msg, dangle).await?;
        tokio::time::sleep(Duration::from_millis(5)).await;
        self.read(path).await
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };
    #[tokio::test]
    async fn helper_redirect_is_rejected_without_contacting_destination() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let destination = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let location = format!("http://{}/escaped", destination.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0; 4096];
            assert!(socket.read(&mut buffer).await.unwrap() > 0);
            socket.write_all(format!("HTTP/1.1 307 Temporary Redirect\r\nlocation: {location}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n").as_bytes()).await.unwrap();
        });
        let error = DriverClient::with_endpoint(endpoint).get_version().await.unwrap_err();
        assert!(error.to_string().contains("307"));
        assert!(tokio::time::timeout(Duration::from_millis(100), destination.accept()).await.is_err());
        server.await.unwrap();
    }
    #[tokio::test]
    async fn helper_oversized_response_is_rejected_before_reading_body() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0; 4096];
            assert!(socket.read(&mut buffer).await.unwrap() > 0);
            socket.write_all(format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", MAX_UNARY_BODY + 1).as_bytes()).await.unwrap();
        });
        let error = DriverClient::with_endpoint(endpoint).get_version().await.unwrap_err();
        assert!(error.to_string().contains("Oversized driver response"));
        server.await.unwrap();
    }
    #[tokio::test]
    async fn local_helper_ignores_system_proxy() {
        // Keep proxy environment changes confined to a fresh child test process.
        if std::env::var_os("R2_PROXY_REGRESSION_CHILD").is_none() {
            let result = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "driver::tests::local_helper_ignores_system_proxy", "--nocapture"])
                .env("R2_PROXY_REGRESSION_CHILD", "1")
                .env("HTTP_PROXY", "http://127.0.0.1:1")
                .env("http_proxy", "http://127.0.0.1:1")
                .env("ALL_PROXY", "http://127.0.0.1:1")
                .env_remove("NO_PROXY").env_remove("no_proxy")
                .output().unwrap();
            assert!(result.status.success(), "{}{}", String::from_utf8_lossy(&result.stdout), String::from_utf8_lossy(&result.stderr));
            return;
        }
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0; 4096];
            assert!(socket.read(&mut buffer).await.unwrap() > 0);
            let body = STANDARD.encode(frame(&field_bytes(1, b"183")));
            socket.write_all(format!("HTTP/1.1 200 OK\r\ncontent-type: application/grpc-web-text\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}", body.len(), body).as_bytes()).await.unwrap();
        });
        assert_eq!(DriverClient::with_endpoint(endpoint).get_version().await.unwrap()["version"], "183");
        server.await.unwrap();
    }
    #[tokio::test]
    async fn vendor_wireless_start_uses_false_default_payload_and_can_repeat() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut raw = Vec::new();
                let end = loop {
                    let mut buffer = [0; 1024];
                    let count = socket.read(&mut buffer).await.unwrap();
                    assert!(count > 0);
                    raw.extend_from_slice(&buffer[..count]);
                    if let Some(index) = raw.windows(4).position(|v| v == b"\r\n\r\n") {
                        break index + 4;
                    }
                };
                let header = String::from_utf8_lossy(&raw[..end]).into_owned();
                assert!(header
                    .starts_with("POST /driver.DriverGrpc/changeWirelessLoopStatus HTTP/1.1\r\n"));
                let length = header
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .and_then(|s| s.trim().parse::<usize>().ok())
                    })
                    .unwrap();
                while raw.len() < end + length {
                    let mut buffer = [0; 1024];
                    let count = socket.read(&mut buffer).await.unwrap();
                    assert!(count > 0);
                    raw.extend_from_slice(&buffer[..count]);
                }
                assert_eq!(
                    STANDARD.decode(&raw[end..end + length]).unwrap(),
                    vec![0, 0, 0, 0, 0]
                );
                // Empty protobuf response in a valid gRPC-web data frame.
                let body = STANDARD.encode(frame(&[]));
                socket.write_all(format!("HTTP/1.1 200 OK\r\ncontent-type: application/grpc-web-text\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}", body.len(), body).as_bytes()).await.unwrap();
            }
        });
        let client = DriverClient::with_endpoint(format!("http://{}", address));
        client.start_wireless_polling().await.unwrap();
        client.start_wireless_polling().await.unwrap();
        server.await.unwrap();
    }
    #[test]
    fn nested_receiver() {
        let mut d = field_num(6, 2147485541);
        d.extend(field_num(7, 12625));
        let list = decode_devices(&field_bytes(1, &field_bytes(2, &d))).unwrap();
        assert!(is_r2(&list["devices"][0]));
    }
    #[test]
    fn fragmented_frames() {
        let wire = STANDARD.encode(frame(&field_bytes(1, b"hello")));
        let mut d = Decoder::default();
        let mut messages = vec![];
        for c in wire.bytes() {
            messages.extend(d.push(&[c], true).unwrap());
        }
        d.finish().unwrap();
        assert_eq!(string(&fields(&messages[0]).unwrap(), 1), "hello");
    }
    #[test]
    fn grpc_web_text_rejects_non_ascii_and_invalid_utf8_without_panicking() {
        for malformed in [&b"AAA\xc3\xa9"[..], &[0xff, 0xfe][..]] {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                Decoder::default().push(malformed, true)
            }));
            assert!(result.is_ok(), "malformed text must not panic");
            assert!(result.unwrap().is_err(), "malformed text should be rejected");
        }
    }
    #[test]
    fn grpc_web_text_accepts_fragmented_ascii_with_whitespace_padding_and_controls() {
        let wire = STANDARD.encode(frame(&field_bytes(1, b"hello")));
        let spaced = wire.chars().map(|c| format!("{c}\t\n")).collect::<String>();
        let mut decoder = Decoder::default();
        let mut messages = vec![];
        for byte in spaced.bytes() {
            messages.extend(decoder.push(&[byte], true).unwrap());
        }
        decoder.finish().unwrap();
        assert_eq!(string(&fields(&messages[0]).unwrap(), 1), "hello");
    }
}
#[cfg(test)]
mod more_tests {
    use super::*;
    #[test]
    fn negative_device_id() {
        let mut d = field_num(4, (-1893i64) as u64);
        d.extend(field_num(7, 12625));
        let list = decode_devices(&field_bytes(1, &field_bytes(1, &d))).unwrap();
        assert_eq!(list["devices"][0]["id"], -1893);
    }
    #[test]
    fn trailers_and_padding() {
        let mut a = frame(b"hello");
        let mut trailer = frame(b"grpc-status: 0\r\n");
        trailer[0] = 128;
        let text = format!("{}{}", STANDARD.encode(&a), STANDARD.encode(&trailer));
        let mut d = Decoder::default();
        assert_eq!(
            d.push(text.as_bytes(), true).unwrap(),
            vec![b"hello".to_vec()]
        );
        d.finish().unwrap();
        a[0] = 1;
        assert!(Decoder::default().push(&a, false).is_err());
    }
    #[test]
    fn truncated_protobuf() {
        assert!(fields(&[10, 4, 1]).is_err());
        assert!(fields(&[128]).is_err());
    }
    #[test]
    fn overflowing_protobuf_values_and_field_tags_are_rejected() {
        let mut overflow = vec![8];
        overflow.extend([255; 9]);
        overflow.push(2);
        assert!(fields(&overflow).is_err());
        let mut oversized_tag = varint((0x2000_0000u64) << 3);
        oversized_tag.push(0);
        assert!(fields(&oversized_tag).is_err());
        let valid = field_num(1, u64::MAX);
        assert_eq!(num(&fields(&valid).unwrap(), 1), u64::MAX);
    }
}
