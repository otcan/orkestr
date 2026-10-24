//! Owner/session-fenced UI operations. Positive decisions are retained before send.
use crate::{tracker_bridge, transport};
use dioxus::prelude::*;
use orkestr_v2_contracts::{tracker_actions::*, tracker_automation::*, TrackerPage};
use orkestr_v2_ui::{session_scope::SessionScope, tracker_setup::PendingDecision};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Clone, Deserialize)]
pub struct MailStatus {
    pub source_revision: i64,
    pub source: Option<SelectedMailSource>,
    pub checks: Vec<TrackerCheckReceipt>,
    pub scheduler_ready: bool,
    pub local_mail_supported: bool,
    pub classifier_id: String,
    pub classifier_digest: String,
    pub reader: ReaderStatus,
    pub alerts: Vec<(String, String)>,
}
#[derive(Clone, Deserialize)]
pub struct ReaderStatus {
    pub occupied: usize,
    pub cancelled: usize,
}
#[derive(Clone)]
pub struct Dashboard {
    pub page: TrackerPage,
    pub mail: MailStatus,
    pub automation: TrackerAutomationStatus,
    pub reports: Vec<TrackerScanReceipt>,
}
#[derive(Clone, Copy)]
pub struct TrackerUi {
    pub conversation: Signal<String>,
    pub csrf: Signal<String>,
    pub binding: Signal<String>,
    pub session: Signal<SessionScope>,
    pub generation: u64,
    pub expired: EventHandler<()>,
    pub data: Signal<Option<Dashboard>>,
    pub needs_setup: Signal<bool>,
    pub busy: Signal<bool>,
    pub notice: Signal<String>,
    pub reload: Signal<u64>,
    pub epoch: Signal<u64>,
    pub sources: Signal<Vec<TrackerMailSource>>,
    pub discovered: Signal<bool>,
    pub pending: Signal<Vec<PendingDecision>>,
}
impl TrackerUi {
    pub fn base(self) -> String {
        format!("/api/v2/conversations/{}/tracker", (self.conversation)())
    }
    pub fn current(self, epoch: u64) -> bool {
        self.session.read().is_current(self.generation) && *self.epoch.peek() == epoch
    }
    fn begin(mut self) -> u64 {
        self.epoch += 1;
        self.busy.set(true);
        self.notice.set(String::new());
        *self.epoch.peek()
    }
    fn finish(mut self, epoch: u64, result: Result<tracker_bridge::Reply, String>, message: &str) {
        if !self.current(epoch) {
            return;
        }
        self.busy.set(false);
        match result {
            Ok(reply) if reply.ok() => self.notice.set(message.into()),
            Ok(reply) if reply.status == 401 || reply.status == 403 => self.expired.call(()),
            Ok(reply) => self.notice.set(reply.failure()),
            Err(error) => self.notice.set(error),
        }
        self.reload += 1;
    }
    pub fn start(self, kind: &'static str, mut body: Value) {
        let epoch = self.begin();
        spawn(async move {
            let key = match transport::key().await {
                Ok(key) => key,
                Err(error) => {
                    self.finish(epoch, Err(error.message), "");
                    return;
                }
            };
            if !self.current(epoch) {
                return;
            }
            body["request_key"] = json!(key);
            self.send_decision(
                epoch,
                PendingDecision {
                    kind: kind.into(),
                    body,
                },
            )
            .await;
        });
    }
    pub fn retry(self, decision: PendingDecision) {
        let epoch = self.begin();
        spawn(async move {
            self.send_decision(epoch, decision).await;
        });
    }
    async fn send_decision(mut self, epoch: u64, decision: PendingDecision) {
        let Some((method, suffix)) = decision.operation() else {
            self.finish(epoch, Err("Unknown saved change.".into()), "");
            return;
        };
        let saved = tracker_bridge::journal(
            "save",
            &(self.binding)(),
            &(self.conversation)(),
            &decision.kind,
            decision.body.clone(),
        )
        .await;
        if let Err(error) = saved {
            self.finish(
                epoch,
                Err(format!("Could not save the recovery record. {error}")),
                "",
            );
            return;
        }
        if !self.current(epoch) {
            return;
        }
        if !self
            .pending
            .peek()
            .iter()
            .any(|p| p.key() == decision.key())
        {
            self.pending.write().push(decision.clone());
        }
        let result = tracker_bridge::call(
            method,
            &format!("{}{suffix}", self.base()),
            &(self.csrf)(),
            decision.body.clone(),
        )
        .await;
        if let Ok(ref reply) = result {
            if decision.resolved(reply.status, &reply.body) {
                let _ = tracker_bridge::journal(
                    "clear",
                    &(self.binding)(),
                    &(self.conversation)(),
                    "",
                    json!({"request_key":decision.key()}),
                )
                .await;
            }
        }
        let message = match decision.kind.as_str() {
            "check" => "Mail check decision confirmed. Current results appear below.",
            "selection" => "Mail folder decision confirmed. Current settings appear below.",
            "source_remove" => "Mail access removal confirmed. Current settings appear below.",
            "automation_enable" => {
                "Recurring schedule decision confirmed. Current settings appear below."
            }
            "automation_disable" => "Stop decision confirmed. Current settings appear below.",
            _ => "Saved.",
        };
        self.finish(epoch, result, message);
    }
    pub fn stop_check(self, key: String) {
        let epoch = self.begin();
        spawn(async move {
            let result = tracker_bridge::call(
                "DELETE",
                &format!("{}/checks/{key}", self.base()),
                &(self.csrf)(),
                Value::Null,
            )
            .await;
            self.finish(
                epoch,
                result,
                "Check stopped. An existing read may still be finishing.",
            );
        });
    }
    pub fn setup(self) {
        let epoch = self.begin();
        spawn(async move {
            let result = tracker_bridge::call(
                "PUT",
                &self.base(),
                &(self.csrf)(),
                json!({"recipe":"job-tracker"}),
            )
            .await;
            self.finish(epoch, result, "Choose the mail folders to read.");
        });
    }
    pub fn discover(mut self) {
        let epoch = self.begin();
        self.sources.set(Vec::new());
        self.discovered.set(false);
        spawn(async move {
            let key = match transport::key().await {
                Ok(key) => key,
                Err(error) => {
                    self.finish(epoch, Err(error.message), "");
                    return;
                }
            };
            if !self.current(epoch) {
                return;
            }
            let result = tracker_bridge::call(
                "POST",
                &format!("{}/mail-sources", self.base()),
                &(self.csrf)(),
                json!({"request_key":key}),
            )
            .await;
            if !self.current(epoch) {
                return;
            }
            if let Ok(ref reply) = result {
                if reply.ok() {
                    match serde_json::from_value::<Vec<TrackerMailSource>>(
                        reply.body["sources"].clone(),
                    ) {
                        Ok(sources) => {
                            self.sources.set(sources);
                            self.discovered.set(true);
                        }
                        Err(_) => {
                            self.finish(
                                epoch,
                                Err("Mail folders could not be displayed.".into()),
                                "",
                            );
                            return;
                        }
                    }
                }
            }
            self.finish(
                epoch,
                result,
                "Choose Inbox and Sent folders. Finish synchronization in Thunderbird first.",
            );
        });
    }
    pub fn remove_source(self) {
        if let Some(data) = self.data.peek().as_ref() {
            self.start(
                "source_remove",
                json!({"expected_revision":data.mail.source_revision}),
            );
        }
    }
    pub fn check_once(self) {
        if let Some(data) = self.data.peek().as_ref() {
            self.start("check",json!({"expected_source_revision":data.mail.source_revision,"expected_recipe":"job-tracker",
                "expected_classifier_id":data.mail.classifier_id,"expected_classifier_digest":data.mail.classifier_digest}));
        }
    }
    pub fn stop_automation(self) {
        if let Some(data) = self.data.peek().as_ref() {
            self.start("automation_disable",json!({"expected_revision":data.automation.revision,"expected_timer_revision":data.automation.timer_revision}));
        }
    }
    pub fn row_change(self, suffix: String, body: Value, done: EventHandler<()>) {
        let epoch = self.begin();
        spawn(async move {
            let mut result = tracker_bridge::call(
                "POST",
                &format!("{}{suffix}", self.base()),
                &(self.csrf)(),
                body,
            )
            .await;
            if let Ok(reply) = &mut result {
                if reply.status == 409 {
                    reply.body = json!({"message":"The entry changed. Close and reopen it to review the current values."});
                }
            }
            if self.current(epoch) && result.as_ref().is_ok_and(|r| r.ok()) {
                done.call(());
            }
            self.finish(epoch, result, "Tracker updated.");
        });
    }
}
