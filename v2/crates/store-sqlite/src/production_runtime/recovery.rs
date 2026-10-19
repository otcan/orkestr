//! Recovery reports predecessor authority already fenced by atomic takeover.
//! It never restarts a provider, reissues a locator or infers a stop/acceptance.
use super::*;
use crate::runtime::ledger::hash;
impl Store {
    pub(crate) async fn production_recover(
        &self,
        owner: &OwnerId,
        instance: &str,
        now_ms: i64,
        after: Option<&str>,
        limit: u32,
    ) -> Result<RecoveryPage> {
        let context = self.context()?;
        if owner != &context.owner || instance != context.incarnation {
            return Err(RuntimeStoreError::Unauthorized);
        }
        if now_ms < 0 || !(1..=100).contains(&limit) {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let cursor = match after {
            None => String::new(),
            Some(value) => {
                let (id, digest) = value
                    .split_once(':')
                    .ok_or(RuntimeStoreError::InvalidInput)?;
                Uuid::parse_str(id).map_err(|_| RuntimeStoreError::InvalidInput)?;
                if digest != recovery_digest(context, id) {
                    return Err(RuntimeStoreError::Unauthorized);
                }
                id.to_owned()
            }
        };
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        context.validate(&mut tx).await?;
        // Caller time is never used to expire/revive authority. Store-clock
        // predecessor CAS already fenced these rows and erased locators atomically.
        // Live current-incarnation work is excluded, even for this supervisor.
        let rows = sqlx::query("SELECT * FROM production_runs WHERE context_id=? AND owner_id=? AND incarnation_id!=? AND state IN ('blocked','cancel_requested') AND id>? ORDER BY id LIMIT ?")
            .bind(&context.id).bind(owner.to_string()).bind(&context.incarnation).bind(cursor).bind(i64::from(limit)+1)
            .fetch_all(&mut *tx).await.map_err(db)?;
        let more = rows.len() > limit as usize;
        let mut records = Vec::new();
        let mut last = None;
        for row in rows.iter().take(limit as usize) {
            let mut provider = super::admission::envelope(row)?;
            let cancellation = row.get::<&str, _>("state") == "cancel_requested";
            if cancellation {
                provider.run.purpose = AdmissionPurpose::CancellationAcknowledgement;
            }
            let binding = sqlx::query(
                "SELECT * FROM session_bindings WHERE id=? AND owner_id=? AND conversation_id=?",
            )
            .bind(provider.run.session_id.to_string())
            .bind(owner.to_string())
            .bind(provider.run.conversation_id.to_string())
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
            records.push(RecoveryRecord {
                binding: crate::runtime::binding(&binding)?,
                admission: Some(provider.run),
                state: Some(if cancellation {
                    RunState::CancelRequested
                } else {
                    RunState::Blocked
                }),
                inflight_status: if row.get::<&str, _>("dispatch_state") == "delivery_unknown" {
                    InflightStatus::Unknown
                } else {
                    InflightStatus::NotDispatched
                },
                requires_reconciliation: true,
            });
            last = Some(row.get::<String, _>("id"));
        }
        let next_cursor = if more {
            last.map(|id| format!("{id}:{}", recovery_digest(context, &id)))
        } else {
            None
        };
        tx.commit().await.map_err(db)?;
        Ok(RecoveryPage {
            records,
            next_cursor,
        })
    }
}
fn recovery_digest(context: &Context, id: &str) -> String {
    hash(
        "production-recovery-cursor-v1",
        &[
            &context.owner.to_string(),
            &context.id,
            &context.incarnation,
            id,
        ],
    )
}
