//! Independent fixtures transcribed from the shipped JJr serializer, not by running it.
//! Source offsets and limitations: research/notes/current-macro-audit.md.
#[allow(dead_code)]
#[path = "../src/protocol.rs"]
mod protocol;
use protocol::*;
use serde_json::json;

#[test]
fn vendor_keyboard_modifier_and_delay_bytes() {
    let source = json!({"repeatCount":4660,"macro":[
        {"type":"keyboard","value":224,"action":"down"},
        {"type":"delay","value":127},
        {"type":"keyboard","value":4,"action":"down"},
        {"type":"delay","value":128},
        {"type":"keyboard","value":4,"action":"up"},
        {"type":"keyboard","value":224,"action":"up"},
        {"type":"delay","value":65535}
    ]});
    let raw = encode_macro(&source).unwrap();
    assert_eq!(&raw[..16], &[0x34,0x12,224,255,4,128,128,0,4,0,0,0,224,0,255,255]);
    assert_eq!(decode_macro(&raw).unwrap(), source);
}

#[test]
fn vendor_recorder_side_button_meanings() {
    // Aya: browser button 3 -> dh.Back; button 4 -> dh.Forward.
    // Vj: dh.Back -> 243, dh.Forward -> 244.
    for (name, code) in [("left",240),("right",241),("middle",242),("back",243),("forward",244)] {
        let source = json!({"repeatCount":1,"macro":[
            {"type":"mouse_button","value":name,"action":"down"},
            {"type":"delay","value":1},
            {"type":"mouse_button","value":name,"action":"up"}
        ]});
        let raw = encode_macro(&source).unwrap();
        assert_eq!(&raw[..6], &[1,0,code,129,code,0], "{name}");
        assert_eq!(decode_macro(&raw).unwrap(), source);
    }
}

#[test]
fn vendor_movement_write_layout_and_explicit_long_delay() {
    let source = json!({"repeatCount":65535,"macro":[
        {"type":"mouse_move","dx":-128,"dy":127},
        {"type":"delay","value":30},
        {"type":"mouse_move","dx":-1,"dy":0},
        {"type":"delay","value":65535}
    ]});
    let raw = encode_macro(&source).unwrap();
    assert_eq!(&raw[..12], &[255,255,249,30,128,127,249,0,255,0,255,255]);
    // Current decoder deliberately follows encoder semantics. The vendor reader
    // instead returns unsigned coordinates and divides inline movement delay by 2.
    assert_eq!(decode_macro(&raw).unwrap(), source);
}

#[test]
fn zero_delay_does_not_hide_following_actions() {
    for events in [
        json!([{"type":"delay","value":0},{"type":"keyboard","value":4,"action":"down"},{"type":"keyboard","value":4,"action":"up"}]),
        json!([{"type":"delay","value":1},{"type":"delay","value":0},{"type":"keyboard","value":4,"action":"down"},{"type":"keyboard","value":4,"action":"up"}]),
    ] {
        let source = json!({"repeatCount":1,"macro":events});
        let result = preview_macro(&source).unwrap();
        let actions: Vec<_> = result["canonical"]["macro"].as_array().unwrap().iter()
            .filter(|event| event["type"] == "keyboard").collect();
        assert_eq!(actions.len(), 2, "zero delay must not become a terminator");
    }
}

#[test]
fn original_leading_zero_record_preserves_actions_and_semantic_restore() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "fixtures/fw01-original-leading-zero.json"
    ))
    .unwrap();
    let raw: Vec<u8> = fixture["raw"]
        .as_array()
        .unwrap()
        .iter()
        .map(|byte| byte.as_u64().unwrap() as u8)
        .collect();
    let expected = json!({"repeatCount":1,"macro":[
        {"type":"keyboard","action":"down","value":4},
        {"type":"delay","value":20},
        {"type":"keyboard","action":"up","value":4}
    ]});

    assert_eq!(decode_macro(&raw).unwrap(), expected);
    let restored = macro_restore_payload(&raw).unwrap();
    assert_eq!(decode_macro(&restored).unwrap(), expected);
}

#[test]
fn zero_first_record_does_not_make_ambiguous_garbage_into_events() {
    let mut raw = vec![0; 256];
    raw[2..6].fill(0); // Original-format first zero-delay no-op.
    raw[6] = 0xff; // Unknown next record: there is no valid event to infer.
    assert!(decode_macro(&raw).is_err());
    assert!(macro_restore_payload(&raw).is_err());
}

#[test]
fn empty_and_authored_zero_noop_macros_keep_their_existing_semantics() {
    let empty = vec![0; 256];
    assert_eq!(decode_macro(&empty).unwrap(), json!({"repeatCount":0,"macro":[]}));
    let mut empty_with_stale_tail = empty.clone();
    empty_with_stale_tail[40..].fill(0xcd);
    assert_eq!(decode_macro(&empty_with_stale_tail).unwrap(), json!({"repeatCount":0,"macro":[]}));

    let authored = json!({"repeatCount":1,"macro":[
        {"type":"delay","value":0},
        {"type":"keyboard","value":4,"action":"down"},
        {"type":"keyboard","value":4,"action":"up"}
    ]});
    let raw = encode_macro(&authored).unwrap();
    let expected = json!({"repeatCount":1,"macro":[
        {"type":"keyboard","value":4,"action":"down"},
        {"type":"keyboard","value":4,"action":"up"}
    ]});
    assert_eq!(decode_macro(&raw).unwrap(), expected);
}

#[test]
fn vendor_pages_boundaries_and_full_restore() {
    for (used, count) in [(0,1),(56,1),(57,2),(224,4),(225,5),(256,5)] {
        let mut raw = vec![0;256];
        if used > 0 { raw[used-1] = 1; }
        let packets = macro_packets(19,&raw).unwrap();
        assert_eq!(packets.len(),count);
        for (page,p) in packets.iter().enumerate() {
            assert_eq!(p.len(),64);
            assert_eq!(&p[..5], &[22,19,page as u8,used as u8,u8::from(page==count-1)]);
        }
    }
    assert!(macro_packets(20,&[0;256]).is_err());
    let erased = vec![255;256];
    let packets = macro_packets(19,&erased).unwrap();
    assert_eq!(&packets[4][8..40], &[255;32]);
    assert_eq!(&packets[4][40..], &[0;24]);
    assert_eq!(verify_macro_upload(19,&erased,&erased).unwrap(),256);
}

#[test]
fn bindings_match_vendor_modes() {
    for (name,code) in [("repeat_times",0),("on_off",1),("touch_repeat",2)] {
        assert_eq!(macro_binding(name,19).unwrap(),vec![9,code,19,0]);
    }
    assert!(macro_binding("repeat_times",20).is_err());
}

#[test]
fn exact_macro_capacity_and_repeat_range() {
    // 127 action+inline delay pairs use 254 bytes plus the 2-byte count.
    let mut events = vec![];
    for _ in 0..127 { events.extend([json!({"type":"keyboard","value":4,"action":"down"}),json!({"type":"delay","value":1})]); }
    let mut value = json!({"repeatCount":0,"macro":events});
    assert_eq!(macro_encoded_len(&value).unwrap(),256);
    value["macro"].as_array_mut().unwrap().push(json!({"type":"delay","value":1}));
    assert!(encode_macro(&value).is_err());
    assert!(encode_macro(&json!({"repeatCount":65536,"macro":[]})).is_err());
}
