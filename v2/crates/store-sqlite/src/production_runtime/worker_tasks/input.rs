use super::*;

impl Store {
    pub(super) async fn task_payload_in(
        &self,
        conn: &mut SqliteConnection,
        row: &SqliteRow,
    ) -> Result<(String, String)> {
        let payload = sqlx::query("SELECT CASE WHEN length(CAST(title AS BLOB))<=160 THEN title END AS title,CASE WHEN length(CAST(instructions AS BLOB))<=16384 THEN instructions END AS instructions FROM worker_task_payloads WHERE task_id=?")
            .bind(row.get::<&str,_>("id")).fetch_optional(&mut *conn).await.map_err(db)?
            .ok_or(RuntimeStoreError::NotFound)?;
        let title = payload
            .get::<Option<String>, _>("title")
            .ok_or(RuntimeStoreError::InvalidInput)?;
        let instructions = payload
            .get::<Option<String>, _>("instructions")
            .ok_or(RuntimeStoreError::InvalidInput)?;
        let request = WorkerTaskCreateRequest {
            parent_run_id: RunId(row.get::<String, _>("parent_run_id").parse().map_err(db)?),
            expected_control_revision: row.get("parent_control_revision"),
            request_key: row.get("request_key"),
            title,
            instructions,
            execution_budget_ms: row
                .get::<Option<i64>, _>("execution_budget_ms")
                .map(u32::try_from)
                .transpose()
                .map_err(db)?,
            lifetime_ms: u32::try_from(row.get::<i64, _>("lifetime_ms")).map_err(db)?,
        };
        if !request.is_valid() || request_digest(&request) != row.get::<&str, _>("request_digest") {
            return Err(RuntimeStoreError::Fenced);
        }
        Ok((request.title, request.instructions))
    }

    /// Called inside ordinary dispatch consumption before its durable fence.
    /// Task-tagged delegations never fall back to the parent's message text.
    pub(in crate::production_runtime) async fn worker_task_input_in(
        &self,
        conn: &mut SqliteConnection,
        run: &SqliteRow,
    ) -> Result<Option<String>> {
        let Some(delegation) = run.get::<Option<String>, _>("worker_delegation_id") else {
            return Ok(None);
        };
        let delegated = sqlx::query(
            "SELECT * FROM worker_provider_delegations WHERE id=? AND admitted_run_id=?",
        )
        .bind(&delegation)
        .bind(run.get::<&str, _>("id"))
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?
        .ok_or(RuntimeStoreError::Fenced)?;
        let task = sqlx::query("SELECT * FROM worker_tasks WHERE delegation_id=?")
            .bind(&delegation)
            .fetch_optional(&mut *conn)
            .await
            .map_err(db)?;
        let Some(task) = task else {
            return if delegated.get::<&str, _>("request_key").starts_with("task:") {
                Err(RuntimeStoreError::Fenced)
            } else {
                Ok(None)
            };
        };
        let id = TaskId(task.get::<String, _>("id").parse().map_err(db)?);
        if task.get::<&str, _>("state") != "delegated"
            || delegated.get::<&str, _>("request_key")
                != delegation_key(&id, task.get("request_digest"))
            || task.get::<&str, _>("parent_run_id") != delegated.get::<&str, _>("parent_run_id")
        {
            return Err(RuntimeStoreError::Fenced);
        }
        for field in [
            "owner_id",
            "conversation_id",
            "context_id",
            "incarnation_id",
        ] {
            if task.get::<&str, _>(field) != run.get::<&str, _>(field) {
                return Err(RuntimeStoreError::Fenced);
            }
        }
        if task.get::<&str, _>("source_message_id") != run.get::<&str, _>("message_id")
            || task.get::<&str, _>("source_event_id") != run.get::<&str, _>("event_id")
        {
            return Err(RuntimeStoreError::Fenced);
        }
        self.task_parent_in(conn, &task).await?;
        let (_, instructions) = self.task_payload_in(conn, &task).await?;
        Ok(Some(instructions))
    }
}
