//! Owner decision boundary, deliberately absent from RuntimeStore provider ports.
use super::*;
use orkestr_v2_contracts::{
    ConversationId, EventId, ExecutionAcceptanceOutcome, ExecutionAcceptanceReceipt,
    ExecutionAcceptanceRequest,
};

/// Who decides. The owner through their own boundary (a browser credential,
/// or trusted composition that already authenticated them), or the server's
/// system principal acting for the owner under the conversation's auto-accept
/// setting and the live window's private credential.
#[derive(Clone, Copy)]
pub(super) enum Principal<'a> {
    Owner(Option<&'a str>),
    AutoAccept,
}

impl Store {
    /// HTTP-facing owner decision. Credential validity is checked again under
    /// the same immediate transaction as both fresh acceptance and receipt replay.
    /// The caller must additionally enforce its browser CSRF/Origin policy.
    pub async fn accept_execution_authenticated(
        &self,
        credential: &str,
        conversation: &ConversationId,
        input: &ExecutionAcceptanceRequest,
    ) -> Result<ExecutionAcceptanceReceipt> {
        if credential.is_empty() || credential.len() > 1024 {
            return Err(RuntimeStoreError::Unauthorized);
        }
        let owner = self
            .authenticate(credential)
            .await
            .map_err(|_| RuntimeStoreError::Unavailable)?
            .ok_or(RuntimeStoreError::Unauthorized)?;
        #[cfg(feature = "fixture-test-controls")]
        self.production_checkpoint("acceptance-after-authentication")
            .await?;
        self.accept_execution_guarded(&owner, conversation, input, Some(credential))
            .await
    }

    /// Trusted HTTP composition supplies authenticated owner and enforces browser
    /// CSRF/Origin. A supervisor-bound provider handle cannot accept its output.
    pub async fn accept_execution(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
        input: &ExecutionAcceptanceRequest,
    ) -> Result<ExecutionAcceptanceReceipt> {
        self.accept_execution_guarded(owner, conversation, input, None)
            .await
    }

    pub(super) async fn accept_execution_guarded(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
        input: &ExecutionAcceptanceRequest,
        credential: Option<&str>,
    ) -> Result<ExecutionAcceptanceReceipt> {
        self.accept_as(owner, conversation, input, Principal::Owner(credential))
            .await
    }

    pub(super) async fn accept_as(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
        input: &ExecutionAcceptanceRequest,
        principal: Principal<'_>,
    ) -> Result<ExecutionAcceptanceReceipt> {
        // Only the owner's own boundary (unbound Store) or the server's
        // window-bound system principal may decide; never a provider port.
        if matches!(principal, Principal::Owner(_)) == self.authority.is_some() {
            return Err(RuntimeStoreError::Unauthorized);
        }
        if !input.is_valid() || conversation.0.is_nil() {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        if let Principal::Owner(Some(credential)) = principal {
            let authorized: i64 = sqlx::query_scalar("SELECT count(*) FROM auth_sessions WHERE token_hash=? AND owner_id=? AND expires_at>unixepoch()")
                .bind(crate::digest(credential)).bind(owner.to_string())
                .fetch_one(&mut *tx).await.map_err(db)?;
            if authorized != 1 {
                return Err(RuntimeStoreError::Unauthorized);
            }
        }
        crate::runtime::scope(&mut tx, owner, conversation).await?;
        let auto = match principal {
            Principal::Owner(_) => None,
            Principal::AutoAccept => Some(
                super::auto_acceptance::authorize(
                    self,
                    &mut tx,
                    owner,
                    conversation,
                    &input.run_id,
                )
                .await?,
            ),
        };
        if let Some(row)=sqlx::query("SELECT * FROM production_acceptances WHERE owner_id=? AND conversation_id=? AND request_key=?")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(&input.request_key).fetch_optional(&mut *tx).await.map_err(db)? {
            if row.get::<String,_>("run_id")!=input.run_id.to_string()
                || row.get::<String,_>("completion_event_id")!=input.completion_event_id.to_string()
                || row.get::<i64,_>("requested_revision")!=input.expected_revision { return Err(RuntimeStoreError::Conflict); }
            let receipt=receipt(conversation,input,EventId(row.get::<String,_>("event_id").parse().map_err(db)?),row.get("receipt_revision"));
            tx.commit().await.map_err(db)?;
            return Ok(receipt);
        }
        let row=sqlx::query("SELECT r.* FROM production_runs r JOIN production_observations o ON o.run_id=r.id JOIN events e ON e.id=o.event_id WHERE r.id=? AND r.owner_id=? AND r.conversation_id=? AND o.event_id=? AND o.kind='completed_proposal' AND o.receipt_state='awaiting_acceptance' AND e.kind='provider_observed' AND e.schema_version=5 AND e.owner_id=r.owner_id AND e.conversation_id=r.conversation_id")
            .bind(input.run_id.to_string()).bind(owner.to_string()).bind(conversation.to_string()).bind(input.completion_event_id.to_string())
            .fetch_optional(&mut *tx).await.map_err(db)?.ok_or(RuntimeStoreError::Fenced)?;
        let descendants:i64=sqlx::query_scalar("SELECT count(*) FROM production_runs r JOIN worker_provider_delegations d ON d.id=r.worker_delegation_id WHERE d.parent_run_id=? AND r.state NOT IN ('cancelled','succeeded')")
            .bind(input.run_id.to_string()).fetch_one(&mut *tx).await.map_err(db)?;
        if descendants != 0 {
            return Err(RuntimeStoreError::Busy);
        }
        if row.get::<&str, _>("state") != "awaiting_acceptance" {
            return Err(RuntimeStoreError::Fenced);
        }
        let revision: i64 =
            sqlx::query_scalar("SELECT revision FROM execution_revisions WHERE conversation_id=?")
                .bind(conversation.to_string())
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
        if revision != input.expected_revision {
            return Err(RuntimeStoreError::Conflict);
        }
        // This exact occupied generation must still exist. No release after
        // takeover/loss, replacement or another run's occupation is permitted.
        let changed=sqlx::query("UPDATE session_bindings SET state='ready',generation=generation+1 WHERE id=? AND owner_id=? AND conversation_id=? AND generation=? AND native_session_id=? AND provider_kind=? AND state='busy' AND EXISTS(SELECT 1 FROM production_readiness rd JOIN production_supervisors supervisor ON supervisor.context_id=rd.context_id WHERE rd.session_id=session_bindings.id AND rd.context_id=? AND rd.incarnation_id=? AND supervisor.incarnation_id=rd.incarnation_id AND session_bindings.provider_namespace=supervisor.namespace) AND NOT EXISTS(SELECT 1 FROM production_runs other WHERE other.session_id=session_bindings.id AND other.id!=? AND other.state NOT IN ('cancelled','succeeded'))")
            .bind(row.get::<String,_>("session_id")).bind(owner.to_string()).bind(conversation.to_string())
            .bind(row.get::<i64,_>("binding_generation")).bind(row.get::<String,_>("native_session_id"))
            .bind(row.get::<String,_>("provider_kind")).bind(row.get::<String,_>("context_id")).bind(row.get::<String,_>("incarnation_id")).bind(input.run_id.to_string()).execute(&mut *tx).await.map_err(db)?.rows_affected();
        if changed != 1 {
            return Err(RuntimeStoreError::Fenced);
        }
        sqlx::query("UPDATE production_runs SET state='succeeded' WHERE id=? AND state='awaiting_acceptance'")
            .bind(input.run_id.to_string()).execute(&mut *tx).await.map_err(db)?;
        let sequence:i64=sqlx::query_scalar("UPDATE conversations SET sequence=sequence+1 WHERE id=? AND owner_id=? RETURNING sequence")
            .bind(conversation.to_string()).bind(owner.to_string()).fetch_one(&mut *tx).await.map_err(db)?;
        let event = EventId(Uuid::new_v4());
        sqlx::query("INSERT INTO events(id,owner_id,conversation_id,message_id,sequence,kind,schema_version) VALUES(?,?,?,NULL,?,'execution_accepted',9)")
            .bind(event.to_string()).bind(owner.to_string()).bind(conversation.to_string()).bind(sequence).execute(&mut *tx).await.map_err(db)?;
        sqlx::query("INSERT INTO outbox(event_id) VALUES(?)")
            .bind(event.to_string())
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        let revision: i64 =
            sqlx::query_scalar("SELECT revision FROM execution_revisions WHERE conversation_id=?")
                .bind(conversation.to_string())
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
        sqlx::query("INSERT INTO production_acceptances(run_id,owner_id,conversation_id,completion_event_id,event_id,request_key,requested_revision,receipt_revision) VALUES(?,?,?,?,?,?,?,?)")
            .bind(input.run_id.to_string()).bind(owner.to_string()).bind(conversation.to_string()).bind(input.completion_event_id.to_string())
            .bind(event.to_string()).bind(&input.request_key).bind(input.expected_revision).bind(revision).execute(&mut *tx).await.map_err(db)?;
        if let Some(auto) = &auto {
            auto.record(&mut tx, &input.run_id).await?;
        }
        #[cfg(all(test, unix))]
        super::process_tests::checkpoint("acceptance-before-commit");
        #[cfg(feature = "fixture-test-controls")]
        self.production_checkpoint("acceptance-before-commit")
            .await?;
        tx.commit().await.map_err(db)?;
        #[cfg(all(test, unix))]
        super::process_tests::checkpoint("acceptance-after-commit");
        #[cfg(feature = "fixture-test-controls")]
        self.production_checkpoint("acceptance-after-commit")
            .await?;
        Ok(receipt(conversation, input, event, revision))
    }
}
fn receipt(
    conversation: &ConversationId,
    input: &ExecutionAcceptanceRequest,
    event: EventId,
    revision: i64,
) -> ExecutionAcceptanceReceipt {
    ExecutionAcceptanceReceipt {
        schema_version: 1,
        conversation_id: conversation.clone(),
        run_id: input.run_id.clone(),
        completion_event_id: input.completion_event_id.clone(),
        acceptance_event_id: event,
        request_key: input.request_key.clone(),
        requested_revision: input.expected_revision,
        revision,
        outcome: ExecutionAcceptanceOutcome::Succeeded,
    }
}
