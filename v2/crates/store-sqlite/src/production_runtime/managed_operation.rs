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
    pub run_id: String,
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
    hard_deadline: i64,
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
            "dispatch_fence":self.parent.run.dispatch_fence,"expires_at_ms":self.expires,"hard_deadline_ms":self.hard_deadline,"evidence":self.evidence,
            "source_message_id":self.source_message_id,"source_event_id":self.source_event_id})
    }
}
impl ManagedOperationParent {
    /// Metadata sent only through the authenticated authority->Root port.
    /// The opaque parent's live writer fence must surround that bounded write.
    pub fn root_run_request(&self) -> Value {
        let s = &self.setup;
        let b = &s.binding;
        json!({"run_id":self.parent.run.run_id.to_string(),"source_message_id":self.source_message_id,
            "source_event_id":self.source_event_id,"setup":{"owner_id":b.owner_id.to_string(),
            "conversation_id":b.conversation_id.to_string(),"session_id":b.session_id.to_string(),
            "generation":b.generation,"role":"deep","provider":match s.provider {ProviderKind::Codex=>"codex",ProviderKind::Claude=>"claude",_=>"unsupported"},
            "incarnation":s.incarnation,"native_session_id":b.native_session_id,"resume_setup_id":s.resume_setup_id}})
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
    pub async fn refresh_managed_operation_parent(
        &self,
        credential: &str,
        parent: &mut ManagedOperationParent,
        renewal: &RunRenewalAuthority,
    ) -> Result<()> {
        let current = renewal.current_provider();
        let previous = &parent.parent;
        if current.run.run_id != previous.run.run_id
            || current.binding != previous.binding
            || current.run.dispatch_fence != previous.run.dispatch_fence
            || current.run.lease_generation != previous.run.lease_generation + 1
        {
            return Err(RuntimeStoreError::Fenced);
        }
        let mut tx = self.pool.begin().await.map_err(db)?;
        super::desk_login::live(self, &mut tx, credential, current).await?;
        *parent.parent = current.clone();
        Ok(())
    }
    pub fn with_managed_run_fence<E>(
        &self,
        credential: &str,
        parent: &ManagedOperationParent,
        action: impl FnOnce() -> std::result::Result<usize, E>,
    ) -> Result<std::result::Result<usize, E>> {
        if crate::digest(credential) != self.context()?.token_hash {
            return Err(RuntimeStoreError::Unauthorized);
        }
        self.with_execution_fence(&parent.parent, action)
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
            || source.run_id != parent.parent.run.run_id.to_string()
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
        let window_deadline: i64 =
            sqlx::query_scalar("SELECT work_deadline_ms FROM execution_windows WHERE id=?")
                .bind(source.window_id.to_string())
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
        let hard_deadline = (now + 300000).min(window_deadline);
        let expires = (now + 30000)
            .min(parent.parent.run.lease_deadline_ms)
            .min(hard_deadline);
        if expires <= now {
            return Err(RuntimeStoreError::Expired);
        }
        let c = self.context()?;
        let p = &parent.parent;
        sqlx::query("INSERT INTO managed_operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'delivery_unknown',?)")
            .bind(id.to_string()).bind(c.owner.to_string()).bind(p.run.conversation_id.to_string()).bind(source.window_id.to_string())
            .bind(p.run.run_id.to_string()).bind(p.run.session_id.to_string()).bind(&c.id).bind(&c.incarnation)
            .bind(i64::try_from(p.binding.generation).map_err(db)?).bind(i64::try_from(p.run.lease_generation).map_err(db)?)
            .bind(i64::try_from(p.run.dispatch_fence).map_err(db)?).bind(sha).bind(&request.operation)
            .bind(serde_json::to_string(&json!({"evidence":evidence,"hard_deadline_ms":hard_deadline})).map_err(db)?).bind(expires)
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
                hard_deadline,
                attempted: std::sync::atomic::AtomicBool::new(false),
                source_message_id: parent.source_message_id.clone(),
                source_event_id: parent.source_event_id.clone(),
            },
        ))
    }
}
mod launch_fence;
mod renewal;
mod result;
pub use renewal::ManagedOperationRenewal;
pub use result::CompletedManagedOperation;
#[cfg(test)]
mod tests;
