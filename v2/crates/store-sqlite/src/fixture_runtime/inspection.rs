//! Scoped diagnostics contain no native identities, capability keys or digests.
use super::*;
use orkestr_v2_contracts::{ConversationId, RunId};

#[derive(Debug, PartialEq, Eq)]
pub enum FixtureDispatchState {
    Candidate,
    Reserved,
    DeliveryUnknown,
    Quarantined,
}

#[derive(Debug, PartialEq, Eq)]
pub struct FixtureAttemptInspection {
    pub run_id: RunId,
    pub blocked: bool,
    pub dispatch: FixtureDispatchState,
    pub inbox_acknowledged: bool,
    pub candidate_verifier_present: bool,
    pub reservation_verifier_present: bool,
}

impl FixtureSupervisorStore {
    /// One snapshot, scoped to the authenticated live context. This grants no
    /// dispatch permission and never reveals reusable verifier/locator material.
    pub async fn inspect_fixture_attempt(
        &self,
        conversation: &ConversationId,
        request_key: &str,
    ) -> Result<Option<FixtureAttemptInspection>> {
        if !valid(request_key) {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self.store.pool.begin().await.map_err(db)?;
        self.validate_in(&mut tx).await?;
        crate::runtime::scope(&mut tx, &self.owner, conversation).await?;
        let row = sqlx::query("SELECT r.*,EXISTS(SELECT 1 FROM reasoning_inbox i WHERE i.admitted_fixture_run_id=r.id AND i.state='consumed') AS acknowledged FROM fixture_runs r WHERE r.owner_id=? AND r.conversation_id=? AND r.request_key=? AND r.context_id=?")
            .bind(self.owner.to_string()).bind(conversation.to_string()).bind(request_key)
            .bind(self.context_id.to_string())
            .fetch_optional(&mut *tx).await.map_err(db)?;
        let result = row
            .map(|r| -> Result<_> {
                Ok(FixtureAttemptInspection {
                    run_id: RunId(Uuid::parse_str(&r.get::<String, _>("id")).map_err(db)?),
                    blocked: r.get::<String, _>("state") == "blocked",
                    dispatch: match r.get::<String, _>("dispatch_state").as_str() {
                        "candidate" => FixtureDispatchState::Candidate,
                        "reserved" => FixtureDispatchState::Reserved,
                        "delivery_unknown" => FixtureDispatchState::DeliveryUnknown,
                        "quarantined" => FixtureDispatchState::Quarantined,
                        _ => return Err(RuntimeStoreError::Unavailable),
                    },
                    inbox_acknowledged: r.get::<i64, _>("acknowledged") == 1,
                    candidate_verifier_present: r
                        .get::<Option<String>, _>("candidate_hash")
                        .is_some(),
                    reservation_verifier_present: r
                        .get::<Option<String>, _>("reservation_hash")
                        .is_some(),
                })
            })
            .transpose()?;
        tx.commit().await.map_err(db)?;
        Ok(result)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct FixtureScopeInspection {
    pub attempts: i64,
    pub acknowledged: i64,
    pub reservations: i64,
    pub delivery_unknown: i64,
    pub quarantined: i64,
}
impl FixtureSupervisorStore {
    /// Includes predecessor attempts in this same immutable context, allowing a
    /// valid successor to inspect quarantine without inheriting dispatch rights.
    pub async fn inspect_fixture_scope(
        &self,
        conversation: &ConversationId,
    ) -> Result<FixtureScopeInspection> {
        let mut tx = self.store.pool.begin().await.map_err(db)?;
        self.validate_in(&mut tx).await?;
        crate::runtime::scope(&mut tx, &self.owner, conversation).await?;
        let row = sqlx::query("SELECT count(*) AS attempts,coalesce(sum(EXISTS(SELECT 1 FROM reasoning_inbox i WHERE i.admitted_fixture_run_id=r.id AND i.state='consumed')),0) AS acknowledged,coalesce(sum(dispatch_state='reserved'),0) AS reservations,coalesce(sum(dispatch_state='delivery_unknown'),0) AS delivery_unknown,coalesce(sum(dispatch_state='quarantined'),0) AS quarantined FROM fixture_runs r WHERE owner_id=? AND conversation_id=? AND context_id=?")
            .bind(self.owner.to_string()).bind(conversation.to_string()).bind(self.context_id.to_string())
            .fetch_one(&mut *tx).await.map_err(db)?;
        let result = FixtureScopeInspection {
            attempts: row.get("attempts"),
            acknowledged: row.get("acknowledged"),
            reservations: row.get("reservations"),
            delivery_unknown: row.get("delivery_unknown"),
            quarantined: row.get("quarantined"),
        };
        tx.commit().await.map_err(db)?;
        Ok(result)
    }
}
