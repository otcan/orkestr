//! Canonical immutable run envelope shared by fixture and production ledgers.
use super::*;
use orkestr_v2_contracts::SessionId;
use sqlx::sqlite::SqliteRow;
fn uuid(row: &SqliteRow, field: &str) -> Result<Uuid> {
    Uuid::parse_str(&row.get::<String, _>(field)).map_err(db)
}
pub(crate) fn envelope(row: &SqliteRow, provider_kind: ProviderKind) -> Result<ProviderAdmission> {
    let owner_id = OwnerId(uuid(row, "owner_id")?);
    let conversation_id = ConversationId(uuid(row, "conversation_id")?);
    let session_id = SessionId(uuid(row, "session_id")?);
    let native: String = row.get("native_session_id");
    Ok(ProviderAdmission {
        run: RunAdmission {
            owner_id: owner_id.clone(),
            conversation_id: conversation_id.clone(),
            run_id: RunId(uuid(row, "id")?),
            session_id: session_id.clone(),
            role: Role::Deep,
            native_session_id: Some(native.clone()),
            lease_generation: u64::try_from(row.get::<i64, _>("lease_generation")).map_err(db)?,
            dispatch_fence: u64::try_from(row.get::<i64, _>("dispatch_fence")).map_err(db)?,
            attempt: 1,
            lease_deadline_ms: row.get("lease_deadline_ms"),
            purpose: AdmissionPurpose::Execution,
        },
        binding: Binding {
            owner_id,
            conversation_id,
            session_id,
            role: Role::Deep,
            provider_kind,
            native_session_id: Some(native),
            parent_session_id: None,
            generation: u64::try_from(row.get::<i64, _>("binding_generation")).map_err(db)?,
            state: SessionState::Ready,
        },
    })
}
pub(crate) fn run_state(row: &SqliteRow) -> RunState {
    match row.get::<&str, _>("state") {
        "starting" => RunState::Starting,
        "running" => RunState::Running,
        "awaiting_acceptance" => RunState::AwaitingAcceptance,
        "failed" => RunState::Failed,
        "cancel_requested" => RunState::CancelRequested,
        "cancelled" => RunState::Cancelled,
        "succeeded" => RunState::Succeeded,
        _ => RunState::Blocked,
    }
}
