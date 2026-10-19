use crate::{
    device::R2Service,
    driver::{self, DriverClient},
    protocol,
};
use serde_json::json;
use std::sync::Arc;
pub async fn run(client: Arc<DriverClient>) -> anyhow::Result<()> {
    let version = client.get_version().await?;
    let list = client.discover().await?;
    let device = list["devices"]
        .as_array()
        .and_then(|a| a.iter().find(|d| driver::is_r2(d)))
        .ok_or_else(|| anyhow::anyhow!("No R2 found."))?
        .clone();
    let service = R2Service::new(client, device);
    let baseline = service.read_settings().await?;
    let mut result = json!({"backend":"Rust","version":version,"baseline":baseline});
    if std::env::args().any(|a| a == "--verify-same-rate") {
        let rate = &result["baseline"]["options"]["rate"];
        let after = service.update_options(&json!({"rate":rate})).await?;
        if after != baseline {
            anyhow::bail!("Same-value write changed the baseline.");
        }
        result["sameRateVerified"] = json!(true);
    }
    if std::env::args().any(|a| a == "--verify-same-button") {
        let mapping: Vec<u8> = baseline["keyMappings"][2]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as u8)
            .collect();
        service
            .set_key(baseline["profile"].as_u64().unwrap() as u8, 2, &mapping)
            .await?;
        result["sameButtonVerified"] = json!(true);
    }
    if std::env::args().any(|a| a == "--verify-macro-slot") {
        let slot = 19u8;
        if baseline["keyMappings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m[0] == 9 && m[2] == slot)
        {
            anyhow::bail!("Test slot is bound to a button. Select an unbound slot for this test.");
        }
        let backup = service.get_macro(slot).await?;
        if backup["erased"] != true {
            anyhow::bail!("Macro test requires an erased slot; slot19 contains existing data.");
        }
        tokio::fs::write(
            "research/evidence/rust-macro-slot19-backup.json",
            serde_json::to_vec_pretty(&backup)?,
        )
        .await?;
        let raw: Vec<u8> = backup["raw"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as u8)
            .collect();
        let fixture = protocol::compile_ui_macro(
            &json!({"steps":[{"type":"key","value":"A"},{"type":"delay","value":25}]}),
        )?;
        let test = service.set_raw_macro(slot, &fixture).await;
        let restored = service.set_raw_macro(slot, &raw).await;
        if let Err(e) = restored {
            anyhow::bail!("Macro backup restoration failed: {e}. Backup is in research/evidence/rust-macro-slot19-backup.json");
        }
        test?;
        result["macroUploadVerified"] = json!(true);
        result["macroBackupRestored"] = json!(true);
    }
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}
