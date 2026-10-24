//! Serial, read-only refresh and recovery. No missing receipt creates new work.
use crate::{tracker_bridge, tracker_controller::*};
use dioxus::prelude::*;
use orkestr_v2_ui::tracker_setup::PendingDecision;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};

async fn get<T: DeserializeOwned>(ui: TrackerUi, suffix: &str) -> Result<T, String> {
    let reply =
        tracker_bridge::call("GET", &format!("{}{suffix}", ui.base()), "", Value::Null).await?;
    if reply.ok() {
        return serde_json::from_value(reply.body)
            .map_err(|_| "Tracker data could not be displayed.".into());
    }
    if (reply.status == 401 || reply.status == 403) && ui.session.read().is_current(ui.generation) {
        ui.expired.call(());
    }
    Err(reply.failure())
}
pub async fn refresh(mut ui: TrackerUi) {
    let epoch = *ui.epoch.peek();
    let result = load(ui, epoch).await;
    if !ui.current(epoch) {
        return;
    }
    match result {
        Ok(Some(data)) => {
            ui.data.set(Some(data));
            ui.needs_setup.set(false);
        }
        Ok(None) => {
            ui.data.set(None);
            ui.needs_setup.set(true);
        }
        Err(error) => ui.notice.set(error),
    }
}
async fn load(mut ui: TrackerUi, epoch: u64) -> Result<Option<Dashboard>, String> {
    let journal = tracker_bridge::journal(
        "load",
        &(ui.binding)(),
        &(ui.conversation)(),
        "",
        Value::Null,
    )
    .await;
    if !ui.current(epoch) {
        return Err(String::new());
    }
    if let Ok(value) = journal {
        let pending: Vec<PendingDecision> = serde_json::from_value(value)
            .map_err(|_| "Saved changes could not be read.".to_owned())?;
        ui.pending.set(pending.clone());
        for decision in pending {
            let Some(path) = decision.receipt_path() else {
                continue;
            };
            let receipt =
                tracker_bridge::call("GET", &format!("{}{path}", ui.base()), "", Value::Null)
                    .await?;
            if !ui.current(epoch) {
                return Err(String::new());
            }
            if receipt.status == 401 || receipt.status == 403 {
                ui.expired.call(());
                return Err(receipt.failure());
            }
            if receipt.ok()
                && receipt.body.get("request_key").and_then(Value::as_str) == decision.key()
            {
                let complete = decision.kind != "check"
                    || receipt.body["cancelled"] == true
                    || !receipt.body["result"].is_null();
                if complete {
                    tracker_bridge::journal(
                        "clear",
                        &(ui.binding)(),
                        &(ui.conversation)(),
                        "",
                        json!({"request_key":decision.key()}),
                    )
                    .await?;
                    if !ui.current(epoch) {
                        return Err(String::new());
                    }
                    ui.pending.write().retain(|p| p.key() != decision.key());
                }
            }
        }
    }
    let page = tracker_bridge::call("GET", &ui.base(), "", Value::Null).await?;
    if !ui.current(epoch) {
        return Err(String::new());
    }
    if page.status == 409 && page.body["code"] == "tracker_not_enabled" {
        return Ok(None);
    }
    if !page.ok() {
        if page.status == 401 || page.status == 403 {
            ui.expired.call(());
        }
        return Err(page.failure());
    }
    let page = serde_json::from_value(page.body)
        .map_err(|_| "Tracker table could not be displayed.".to_owned())?;
    let mail = get(ui, "/mail-status").await?;
    if !ui.current(epoch) {
        return Err(String::new());
    }
    let automation = get(ui, "/automation").await?;
    if !ui.current(epoch) {
        return Err(String::new());
    }
    let reports = get(ui, "/scan-reports").await?;
    Ok(Some(Dashboard {
        page,
        mail,
        automation,
        reports,
    }))
}
