use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};
pub const GET_PROFILE: u8 = 0x85;
pub const GET_OPTIONS: u8 = 0xd3;
pub const GET_DPI: u8 = 0xd4;
pub const GET_KEYS: u8 = 0xd0;
pub const GET_MACRO: u8 = 0x96;
pub fn packet(command: u8) -> Vec<u8> {
    let mut b = vec![0; 64];
    b[0] = command;
    b
}
fn u16at(b: &[u8], i: usize) -> u16 {
    u16::from_le_bytes([b[i], b[i + 1]])
}
pub fn rate_code(rate: u64) -> Result<u8> {
    Ok(match rate {
        125 => 8,
        250 => 4,
        500 => 2,
        1000 => 1,
        2000 => 132,
        4000 => 130,
        8000 => 129,
        _ => bail!("Unsupported polling rate"),
    })
}
pub fn parse_options(b: &[u8]) -> Result<Value> {
    if b.len() != 64 {
        bail!("Expected 64-byte options response")
    }
    let bits = u16at(b, 12);
    let rate = match b[9] {
        8 => 125,
        4 => 250,
        2 => 500,
        1 => 1000,
        132 => 2000,
        130 => 4000,
        129 => 8000,
        _ => 0,
    };
    Ok(
        json!({"profile":b[8],"rate":rate,"deBounce":b[10],"lightOff":bits&1!=0,"wheelLightOff":bits&2!=0,"smooth":bits&4!=0,"ledSelect":bits&8!=0,"powerSaveMode":bits&16!=0,"buttonChange":b[14],"wheelToButton":b[15],"buttonToWheel":b[16],"sleepTime":{"time_bt":u16at(b,40),"deepTime_bt":u16at(b,42),"time_24":u16at(b,44),"deepTime_24":u16at(b,46)},"xSensitivity":b[50],"ySensitivity":b[51],"liftCutOff":b[52],"angelSnap":b[53],"light":decode_light(&b[24..32])?,"logoLight":if bits&2!=0{json!({"type":"LightOff"})}else{Value::Null}}),
    )
}
pub fn parse_dpi(b: &[u8]) -> Result<Value> {
    if b.len() != 64 {
        bail!("Expected 64-byte DPI response")
    }
    let dpi: Vec<u16> = (0..16).map(|i| u16at(b, 8 + 2 * i)).collect();
    let colors: Vec<u32> = (0..8)
        .map(|i| {
            let j = 40 + i * 3;
            (b[j] as u32) * 65536 + (b[j + 1] as u32) * 256 + b[j + 2] as u32
        })
        .collect();
    Ok(
        json!({"profile":b[1],"currentDpi":b[2],"currentDPIMax":b[3],"dpiArr":dpi,"DPIColorArr":colors}),
    )
}
fn bounded(v: &Value, min: u64, max: u64, name: &str) -> Result<u64> {
    let n = v.as_u64().ok_or_else(|| anyhow!("Invalid {}", name))?;
    if n < min || n > max {
        bail!("{} must be {}–{}", name, min, max)
    }
    Ok(n)
}
pub fn patch_options(raw: &[u8], changes: &Value) -> Result<Vec<u8>> {
    if raw.len() != 64 {
        bail!("Invalid raw options")
    }
    let mut b = raw.to_vec();
    b[0] = 0x53;
    b[1..8].fill(0);
    let map = changes
        .as_object()
        .ok_or_else(|| anyhow!("Options must be an object"))?;
    let at = [
        ("profile", 8),
        ("deBounce", 10),
        ("buttonChange", 14),
        ("wheelToButton", 15),
        ("buttonToWheel", 16),
        ("xSensitivity", 50),
        ("ySensitivity", 51),
        ("liftCutOff", 52),
        ("angelSnap", 53),
    ];
    let flags = [
        "lightOff",
        "wheelLightOff",
        "smooth",
        "ledSelect",
        "powerSaveMode",
    ];
    let mut bits = u16at(&b, 12);
    for (k, v) in map {
        if let Some((_, i)) = at.iter().find(|(name, _)| name == k) {
            b[*i] = bounded(v, 0, 255, k)? as u8;
        } else if k == "rate" {
            b[9] = rate_code(bounded(v, 125, 8000, k)?)?;
        } else if let Some(i) = flags.iter().position(|name| name == k) {
            let on = v
                .as_bool()
                .ok_or_else(|| anyhow!("{} must be boolean", k))?;
            if on {
                bits |= 1 << i
            } else {
                bits &= !(1 << i)
            }
        } else if k == "sleepTime" {
            let s = v.as_object().ok_or_else(|| anyhow!("Invalid sleep time"))?;
            let names = ["time_bt", "deepTime_bt", "time_24", "deepTime_24"];
            for (key, value) in s {
                let i = names
                    .iter()
                    .position(|name| name == key)
                    .ok_or_else(|| anyhow!("Unsupported sleep field"))?;
                b[40 + 2 * i..42 + 2 * i]
                    .copy_from_slice(&(bounded(value, 0, 65535, key)? as u16).to_le_bytes());
            }
        } else {
            bail!("Unsupported option {}", k)
        }
    }
    b[12..14].copy_from_slice(&bits.to_le_bytes());
    Ok(b)
}
pub fn patch_dpi(raw: &[u8], changes: &Value) -> Result<Vec<u8>> {
    if raw.len() != 64 {
        bail!("Invalid raw DPI")
    }
    let mut b = raw.to_vec();
    b[0] = 0x54;
    b[4..8].fill(0);
    for (k, v) in changes
        .as_object()
        .ok_or_else(|| anyhow!("DPI must be an object"))?
    {
        match k.as_str() {
            "currentDpi" => b[2] = bounded(v, 0, 7, k)? as u8,
            "currentDPIMax" => b[3] = bounded(v, 1, 8, k)? as u8,
            "dpiArr" => {
                let a = v.as_array().ok_or_else(|| anyhow!("Invalid DPI array"))?;
                if a.len() > 16 {
                    bail!("Too many DPI values")
                }
                for (i, v) in a.iter().enumerate() {
                    let n = bounded(v, 0, 42000, k)?;
                    if n % 50 != 0 {
                        bail!("DPI must use increments of 50")
                    }
                    b[8 + i * 2..10 + i * 2].copy_from_slice(&(n as u16).to_le_bytes());
                }
            }
            "DPIColorArr" => {
                let a = v.as_array().ok_or_else(|| anyhow!("Invalid color array"))?;
                if a.len() > 8 {
                    bail!("Too many colors")
                }
                for (i, v) in a.iter().enumerate() {
                    let n = bounded(v, 0, 0xffffff, k)? as u32;
                    b[40 + i * 3..43 + i * 3].copy_from_slice(&n.to_be_bytes()[1..]);
                }
            }
            _ => bail!("Unsupported DPI field {}", k),
        }
    }
    Ok(b)
}
pub fn verify_requested(actual: &Value, requested: &Value) -> Result<()> {
    if let Some(obj) = requested.as_object() {
        for (k, v) in obj {
            verify_requested(&actual[k], v)?
        }
    } else if let Some(a) = requested.as_array() {
        for (i, v) in a.iter().enumerate() {
            verify_requested(&actual[i], v)?
        }
    } else if actual != requested {
        bail!(
            "Device readback mismatch: requested {}, received {}",
            requested,
            actual
        )
    }
    Ok(())
}
pub fn key_packet(profile: u8, index: u8, mapping: &[u8]) -> Result<Vec<u8>> {
    if profile > 7 || index > 15 || mapping.len() != 4 {
        bail!("Invalid key mapping")
    }
    if mapping[0] == 9 && (mapping[1] > 2 || mapping[2] >= 20) {
        bail!("Invalid macro binding")
    }
    let mut b = packet(0x50);
    b[1] = profile;
    b[2] = index;
    b[8..12].copy_from_slice(mapping);
    Ok(b)
}
pub fn macro_packets(index: u8, raw: &[u8]) -> Result<Vec<Vec<u8>>> {
    if index >= 20 || raw.len() != 256 {
        bail!("Invalid macro slot or data")
    }
    let used = raw
        .iter()
        .rposition(|b| *b != 0)
        .map(|i| i + 1)
        .unwrap_or(0);
    let count = std::cmp::max(1, (used + 55) / 56);
    let mut out = vec![];
    for i in 0..count {
        let mut p = packet(0x16);
        p[1] = index;
        p[2] = i as u8;
        p[3] = used as u8;
        p[4] = u8::from(i == count - 1);
        let end = std::cmp::min((i + 1) * 56, 256);
        p[8..8 + end - i * 56].copy_from_slice(&raw[i * 56..end]);
        out.push(p)
    }
    Ok(out)
}
fn encode_macro_unpadded(value: &Value) -> Result<Vec<u8>> {
    let repeat = bounded(&value["repeatCount"], 0, 65535, "repeat count")? as u16;
    let events = value["macro"]
        .as_array()
        .ok_or_else(|| anyhow!("Expected macro events"))?;
    let mut out = repeat.to_le_bytes().to_vec();
    let mut i = 0;
    let mut needs_delay = false;
    while i < events.len() {
        let e = &events[i];
        let kind = e["type"].as_str().unwrap_or("");
        if kind == "delay" {
            let delay = bounded(&e["value"], 0, 65535, "delay")? as u16;
            // A standalone zero record is interpreted as an end marker by the decoder.
            // Treat zero-duration editor entries as no-ops, preserving any pending
            // event delay instead of accidentally terminating the remaining macro.
            if delay == 0 {
                i += 1;
                continue;
            }
            if !needs_delay {
                out.extend([0, 0])
            }
            out.extend(delay.to_le_bytes());
            needs_delay = false;
            i += 1;
            continue;
        }
        if needs_delay {
            out.extend([0, 0])
        }
        let code = match kind {
            "keyboard" => bounded(&e["value"], 4, 239, "keyboard code")? as u8,
            "mouse_button" => match e["value"].as_str().unwrap_or("") {
                "left" => 240,
                "right" => 241,
                "middle" => 242,
                "back" => 243,
                "forward" => 244,
                _ => bail!("Invalid mouse button"),
            },
            "mouse_move" => 249,
            _ => bail!("Unsupported macro event"),
        };
        out.push(code);
        let mut delay = 0;
        if i + 1 < events.len() && events[i + 1]["type"] == "delay" {
            if let Some(n) = events[i + 1]["value"].as_u64() {
                if n > 0 && n <= 127 {
                    delay = n as u8;
                    i += 1;
                }
            }
        }
        let down = if kind == "mouse_move" {
            false
        } else {
            match e["action"].as_str() {
                Some("down") => true,
                Some("up") => false,
                _ => bail!("Invalid macro action"),
            }
        };
        out.push(delay | if down { 128 } else { 0 });
        if kind == "mouse_move" {
            for key in ["dx", "dy"] {
                let n = e[key].as_i64().ok_or_else(|| anyhow!("Invalid movement"))?;
                if !(-128..=127).contains(&n) {
                    bail!("Movement out of range")
                }
                out.push(n as i8 as u8)
            }
        }
        needs_delay = delay == 0;
        i += 1;
    }
    if out.len() > 256 {
        bail!("Macro exceeds 256 bytes")
    }
    Ok(out)
}
/// Exact occupied storage, including the repeat-count header, before zero padding.
pub fn macro_encoded_len(value: &Value) -> Result<usize> {
    Ok(encode_macro_unpadded(value)?.len())
}
pub fn encode_macro(value: &Value) -> Result<Vec<u8>> {
    let mut out = encode_macro_unpadded(value)?;
    out.resize(256, 0);
    Ok(out)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn patch_preserves_bytes() {
        let b = vec![85; 64];
        let p = patch_options(&b, &json!({"rate":8000,"smooth":false})).unwrap();
        assert_eq!(p[9], 129);
        assert_eq!(p[23], 85);
        assert_eq!(parse_options(&p).unwrap()["smooth"], false);
        assert!(patch_options(&b, &json!({"smooth":"false"})).is_err());
    }
    #[test]
    fn macro_fixture() {
        let b=encode_macro(&json!({"repeatCount":3,"macro":[{"type":"keyboard","action":"down","value":4},{"type":"delay","value":20},{"type":"keyboard","action":"up","value":4},{"type":"delay","value":200}]})).unwrap();
        assert_eq!(&b[..8], &[3, 0, 4, 148, 4, 0, 200, 0]);
        assert_eq!(&macro_packets(2, &b).unwrap()[0][..5], &[22, 2, 0, 7, 1]);
    }
    #[test]
    fn readback_mismatch() {
        assert!(verify_requested(&json!({"rate":1000}), &json!({"rate":2000})).is_err());
    }
}
fn hid_key(name: &str) -> Result<u8> {
    let key = name.trim().to_ascii_uppercase();
    if key.len() == 1 {
        let c = key.as_bytes()[0];
        if c.is_ascii_alphabetic() {
            return Ok(4 + c - b'A');
        }
        if (b'1'..=b'9').contains(&c) {
            return Ok(30 + c - b'1');
        }
        if c == b'0' {
            return Ok(39);
        }
    }
    Ok(match key.as_str() {
        "ENTER" | "RETURN" => 40,
        "ESC" | "ESCAPE" => 41,
        "BACKSPACE" => 42,
        "TAB" => 43,
        "SPACE" => 44,
        "-" | "MINUS" => 45,
        "=" | "EQUAL" => 46,
        "[" => 47,
        "]" => 48,
        "\\" => 49,
        ";" => 51,
        "'" => 52,
        "`" => 53,
        "," => 54,
        "." => 55,
        "/" => 56,
        "CAPSLOCK" => 57,
        "PRINTSCREEN" => 70,
        "SCROLLLOCK" => 71,
        "PAUSE" => 72,
        "INSERT" => 73,
        "HOME" => 74,
        "PAGEUP" => 75,
        "DELETE" | "DEL" => 76,
        "END" => 77,
        "PAGEDOWN" => 78,
        "RIGHT" | "ARROWRIGHT" => 79,
        "LEFT" | "ARROWLEFT" => 80,
        "DOWN" | "ARROWDOWN" => 81,
        "UP" | "ARROWUP" => 82,
        _ => {
            if let Some(n) = key.strip_prefix('F').and_then(|n| n.parse::<u8>().ok()) {
                if (1..=12).contains(&n) {
                    return Ok(57 + n);
                }
            }
            bail!("Unsupported key name {}", name)
        }
    })
}
fn ui_macro_events(value: &Value) -> Result<Value> {
    let steps = value["steps"]
        .as_array()
        .ok_or_else(|| anyhow!("Macro requires steps"))?;
    if steps.len() > 100 {
        bail!("Too many macro steps")
    }
    let mut events = vec![];
    for step in steps {
        match step["type"].as_str().unwrap_or("") {
            "delay" => {
                bounded(&step["value"], 0, 65535, "delay")?;
                events.push(json!({"type":"delay","value":step["value"]}));
            }
            "click" => {
                let button = step["value"]
                    .as_str()
                    .ok_or_else(|| anyhow!("Invalid click"))?;
                if !["left", "right", "middle", "back", "forward"].contains(&button) {
                    bail!("Unsupported mouse button")
                }
                events.push(json!({"type":"mouse_button","value":button,"action":"down"}));
                events.push(json!({"type":"mouse_button","value":button,"action":"up"}));
            }
            "key" => {
                let combo = step["value"]
                    .as_str()
                    .ok_or_else(|| anyhow!("Invalid key combo"))?;
                let parts: Vec<_> = combo.split('+').map(str::trim).collect();
                let mut modifiers = vec![];
                let mut keys = vec![];
                for part in parts {
                    let upper = part.to_ascii_uppercase();
                    let modifier = match upper.as_str() {
                        "CTRL" | "CONTROL" => Some(224),
                        "SHIFT" => Some(225),
                        "ALT" => Some(226),
                        "WIN" | "WINDOWS" | "META" | "CMD" => Some(227),
                        _ => None,
                    };
                    if let Some(m) = modifier {
                        if !modifiers.contains(&m) {
                            modifiers.push(m)
                        }
                    } else {
                        keys.push(hid_key(part)?);
                    }
                }
                if keys.is_empty() {
                    bail!("Key combo needs a non-modifier key")
                }
                for key in modifiers.iter().chain(keys.iter()) {
                    events.push(json!({"type":"keyboard","value":key,"action":"down"}));
                }
                for key in keys.iter().rev().chain(modifiers.iter().rev()) {
                    events.push(json!({"type":"keyboard","value":key,"action":"up"}));
                }
            }
            _ => bail!("Unsupported macro step"),
        }
    }
    Ok(json!({"repeatCount":value.get("repeatCount").cloned().unwrap_or(json!(1)),"macro":events}))
}
pub fn compile_ui_macro(value: &Value) -> Result<Vec<u8>> {
    encode_macro(&ui_macro_events(value)?)
}
/// Compile and inspect a macro locally; this operation never accesses a device.
pub fn preview_macro(value: &Value) -> Result<Value> {
    let source = if value.get("macro").is_some() {
        value.clone()
    } else {
        ui_macro_events(value)?
    };
    let used = macro_encoded_len(&source)?;
    let canonical = decode_macro(&encode_macro(&source)?)?;
    let duration: u64 = canonical["macro"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|event| event["type"] == "delay")
        .filter_map(|event| event["value"].as_u64())
        .sum();
    Ok(json!({"canonical":canonical,"usedBytes":used,"capacity":256,"durationMs":duration}))
}
#[cfg(test)]
mod macro_preview_tests {
    use super::*;
    #[test]
    fn byte_accounting_matches_browser_fixtures() {
        let fixtures: Value =
            serde_json::from_str(include_str!("../backend/recorder-byte-fixtures.json")).unwrap();
        for fixture in fixtures.as_array().unwrap() {
            let source = json!({"repeatCount":1,"macro":fixture["events"]});
            assert_eq!(
                macro_encoded_len(&source).unwrap(),
                fixture["bytes"].as_u64().unwrap() as usize,
                "{}",
                fixture["name"]
            );
            assert_eq!(encode_macro(&source).unwrap().len(), 256);
        }
    }
    #[test]
    fn preview_compiles_ui_steps_and_preserves_canonical_holds() {
        let result = preview_macro(&json!({"repeatCount":2,"steps":[
            {"type":"click","value":"left"}, {"type":"delay","value":200},
            {"type":"key","value":"Ctrl+C"}
        ]}))
        .unwrap();
        assert_eq!(result["capacity"], 256);
        assert_eq!(result["usedBytes"], 24);
        assert_eq!(result["durationMs"], 200);
        assert_eq!(result["canonical"]["repeatCount"], 2);
        assert_eq!(
            result["canonical"]["macro"][0],
            json!({"type":"mouse_button","value":"left","action":"down"})
        );
        assert_eq!(
            result["canonical"]["macro"][3],
            json!({"type":"keyboard","value":224,"action":"down"})
        );
        let canonical = json!({"repeatCount":1,"macro":[
            {"type":"keyboard","value":4,"action":"down"}, {"type":"delay","value":99},
            {"type":"keyboard","value":4,"action":"up"}
        ]});
        assert_eq!(preview_macro(&canonical).unwrap()["canonical"], canonical);
    }
    #[test]
    fn preview_rejects_over_capacity_without_changing_encoder_limits() {
        let events = vec![json!({"type":"keyboard","value":4,"action":"down"}); 100];
        let source = json!({"repeatCount":1,"macro":events});
        assert!(macro_encoded_len(&source).is_err());
        assert!(preview_macro(&source).is_err());
        assert!(preview_macro(&json!({"steps":[{"type":"key","value":"Unknown"}]})).is_err());
    }
}
#[cfg(test)]
mod ui_tests {
    use super::*;
    #[test]
    fn combo() {
        let b=compile_ui_macro(&json!({"steps":[{"type":"key","value":"Ctrl+C"},{"type":"delay","value":100},{"type":"click","value":"left"}]})).unwrap();
        assert_eq!(&b[..6], &[1, 0, 224, 128, 0, 0]);
        assert!(compile_ui_macro(&json!({"steps":[{"type":"key","value":"Unknown"}]})).is_err());
    }
}
#[cfg(test)]
mod extra_tests {
    use super::*;
    #[test]
    fn dpi_endian_and_colors() {
        let b = packet(GET_DPI);
        let patched=patch_dpi(&b,&json!({"currentDpi":2,"currentDPIMax":6,"dpiArr":[400,800,1600],"DPIColorArr":[16744448]})).unwrap();
        assert_eq!(&patched[8..14], &[144, 1, 32, 3, 64, 6]);
        let parsed = parse_dpi(&patched).unwrap();
        assert_eq!(parsed["dpiArr"][2], 1600);
        assert_eq!(parsed["DPIColorArr"][0], 16744448);
        assert!(patch_dpi(&b, &json!({"dpiArr":[51]})).is_err());
    }
    #[test]
    fn sleep_readback_and_flags() {
        let mut b = packet(GET_OPTIONS);
        b[23] = 99;
        let p = patch_options(
            &b,
            &json!({"smooth":true,"powerSaveMode":true,"sleepTime":{"time_24":3600}}),
        )
        .unwrap();
        let value = parse_options(&p).unwrap();
        assert_eq!(value["sleepTime"]["time_24"], 3600);
        assert_eq!(value["smooth"], true);
        assert_eq!(p[23], 99);
        assert!(verify_requested(&value, &json!({"sleepTime":{"time_24":30}})).is_err());
    }
    #[test]
    fn erased_macro_exact_upload_layout() {
        let p = macro_packets(19, &[255; 256]).unwrap();
        assert_eq!(p.len(), 5);
        assert_eq!(&p[4][..5], &[22, 19, 4, 0, 1]);
        assert_eq!(&p[4][8..40], &[255; 32]);
    }
    #[test]
    fn macro_overflow_and_bad_values() {
        let events: Vec<Value> = (0..150)
            .map(|_| json!({"type":"keyboard","action":"down","value":4}))
            .collect();
        assert!(encode_macro(&json!({"repeatCount":1,"macro":events})).is_err());
        assert!(compile_ui_macro(&json!({"steps":[{"type":"delay","value":-1}]})).is_err());
    }
}
pub fn decode_macro(raw: &[u8]) -> Result<Value> {
    if raw.len() != 256 {
        bail!("Expected 256-byte macro")
    }
    if raw.iter().all(|b| *b == 255) {
        return Ok(json!({"erased":true,"repeatCount":0,"macro":[]}));
    }
    let mut i = 2;
    let mut events = vec![];
    while i + 1 < raw.len() {
        // The original reader processes its first four-byte record before it
        // checks for the next-record sentinel. In particular, an authored
        // leading zero-delay record is a no-op, not an empty-macro marker.
        // Keep the sentinel check for every later record so ordinary empty
        // macros and stale/unwritten tails still terminate safely.
        if i > 2 && i + 4 <= raw.len() && raw[i..i + 4] == [0, 0, 0, 0] {
            break;
        }
        let code = raw[i];
        let flags = raw[i + 1];
        i += 2;
        if code == 0 && flags == 0 {
            if i + 1 >= raw.len() {
                break;
            }
            let delay = u16at(raw, i);
            i += 2;
            if delay > 0 {
                events.push(json!({"type":"delay","value":delay}))
            } else if raw[i..].iter().all(|v| *v == 0) {
                break;
            }
            continue;
        }
        let action = if flags & 128 != 0 { "down" } else { "up" };
        if code == 249 {
            if i + 1 >= raw.len() {
                bail!("Truncated mouse move")
            }
            events.push(json!({"type":"mouse_move","dx":raw[i]as i8,"dy":raw[i+1]as i8}));
            i += 2;
        } else if (4..=239).contains(&code) {
            events.push(json!({"type":"keyboard","value":code,"action":action}));
        } else {
            let name = match code {
                240 => "left",
                241 => "right",
                242 => "middle",
                243 => "back",
                244 => "forward",
                _ => bail!("Unknown macro code {}", code),
            };
            events.push(json!({"type":"mouse_button","value":name,"action":action}));
        }
        let mut delay = (flags & 127) as u16;
        if delay == 0 {
            if i + 1 >= raw.len() {
                break;
            }
            delay = u16at(raw, i);
            i += 2;
        }
        if delay > 0 {
            events.push(json!({"type":"delay","value":delay}));
        }
    }
    Ok(json!({"repeatCount":u16at(raw,0),"macro":events}))
}
#[cfg(test)]
mod decode_tests {
    use super::*;
    #[test]
    fn canonical_roundtrip() {
        let value = json!({"repeatCount":2,"macro":[{"type":"keyboard","value":4,"action":"down"},{"type":"delay","value":20},{"type":"keyboard","value":4,"action":"up"},{"type":"delay","value":200},{"type":"mouse_move","dx":-2,"dy":3},{"type":"delay","value":30}]});
        assert_eq!(decode_macro(&encode_macro(&value).unwrap()).unwrap(), value);
    }
}

/// Validate complete HTTP request groups before any hardware write is attempted.
pub fn validate_options(changes: &Value) -> Result<()> {
    patch_options(&[0; 64], changes)?;
    Ok(())
}
pub fn validate_dpi(changes: &Value) -> Result<()> {
    patch_dpi(&[0; 64], changes)?;
    Ok(())
}
pub fn validate_key_mapping(profile: u8, index: u8, mapping: &[u8]) -> Result<()> {
    key_packet(profile, index, mapping)?;
    Ok(())
}

#[cfg(test)]
mod validation_tests {
    use super::*;
    #[test]
    fn complete_request_syntax() {
        assert!(validate_options(&json!({"smooth":"false"})).is_err());
        assert!(validate_dpi(&json!({"dpiArr":[50000]})).is_err());
        assert!(validate_key_mapping(0, 2, &[9, 0, 255, 0]).is_err());
        assert!(validate_key_mapping(0, 2, &[1, 0, 242, 0]).is_ok());
    }
}
/// Exact R2 catalog capabilities, from recovered/renderer/devices/symbol-{Ii,Di,Mi,Ei,sl,il,fl}.js.
pub fn r2_capabilities(device: &Value) -> Value {
    let receiver = device["kind"] == "receiver";
    let id = if receiver {
        let n = device["mouseId"].as_i64().unwrap_or(0);
        if n >= 2147483648 {
            n - 2147483648
        } else {
            n
        }
    } else {
        device["id"].as_i64().unwrap_or(0).abs()
    };
    let sensor3395 = id == 1821 || id == 1913;
    let stages = if id == 1913 { 8 } else { 6 };
    let max = if sensor3395 { 26000 } else { 42000 };
    let rates = if !receiver && (id == 1893 || id == 1913) {
        json!([125, 250, 500, 1000])
    } else {
        json!([125, 250, 500, 1000, 2000, 4000, 8000])
    };
    json!({"logicalId":id,"model":if id==1913{"R2-C"}else{"R2"},"variant":match id{1913=>"R2-C · PAW3395",1821=>"R2 · PAW3395",1893=>"R2B · PAW3950",_=>"R2 · PAW3950"},"dpiStages":stages,"dpiMax":max,"dpiMin":50,"dpiStep":50,"pollingRates":rates,"lightingTypes":[],"rgb":false,"independentXY":false,"liftOffLevels":if id==1822||id==1893{json!([0,1,2])}else{json!([0,1])},"debounceMax":10,"defaultDpi":if id==1913{json!([400,800,1200,1600,3200,5200,0,0])}else if id==1821{json!([800,1600,2400,3200,5000,26000])}else{json!([400,800,1200,1600,2400,3200])},"defaultCurrentDpi":if id==1821{0}else{1},"profiles":8,"macroSlots":20,"macroModes":["repeat_times","on_off","touch_repeat"],"sleep":{"time_bt":{"min":0,"max":3600},"time_24":{"min":0,"max":3600},"deepTime_bt":{"min":0,"max":0},"deepTime_24":{"min":0,"max":0}}})
}
/// Generic parent-class light decoder. Actual R2 catalogs have no exposed lighting types.
pub fn decode_light(raw: &[u8]) -> Result<Value> {
    if raw.len() != 8 {
        bail!("Expected eight light bytes")
    }
    let kind = raw[0];
    let speed = 4i32 - raw[1] as i32;
    let code = raw[3] & 15;
    let option = raw[3] >> 4;
    let palette = [
        0xff0000, 0xff80ff, 0xffff00, 0x00ff00, 0x00ffff, 0x0000ff, 0xff00ff,
    ];
    let mut rgb = (raw[4] as u32) * 65536 + (raw[5] as u32) * 256 + raw[6] as u32;
    if rgb == 16449530 && kind != 7 && kind != 9 {
        rgb = 0xffffff
    }
    if kind != 7 && kind != 9 && code < 7 {
        rgb = palette[code as usize]
    }
    let name = match kind {
        0 => "LightOff",
        1 => "LightAlwaysOn",
        2 => "LightBreath",
        3 => "LightNeon",
        4 => "LightWave",
        5 => "LightDazzing",
        6 => "LightLaser",
        7 => "LightMusicFollow",
        8 => "LightScreenColor",
        9 => "LightMusicFollow2",
        _ => return Ok(json!({"type":"Unknown","raw":raw})),
    };
    let mut out = json!({"type":name});
    if kind == 0 {
        return Ok(out);
    }
    out["value"] = json!(if kind == 8 { 4 } else { raw[2] });
    if [2, 3, 4, 5, 6].contains(&kind) {
        out["speed"] = json!(speed)
    }
    if kind != 3 && kind != 8 {
        out["rgb"] = json!(rgb);
        out["dazzle"] = json!(if kind == 7 || kind == 9 {
            code == 0
        } else {
            code == 8
        });
    }
    if kind == 3 {
        out["option"] = json!(if option == 0 { "Default" } else { "Random" });
    }
    if kind == 4 {
        out["option"] = json!(match option {
            1 => "left",
            2 => "down",
            3 => "up",
            _ => "right",
        });
    }
    if kind == 7 || kind == 9 {
        out["option"] = json!(match option {
            1 => "separate",
            2 => "intersect",
            _ => "upright",
        });
    }
    Ok(out)
}
pub fn macro_binding(mode: &str, index: u8) -> Result<Vec<u8>> {
    if index >= 20 {
        bail!("Macro slot must be 0–19")
    }
    let code = match mode {
        "repeat_times" => 0,
        "on_off" => 1,
        "touch_repeat" => 2,
        _ => bail!("Unsupported macro binding mode"),
    };
    Ok(vec![9, code, index, 0])
}
pub fn decode_key_mapping(mapping: &[u8]) -> Result<Value> {
    if mapping.len() != 4 {
        bail!("Expected four mapping bytes")
    }
    Ok(match mapping[0] {
        0 if mapping == [0, 0, 0, 0] => json!({"type":"forbidden"}),
        0 => json!({"type":"combo","modifierHid":mapping[1],"key":mapping[2],"key2":mapping[3]}),
        1 => json!({"type":"mouse","code":mapping[2],"parameter":mapping[3]}),
        9 => {
            if mapping[1] > 2 || mapping[2] >= 20 {
                bail!("Invalid macro binding")
            }
            json!({"type":"macro","mode":match mapping[1]{0=>"repeat_times",1=>"on_off",_=>"touch_repeat"},"slot":mapping[2]})
        }
        _ => json!({"type":"function","raw":mapping}),
    })
}
/// Compile the original linked X/Y stage editor into canonical DPI changes without any I/O.
pub fn compile_dpi_stages(stages: &Value, current: usize, count: usize) -> Result<Value> {
    let stages = stages
        .as_array()
        .ok_or_else(|| anyhow!("Expected DPI stage list"))?;
    if stages.len() != count || !(1..=8).contains(&count) || current >= count {
        bail!("Invalid DPI stage list/current index")
    }
    let mut values = vec![0u16; 8];
    let mut colors = vec![0u32; 8];
    for (i, stage) in stages.iter().enumerate() {
        let enabled = stage
            .get("enabled")
            .map(|v| {
                v.as_bool()
                    .ok_or_else(|| anyhow!("DPI enabled must be boolean"))
            })
            .transpose()?
            .unwrap_or(true);
        let v = bounded(&stage["value"], 0, 42000, "DPI value")?;
        if v % 50 != 0 {
            bail!("DPI must use increments of 50")
        }
        if enabled && v < 50 {
            bail!("Enabled DPI must be at least50")
        }
        values[i] = if enabled { v as u16 } else { 0 };
        colors[i] = bounded(&stage["color"], 0, 0xffffff, "DPI color")? as u32;
    }
    if values[current] == 0 {
        bail!("Current DPI stage is disabled")
    }
    let xy: Vec<u16> = values.iter().chain(values.iter()).copied().collect();
    Ok(json!({"currentDpi":current,"currentDPIMax":count,"dpiArr":xy,"DPIColorArr":colors}))
}
#[cfg(test)]
mod parity_tests {
    use super::*;
    #[test]
    fn actual_r2_capabilities_hide_generic_controls() {
        let c = r2_capabilities(&json!({"kind":"receiver","mouseId":2147485541u64}));
        assert_eq!(c["dpiStages"], 6);
        assert_eq!(c["lightingTypes"], json!([]));
        assert_eq!(c["independentXY"], false);
        assert_eq!(c["sleep"]["deepTime_24"]["max"], 0);
        let c = r2_capabilities(&json!({"kind":"device","id":1913}));
        assert_eq!(c["dpiStages"], 8);
        assert_eq!(c["dpiMax"], 26000);
        assert_eq!(c["pollingRates"], json!([125, 250, 500, 1000]));
    }
    #[test]
    fn macro_binding_modes_roundtrip() {
        for mode in ["repeat_times", "on_off", "touch_repeat"] {
            let mapping = macro_binding(mode, 19).unwrap();
            let parsed = decode_key_mapping(&mapping).unwrap();
            assert_eq!(parsed["mode"], mode);
            assert_eq!(parsed["slot"], 19);
            assert_eq!(&key_packet(7, 2, &mapping).unwrap()[8..12], &mapping);
        }
        assert!(macro_binding("unknown", 0).is_err());
    }
    #[test]
    fn linked_dpi_stages_include_colors_and_xy() {
        let stages = json!([{"value":400,"color":16711680},{"value":800,"color":65280},{"value":1200,"color":255},{"value":1600,"color":16776960},{"value":2400,"color":65535},{"value":3200,"color":16711935}]);
        let c = compile_dpi_stages(&stages, 1, 6).unwrap();
        assert_eq!(c["dpiArr"][1], 800);
        assert_eq!(c["dpiArr"][9], 800);
        assert_eq!(c["dpiArr"][6], 0);
        let b = patch_dpi(&packet(GET_DPI), &c).unwrap();
        let parsed = parse_dpi(&b).unwrap();
        verify_requested(&parsed, &c).unwrap();
    }
    #[test]
    fn lighting_wire_decode_preserves_generic_parent_semantics() {
        let v = decode_light(&[3, 3, 4, 7, 0, 0, 0, 0]).unwrap();
        assert_eq!(
            v,
            json!({"type":"LightNeon","value":4,"speed":1,"option":"Default"})
        );
        let p = decode_light(&[4, 2, 3, 0x18, 255, 0, 0, 0]).unwrap();
        assert_eq!(p["option"], "left");
        assert_eq!(p["dazzle"], true);
        assert_eq!(p["rgb"], 16711680);
    }
    #[test]
    fn full_sleep_and_sensitivity_wire_fields() {
        let p=patch_options(&packet(GET_OPTIONS),&json!({"xSensitivity":85,"ySensitivity":115,"sleepTime":{"time_bt":120,"deepTime_bt":0,"time_24":3600,"deepTime_24":0}})).unwrap();
        let got = parse_options(&p).unwrap();
        assert_eq!(got["xSensitivity"], 85);
        assert_eq!(got["ySensitivity"], 115);
        assert_eq!(got["sleepTime"]["time_24"], 3600);
    }
}

/// Firmware leaves unsent macro pages unchanged; only uploaded 56-byte pages have defined readback.
pub fn verify_macro_upload(index: u8, requested: &[u8], actual: &[u8]) -> Result<usize> {
    if actual.len() != 256 {
        bail!("Short macro readback")
    }
    let written = std::cmp::min(macro_packets(index, requested)?.len() * 56, 256);
    if actual[..written] != requested[..written] {
        bail!("Macro readback mismatch within uploaded {} bytes", written)
    }
    if let Ok(expected) = decode_macro(requested) {
        let received = decode_macro(actual)?;
        if received != expected {
            bail!("Macro semantic readback mismatch")
        }
    }
    Ok(written)
}
#[cfg(test)]
mod macro_tail_tests {
    use super::*;
    #[test]
    fn stale_unwritten_tail_is_not_macro_content() {
        let value = json!({"repeatCount":1,"macro":[{"type":"keyboard","value":4,"action":"down"},{"type":"keyboard","value":4,"action":"up"},{"type":"delay","value":25}]});
        let expected = encode_macro(&value).unwrap();
        let mut actual = expected.clone();
        actual[56..].fill(0xcd);
        assert_eq!(verify_macro_upload(19, &expected, &actual).unwrap(), 56);
        assert_eq!(decode_macro(&actual).unwrap(), value);
        actual[55] = 1;
        assert!(verify_macro_upload(19, &expected, &actual).is_err());
    }
    #[test]
    fn erased_restore_verifies_all256_bytes() {
        let mut actual = vec![255; 256];
        assert_eq!(verify_macro_upload(19, &actual, &actual).unwrap(), 256);
        actual[255] = 0;
        assert!(verify_macro_upload(19, &[255; 256], &actual).is_err());
    }
}
/// Compile a physical button keyboard combo using the original 4-byte [0,modifier,key1,key2] layout.
pub fn compile_key_combo(combo: &str) -> Result<Vec<u8>> {
    let mut modifiers = vec![];
    let mut keys = vec![];
    for part in combo.split('+').map(str::trim) {
        let modifier = match part.to_ascii_uppercase().as_str() {
            "CTRL" | "CONTROL" => Some(224),
            "SHIFT" => Some(225),
            "ALT" => Some(226),
            "WIN" | "WINDOWS" | "META" | "CMD" => Some(227),
            "RCTRL" | "RIGHTCTRL" => Some(228),
            "RSHIFT" | "RIGHTSHIFT" => Some(229),
            "RALT" | "RIGHTALT" => Some(230),
            "RWIN" | "RIGHTWIN" => Some(231),
            _ => None,
        };
        if let Some(code) = modifier {
            if !modifiers.contains(&code) {
                modifiers.push(code)
            }
        } else {
            let code = hid_key(part)?;
            if !keys.contains(&code) {
                keys.push(code)
            }
        }
    }
    if keys.is_empty() {
        bail!("A button combo needs an ordinary key")
    }
    let modifier = if modifiers.is_empty() {
        0
    } else {
        modifiers.remove(0)
    };
    let held: Vec<u8> = modifiers.into_iter().chain(keys).collect();
    if held.len() > 2 {
        bail!("Button combo exceeds its three HID usage slots")
    }
    Ok(vec![0, modifier, held[0], *held.get(1).unwrap_or(&0)])
}
#[cfg(test)]
mod combo_tests {
    use super::*;
    #[test]
    fn button_combo_wire_layout() {
        assert_eq!(
            compile_key_combo("Ctrl+Shift+C").unwrap(),
            vec![0, 224, 225, 6]
        );
        assert_eq!(compile_key_combo("Alt+Tab").unwrap(), vec![0, 226, 43, 0]);
        assert_eq!(compile_key_combo("RAlt+A+B").unwrap(), vec![0, 230, 4, 5]);
        assert!(compile_key_combo("Ctrl").is_err());
        assert!(compile_key_combo("A+B+C").is_err());
    }
}

/// Restore semantic macro content, never promote unspecified unsent device memory into new events.
pub fn macro_restore_payload(raw: &[u8]) -> Result<Vec<u8>> {
    if raw.len() != 256 {
        bail!("Expected 256-byte macro backup")
    }
    if raw.iter().all(|b| *b == 255) {
        return Ok(raw.to_vec());
    }
    encode_macro(&decode_macro(raw)?)
}
#[cfg(test)]
mod restore_tests {
    use super::*;
    #[test]
    fn backup_normalizes_unwritten_tail() {
        let expected = compile_ui_macro(
            &json!({"steps":[{"type":"key","value":"A"},{"type":"delay","value":25}]}),
        )
        .unwrap();
        let mut backup = expected.clone();
        backup[56..].fill(0xcd);
        assert_eq!(macro_restore_payload(&backup).unwrap(), expected);
        assert_eq!(macro_restore_payload(&[255; 256]).unwrap(), vec![255; 256]);
    }
}
