// Offline source-derived parity tests. Include under #[cfg(test)] from main.rs.
use crate::protocol::*;
use serde_json::{json, Value};
fn fixtures() -> Value { serde_json::from_str(include_str!("protocol-source-fixtures.json")).unwrap() }
fn packet_named(f:&Value,name:&str)->Vec<u8>{f["cases"].as_array().unwrap().iter().find(|v|v["name"]==name).unwrap()["packet"].as_array().unwrap().iter().map(|n|n.as_u64().unwrap()as u8).collect()}
#[test]
fn options_match_original_fields_and_preserve_unknown_payload(){
 let f=fixtures();
 for rate in [125,250,500,1000,2000,4000,8000]{
  let expected=packet_named(&f,&format!("options-{}",rate));
  let change=json!({"profile":7,"rate":rate,"deBounce":10,"lightOff":true,"wheelLightOff":false,"smooth":true,"ledSelect":false,"powerSaveMode":true,"buttonChange":2,"wheelToButton":3,"buttonToWheel":4,"xSensitivity":100,"ySensitivity":99,"liftCutOff":2,"angelSnap":1,"sleepTime":{"time_bt":60,"deepTime_bt":0,"time_24":3600,"deepTime_24":0}});
  assert_eq!(patch_options(&[0;64],&change).unwrap(),expected);
  let raw:Vec<u8>=(0..64).map(|i|i as u8).collect();
  let patched=patch_options(&raw,&json!({"rate":rate})).unwrap();
  for i in 8..64{if i!=9{assert_eq!(patched[i],raw[i],"unknown byte {}",i)}}
 }
}
#[test]
fn dpi_profile_and_key_match_original_wire(){
 let f=fixtures();let mut raw=vec![0;64];raw[1]=7;
 let patched=patch_dpi(&raw,&json!({"currentDpi":5,"currentDPIMax":6,"dpiArr":f["inputs"]["dpi"],"DPIColorArr":f["inputs"]["colors"]})).unwrap();
 assert_eq!(patched,packet_named(&f,"dpi-profile7"));
 assert_eq!(key_packet(7,5,&[0,224,225,6]).unwrap(),packet_named(&f,"key5-profile7"));
 let mut p=packet(5);p[1]=7;assert_eq!(p,packet_named(&f,"profile7"));
 for(name,cmd,profile)in[("get-profile",GET_PROFILE,None),("get-options",GET_OPTIONS,None),("get-dpi-profile7",GET_DPI,Some(7)),("get-keys-profile7",GET_KEYS,Some(7))]{
  let mut vendor=packet_named(&f,name);vendor.resize(64,0);let mut ours=packet(cmd);if let Some(n)=profile{ours[1]=n}assert_eq!(ours,vendor);
 }
}
#[test]
fn catalog_sensor_connection_and_stage_capabilities(){
 for(id,max,stages,lod)in[(1821,26000,6,2),(1822,42000,6,3),(1893,42000,6,3),(1913,26000,8,2)]{
  for receiver in [false,true]{let d=if receiver{json!({"kind":"receiver","mouseId":2147483648u64+id})}else{json!({"kind":"device","id":id})};let c=r2_capabilities(&d);assert_eq!(c["dpiMax"],max);assert_eq!(c["dpiStages"],stages);assert_eq!(c["profiles"],8);assert_eq!(c["liftOffLevels"].as_array().unwrap().len(),lod);assert_eq!(c["pollingRates"].as_array().unwrap().last().unwrap(),if !receiver&&(id==1893||id==1913){1000}else{8000});assert_eq!(c["independentXY"],false);assert_eq!(c["lightingTypes"],json!([]));}
 }
}
#[test]
fn generic_light_decoder_keeps_original_music_rgb(){
 let f=fixtures();for case in f["lightCases"].as_array().unwrap(){let raw:Vec<u8>=case["raw"].as_array().unwrap().iter().map(|n|n.as_u64().unwrap() as u8).collect();assert_eq!(decode_light(&raw).unwrap(),case["result"]);}
}
