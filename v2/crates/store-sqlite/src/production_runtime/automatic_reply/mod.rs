//! No transport is registered here. Handles are trusted composition only.
use super::*;
use orkestr_v2_contracts::*;
mod authority;
mod delivery;
#[cfg(test)]
mod fence_tests;
mod inputs;
#[cfg(all(test, feature = "fixture-test-controls", unix))]
mod process_tests;
mod reserve;
#[cfg(test)]
mod tests;

pub struct AutomaticReplyProducer {
    context: Context,
    conversation: ConversationId,
    route: Uuid,
    generation: i64,
    account_scope: String,
}
impl AutomaticReplyProducer {
    pub fn route_id(&self) -> Uuid {
        self.route
    }
    pub fn route_generation(&self) -> i64 {
        self.generation
    }
    pub fn account_scope(&self) -> &str {
        &self.account_scope
    }
}
pub struct AutomaticReplyReservation {
    producer: Box<AutomaticReplyProducer>,
    receipt: AutomaticReplySendReceipt,
    bytes: Vec<u8>,
    nonce: String,
}
pub enum AutomaticReplyReservationResult {
    Reserved(AutomaticReplyReservation),
    Replay(AutomaticReplySendReceipt),
}
pub enum AutomaticReplyConsumption {
    Deliver(AutomaticReplyDelivery),
    ReconciliationRequired,
}
pub struct AutomaticReplyDelivery {
    reservation: Box<AutomaticReplyReservation>,
    nonce: String,
    offset: usize,
    poisoned: bool,
}
impl AutomaticReplyDelivery {
    pub fn receipt(&self) -> &AutomaticReplySendReceipt {
        &self.reservation.receipt
    }
    pub fn account_scope(&self) -> &str {
        &self.reservation.producer.account_scope
    }
    pub fn written_bytes(&self) -> usize {
        self.offset
    }
}
fn text(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}
fn sha(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}
fn copy_producer(p: &AutomaticReplyProducer) -> AutomaticReplyProducer {
    AutomaticReplyProducer {
        context: p.context.clone(),
        conversation: p.conversation.clone(),
        route: p.route,
        generation: p.generation,
        account_scope: p.account_scope.clone(),
    }
}
async fn owner_in(
    store: &Store,
    tx: &mut SqliteConnection,
    credential: &str,
    conversation: &ConversationId,
) -> Result<OwnerId> {
    if store.authority.is_some() || !text(credential, 1024) {
        return Err(RuntimeStoreError::Unauthorized);
    }
    let owner:Option<String> = sqlx::query_scalar("SELECT a.owner_id FROM auth_sessions a JOIN conversations c ON c.owner_id=a.owner_id WHERE a.token_hash=? AND a.expires_at>unixepoch() AND c.id=?")
        .bind(crate::digest(credential)).bind(conversation.to_string()).fetch_optional(tx).await.map_err(db)?;
    Ok(OwnerId(
        owner
            .ok_or(RuntimeStoreError::Unauthorized)?
            .parse()
            .map_err(db)?,
    ))
}
async fn producer_in(
    store: &Store,
    tx: &mut SqliteConnection,
    credential: &str,
    p: &AutomaticReplyProducer,
) -> Result<()> {
    store.worker_credential(credential)?;
    let c = store.context()?;
    if c.id != p.context.id
        || c.incarnation != p.context.incarnation
        || c.generation != p.context.generation
        || c.token_hash != p.context.token_hash
        || c.owner != p.context.owner
        || c.namespace != p.context.namespace
    {
        return Err(RuntimeStoreError::Fenced);
    }
    c.validate(tx).await?;
    let valid:i64=sqlx::query_scalar("SELECT count(*) FROM automatic_reply_routes WHERE id=? AND owner_id=? AND conversation_id=? AND context_id=? AND incarnation_id=? AND account_scope=? AND generation=?")
        .bind(p.route.to_string()).bind(c.owner.to_string()).bind(p.conversation.to_string()).bind(&c.id).bind(&c.incarnation).bind(&p.account_scope).bind(p.generation).fetch_one(tx).await.map_err(db)?;
    if valid != 1 {
        return Err(RuntimeStoreError::Fenced);
    }
    Ok(())
}
async fn input_in(
    tx: &mut SqliteConnection,
    p: &AutomaticReplyProducer,
    input: Uuid,
) -> Result<i64> {
    let revision:Option<i64>=sqlx::query_scalar("SELECT r.permission_revision FROM automatic_reply_routes r JOIN automatic_reply_inputs i ON i.route_id=r.id AND i.route_generation=r.generation AND i.owner_id=r.owner_id AND i.conversation_id=r.conversation_id WHERE r.id=? AND r.generation=? AND r.enabled=1 AND i.id=? AND i.dormant=0 AND i.held=0")
        .bind(p.route.to_string()).bind(p.generation).bind(input.to_string()).fetch_optional(tx).await.map_err(db)?;
    revision.ok_or(RuntimeStoreError::Fenced)
}
fn receipt(row: &sqlx::sqlite::SqliteRow) -> Result<AutomaticReplySendReceipt> {
    Ok(AutomaticReplySendReceipt {
        reservation_id: row.get::<String, _>("id").parse().map_err(db)?,
        input_id: row.get::<String, _>("input_id").parse().map_err(db)?,
        route_id: row.get::<String, _>("route_id").parse().map_err(db)?,
        route_generation: row.get("route_generation"),
        account_scope: row.get("account_scope"),
        permission_revision: row.get("permission_revision"),
        output_sha256: row.get("output_sha256"),
        byte_length: u32::try_from(row.get::<i64, _>("byte_length")).map_err(db)?,
        state: if row.get::<&str, _>("state") == "reserved" {
            AutomaticReplySendState::Reserved
        } else {
            AutomaticReplySendState::DeliveryUnknown
        },
        written_bytes: u32::try_from(row.get::<i64, _>("written_bytes")).map_err(db)?,
    })
}
