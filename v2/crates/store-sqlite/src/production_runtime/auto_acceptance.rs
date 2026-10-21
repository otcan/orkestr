//! Owner auto-acceptance by the server's system principal (V1 behaviour).
//!
//! Principal: the API server acting for the owner, not a browser session.
//! Authority, checked in the acceptance's own immediate transaction:
//! - this Store is bound to the conversation's live execution window by the
//!   window's private credential (held only by the server's window task,
//!   never by a provider process or an HTTP client), with the supervisor's
//!   current incarnation;
//! - the conversation's owner setting `review_before_accepting` is off, which
//!   is the owner's explicit, persisted delegation;
//! - the run belongs to an input of that same window.
//!
//! Every other acceptance rule is the owner path's own: exact owner,
//! conversation and run, an `awaiting_acceptance` completed proposal, the
//! exact revision, no undecided descendants. Each acceptance is audited in
//! `production_auto_acceptances` (actor `auto_accept`, window, context and
//! settings revision), so it is distinguishable from a browser decision.
//! This is not a `RuntimeStore` provider port: provider output cannot call it.
use super::acceptance::Principal;
use super::*;
use orkestr_v2_contracts::{
    ConversationId, EventId, ExecutionAcceptanceReceipt, ExecutionAcceptanceRequest, RunId,
};
use sqlx::{Sqlite, Transaction};

/// Proposals accepted per pass at most; later ones wait for the next pass.
const MAX_PER_PASS: i64 = 16;

pub(super) struct AutoAuthority {
    window: String,
    context: String,
    incarnation: String,
    settings_revision: i64,
}

/// Deterministic per-run key, so a retried pass replays its receipt.
pub fn auto_accept_request_key(run: &RunId) -> String {
    format!("auto-accept:{run}")
}

pub(super) async fn authorize(
    store: &Store,
    tx: &mut Transaction<'_, Sqlite>,
    owner: &OwnerId,
    conversation: &ConversationId,
    run: &RunId,
) -> Result<AutoAuthority> {
    let c = store.context()?;
    if c.window_bootstrap_only || c.owner != *owner {
        return Err(RuntimeStoreError::Unauthorized);
    }
    c.authenticate(tx).await?;
    let w = c
        .window_scope(tx)
        .await?
        .ok_or(RuntimeStoreError::Unauthorized)?;
    if w.get::<String, _>("conversation_id") != conversation.to_string()
        || !matches!(w.get::<&str, _>("state"), "opening" | "active" | "retiring")
    {
        return Err(RuntimeStoreError::Fenced);
    }
    let window: String = w.get("id");
    let settings = sqlx::query(
        "SELECT revision,review_before_accepting FROM conversation_settings WHERE conversation_id=? AND owner_id=?",
    )
    .bind(conversation.to_string())
    .bind(owner.to_string())
    .fetch_optional(&mut **tx)
    .await
    .map_err(db)?;
    let settings_revision = match settings {
        None => 0,
        Some(row) if row.get::<i64, _>("review_before_accepting") == 0 => row.get("revision"),
        Some(_) => return Err(RuntimeStoreError::Unauthorized),
    };
    let member: i64 = sqlx::query_scalar("SELECT count(*) FROM production_runs r WHERE r.id=? AND r.owner_id=? AND r.conversation_id=? AND r.message_id IN (SELECT i.message_id FROM execution_window_inputs i WHERE i.window_id=? AND i.owner_id=r.owner_id AND i.conversation_id=r.conversation_id)")
        .bind(run.to_string()).bind(owner.to_string()).bind(conversation.to_string()).bind(&window)
        .fetch_one(&mut **tx).await.map_err(db)?;
    if member != 1 {
        return Err(RuntimeStoreError::Fenced);
    }
    Ok(AutoAuthority {
        window,
        context: c.id.clone(),
        incarnation: c.incarnation.clone(),
        settings_revision,
    })
}

impl AutoAuthority {
    pub(super) async fn record(&self, tx: &mut Transaction<'_, Sqlite>, run: &RunId) -> Result<()> {
        sqlx::query("INSERT INTO production_auto_acceptances(run_id,actor,window_id,context_id,incarnation_id,settings_revision) VALUES(?,'auto_accept',?,?,?,?)")
            .bind(run.to_string()).bind(&self.window).bind(&self.context).bind(&self.incarnation).bind(self.settings_revision)
            .execute(&mut **tx).await.map_err(db)?;
        Ok(())
    }
}

impl Store {
    /// Accept every pending proposal of this window's inputs on the owner's
    /// behalf, Workers first so a decided Worker never holds its Deep parent,
    /// then Fast, then Deep. Requires a Store bound by the window credential.
    /// Returns the receipts committed (or replayed) in this pass; proposals
    /// still blocked (a Worker running, a moved revision) wait for the next.
    /// Review on, or no live window for this Store, accepts nothing.
    pub async fn auto_accept_window_proposals(
        &self,
        conversation: &ConversationId,
    ) -> Result<Vec<ExecutionAcceptanceReceipt>> {
        let c = self.context()?;
        let owner = c.owner.clone();
        let window = {
            let mut tx = self.pool.begin().await.map_err(db)?;
            c.authenticate(&mut tx).await?;
            let Some(w) = c.window_scope(&mut tx).await? else {
                return Ok(Vec::new());
            };
            let review: Option<i64> = sqlx::query_scalar(
                "SELECT review_before_accepting FROM conversation_settings WHERE conversation_id=? AND owner_id=?",
            )
            .bind(conversation.to_string())
            .bind(owner.to_string())
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?;
            tx.commit().await.map_err(db)?;
            if w.get::<String, _>("conversation_id") != conversation.to_string()
                || review == Some(1)
            {
                return Ok(Vec::new());
            }
            w.get::<String, _>("id")
        };
        let pending = sqlx::query("SELECT r.id,o.event_id FROM production_runs r JOIN production_observations o ON o.run_id=r.id JOIN events e ON e.id=o.event_id WHERE r.owner_id=? AND r.conversation_id=? AND r.state='awaiting_acceptance' AND o.kind='completed_proposal' AND o.receipt_state='awaiting_acceptance' AND e.kind='provider_observed' AND e.schema_version=5 AND e.owner_id=r.owner_id AND e.conversation_id=r.conversation_id AND r.message_id IN (SELECT i.message_id FROM execution_window_inputs i WHERE i.window_id=? AND i.owner_id=r.owner_id AND i.conversation_id=r.conversation_id) ORDER BY CASE r.role WHEN 'worker' THEN 0 WHEN 'fast' THEN 1 ELSE 2 END,r.scope_sequence,r.id LIMIT ?")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(&window).bind(MAX_PER_PASS)
            .fetch_all(&self.pool).await.map_err(db)?;
        let mut receipts = Vec::new();
        for row in pending {
            let run = RunId(row.get::<String, _>("id").parse().map_err(db)?);
            let completion = EventId(row.get::<String, _>("event_id").parse().map_err(db)?);
            let revision: i64 = sqlx::query_scalar(
                "SELECT revision FROM execution_revisions WHERE conversation_id=?",
            )
            .bind(conversation.to_string())
            .fetch_one(&self.pool)
            .await
            .map_err(db)?;
            let request = ExecutionAcceptanceRequest {
                request_key: auto_accept_request_key(&run),
                run_id: run,
                completion_event_id: completion,
                expected_revision: revision,
            };
            match self
                .accept_as(&owner, conversation, &request, Principal::AutoAccept)
                .await
            {
                Ok(receipt) => receipts.push(receipt),
                // A Worker still running (Busy), a sibling moving the revision
                // (Conflict) or a fenced run: try again on a later pass.
                Err(
                    RuntimeStoreError::Busy
                    | RuntimeStoreError::Conflict
                    | RuntimeStoreError::Fenced
                    | RuntimeStoreError::StaleLease,
                ) => {}
                Err(error) => return Err(error),
            }
        }
        Ok(receipts)
    }
}
