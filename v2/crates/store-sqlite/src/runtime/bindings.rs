use super::*;

pub(super) async fn ensure(
    store: &Store,
    owner: &OwnerId,
    conversation: &ConversationId,
) -> Result<RoleBindings> {
    let mut tx = store.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
    store.check_context_in(&mut tx, owner).await?;
    scope(&mut tx, owner, conversation).await?;
    let mut records = Vec::new();
    for role in ["fast", "deep"] {
        let existing = sqlx::query("SELECT * FROM session_bindings WHERE owner_id=? AND conversation_id=? AND role=? AND state <> 'retired'")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(role)
            .fetch_optional(&mut *tx).await.map_err(db)?;
        let row = match existing {
            Some(row) => row,
            None => sqlx::query("INSERT INTO session_bindings(id,owner_id,conversation_id,role) VALUES (?,?,?,?) RETURNING *")
                .bind(Uuid::new_v4().to_string()).bind(owner.to_string()).bind(conversation.to_string()).bind(role)
                .fetch_one(&mut *tx).await.map_err(db)?,
        };
        records.push(binding(&row)?);
    }
    let deep = records.pop().ok_or(RuntimeStoreError::Unavailable)?;
    let fast = records.pop().ok_or(RuntimeStoreError::Unavailable)?;
    tx.commit().await.map_err(db)?;
    Ok(RoleBindings { fast, deep })
}

pub(super) async fn worker(
    store: &Store,
    owner: &OwnerId,
    conversation: &ConversationId,
    parent: Option<&SessionId>,
    request_key: &str,
) -> Result<Binding> {
    if !key(request_key) {
        return Err(RuntimeStoreError::InvalidInput);
    }
    let mut tx = store.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
    store.check_context_in(&mut tx, owner).await?;
    scope(&mut tx, owner, conversation).await?;
    let parent_id = parent.map(ToString::to_string);
    let fingerprint = super::super::digest(&format!(
        "worker:{}",
        parent_id.as_deref().unwrap_or("none")
    ));
    if let Some(row) = sqlx::query(
        "SELECT * FROM session_bindings WHERE owner_id=? AND conversation_id=? AND request_key=?",
    )
    .bind(owner.to_string())
    .bind(conversation.to_string())
    .bind(request_key)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db)?
    {
        if row.get::<String, _>("request_digest") != fingerprint {
            return Err(RuntimeStoreError::Conflict);
        }
        return binding(&row);
    }
    if let Some(parent_id) = &parent_id {
        let found: i64 = sqlx::query_scalar("SELECT count(*) FROM session_bindings WHERE id=? AND owner_id=? AND conversation_id=? AND state <> 'retired'")
            .bind(parent_id).bind(owner.to_string()).bind(conversation.to_string()).fetch_one(&mut *tx).await.map_err(db)?;
        if found != 1 {
            return Err(RuntimeStoreError::NotFound);
        }
    }
    let row = sqlx::query("INSERT INTO session_bindings(id,owner_id,conversation_id,role,parent_session_id,request_key,request_digest) VALUES (?,?,?,'worker',?,?,?) RETURNING *")
        .bind(Uuid::new_v4().to_string()).bind(owner.to_string()).bind(conversation.to_string())
        .bind(parent_id).bind(request_key).bind(fingerprint).fetch_one(&mut *tx).await.map_err(db)?;
    let result = binding(&row)?;
    tx.commit().await.map_err(db)?;
    Ok(result)
}
