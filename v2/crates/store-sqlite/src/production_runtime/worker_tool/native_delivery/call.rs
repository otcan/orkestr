use super::*;

impl OfflinePythonNativeCall {
    pub(super) fn validate(&self) -> Result<()> {
        fn bounded(s: &str, max: usize) -> bool {
            !s.is_empty() && s.len() <= max && !s.chars().any(char::is_control)
        }
        if !self.request_id.is_valid()
            || !bounded(&self.call_id, 128)
            || !bounded(&self.thread_id, 512)
            || !bounded(&self.turn_id, 512)
        {
            return Err(RuntimeStoreError::InvalidInput);
        }
        Ok(())
    }
    pub(super) fn request(&self) -> (&'static str, String) {
        match &self.request_id {
            OfflinePythonNativeRequestId::Text(s) => ("text", s.clone()),
            OfflinePythonNativeRequestId::Integer(n) => ("integer", n.to_string()),
        }
    }
    pub(super) fn digest(&self) -> String {
        let (kind, id) = self.request();
        hash(
            "offline-python-native-call-v1",
            &[kind, &id, &self.call_id, &self.thread_id, &self.turn_id],
        )
    }
    pub(super) fn from_row(row: &SqliteRow) -> Result<Self> {
        let request_id = match row.get::<&str, _>("request_kind") {
            "text" => OfflinePythonNativeRequestId::Text(row.get("request_id")),
            "integer" => OfflinePythonNativeRequestId::Integer(
                row.get::<&str, _>("request_id").parse().map_err(db)?,
            ),
            _ => return Err(RuntimeStoreError::Unavailable),
        };
        let call = Self {
            request_id,
            call_id: row.get("call_id"),
            thread_id: row.get("native_thread"),
            turn_id: row.get("native_turn"),
        };
        call.validate()?;
        if call.digest() != row.get::<&str, _>("call_digest") {
            return Err(RuntimeStoreError::Conflict);
        }
        Ok(call)
    }
}

impl Store {
    /// The trusted server borrows Runtime's sealed pending call to populate this
    /// data. Parent lineage and the authenticated live Worker supply authority.
    /// Delegation and exact native correlation commit in the same transaction.
    pub async fn delegate_native_offline_python(
        &self,
        credential: &str,
        parent: &OfflinePythonParent,
        call: &OfflinePythonNativeCall,
        source: &str,
        lifetime_ms: u32,
    ) -> Result<OfflinePythonAdmission> {
        call.validate()?;
        if source.is_empty() || source.len() > 32768 || source.contains('\0') {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        execution(self, &mut tx, credential, &parent.parent).await?;
        if parent.parent.run.role != Role::Worker
            || parent.parent.run.native_session_id.as_deref() != Some(call.thread_id.as_str())
        {
            return Err(RuntimeStoreError::Fenced);
        }
        let digest = call.digest();
        let (kind, id) = call.request();
        let existing = sqlx::query("SELECT * FROM worker_tool_results WHERE parent_run_id=? AND native_thread=? AND native_turn=? AND ((request_kind=? AND request_id=?) OR call_id=?)")
            .bind(parent.parent.run.run_id.to_string()).bind(&call.thread_id).bind(&call.turn_id)
            .bind(kind).bind(&id).bind(&call.call_id).fetch_optional(&mut *tx).await.map_err(db)?;
        if let Some(row) = &existing {
            if row.get::<&str, _>("call_digest") != digest {
                return Err(RuntimeStoreError::Conflict);
            }
        } else {
            let count: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM worker_tool_results WHERE parent_run_id=?",
            )
            .bind(parent.parent.run.run_id.to_string())
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
            if count >= 32 {
                return Err(RuntimeStoreError::Busy);
            }
        }
        let admission = self
            .delegate_offline_python_in_transaction(
                &mut tx,
                credential,
                &parent.parent,
                (&parent.namespace, &parent.incarnation),
                &format!("native:{digest}"),
                source,
                lifetime_ms,
            )
            .await?;
        match &admission {
            OfflinePythonAdmission::Fresh(grant) if existing.is_none() => {
                sqlx::query("INSERT INTO worker_tool_results(delegation_id,parent_run_id,request_kind,request_id,call_id,native_thread,native_turn,call_digest,state) VALUES(?,?,?,?,?,?,?,?,'bound')")
                    .bind(grant.id().to_string()).bind(parent.parent.run.run_id.to_string()).bind(kind).bind(id)
                    .bind(&call.call_id).bind(&call.thread_id).bind(&call.turn_id).bind(digest)
                    .execute(&mut *tx).await.map_err(db)?;
            }
            OfflinePythonAdmission::Existing(receipt)
                if existing.as_ref().is_some_and(|row| {
                    row.get::<String, _>("delegation_id") == receipt.delegation_id.to_string()
                }) => {}
            _ => return Err(RuntimeStoreError::Conflict),
        }
        tx.commit().await.map_err(db)?;
        Ok(admission)
    }
}
