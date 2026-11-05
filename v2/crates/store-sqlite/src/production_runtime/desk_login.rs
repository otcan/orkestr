//! Fixed Root operation admission from an already consumed canonical Deep turn.
//! No browser endpoint, credentials, helper paths, arbitrary argv or environment.
use super::*;
use serde_json::{json, Value};

/// Native correlation copied only from Runtime's sealed pending tool call.
/// These public values alone confer no authority; issuance also requires the
/// private consumed dispatch and its exact currently live Core fence.
#[derive(Clone)]
pub struct DeskLoginNativeCall {
    pub request_id: Value,
    pub call_id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub operation_id: String,
}
/// Retained only from a consumed Deep dispatch before Runtime takes it.
pub struct DeskLoginParent {
    parent: Box<ProviderAdmission>,
    namespace: String,
    incarnation: String,
    setup_generation: u64,
}
/// Source locator from an original Core metadata grant, not authorization.
/// Native confirmation and later turns advance the current binding generation;
/// this immutable locator still names the original Root-owned broker setup.
#[derive(Clone)]
pub struct DeskLoginSetup {
    binding: Binding,
    namespace: String,
    incarnation: String,
}
impl DeskLoginSetup {
    pub fn from_metadata(grant: &BoundSessionMetadata) -> Result<Self> {
        if grant.binding().role != Role::Deep || grant.provider() != ProviderKind::Codex {
            return Err(RuntimeStoreError::Fenced);
        }
        Ok(Self {
            binding: grant.binding().clone(),
            namespace: grant.namespace().into(),
            incarnation: grant.incarnation_id().into(),
        })
    }
}
/// DeliveryUnknown committed before this non-Clone, nonserializable value leaves
/// Core. A lost Root acknowledgment cannot mint another operation.
pub struct ConsumedDeskLogin {
    id: Uuid,
    parent: Box<ProviderAdmission>,
    context: String,
    incarnation: String,
    operation: String,
    correlation: String,
    expires: i64,
    call: Box<DeskLoginNativeCall>,
    launch_attempted: std::sync::atomic::AtomicBool,
    setup_generation: u64,
}
pub enum DeskLoginConsumption {
    Operation(ConsumedDeskLogin),
    ReconciliationRequired,
}
impl ConsumedDeskLogin {
    pub fn id(&self) -> Uuid {
        self.id
    }
    /// Only the authority's exact local Root-manager channel may transmit this
    /// bounded request. This is a locator, not a bearer or native-visible token.
    pub fn root_request(&self) -> Value {
        let p = &self.parent;
        json!({"operation_id":self.id.to_string(),"resource_id":self.operation,
            "run_id":p.run.run_id.to_string(),"session_id":p.run.session_id.to_string(),
            "binding_generation":p.binding.generation,"lease_generation":p.run.lease_generation,
            "setup_generation":self.setup_generation,
            "dispatch_fence":p.run.dispatch_fence,"incarnation":self.incarnation,
            "correlation_sha256":self.correlation,"expires_at_ms":self.expires})
    }
}
fn valid(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._:-".contains(&c))
}
async fn live(
    store: &Store,
    conn: &mut SqliteConnection,
    credential: &str,
    parent: &ProviderAdmission,
) -> Result<()> {
    let context = store.context()?;
    if credential.len() != 64
        || crate::digest(credential) != context.token_hash
        || parent.run.role != Role::Deep
        || parent.run.purpose != AdmissionPurpose::Execution
    {
        return Err(RuntimeStoreError::Unauthorized);
    }
    let row = store.production_authorized_run(conn, parent).await?;
    if !matches!(row.get::<&str, _>("state"), "starting" | "running")
        || row.get::<&str, _>("dispatch_state") != "delivery_unknown"
    {
        return Err(RuntimeStoreError::Fenced);
    }
    if parallel_deep::present(&mut *conn).await? {
        let canonical: i64 = sqlx::query_scalar(&format!(
            "SELECT count(*) FROM production_runs WHERE id=? AND {}",
            parallel_deep::canonical_run("production_runs")
        ))
        .bind(parent.run.run_id.to_string())
        .fetch_one(&mut *conn)
        .await
        .map_err(db)?;
        if canonical != 1 {
            return Err(RuntimeStoreError::Fenced);
        }
    }
    Ok(())
}
impl Store {
    pub async fn authorize_desk_login_parent(
        &self,
        credential: &str,
        consumed: &ConsumedProviderDispatch,
        source: &DeskLoginSetup,
    ) -> Result<DeskLoginParent> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        live(self, &mut tx, credential, consumed.provider()).await?;
        let binding = &consumed.provider().binding;
        if source.binding.owner_id != binding.owner_id
            || source.binding.conversation_id != binding.conversation_id
            || source.binding.session_id != binding.session_id
            || source.binding.generation > binding.generation
            || source.namespace != consumed.namespace()
            || source.incarnation != consumed.incarnation_id()
            || source
                .binding
                .native_session_id
                .as_ref()
                .is_some_and(|native| Some(native) != binding.native_session_id.as_ref())
        {
            return Err(RuntimeStoreError::Fenced);
        }
        Ok(DeskLoginParent {
            parent: Box::new(consumed.provider().clone()),
            namespace: consumed.namespace().into(),
            incarnation: consumed.incarnation_id().into(),
            setup_generation: source.binding.generation,
        })
    }
    /// Atomically consumes a native call exactly once. No issued/reusable stage
    /// exists between the live fence and durable delivery_unknown insertion.
    pub async fn consume_native_desk_login(
        &self,
        credential: &str,
        parent: &DeskLoginParent,
        call: &DeskLoginNativeCall,
        lifetime_ms: u32,
    ) -> Result<DeskLoginConsumption> {
        let request_valid = match &call.request_id {
            Value::String(s) => !s.is_empty() && s.len() <= 128 && !s.chars().any(char::is_control),
            Value::Number(n) => n.as_u64().is_some_and(|n| n < 1 << 53),
            _ => false,
        };
        if !request_valid
            || !valid(&call.call_id)
            || !valid(&call.operation_id)
            || call.turn_id.is_empty()
            || call.turn_id.len() > 512
            || call.turn_id.chars().any(char::is_control)
            || !(1..=30000).contains(&lifetime_ms)
            || parent.parent.binding.native_session_id.as_deref() != Some(&call.thread_id)
        {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        live(self, &mut tx, credential, &parent.parent).await?;
        let context = self.context()?;
        if parent.namespace != context.namespace || parent.incarnation != context.incarnation {
            return Err(RuntimeStoreError::Fenced);
        }
        let p = &parent.parent;
        let correlation = crate::digest(
            &serde_json::to_string(&json!([
                call.request_id,
                call.call_id,
                call.thread_id,
                call.turn_id,
                call.operation_id
            ]))
            .map_err(db)?,
        );
        let existing:Option<String>=sqlx::query_scalar("SELECT correlation_sha256 FROM deep_desk_operations WHERE owner_id=? AND run_id=? AND native_call_id=?")
            .bind(context.owner.to_string()).bind(p.run.run_id.to_string()).bind(&call.call_id).fetch_optional(&mut *tx).await.map_err(db)?;
        if let Some(existing) = existing {
            if existing != correlation {
                return Err(RuntimeStoreError::Conflict);
            }
            return Ok(DeskLoginConsumption::ReconciliationRequired);
        }
        let now: i64 = sqlx::query_scalar("SELECT CAST(unixepoch('subsec')*1000 AS INTEGER)")
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM deep_desk_operations WHERE run_id=?")
                .bind(p.run.run_id.to_string())
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
        if count >= 8 {
            return Err(RuntimeStoreError::Fenced);
        }
        let expires = now
            .saturating_add(i64::from(lifetime_ms))
            .min(p.run.lease_deadline_ms);
        if expires <= now {
            return Err(RuntimeStoreError::Expired);
        }
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO deep_desk_operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'delivery_unknown',?)")
            .bind(id.to_string()).bind(context.owner.to_string()).bind(p.run.conversation_id.to_string())
            .bind(&context.id).bind(&context.incarnation).bind(p.run.run_id.to_string()).bind(p.run.session_id.to_string())
            .bind(i64::try_from(p.binding.generation).map_err(db)?).bind(i64::try_from(parent.setup_generation).map_err(db)?).bind(i64::try_from(p.run.lease_generation).map_err(db)?)
            .bind(i64::try_from(p.run.dispatch_fence).map_err(db)?).bind(&call.thread_id).bind(&call.turn_id).bind(&call.call_id)
            .bind(&correlation).bind(&call.operation_id).bind(expires).bind(now).execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(DeskLoginConsumption::Operation(ConsumedDeskLogin {
            id,
            parent: p.clone(),
            context: context.id.clone(),
            incarnation: context.incarnation.clone(),
            operation: call.operation_id.clone(),
            correlation,
            expires,
            call: Box::new(call.clone()),
            launch_attempted: std::sync::atomic::AtomicBool::new(false),
            setup_generation: parent.setup_generation,
        }))
    }
    /// Fresh monitor for expiry, Stop, lease/binding changes and revocation.
    /// Failure cancels Root work; it never proves physical cleanup or completion.
    pub async fn desk_login_live(
        &self,
        credential: &str,
        operation: &ConsumedDeskLogin,
    ) -> Result<()> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        live(self, &mut tx, credential, &operation.parent).await?;
        let context = self.context()?;
        let present:i64=sqlx::query_scalar("SELECT count(*) FROM deep_desk_operations WHERE id=? AND context_id=? AND incarnation_id=? AND correlation_sha256=? AND expires_at_ms=? AND expires_at_ms>CAST(unixepoch('subsec')*1000 AS INTEGER) AND state='delivery_unknown'")
            .bind(operation.id.to_string()).bind(&operation.context).bind(&operation.incarnation).bind(&operation.correlation).bind(operation.expires)
            .fetch_one(&mut *tx).await.map_err(db)?;
        if context.id != operation.context
            || context.incarnation != operation.incarnation
            || present != 1
        {
            return Err(RuntimeStoreError::Fenced);
        }
        Ok(())
    }
}

mod launch_fence;
mod result;
#[cfg(test)]
mod tests;
pub use result::{CompletedDeskLogin, DeskLoginOutcome};
