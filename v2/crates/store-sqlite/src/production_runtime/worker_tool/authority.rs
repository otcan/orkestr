use super::*;

pub(super) fn credential(store: &Store, value: &str) -> Result<()> {
    if value.len() != 64
        || !value.bytes().all(|b| b.is_ascii_hexdigit())
        || crate::digest(value) != store.context()?.token_hash
    {
        return Err(RuntimeStoreError::Unauthorized);
    }
    Ok(())
}

pub(super) async fn execution(
    store: &Store,
    conn: &mut SqliteConnection,
    token: &str,
    parent: &ProviderAdmission,
) -> Result<()> {
    credential(store, token)?;
    let row = store.production_authorized_run(conn, parent).await?;
    if parent.run.purpose != AdmissionPurpose::Execution
        || !matches!(row.get::<&str, _>("state"), "starting" | "running")
        || row.get::<&str, _>("dispatch_state") != "delivery_unknown"
    {
        return Err(RuntimeStoreError::Fenced);
    }
    Ok(())
}

pub(super) async fn load(
    store: &Store,
    conn: &mut SqliteConnection,
    id: Uuid,
    parent: &ProviderAdmission,
    context_id: &str,
    incarnation: &str,
) -> Result<SqliteRow> {
    let context = store.context()?;
    if context_id != context.id || incarnation != context.incarnation {
        return Err(RuntimeStoreError::Fenced);
    }
    let row = sqlx::query(
        "SELECT * FROM worker_tool_delegations WHERE id=? AND owner_id=? AND context_id=?",
    )
    .bind(id.to_string())
    .bind(context.owner.to_string())
    .bind(&context.id)
    .fetch_optional(conn)
    .await
    .map_err(db)?
    .ok_or(RuntimeStoreError::NotFound)?;
    if row.get::<&str, _>("operation") != "python_offline_v1"
        || row.get::<&str, _>("incarnation_id") != incarnation
        || row.get::<String, _>("conversation_id") != parent.run.conversation_id.to_string()
        || row.get::<String, _>("parent_run_id") != parent.run.run_id.to_string()
        || row.get::<String, _>("parent_session_id") != parent.run.session_id.to_string()
        || row.get::<i64, _>("parent_binding_generation")
            != i64::try_from(parent.binding.generation).map_err(db)?
        || row.get::<i64, _>("parent_lease_generation")
            != i64::try_from(parent.run.lease_generation).map_err(db)?
        || row.get::<i64, _>("parent_dispatch_fence")
            != i64::try_from(parent.run.dispatch_fence).map_err(db)?
        || row.get::<i64, _>("parent_deadline_ms") != parent.run.lease_deadline_ms
    {
        return Err(RuntimeStoreError::Conflict);
    }
    Ok(row)
}

pub(super) fn receipt(row: &SqliteRow) -> Result<OfflinePythonReceipt> {
    Ok(OfflinePythonReceipt {
        delegation_id: Uuid::parse_str(row.get("id")).map_err(db)?,
        owner_id: OwnerId(Uuid::parse_str(row.get("owner_id")).map_err(db)?),
        conversation_id: ConversationId(Uuid::parse_str(row.get("conversation_id")).map_err(db)?),
        parent_run_id: RunId(Uuid::parse_str(row.get("parent_run_id")).map_err(db)?),
        source_digest: row.get("source_digest"),
        revision: row.get("revision"),
        state: match row.get::<&str, _>("state") {
            "delegated" => OfflinePythonState::Delegated,
            "delivery_unknown" => OfflinePythonState::DeliveryUnknown,
            "completed" => OfflinePythonState::Completed,
            "failed" => OfflinePythonState::Failed,
            "cancelled" => OfflinePythonState::Cancelled,
            "blocked" => OfflinePythonState::Blocked,
            _ => return Err(RuntimeStoreError::Unavailable),
        },
    })
}

pub(super) async fn live(
    store: &Store,
    conn: &mut SqliteConnection,
    token: &str,
    launch: &ConsumedOfflinePython,
) -> Result<SqliteRow> {
    execution(store, conn, token, &launch.parent).await?;
    let row = load(
        store,
        conn,
        launch.id(),
        &launch.parent,
        &launch.context_id,
        &launch.incarnation,
    )
    .await?;
    if row.get::<&str, _>("source_digest") != launch.source_digest()
        || row.get::<i64, _>("expires_at_ms") != launch.expires_at_ms
    {
        return Err(RuntimeStoreError::Conflict);
    }
    if launch.expires_at_ms <= now(conn).await? {
        return Err(RuntimeStoreError::Expired);
    }
    Ok(row)
}

impl Store {
    /// Fresh, read-only monitor. Refusal requires physical termination, not a
    /// successful Stop receipt. The spawn path uses the separate immediate fence.
    pub async fn check_offline_python(
        &self,
        credential: &str,
        launch: &ConsumedOfflinePython,
    ) -> Result<()> {
        let mut tx = self.pool.begin().await.map_err(db)?;
        let row = live(self, &mut tx, credential, launch).await?;
        if row.get::<&str, _>("state") != "delivery_unknown" {
            return Err(RuntimeStoreError::Fenced);
        }
        tx.commit().await.map_err(db)?;
        Ok(())
    }

    /// Only actual bounded spawn belongs in action, never its scheduling or wait.
    /// Durable consumption prevents reissue; the private one-use bit also stops
    /// a caller from invoking action twice using the same consumed capability.
    pub fn with_offline_python_fence<T, E>(
        &self,
        credential: &str,
        launch: &ConsumedOfflinePython,
        action: impl FnOnce() -> std::result::Result<T, E>,
    ) -> Result<std::result::Result<T, E>> {
        let operation = async {
            let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
            let row = live(self, &mut tx, credential, launch).await?;
            if row.get::<&str, _>("state") != "delivery_unknown" {
                return Err(RuntimeStoreError::Fenced);
            }
            if launch
                .spawn_spent
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
            {
                return Err(RuntimeStoreError::Fenced);
            }
            let result = action();
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
