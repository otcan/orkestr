use super::*;
/// Retained private original execution identity, no start/dispatch constructor.
pub struct CodexSteeringAuthority {
    pub(super) provider: ProviderAdmission,
    pub(super) context: String,
    pub(super) incarnation: String,
}
impl CodexSteeringAuthority {
    /// Exact retained execution identity for same-pump pairing checks only.
    /// This reference grants no dispatch, renewal or native-write authority.
    pub fn provider(&self) -> &ProviderAdmission {
        &self.provider
    }
}
pub struct SteeringReservation {
    pub(super) id: Uuid,
    pub(super) authority: CodexSteeringAuthority,
    pub(super) grant: String,
    pub(super) turn: String,
    pub(super) text: String,
}
pub struct ConsumedSteering {
    pub(super) reservation: SteeringReservation,
    pub(super) nonce: String,
    pub(super) offset: usize,
    pub(super) poisoned: bool,
}
pub enum SteeringConsumption {
    Deliver(Box<ConsumedSteering>),
    ReconciliationRequired,
}
impl ConsumedSteering {
    pub fn request_id(&self) -> Uuid {
        self.reservation.id
    }
    pub fn provider(&self) -> &ProviderAdmission {
        &self.reservation.authority.provider
    }
    pub fn thread_id(&self) -> &str {
        self.provider()
            .run
            .native_session_id
            .as_deref()
            .expect("issued native binding")
    }
    pub fn expected_turn_id(&self) -> &str {
        &self.reservation.turn
    }
    pub fn text(&self) -> &str {
        &self.reservation.text
    }
    pub fn written_bytes(&self) -> usize {
        self.offset
    }
}
fn disposition(s: &str) -> Result<SteeringDisposition> {
    Ok(match s {
        "reserved" => SteeringDisposition::Reserved,
        "queued_unsupported" => SteeringDisposition::QueuedUnsupported,
        "queued_ordered" => SteeringDisposition::QueuedOrdered,
        _ => return Err(RuntimeStoreError::Unavailable),
    })
}
pub(super) fn receipt(row: &sqlx::sqlite::SqliteRow) -> Result<ExecutionSteeringReceipt> {
    Ok(ExecutionSteeringReceipt {
        conversation_id: ConversationId(
            row.get::<String, _>("conversation_id")
                .parse()
                .map_err(db)?,
        ),
        run_id: orkestr_v2_contracts::RunId(row.get::<String, _>("run_id").parse().map_err(db)?),
        request_key: row.get("request_key"),
        message_id: MessageId(row.get::<String, _>("message_id").parse().map_err(db)?),
        event_id: EventId(row.get::<String, _>("event_id").parse().map_err(db)?),
        scope_sequence: row.get("scope_sequence"),
        disposition: disposition(row.get("disposition"))?,
    })
}
