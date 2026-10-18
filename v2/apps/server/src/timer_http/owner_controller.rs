//! Durable owner transitions. No browser credential or instruction cache.
use super::*;
use orkestr_v2_store_sqlite::history_import::timers::authority::DurableTimerEnable;
#[derive(Clone)]
pub struct DurableOwnerController {
    store: Store,
    pub(crate) ready: std::sync::Arc<std::sync::atomic::AtomicBool>,
}
impl DurableOwnerController {
    pub fn new(store: Store) -> Self {
        Self {
            store,
            ready: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }
    pub(crate) async fn enable(
        &self,
        credential: String,
        owner: OwnerId,
        namespace: Uuid,
        body: dto::Enable,
    ) -> Result<TimerReceipt, HistoryError> {
        self.store
            .enable_durable_timer(
                &credential,
                &owner,
                &DurableTimerEnable {
                    timer: TimerEnableRequest {
                        namespace,
                        expected_revision: body.expected_revision,
                        request_key: body.request_key,
                        conversation_id: body.conversation_id,
                    },
                    instruction: body.text,
                },
            )
            .await?;
        // Return current state, including after immutable historical replay.
        self.store
            .dormant_timer_receipt(&credential, &owner, namespace)
            .await
    }
}
