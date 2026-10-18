use super::admission::envelope;
use super::*;
use crate::runtime::ledger::{self, hash, secret, Ledger};
use sqlx::sqlite::SqliteRow;
impl Store {
    pub(crate) async fn check_context_in(
        &self,
        conn: &mut SqliteConnection,
        owner: &OwnerId,
    ) -> Result<()> {
        if let Some(c) = &self.authority {
            if c.owner != *owner {
                return Err(RuntimeStoreError::Unauthorized);
            }
            c.validate(conn).await?;
        }
        Ok(())
    }
    pub(super) async fn production_authorized_run(
        &self,
        conn: &mut SqliteConnection,
        p: &ProviderAdmission,
    ) -> Result<SqliteRow> {
        let c = self.context()?;
        c.validate(conn).await?;
        if p.run.owner_id != c.owner {
            return Err(RuntimeStoreError::Unauthorized);
        }
        let row =
            sqlx::query("SELECT * FROM production_runs WHERE id=? AND owner_id=? AND context_id=?")
                .bind(p.run.run_id.to_string())
                .bind(c.owner.to_string())
                .bind(&c.id)
                .fetch_optional(&mut *conn)
                .await
                .map_err(db)?
                .ok_or(RuntimeStoreError::NotFound)?;
        if row.get::<String, _>("incarnation_id") != c.incarnation {
            return Err(RuntimeStoreError::Fenced);
        }
        let canonical = envelope(&row)?;
        if canonical.run.dispatch_fence != p.run.dispatch_fence {
            return Err(RuntimeStoreError::Fenced);
        }
        if canonical.run.lease_generation != p.run.lease_generation {
            return Err(RuntimeStoreError::StaleLease);
        }
        if canonical != *p {
            return Err(RuntimeStoreError::Conflict);
        }
        if row.get::<&str, _>("state") != "starting" {
            return Err(RuntimeStoreError::Fenced);
        }
        if p.run.lease_deadline_ms <= now(conn).await? {
            return Err(RuntimeStoreError::Expired);
        }
        let ready:i64=sqlx::query_scalar("SELECT count(*) FROM session_bindings b JOIN production_readiness r ON r.session_id=b.id WHERE b.id=? AND b.owner_id=? AND b.conversation_id=? AND b.role='deep' AND b.state='busy' AND b.generation=? AND b.provider_kind=? AND b.provider_namespace=? AND b.native_session_id=? AND r.context_id=? AND r.incarnation_id=?")
            .bind(p.run.session_id.to_string()).bind(c.owner.to_string()).bind(p.run.conversation_id.to_string()).bind(i64::try_from(p.binding.generation).map_err(db)?)
            .bind(provider_name(c.provider)?).bind(&c.namespace).bind(&p.run.native_session_id).bind(&c.id).bind(&c.incarnation).fetch_one(conn).await.map_err(db)?;
        if ready != 1 {
            return Err(RuntimeStoreError::Fenced);
        }
        Ok(row)
    }
    pub(crate) async fn production_reserve(
        &self,
        candidate: &RunAdmissionResult,
        key: &str,
    ) -> Result<DispatchClaimResult> {
        if !valid(key) {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let row = self
            .production_authorized_run(&mut tx, &candidate.provider)
            .await?;
        if candidate.run_state != RunState::Starting {
            return Err(RuntimeStoreError::Conflict);
        }
        match row.get::<&str, _>("dispatch_state") {
            "delivery_unknown" | "quarantined" => {
                return Ok(DispatchClaimResult::ReconciliationRequired)
            }
            _ => {}
        }
        if candidate.disposition != AdmissionDisposition::FreshCandidate {
            return Ok(DispatchClaimResult::Replay);
        }
        let token = candidate
            .candidate_key
            .as_deref()
            .filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or(RuntimeStoreError::InvalidInput)?;
        if row.get::<Option<String>, _>("candidate_hash")
            != Some(hash("production-candidate-v1", &[token]))
        {
            return Err(RuntimeStoreError::Conflict);
        }
        if row.get::<&str, _>("dispatch_state") == "reserved" {
            if row.get::<Option<String>, _>("reserve_key").as_deref() != Some(key) {
                return Err(RuntimeStoreError::Conflict);
            }
            return Ok(DispatchClaimResult::Replay);
        }
        let reservation = secret();
        ledger::reserve(
            &mut tx,
            Ledger::Production,
            &candidate.provider.run.run_id.to_string(),
            &hash("production-reservation-v1", &[&reservation]),
            key,
        )
        .await?;
        #[cfg(all(test, unix))]
        super::process_tests::checkpoint("reserve-before-commit");
        #[cfg(feature = "fixture-test-controls")]
        self.production_checkpoint("reserve-before-commit").await?;
        tx.commit().await.map_err(db)?;
        #[cfg(all(test, unix))]
        super::process_tests::checkpoint("reserve-after-commit");
        #[cfg(feature = "fixture-test-controls")]
        self.production_checkpoint("reserve-after-commit").await?;
        Ok(DispatchClaimResult::Reserved(Box::new(DispatchClaim {
            provider: candidate.provider.clone(),
            reservation_key: reservation,
        })))
    }
    pub(crate) async fn production_consume(
        &self,
        claim: &DispatchClaim,
    ) -> Result<DispatchConsumption> {
        Ok(match self.consume_execution(claim).await? {
            ExecutionConsumption::Dispatch(_) => DispatchConsumption::DispatchNow,
            ExecutionConsumption::ReconciliationRequired => {
                DispatchConsumption::ReconciliationRequired
            }
        })
    }
    /// Trusted runtime/Executor bridge. Caller text cannot replace durable message
    /// input. Lost reply leaves DeliveryUnknown and no replacement capability.
    pub async fn consume_execution(&self, claim: &DispatchClaim) -> Result<ExecutionConsumption> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let row = self
            .production_authorized_run(&mut tx, &claim.provider)
            .await?;
        match row.get::<&str, _>("dispatch_state") {
            "delivery_unknown" | "quarantined" => {
                return Ok(ExecutionConsumption::ReconciliationRequired)
            }
            "reserved" => {}
            _ => return Err(RuntimeStoreError::Conflict),
        }
        if claim.reservation_key.len() != 64
            || !claim.reservation_key.bytes().all(|b| b.is_ascii_hexdigit())
            || row.get::<Option<String>, _>("reservation_hash")
                != Some(hash("production-reservation-v1", &[&claim.reservation_key]))
        {
            return Err(RuntimeStoreError::Conflict);
        }
        let context = self.context()?;
        let message_id: String = row.get("message_id");
        let text: String = sqlx::query_scalar(
            "SELECT text FROM messages WHERE id=? AND owner_id=? AND conversation_id=?",
        )
        .bind(&message_id)
        .bind(context.owner.to_string())
        .bind(claim.provider.run.conversation_id.to_string())
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        let capability = ConsumedProviderDispatch {
            provider: claim.provider.clone(),
            message_id: orkestr_v2_contracts::MessageId(Uuid::parse_str(&message_id).map_err(db)?),
            text,
            namespace: context.namespace.clone(),
            incarnation: context.incarnation.clone(),
        };
        let won = ledger::consume(
            &mut tx,
            Ledger::Production,
            &claim.provider.run.run_id.to_string(),
        )
        .await?;
        #[cfg(all(test, unix))]
        super::process_tests::checkpoint("consume-before-commit");
        #[cfg(feature = "fixture-test-controls")]
        self.production_checkpoint("consume-before-commit").await?;
        tx.commit().await.map_err(db)?;
        #[cfg(all(test, unix))]
        super::process_tests::checkpoint("consume-after-commit");
        #[cfg(feature = "fixture-test-controls")]
        self.production_checkpoint("consume-after-commit").await?;
        Ok(if won {
            ExecutionConsumption::Dispatch(Box::new(capability))
        } else {
            ExecutionConsumption::ReconciliationRequired
        })
    }
}
