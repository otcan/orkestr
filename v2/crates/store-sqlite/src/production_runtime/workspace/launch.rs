use super::*;
use crate::runtime::ledger::{hash, secret};
impl Store {
    pub async fn reserve_workspace_launch(
        &self,
        credential: &str,
        grant: &WorkspaceGrant,
        metadata: &BoundSessionMetadata,
        key: &str,
    ) -> Result<WorkspaceLaunchReservationResult> {
        self.worker_credential(credential)?;
        if !valid(key) {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        self.workspace_grant_in(&mut tx, grant).await?;
        self.validate_metadata(&mut tx, metadata).await?;
        if metadata.binding.conversation_id != grant.conversation {
            return Err(RuntimeStoreError::Fenced);
        }
        let existing=sqlx::query("SELECT * FROM workspace_launches WHERE context_id=? AND incarnation_id=? AND (request_key=? OR (session_id=? AND binding_generation=?))")
            .bind(&grant.context.id).bind(&grant.context.incarnation).bind(key).bind(metadata.binding.session_id.to_string()).bind(i64::try_from(metadata.binding.generation).map_err(db)?).fetch_optional(&mut *tx).await.map_err(db)?;
        if let Some(row) = existing {
            if row.get::<String, _>("metadata_key") != metadata.workspace_identity()
                || row.get::<String, _>("request_key") != key
                || row.get::<String, _>("project_id") != grant.project
                || row.get::<i64, _>("generation") != grant.generation
                || row.get::<String, _>("session_id") != metadata.binding.session_id.to_string()
                || row.get::<i64, _>("binding_generation")
                    != i64::try_from(metadata.binding.generation).map_err(db)?
            {
                return Err(RuntimeStoreError::Conflict);
            }
            tx.commit().await.map_err(db)?;
            return Ok(WorkspaceLaunchReservationResult::ReconciliationRequired);
        }
        let id = Uuid::new_v4().to_string();
        let nonce = secret();
        sqlx::query("INSERT INTO workspace_launches(id,project_id,generation,session_id,binding_generation,context_id,incarnation_id,request_key,metadata_key,nonce_hash,state) VALUES(?,?,?,?,?,?,?,?,?,?,'reserved')")
            .bind(&id)
            .bind(&grant.project)
            .bind(grant.generation)
            .bind(metadata.binding.session_id.to_string())
            .bind(i64::try_from(metadata.binding.generation).map_err(db)?)
            .bind(&grant.context.id)
            .bind(&grant.context.incarnation)
            .bind(key)
            .bind(metadata.workspace_identity())
            .bind(hash("workspace-launch", &[&nonce]))
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(WorkspaceLaunchReservationResult::Reserved(
            WorkspaceLaunchReservation {
                grant: Box::new(grant.retained()),
                binding: Box::new(metadata.binding.clone()),
                id,
                nonce,
                metadata_key: metadata.workspace_identity(),
            },
        ))
    }
    /// Commits unknown before any child can be created. Lost reply never reissues.
    pub async fn consume_workspace_launch(
        &self,
        credential: &str,
        reservation: WorkspaceLaunchReservation,
    ) -> Result<WorkspaceLaunchConsumption> {
        self.worker_credential(credential)?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        self.workspace_grant_in(&mut tx, &reservation.grant).await?;
        self.validate_workspace_binding(&mut tx, &reservation.binding)
            .await?;
        let binding = sqlx::query("SELECT * FROM session_bindings WHERE id=? AND owner_id=?")
            .bind(reservation.binding.session_id.to_string())
            .bind(reservation.grant.context.owner.to_string())
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?
            .ok_or(RuntimeStoreError::Fenced)?;
        if crate::runtime::binding(&binding)? != *reservation.binding {
            return Err(RuntimeStoreError::Fenced);
        }
        let changed=sqlx::query("UPDATE workspace_launches SET state='delivery_unknown',nonce_hash=NULL WHERE id=? AND state='reserved' AND nonce_hash=?")
            .bind(&reservation.id).bind(hash("workspace-launch", &[&reservation.nonce])).execute(&mut *tx).await.map_err(db)?.rows_affected();
        tx.commit().await.map_err(db)?;
        if changed != 1 {
            return Ok(WorkspaceLaunchConsumption::ReconciliationRequired);
        }
        Ok(WorkspaceLaunchConsumption::Launch(WorkspaceLaunch {
            reservation,
            attempted: false,
        }))
    }
    /// Only the actual bounded synchronous spawn belongs here. No protocol wait
    /// or nested metadata writer. Borrowed descriptors cannot escape the callback.
    pub fn with_workspace_metadata_fence<T, E>(
        &self,
        credential: &str,
        launch: &mut WorkspaceLaunch,
        metadata: &BoundSessionMetadata,
        action: impl FnOnce(WorkspaceDescriptors<'_>) -> std::result::Result<T, E>,
    ) -> Result<std::result::Result<T, E>> {
        if launch.attempted {
            return Err(RuntimeStoreError::Fenced);
        }
        // Poison on every attempt, including uncertain transaction acquisition.
        launch.attempted = true;
        let operation = async {
            self.worker_credential(credential)?;
            let r = &launch.reservation;
            let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
            self.workspace_grant_in(&mut tx, &r.grant).await?;
            self.validate_metadata(&mut tx, metadata).await?;
            if metadata.binding != *r.binding || metadata.workspace_identity() != r.metadata_key {
                return Err(RuntimeStoreError::Fenced);
            }
            let unknown:i64=sqlx::query_scalar("SELECT count(*) FROM workspace_launches WHERE id=? AND state='delivery_unknown' AND project_id=? AND generation=? AND context_id=? AND incarnation_id=?")
                .bind(&r.id).bind(&r.grant.project).bind(r.grant.generation).bind(&r.grant.context.id).bind(&r.grant.context.incarnation).fetch_one(&mut *tx).await.map_err(db)?;
            if unknown != 1 {
                return Err(RuntimeStoreError::Fenced);
            }
            r.grant.installation.check()?;
            let result = action(r.grant.installation.descriptors());
            sqlx::query("UPDATE workspace_launches SET callback_attempted=1 WHERE id=? AND state='delivery_unknown'").bind(&r.id).execute(&mut *tx).await.map_err(db)?;
            // Even a COMMIT error after spawn permanently spends the local token.
            tx.commit().await.map_err(db)?;
            Ok(result)
        };
        match tokio::runtime::Handle::try_current() {
            Ok(handle) if handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread => {
                tokio::task::block_in_place(|| handle.block_on(operation))
            }
            Ok(_) => Err(RuntimeStoreError::Unavailable),
            Err(_) => tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(db)?
                .block_on(operation),
        }
    }
}
