use super::*;

pub(super) async fn current(
    store: &Store,
    conn: &mut SqliteConnection,
    credential: &str,
    reservation: &WorkspaceExecResultReservation,
) -> Result<SqliteRow> {
    let launch = &reservation.launch;
    launch.profile.validate(store, conn).await?;
    execution(store, conn, credential, &launch.parent).await?;
    let tool = load(
        store,
        conn,
        launch.id,
        &launch.parent,
        &launch.context_id,
        &launch.incarnation,
        &launch.profile,
    )
    .await?;
    if launch.parent.run.role != Role::Worker
        || tool.get::<&str, _>("source_digest") != launch.source_digest
        || tool.get::<i64, _>("expires_at_ms") != launch.expires_at_ms
        || tool.get::<&str, _>("state")
            != if reservation.success {
                "completed"
            } else {
                "failed"
            }
        || tool.get::<Option<&str>, _>("outcome_digest") != Some(reservation.output_digest.as_str())
    {
        return Err(RuntimeStoreError::Conflict);
    }
    if launch.expires_at_ms <= now(conn).await? {
        return Err(RuntimeStoreError::Expired);
    }
    let row = sqlx::query(
        "SELECT * FROM workspace_exec_results WHERE delegation_id=? AND parent_run_id=?",
    )
    .bind(launch.id.to_string())
    .bind(launch.parent.run.run_id.to_string())
    .fetch_optional(conn)
    .await
    .map_err(db)?
    .ok_or(RuntimeStoreError::Fenced)?;
    if WorkspaceExecNativeCall::from_row(&row)? != reservation.call
        || row.get::<Option<&str>, _>("output_digest") != Some(reservation.output_digest.as_str())
        || row.get::<Option<&str>, _>("response_text") != Some(reservation.text.as_str())
        || row.get::<Option<bool>, _>("success") != Some(reservation.success)
        || row.get::<Option<String>, _>("response_digest")
            != Some(output::response_digest(
                &reservation.text,
                reservation.success,
            ))
    {
        return Err(RuntimeStoreError::Conflict);
    }
    Ok(row)
}

impl Store {
    /// Commits uncertainty before any native preparation/write. Even a lost
    /// return, reopened DB or duplicated private reservation cannot issue twice.
    pub async fn consume_workspace_exec_result(
        &self,
        credential: &str,
        reservation: WorkspaceExecResultReservation,
    ) -> Result<WorkspaceExecResultConsumption> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let row = current(self, &mut tx, credential, &reservation).await?;
        if matches!(
            row.get::<&str, _>("state"),
            "delivery_unknown" | "delivered"
        ) {
            tx.commit().await.map_err(db)?;
            return Ok(WorkspaceExecResultConsumption::ReconciliationRequired);
        }
        if row.get::<&str, _>("state") != "prepared"
            || row.get::<Option<String>, _>("grant_hash")
                != Some(hash(
                    "workspace-exec-result-grant-v1",
                    &[&reservation.locator],
                ))
        {
            return Err(RuntimeStoreError::Conflict);
        }
        let nonce = secret();
        sqlx::query("UPDATE workspace_exec_results SET state='delivery_unknown',grant_hash=NULL,delivery_hash=? WHERE delegation_id=? AND state='prepared'")
            .bind(hash("workspace-exec-result-delivery-v1", &[&nonce]))
            .bind(reservation.launch.id.to_string()).execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(WorkspaceExecResultConsumption::Deliver(
            CompletedWorkspaceExecDelivery {
                reservation: Box::new(reservation),
                nonce,
                offset: 0,
                poisoned: false,
            },
        ))
    }
}
