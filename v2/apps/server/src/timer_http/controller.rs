//! Bounded ephemeral grants; no credential or text persistence/autostart.
use super::*;
use orkestr_v2_store_sqlite::history_import::timers::{
    input::TimerInputRequest, TimerClaimRequest,
};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;
const MAX_GRANTS: usize = 32;
const GRANT_TTL: Duration = Duration::from_secs(3600);
pub trait Clock: Send + Sync {
    fn now_ms(&self) -> Result<i64, HistoryError>;
}
pub struct SystemClock;
impl Clock for SystemClock {
    fn now_ms(&self) -> Result<i64, HistoryError> {
        i64::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| HistoryError::Unavailable)?
                .as_millis(),
        )
        .map_err(|_| HistoryError::Unavailable)
    }
}
struct Grant {
    credential: String,
    owner: OwnerId,
    namespace: Uuid,
    generation: i64,
    text: String,
    expires: Instant,
}
#[derive(Clone)]
pub struct TimerController {
    store: Store,
    clock: Arc<dyn Clock>,
    grants: Arc<Mutex<BTreeMap<String, Grant>>>,
}
impl TimerController {
    pub fn new(store: Store) -> Self {
        Self::with_clock(store, Arc::new(SystemClock))
    }
    // Clock injection is a Rust composition seam, never an HTTP selector.
    pub fn with_clock(store: Store, clock: Arc<dyn Clock>) -> Self {
        Self {
            store,
            clock,
            grants: Arc::new(Mutex::new(BTreeMap::new())),
        }
    }
    /// Explicit server lifecycle integration. Shutdown drops every ephemeral grant.
    pub async fn run(self, mut shutdown: tokio::sync::watch::Receiver<bool>) {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            if *shutdown.borrow() {
                break;
            }
            tokio::select! {
                changed=shutdown.changed()=> {if changed.is_err() || *shutdown.borrow() {break;}},
                _=interval.tick()=> {let _=self.tick().await;}
            }
        }
        self.grants.lock().await.clear();
    }
    fn key(owner: &OwnerId, namespace: Uuid) -> String {
        format!("{owner}:{namespace}")
    }
    pub(crate) async fn enable(
        &self,
        credential: String,
        owner: OwnerId,
        namespace: Uuid,
        body: dto::Enable,
    ) -> Result<TimerReceipt, HistoryError> {
        if body.request_key.is_empty()
            || body.request_key.len() > 128
            || body.request_key.chars().any(char::is_control)
            || body.text.trim().is_empty()
            || body.text.len() > 32768
        {
            return Err(HistoryError::Invalid);
        }
        let semantic =
            serde_json::json!(["orkestr.timer.http.enable.v1", body.request_key, body.text])
                .to_string();
        let request_key = format!("http:{:x}", Sha256::digest(semantic.as_bytes()));
        let mut grants = self.grants.lock().await;
        grants.retain(|_, g| g.expires > Instant::now());
        let key = Self::key(&owner, namespace);
        if !grants.contains_key(&key) && grants.len() >= MAX_GRANTS {
            return Err(HistoryError::Unavailable);
        }
        let receipt = self
            .store
            .enable_timer_input(
                &credential,
                &owner,
                &TimerEnableRequest {
                    namespace,
                    expected_revision: body.expected_revision,
                    request_key,
                    conversation_id: body.conversation_id,
                },
                self.clock.now_ms()?,
            )
            .await?;
        grants.insert(
            key,
            Grant {
                credential,
                owner,
                namespace,
                generation: receipt.generation,
                text: body.text,
                expires: Instant::now() + GRANT_TTL,
            },
        );
        Ok(receipt)
    }
    pub(crate) async fn disarm(&self, owner: &OwnerId, namespace: Uuid) {
        self.grants
            .lock()
            .await
            .remove(&Self::key(owner, namespace));
    }
    pub(crate) async fn armed(&self, owner: &OwnerId, receipt: &TimerReceipt) -> bool {
        self.grants
            .lock()
            .await
            .get(&Self::key(owner, receipt.namespace))
            .is_some_and(|g| {
                g.expires > Instant::now()
                    && g.generation == receipt.generation
                    && receipt.state == TimerState::Enabled
            })
    }
    /// One finite pass, at most 32 deliveries. Server lifecycle owns invocation.
    /// No public HTTP tick/run endpoint. Each Store call rechecks current auth.
    pub async fn tick(&self) -> Result<u32, HistoryError> {
        tokio::time::timeout(Duration::from_secs(5), self.tick_inner())
            .await
            .map_err(|_| HistoryError::Unavailable)?
    }
    async fn tick_inner(&self) -> Result<u32, HistoryError> {
        let now = self.clock.now_ms()?;
        let mut grants = self.grants.lock().await;
        grants.retain(|_, g| g.expires > Instant::now());
        let mut removed = Vec::new();
        let mut delivered = 0;
        for (key, g) in grants.iter() {
            if g.expires <= Instant::now() {
                removed.push(key.clone());
                continue;
            }
            let current = match self
                .store
                .dormant_timer_receipt(&g.credential, &g.owner, g.namespace)
                .await
            {
                Ok(r) => r,
                Err(_) => {
                    removed.push(key.clone());
                    continue;
                }
            };
            if current.state != TimerState::Enabled || current.generation != g.generation {
                removed.push(key.clone());
                continue;
            }
            if let Some(due) = current.next_due_ms.filter(|due| *due <= now) {
                let request = TimerInputRequest {
                    claim: TimerClaimRequest {
                        namespace: g.namespace,
                        generation: g.generation,
                        request_key: format!("http-due:{}:{due}", g.generation),
                        due_ms: due,
                    },
                    text: g.text.clone(),
                };
                match self
                    .store
                    .admit_timer_input(&g.credential, &g.owner, &request, now)
                    .await
                {
                    Ok(_) => delivered += 1,
                    Err(_) => removed.push(key.clone()),
                }
            }
        }
        for key in removed {
            grants.remove(&key);
        }
        Ok(delivered)
    }
}

#[cfg(test)]
#[path = "grant_tests.rs"]
mod grant_tests;
