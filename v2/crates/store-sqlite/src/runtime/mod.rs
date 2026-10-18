//! Durable binding/claim foundation. Remaining operations fail closed.
use super::Store;
use orkestr_v2_application::runtime::*;
use orkestr_v2_contracts::{ConversationId, OwnerId, RunId, SessionId};
use sqlx::{sqlite::SqliteRow, Row, SqliteConnection};
use std::time::Duration;
use uuid::Uuid;
mod bindings;
mod claims;

fn db(_: impl std::fmt::Display) -> RuntimeStoreError {
    RuntimeStoreError::Unavailable
}
fn id(value: String) -> Result<Uuid> {
    Uuid::parse_str(&value).map_err(db)
}
fn key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
}
async fn scope(
    conn: &mut SqliteConnection,
    owner: &OwnerId,
    conversation: &ConversationId,
) -> Result<()> {
    let found: i64 =
        sqlx::query_scalar("SELECT count(*) FROM conversations WHERE id=? AND owner_id=?")
            .bind(conversation.to_string())
            .bind(owner.to_string())
            .fetch_one(conn)
            .await
            .map_err(db)?;
    if found == 1 {
        Ok(())
    } else {
        Err(RuntimeStoreError::NotFound)
    }
}
fn binding(row: &SqliteRow) -> Result<Binding> {
    Ok(Binding {
        owner_id: OwnerId(id(row.get("owner_id"))?),
        conversation_id: ConversationId(id(row.get("conversation_id"))?),
        session_id: SessionId(id(row.get("id"))?),
        role: match row.get::<&str, _>("role") {
            "fast" => Role::Fast,
            "deep" => Role::Deep,
            "worker" => Role::Worker,
            _ => return Err(RuntimeStoreError::Unavailable),
        },
        provider_kind: match row.get::<&str, _>("provider_kind") {
            "unconfigured" => ProviderKind::Unconfigured,
            "codex" => ProviderKind::Codex,
            "claude" => ProviderKind::Claude,
            "explicit_fixture" => ProviderKind::ExplicitFixture,
            _ => return Err(RuntimeStoreError::Unavailable),
        },
        native_session_id: row.get("native_session_id"),
        parent_session_id: row
            .get::<Option<String>, _>("parent_session_id")
            .map(id)
            .transpose()?
            .map(SessionId),
        generation: u64::try_from(row.get::<i64, _>("generation")).map_err(db)?,
        state: match row.get::<&str, _>("state") {
            "starting" => SessionState::Starting,
            "ready" => SessionState::Ready,
            "busy" => SessionState::Busy,
            "blocked" => SessionState::Blocked,
            "lost" => SessionState::Lost,
            "retired" => SessionState::Retired,
            _ => return Err(RuntimeStoreError::Unavailable),
        },
    })
}
impl RuntimeStore for Store {
    async fn ensure_role_bindings(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> Result<RoleBindings> {
        bindings::ensure(self, owner, conversation).await
    }
    async fn create_worker_binding(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
        parent: Option<&SessionId>,
        request_key: &str,
    ) -> Result<Binding> {
        bindings::worker(self, owner, conversation, parent, request_key).await
    }
    async fn claim_next(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
        consumer: &SessionId,
        lease_duration: Duration,
    ) -> Result<Option<InboxClaim>> {
        claims::next(self, owner, conversation, consumer, lease_duration).await
    }
    async fn admit_run(
        &self,
        _: &InboxClaim,
        _: &SessionId,
        _: u64,
        _: &str,
    ) -> Result<RunAdmission> {
        Err(RuntimeStoreError::Unavailable)
    }
    async fn bind_native_session(
        &self,
        _: &RunAdmission,
        _: &str,
        _: &str,
    ) -> Result<RunAdmission> {
        Err(RuntimeStoreError::Unavailable)
    }
    async fn renew_lease(&self, _: &RunAdmission, _: u64) -> Result<RunAdmission> {
        Err(RuntimeStoreError::Unavailable)
    }
    async fn append_provider_event(
        &self,
        _: &OwnerId,
        _: &ProviderAdmission,
        _: &ProviderEventInput,
    ) -> Result<ProviderEventReceipt> {
        Err(RuntimeStoreError::Unavailable)
    }
    async fn request_cancel(&self, _: &OwnerId, _: &RunId, _: &str) -> Result<CancelReceipt> {
        Err(RuntimeStoreError::Unavailable)
    }
    async fn acknowledge_inbox(&self, _: &InboxClaim, _: &RunAdmission) -> Result<()> {
        Err(RuntimeStoreError::Unavailable)
    }
    async fn recover_runtime(
        &self,
        _: &OwnerId,
        _: &str,
        _: i64,
        _: Option<&str>,
        _: u32,
    ) -> Result<RecoveryPage> {
        Err(RuntimeStoreError::Unavailable)
    }
}

#[cfg(test)]
mod tests;
