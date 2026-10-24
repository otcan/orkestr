//! One typed reader action called by the existing durable timer controller.
use crate::{
    tracker_mail_sources,
    tracker_scan_pool::{Refused, ScanPool},
};
use orkestr_v2_mail_reader::{
    classify, store::scan_folders_with_identity, Cursor, Outcome, RulePack, ScanLimits,
};
use orkestr_v2_store_sqlite::{
    history_import::{HistoryError, Result},
    ScannedMessage, Store, TimerSchedulerIssuer,
};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

const RULES: &str = include_str!("../../../recipes/job-tracker/rules.json");
struct Batch {
    messages: Vec<ScannedMessage>,
    cursor: String,
    summary: String,
}

fn classify_batch(
    output: orkestr_v2_mail_reader::ScanOutput,
    rules: &RulePack,
) -> std::result::Result<Batch, crate::tracker_scan_pool::ReadFailure> {
    use crate::tracker_scan_pool::ReadFailure;
    if output.stats.missing_folders != 0 {
        return Err(ReadFailure::Unavailable);
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ReadFailure::Unavailable)?
        .as_millis() as i64;
    let mut events_total = 0usize;
    let mut messages = Vec::new();
    for envelope in &output.envelopes {
        let outcome = match classify(envelope, rules, now) {
            Outcome::Events { mut events, .. } => {
                events_total += events.len();
                if events_total > 256
                    || events.len() > orkestr_v2_contracts::TRACKER_EVENTS_PER_REQUEST
                {
                    return Err(ReadFailure::Unavailable);
                }
                for event in &mut events {
                    event.classifier.clone_from(&rules.version);
                }
                Ok(events)
            }
            Outcome::Dropped { reason } => Err(reason),
        };
        messages.push(ScannedMessage {
            message_ref: envelope.message_ref.clone(),
            outcome,
        });
    }
    Ok(Batch {
        messages,
        cursor: serde_json::to_string(&output.cursor).map_err(|_| ReadFailure::Unavailable)?,
        summary: serde_json::to_string(&output.stats).map_err(|_| ReadFailure::Unavailable)?,
    })
}

pub(crate) struct TrackerMailRuntime {
    pub pool: Arc<ScanPool>,
    pub metadata_pool: Arc<ScanPool>,
    pub rules: Arc<RulePack>,
    pub digest: String,
    pub discovery_env: orkestr_v2_mail_reader::profile::DiscoveryEnv,
    alerts: Mutex<BTreeMap<Uuid, &'static str>>,
    #[cfg(test)]
    pub reject_classified_event: std::sync::atomic::AtomicBool,
}
impl TrackerMailRuntime {
    pub fn new() -> std::result::Result<Self, &'static str> {
        Ok(Self {
            pool: Arc::new(ScanPool::new(2, 4).map_err(|_| "mail reader pool unavailable")?),
            metadata_pool: Arc::new(
                ScanPool::new(1, 2).map_err(|_| "mail metadata pool unavailable")?,
            ),
            rules: Arc::new(
                RulePack::from_json(RULES).map_err(|_| "installed mail rules invalid")?,
            ),
            digest: format!("{:x}", Sha256::digest(RULES.as_bytes())),
            discovery_env: orkestr_v2_mail_reader::profile::DiscoveryEnv::from_process(),
            alerts: Mutex::new(BTreeMap::new()),
            #[cfg(test)]
            reject_classified_event: std::sync::atomic::AtomicBool::new(false),
        })
    }
    pub fn alert(&self, namespace: Uuid, reason: &'static str) {
        let mut alerts = self
            .alerts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if reason == "tracker_scan_failed_occurrence_held" && alerts.contains_key(&namespace) {
            return;
        }
        if alerts.get(&namespace) == Some(&reason) {
            return;
        }
        if alerts.len() >= 256 && !alerts.contains_key(&namespace) {
            alerts.pop_first();
        }
        alerts.insert(namespace, reason);
        eprintln!(
            "{}",
            serde_json::json!({"event":"tracker_scan_refused","namespace":namespace,"reason":reason,"occurrence_held":true})
        );
    }
    pub fn capacity_alert(&self, namespace: Uuid, reason: Refused) {
        self.alert(
            namespace,
            match reason {
                Refused::Full => "reader_capacity_exhausted",
                Refused::Busy => "previous_reader_still_in_custody",
                Refused::Stopping => "reader_stopping",
                _ => "reader_unavailable",
            },
        );
    }
    pub fn alerts(&self) -> Vec<(Uuid, &'static str)> {
        self.alerts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .map(|(k, v)| (*k, *v))
            .collect()
    }

    /// Returns only after actual read completion and its guarded Store commit.
    /// A dropped/timed-out future leaves I/O custody with the process-owned pool.
    pub async fn run(
        &self,
        store: &Store,
        issuer: &TimerSchedulerIssuer,
        namespace: Uuid,
    ) -> Result<()> {
        let (owner, conversation) = store
            .tracker_scan_target(issuer, namespace)
            .await
            .inspect_err(|_| {
                self.alert(namespace, "source_or_timer_authority_changed");
            })?;
        let slot = self
            .pool
            .reserve_action(&owner, &conversation, namespace)
            .map_err(|e| {
                self.capacity_alert(namespace, e);
                HistoryError::Conflict
            })?;
        let claim = store
            .claim_tracker_scan(issuer, namespace)
            .await
            .inspect_err(|_| self.alert(namespace, "tracker_scan_claim_refused"))?;
        if claim.recipe_id() != "job-tracker"
            || claim.read_policy_id()
                != orkestr_v2_contracts::tracker_actions::TRACKER_READ_POLICY_V1
            || claim.classifier_id() != self.rules.version
            || claim.classifier_digest() != self.digest
        {
            self.abandon(store, issuer, &claim, namespace).await;
            self.alert(namespace, "installed_recipe_or_rules_changed");
            return Err(HistoryError::Conflict);
        }
        let material = store.tracker_scan_material(issuer, &claim).await;
        let (backing, cursor) = match material {
            Ok(value) => value,
            Err(error) => {
                self.alert(namespace, "tracker_scan_material_refused");
                self.abandon(store, issuer, &claim, namespace).await;
                return Err(error);
            }
        };
        let selected = claim.source().clone();
        let rules = self.rules.clone();
        #[cfg(test)]
        let reject = self
            .reject_classified_event
            .load(std::sync::atomic::Ordering::Relaxed);
        let ticket = match self.pool.enqueue(slot, move || {
            let resolved = tracker_mail_sources::resolve(&backing, &selected)?;
            // Corrupt stored cursors refuse; they never silently restart history.
            let cursor: Cursor = cursor
                .as_deref()
                .map(serde_json::from_str)
                .transpose()
                .map_err(|_| crate::tracker_scan_pool::ReadFailure::Unavailable)?
                .unwrap_or_default();
            let limits = ScanLimits {
                max_messages: 64,
                max_message_bytes: 4 * 1024 * 1024,
                max_mbox_bytes: 8 * 1024 * 1024,
                max_seen: 2_048,
                deadline: std::time::Instant::now() + Duration::from_millis(1500),
                ..ScanLimits::default()
            };
            let output = scan_folders_with_identity(
                &resolved.profile,
                Some(resolved.identity),
                &resolved.folders,
                &cursor,
                &limits,
                SystemTime::now(),
            )
            .map_err(|_| crate::tracker_scan_pool::ReadFailure::Unavailable)?;
            let batch = classify_batch(output, &rules)?;
            #[cfg(test)]
            let batch = if reject {
                let mut batch = batch;
                if let Some(event) = batch
                    .messages
                    .iter_mut()
                    .filter_map(|m| m.outcome.as_mut().ok())
                    .flatten()
                    .next()
                {
                    event.company.clear();
                }
                batch
            } else {
                batch
            };
            Ok(batch)
        }) {
            Ok(ticket) => ticket,
            Err(e) => {
                self.capacity_alert(namespace, e);
                self.abandon(store, issuer, &claim, namespace).await;
                return Err(HistoryError::Conflict);
            }
        };
        let completed = match ticket
            .wait(tokio::time::Instant::now() + Duration::from_secs(2))
            .await
        {
            Ok(value) => value,
            Err(_) => {
                self.abandon(store, issuer, &claim, namespace).await;
                self.alert(namespace, "reader_wait_ended_custody_retained_until_exit");
                return Err(HistoryError::Unavailable);
            }
        };
        let output = match completed.result() {
            Ok(output) => output,
            _ => {
                self.abandon(store, issuer, &claim, namespace).await;
                self.alert(namespace, "selected_mail_source_unavailable");
                return Err(HistoryError::Conflict);
            }
        };
        let result = store
            .commit_tracker_scan(
                issuer,
                &claim,
                &output.messages,
                &output.cursor,
                &output.summary,
            )
            .await;
        // The completion (and reservation) remains alive through commit/rollback.
        drop(completed);
        match result {
            Ok(_) => {
                self.alerts
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .remove(&namespace);
                Ok(())
            }
            Err(error) => {
                self.alert(namespace, "tracker_scan_commit_refused");
                self.abandon(store, issuer, &claim, namespace).await;
                Err(error)
            }
        }
    }
    async fn abandon(
        &self,
        store: &Store,
        issuer: &TimerSchedulerIssuer,
        claim: &orkestr_v2_store_sqlite::history_import::timers::scan_action::TrackerScanClaim,
        namespace: Uuid,
    ) {
        if let Err(error) = store.abandon_tracker_scan(issuer, claim).await {
            // Cleanup failure is separate evidence, never the scan's result or
            // a reason to terminate the shared timer controller.
            eprintln!(
                "{}",
                serde_json::json!({"event":"tracker_scan_cleanup_refused","namespace":namespace,"error":format!("{error:?}"),"occurrence_held":true})
            );
        }
    }
    pub async fn shutdown(&self) -> std::result::Result<(), &'static str> {
        self.pool.begin_shutdown();
        self.metadata_pool.begin_shutdown();
        let until = tokio::time::Instant::now() + Duration::from_secs(6);
        loop {
            let reads_joined = self.pool.try_join();
            let metadata_joined = self.metadata_pool.try_join();
            if reads_joined && metadata_joined {
                return Ok(());
            }
            if tokio::time::Instant::now() >= until {
                return Err("mail reader threads have not exited");
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}
