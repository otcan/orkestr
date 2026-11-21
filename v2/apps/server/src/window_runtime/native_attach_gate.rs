//! Native-attach holds at window admission and dispatch (`native_attach`).
//!
//! While the owner works in a conversation's native session from a terminal,
//! its window intents only queue: no fresh window, no follow-up join and no
//! operator provider switch. Each pass of the dispatcher (at least once a
//! second while rows wait) skips a held conversation's rows, so they are
//! admitted in their order, on the same session binding, once the hold is
//! released or lapses. The hold is a Root file read on every check, so a
//! restarted process honours it the same way. A deploy drain is unaffected:
//! a held conversation has no unresolved window, only queued intents. Held
//! rows count toward the owner-wide queue cap, so a large backlog alerts.
//!
//! No second writer: every window open or join, by admission or dispatch,
//! happens under `opening` and re-checks the hold there, right before Core
//! creates the window (`open_unless_held`, `entry_unless_held`). The owner's
//! read of `native_idle` takes the same lock (`native_idle`), so it never
//! reports idle while an open that passed its check before the hold existed
//! can still create its window: that window exists by then and keeps
//! `native_idle` false until it ran its turn and closed.
use super::{
    controller::{Controller, WindowOutcome},
    conversation::ConversationController,
};
use orkestr_v2_application::runtime::RuntimeStoreError;
use orkestr_v2_contracts::{ConversationId, ExecutionWindowQueued, ExecutionWindowRequest, OwnerId};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};

/// How long a `native_idle` read waits for an in-flight window open.
const IDLE_WAIT: Duration = Duration::from_secs(2);

impl Controller {
    pub(super) fn native_attach_held(&self, conversation: &ConversationId) -> bool {
        self.config
            .native_attach
            .as_ref()
            .is_some_and(|holds| holds.held(conversation, super::dispatch::now_ms()))
    }

    /// The conversations of one dispatch pass's queued rows that the owner
    /// holds now. Their rows keep their place and `pending` stays set, so a
    /// later pass admits them. A held conversation with more than
    /// `HELD_QUEUE_ALERT` queued intents raises a rate-limited alert.
    pub(super) fn native_attach_held_rows(
        &self,
        rows: &[ExecutionWindowQueued],
    ) -> HashSet<ConversationId> {
        let mut held = HashSet::new();
        let Some(holds) = &self.config.native_attach else {
            return held;
        };
        let now = super::dispatch::now_ms();
        let mut queued: HashMap<&ConversationId, usize> = HashMap::new();
        for row in rows {
            *queued.entry(&row.conversation_id).or_default() += 1;
        }
        for (conversation, count) in queued {
            if !holds.held(conversation, now) {
                continue;
            }
            if let Some(line) = holds.backlog_alert(conversation, count, now) {
                eprintln!("{line}");
            }
            held.insert(conversation.clone());
        }
        held
    }

    /// Admission's open or join, unless a hold appeared since its first check
    /// (then the intent only queues). The caller holds `opening`.
    pub(super) async fn open_unless_held(
        &self,
        entry: &ConversationController,
        browser: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        input: &ExecutionWindowRequest,
    ) -> Result<WindowOutcome, &'static str> {
        if self.native_attach_held(conversation) {
            self.queue.remember(browser);
            return self.enqueue(browser, conversation, input).await;
        }
        entry
            .process(browser, owner, conversation, input)
            .await
            .map(WindowOutcome::Admitted)
    }

    /// The dispatcher's controller for an open or join, unless a hold
    /// appeared since this pass began (the row then keeps its place). The
    /// caller holds `opening`.
    pub(super) fn entry_unless_held(
        &self,
        conversation: &ConversationId,
    ) -> Option<Arc<ConversationController>> {
        if self.native_attach_held(conversation) {
            return None;
        }
        self.entry(conversation).ok()
    }

    /// Whether V2 holds no native process of `conversation`: Core shows no
    /// unfinished window, read under `opening`. `None` (unknown) when an
    /// open stays in flight for `IDLE_WAIT` or Core is unavailable; never
    /// `Some(true)` while a window can still be created from a check made
    /// before the hold.
    pub(crate) async fn native_idle(
        &self,
        browser: &str,
        conversation: &ConversationId,
    ) -> Result<Option<bool>, RuntimeStoreError> {
        let Ok(_opening) = tokio::time::timeout(IDLE_WAIT, self.opening.lock()).await else {
            return Ok(None);
        };
        let status = self
            .store
            .execution_window_status_authenticated(browser, conversation)
            .await;
        crate::native_attach_http::window_idle(status)
    }
}
