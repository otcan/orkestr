//! Root-observed caller -> current Core Deep run -> one durable fixed operation.
//! Evidence is accepted only by the trusted Root transport, never HTTP JSON.
use super::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone)]
pub struct ManagedOperationSetup {
    binding: Binding,
    provider: ProviderKind,
    namespace: String,
    incarnation: String,
    resume_setup_id: Option<String>,
}
impl ManagedOperationSetup {
    pub fn from_metadata(grant: &BoundSessionMetadata) -> Result<Self> {
        if grant.binding().role != Role::Deep
            || !matches!(grant.provider(), ProviderKind::Codex | ProviderKind::Claude)
        {
            return Err(RuntimeStoreError::Fenced);
        }
        Ok(Self {
            binding: grant.binding().clone(),
            provider: grant.provider(),
            namespace: grant.namespace().into(),
            incarnation: grant.incarnation_id().into(),
            resume_setup_id: grant.resume_setup_id().map(Into::into),
        })
    }
}
pub struct ManagedOperationParent {
    parent: Box<ProviderAdmission>,
    setup: ManagedOperationSetup,
    source_message_id: String,
    source_event_id: String,
}
/// Non-authorizing Root receipt locators. The authority adapter must validate
/// the original pinned manager peer before decoding this shape.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManagedCallerEvidence {
    pub owner_id: String,
    pub conversation_id: String,
    pub session_id: String,
    pub generation: u64,
    pub incarnation: String,
    pub provider: String,
    pub native_session_id: Option<String>,
    pub resume_setup_id: Option<String>,
    pub window_id: Uuid,
    pub window_generation: u64,
    pub broker_pid: u32,
    pub broker_start: u64,
    pub caller_pid: u32,
    pub caller_start: u64,
    pub caller_uid: u32,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManagedOperationRequest {
    pub version: u32,
    pub request_key: String,
    pub operation: String,
    pub arguments: Value,
}
impl ManagedOperationRequest {
    fn bounded(&self) -> bool {
        if self.version != 1 || !valid(&self.request_key) {
            return false;
        }
        let Some(args) = self.arguments.as_object() else {
            return false;
        };
        match self.operation.as_str() {
            "desk_login" => {
                args.len() == 1
                    && args
                        .get("operation_id")
                        .and_then(Value::as_str)
                        .is_some_and(valid)
            }
            "root_request_submit" => {
                args.len() == 3
                    && [("action", 256), ("resource", 512), ("summary", 4096)]
                        .iter()
                        .all(|(field, cap)| {
                            args.get(*field).and_then(Value::as_str).is_some_and(|s| {
                                !s.is_empty() && s.len() <= *cap && !s.contains('\0')
                            })
                        })
            }
            _ => false,
        }
    }
}
/// No Clone/Deserialize/constructor. DeliveryUnknown is committed first.
pub struct ConsumedManagedOperation {
    id: Uuid,
    parent: Box<ProviderAdmission>,
    evidence: Value,
    context: String,
    incarnation: String,
    expires: i64,
    attempted: std::sync::atomic::AtomicBool,
    source_message_id: String,
    source_event_id: String,
}
pub enum ManagedOperationConsumption {
    Operation(ConsumedManagedOperation),
    ReconciliationRequired,
}
/// Only from an authenticated, exact Root receipt. A submission is not approval.
pub enum ManagedOperationOutcome {
    HelperCompleted,
    Submitted,
    Failed,
    Cancelled,
}
impl ConsumedManagedOperation {
    pub fn id(&self) -> Uuid {
        self.id
    }
    pub fn root_request(&self) -> Value {
        json!({"operation_id":self.id,"run_id":self.parent.run.run_id.to_string(),
            "binding_generation":self.parent.binding.generation,"lease_generation":self.parent.run.lease_generation,
            "dispatch_fence":self.parent.run.dispatch_fence,"expires_at_ms":self.expires,"evidence":self.evidence,
            "source_message_id":self.source_message_id,"source_event_id":self.source_event_id})
    }
}
async fn current(
    store: &Store,
    tx: &mut SqliteConnection,
    credential: &str,
    parent: &ProviderAdmission,
    source: &ManagedCallerEvidence,
) -> Result<()> {
    super::desk_login::live(store, tx, credential, parent).await?;
    let c = store.context()?;
    // Exact Core window, context, incarnation and credential. A global V1
    // owner credential or a stale Root journal cannot substitute for this.
    let found:i64=sqlx::query_scalar("SELECT count(*) FROM execution_windows WHERE id=? AND generation=? AND owner_id=? AND conversation_id=? AND context_id=? AND incarnation_id=? AND credential_hash=? AND state='active' AND work_deadline_ms>CAST(unixepoch('subsec')*1000 AS INTEGER)")
        .bind(source.window_id.to_string()).bind(i64::try_from(source.window_generation).map_err(db)?)
        .bind(c.owner.to_string()).bind(parent.run.conversation_id.to_string()).bind(&c.id).bind(&c.incarnation)
        .bind(crate::digest(credential)).fetch_one(&mut *tx).await.map_err(db)?;
    if found != 1 {
        return Err(RuntimeStoreError::Fenced);
    }
    Ok(())
}
impl Store {
    pub async fn complete_managed_operation(
        &self,
        credential: &str,
        operation: ConsumedManagedOperation,
        outcome: ManagedOperationOutcome,
    ) -> Result<()> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        launch_fence::checked(self, &mut tx, credential, &operation).await?;
        let state = match outcome {
            ManagedOperationOutcome::HelperCompleted => "helper_completed",
            ManagedOperationOutcome::Submitted => "submitted",
            ManagedOperationOutcome::Failed => "failed",
            ManagedOperationOutcome::Cancelled => "cancelled",
        };
        if (state == "submitted"
            && operation.evidence["request"]["operation"] != "root_request_submit")
            || (state == "helper_completed"
                && operation.evidence["request"]["operation"] != "desk_login")
        {
            return Err(RuntimeStoreError::Fenced);
        }
        let changed = sqlx::query(
            "UPDATE managed_operations SET state=? WHERE id=? AND state='delivery_unknown'",
        )
        .bind(state)
        .bind(operation.id.to_string())
        .execute(&mut *tx)
        .await
        .map_err(db)?
        .rows_affected();
        if changed != 1 {
            return Err(RuntimeStoreError::Fenced);
        }
        tx.commit().await.map_err(db)?;
        Ok(())
    }
    pub async fn authorize_managed_operation_parent(
        &self,
        credential: &str,
        consumed: &ConsumedProviderDispatch,
        setup: &ManagedOperationSetup,
    ) -> Result<ManagedOperationParent> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        super::desk_login::live(self, &mut tx, credential, consumed.provider()).await?;
        let b = &consumed.provider().binding;
        if setup.binding.owner_id != b.owner_id
            || setup.binding.conversation_id != b.conversation_id
            || setup.binding.session_id != b.session_id
            || setup.provider != b.provider_kind
            || setup.binding.generation > b.generation
            || setup.namespace != consumed.namespace()
            || setup.incarnation != consumed.incarnation_id()
            || setup
                .binding
                .native_session_id
                .as_ref()
                .is_some_and(|id| Some(id) != b.native_session_id.as_ref())
        {
            return Err(RuntimeStoreError::Fenced);
        }
        Ok(ManagedOperationParent {
            parent: Box::new(consumed.provider().clone()),
            setup: setup.clone(),
            source_message_id: consumed.message_id().to_string(),
            source_event_id: consumed.source_event_id().to_string(),
        })
    }
    /// Trusted Root-observer adapter only. IDs/body are evidence; the nonforgeable
    /// parent, exact Core window and transaction provide all authorization.
    pub async fn consume_managed_operation(
        &self,
        credential: &str,
        parent: &ManagedOperationParent,
        id: Uuid,
        source: &ManagedCallerEvidence,
        request: &ManagedOperationRequest,
    ) -> Result<ManagedOperationConsumption> {
        let s = &parent.setup;
        let b = &s.binding;
        if id.is_nil()
            || !request.bounded()
            || source.owner_id != b.owner_id.to_string()
            || source.conversation_id != b.conversation_id.to_string()
            || source.session_id != b.session_id.to_string()
            || source.generation != b.generation
            || source.incarnation != s.incarnation
            || source.provider != provider_name(s.provider)?
            || source.native_session_id != b.native_session_id
            || source.resume_setup_id != s.resume_setup_id
            || source.window_id.is_nil()
            || source.window_generation == 0
            || source.broker_pid <= 1
            || source.caller_pid <= 1
            || source.broker_start == 0
            || source.caller_start == 0
            || source.caller_uid == 0
        {
            return Err(RuntimeStoreError::Fenced);
        }
        let evidence = json!({"source":source,"request":request});
        let encoded = serde_json::to_string(&evidence).map_err(db)?;
        if encoded.len() > 16384 {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let sha = crate::digest(&encoded);
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        current(self, &mut tx, credential, &parent.parent, source).await?;
        let existing: Option<String> =
            sqlx::query_scalar("SELECT evidence_sha256 FROM managed_operations WHERE id=?")
                .bind(id.to_string())
                .fetch_optional(&mut *tx)
                .await
                .map_err(db)?;
        if let Some(existing) = existing {
            if existing != sha {
                return Err(RuntimeStoreError::Conflict);
            }
            return Ok(ManagedOperationConsumption::ReconciliationRequired);
        }
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM managed_operations WHERE window_id=?")
                .bind(source.window_id.to_string())
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
        if count >= 32 {
            return Err(RuntimeStoreError::Fenced);
        }
        let now = now(&mut tx).await?;
        let expires = (now + 30000).min(parent.parent.run.lease_deadline_ms);
        if expires <= now {
            return Err(RuntimeStoreError::Expired);
        }
        let c = self.context()?;
        let p = &parent.parent;
        sqlx::query("INSERT INTO managed_operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'delivery_unknown',?)")
            .bind(id.to_string()).bind(c.owner.to_string()).bind(p.run.conversation_id.to_string()).bind(source.window_id.to_string())
            .bind(p.run.run_id.to_string()).bind(p.run.session_id.to_string()).bind(&c.id).bind(&c.incarnation)
            .bind(i64::try_from(p.binding.generation).map_err(db)?).bind(i64::try_from(p.run.lease_generation).map_err(db)?)
            .bind(i64::try_from(p.run.dispatch_fence).map_err(db)?).bind(sha).bind(&request.operation).bind(encoded).bind(expires)
            .bind(now).execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(ManagedOperationConsumption::Operation(
            ConsumedManagedOperation {
                id,
                parent: p.clone(),
                evidence,
                context: c.id.clone(),
                incarnation: c.incarnation.clone(),
                expires,
                attempted: std::sync::atomic::AtomicBool::new(false),
                source_message_id: parent.source_message_id.clone(),
                source_event_id: parent.source_event_id.clone(),
            },
        ))
    }
}
mod launch_fence;
#[cfg(test)]
mod tests;
