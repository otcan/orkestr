//! Conversation desktop bindings, grants and V1-lease fences. The server
//! calls V1 between `prepare_desktop_acquire` and `record_desktop_acquired`;
//! every later call is fenced by the hash of V1's fencing token.
use super::{now_ms, owned, unavailable, ResourceError, Result};
use crate::Store;
use orkestr_v2_contracts::*;
use sqlx::{Row, Sqlite, Transaction};

/// Owner credential, or a per-conversation desktop grant (lease routes only).
#[derive(Clone, Copy)]
pub enum DesktopCaller<'a> {
    Owner {
        credential: &'a str,
        owner: &'a OwnerId,
    },
    Grant(&'a str),
}
#[derive(Debug, Clone)]
pub struct PreparedAcquire {
    pub v1_thread_id: String,
    binding_revision: i64,
}
#[derive(Debug, Clone)]
pub struct V1LeaseGrant {
    pub lease_id: String,
    pub fencing_token: String,
    pub fencing_version: i64,
    pub expires_at: Option<String>,
}
#[derive(Debug, Clone)]
pub struct DesktopFence {
    row: i64,
    token_hash: String,
    pub v1_thread_id: String,
    pub v1_lease_id: String,
    pub fencing_version: i64,
}

fn grant_hash(grant: &str) -> String {
    crate::digest(&format!("orkestr-v2-desktop-grant:{grant}"))
}
fn fence_hash(token: &str) -> String {
    crate::digest(&format!("orkestr-v2-desktop-fence:{token}"))
}
fn binding_of(
    conversation: &ConversationId,
    row: &sqlx::sqlite::SqliteRow,
) -> Result<DesktopBinding> {
    Ok(DesktopBinding {
        schema_version: 1,
        conversation_id: conversation.clone(),
        revision: row.get("revision"),
        v1_thread_id: row.get("v1_thread_id"),
        desktop_slugs: serde_json::from_str(row.get::<String, _>("desktop_slugs").as_str())
            .map_err(unavailable)?,
        grant_issued: row.get::<Option<String>, _>("grant_hash").is_some(),
        grant_generation: row.get("grant_generation"),
    })
}
async fn binding(
    tx: &mut Transaction<'_, Sqlite>,
    conversation: &ConversationId,
) -> Result<Option<DesktopBinding>> {
    match sqlx::query("SELECT * FROM desktop_bindings WHERE conversation_id=?")
        .bind(conversation.to_string())
        .fetch_optional(&mut **tx)
        .await
        .map_err(unavailable)?
    {
        Some(row) => Ok(Some(binding_of(conversation, &row)?)),
        None => Ok(None),
    }
}
fn lease_of(row: &sqlx::sqlite::SqliteRow) -> Result<DesktopLeaseView> {
    let conversation = uuid::Uuid::parse_str(row.get::<String, _>("conversation_id").as_str())
        .map_err(unavailable)?;
    Ok(DesktopLeaseView {
        conversation_id: ConversationId(conversation),
        desktop_slug: row.get("desktop_slug"),
        v1_thread_id: row.get("v1_thread_id"),
        v1_lease_id: row.get("v1_lease_id"),
        fencing_version: row.get("fencing_version"),
        state: DesktopLeaseState::parse(row.get::<String, _>("state").as_str())
            .ok_or(ResourceError::Unavailable)?,
        expires_at: row.get("expires_at"),
        acquired_at_ms: row.get("acquired_at_ms"),
        heartbeat_at_ms: row.get("heartbeat_at_ms"),
        ended_at_ms: row.get("ended_at_ms"),
        end_reason: row.get("end_reason"),
    })
}
async fn lease_row(tx: &mut Transaction<'_, Sqlite>, row: i64) -> Result<DesktopLeaseView> {
    let row = sqlx::query("SELECT * FROM desktop_leases WHERE row_sequence=?")
        .bind(row)
        .fetch_one(&mut **tx)
        .await
        .map_err(unavailable)?;
    lease_of(&row)
}

impl Store {
    async fn desktop_scope(
        &self,
        caller: DesktopCaller<'_>,
        conversation: &ConversationId,
        write: bool,
    ) -> Result<(Transaction<'_, Sqlite>, OwnerId)> {
        match caller {
            DesktopCaller::Owner { credential, owner } => Ok((
                self.owner_scope(credential, owner, conversation, write)
                    .await?,
                owner.clone(),
            )),
            DesktopCaller::Grant(grant) => {
                if self.authority.is_some()
                    || grant.len() != 64
                    || !grant
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                {
                    return Err(ResourceError::Unauthorized);
                }
                let mut tx = self
                    .pool
                    .begin_with(if write { "BEGIN IMMEDIATE" } else { "BEGIN" })
                    .await
                    .map_err(unavailable)?;
                let owner: Option<String> = sqlx::query_scalar(
                    "SELECT owner_id FROM desktop_bindings WHERE conversation_id=? AND grant_hash=?",
                )
                .bind(conversation.to_string())
                .bind(grant_hash(grant))
                .fetch_optional(&mut *tx)
                .await
                .map_err(unavailable)?;
                let owner = owner
                    .and_then(|o| uuid::Uuid::parse_str(&o).ok())
                    .map(OwnerId)
                    .ok_or(ResourceError::Unauthorized)?;
                owned(&mut tx, &owner, conversation).await?;
                Ok((tx, owner))
            }
        }
    }

    pub async fn desktop_binding(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> Result<Option<DesktopBinding>> {
        let mut tx = self
            .owner_scope(credential, owner, conversation, false)
            .await?;
        let result = binding(&mut tx, conversation).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(result)
    }

    /// Create or replace a binding. The V1 thread identity and any leased
    /// slug cannot change while this conversation holds an active lease.
    pub async fn bind_desktops(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        request: &DesktopBindingRequest,
    ) -> Result<DesktopBinding> {
        if !request.is_valid() {
            return Err(ResourceError::Invalid);
        }
        let mut tx = self
            .owner_scope(credential, owner, conversation, true)
            .await?;
        let before = binding(&mut tx, conversation).await?;
        let revision = before.as_ref().map_or(0, |b| b.revision);
        if revision != request.expected_revision {
            return Err(ResourceError::Conflict("binding_revision_mismatch"));
        }
        let active: Vec<String> = sqlx::query_scalar(
            "SELECT desktop_slug FROM desktop_leases WHERE conversation_id=? AND state='active'",
        )
        .bind(conversation.to_string())
        .fetch_all(&mut *tx)
        .await
        .map_err(unavailable)?;
        if before
            .as_ref()
            .is_some_and(|b| b.v1_thread_id != request.v1_thread_id && !active.is_empty())
            || active.iter().any(|s| !request.desktop_slugs.contains(s))
        {
            return Err(ResourceError::Conflict("desktop_lease_active"));
        }
        let taken: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM desktop_bindings WHERE owner_id=? AND v1_thread_id=? AND conversation_id<>?",
        )
        .bind(owner.to_string())
        .bind(&request.v1_thread_id)
        .bind(conversation.to_string())
        .fetch_one(&mut *tx)
        .await
        .map_err(unavailable)?;
        if taken != 0 {
            return Err(ResourceError::Conflict("v1_thread_already_bound"));
        }
        let slugs = serde_json::to_string(&request.desktop_slugs).map_err(unavailable)?;
        sqlx::query(
            "INSERT INTO desktop_bindings(conversation_id,owner_id,revision,v1_thread_id,desktop_slugs) VALUES(?,?,?,?,?)
             ON CONFLICT(conversation_id) DO UPDATE SET revision=excluded.revision,v1_thread_id=excluded.v1_thread_id,desktop_slugs=excluded.desktop_slugs",
        )
        .bind(conversation.to_string())
        .bind(owner.to_string())
        .bind(revision + 1)
        .bind(&request.v1_thread_id)
        .bind(slugs)
        .execute(&mut *tx)
        .await
        .map_err(unavailable)?;
        let result = binding(&mut tx, conversation)
            .await?
            .ok_or(ResourceError::Unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(result)
    }

    /// Issue (rotate) the conversation desktop grant. Shown once; hash stored.
    pub async fn issue_desktop_grant(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> Result<DesktopGrantIssued> {
        let mut tx = self
            .owner_scope(credential, owner, conversation, true)
            .await?;
        let grant = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let changed = sqlx::query(
            "UPDATE desktop_bindings SET grant_hash=?,grant_generation=grant_generation+1 WHERE conversation_id=?",
        )
        .bind(grant_hash(&grant))
        .bind(conversation.to_string())
        .execute(&mut *tx)
        .await
        .map_err(unavailable)?
        .rows_affected();
        if changed != 1 {
            return Err(ResourceError::Conflict("desktop_binding_required"));
        }
        let binding = binding(&mut tx, conversation)
            .await?
            .ok_or(ResourceError::Unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(DesktopGrantIssued { binding, grant })
    }

    pub async fn revoke_desktop_grant(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
    ) -> Result<DesktopBinding> {
        let mut tx = self
            .owner_scope(credential, owner, conversation, true)
            .await?;
        sqlx::query("UPDATE desktop_bindings SET grant_hash=NULL WHERE conversation_id=?")
            .bind(conversation.to_string())
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
        let binding = binding(&mut tx, conversation)
            .await?
            .ok_or(ResourceError::NotFound)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(binding)
    }

    pub async fn desktop_leases(
        &self,
        caller: DesktopCaller<'_>,
        conversation: &ConversationId,
    ) -> Result<DesktopLeaseList> {
        let (mut tx, _) = self.desktop_scope(caller, conversation, false).await?;
        let binding = binding(&mut tx, conversation).await?;
        let rows = sqlx::query(
            "SELECT * FROM desktop_leases WHERE conversation_id=? ORDER BY (state='active') DESC,row_sequence DESC LIMIT 50",
        )
        .bind(conversation.to_string())
        .fetch_all(&mut *tx)
        .await
        .map_err(unavailable)?;
        let leases = rows.iter().map(lease_of).collect::<Result<Vec<_>>>()?;
        tx.commit().await.map_err(unavailable)?;
        Ok(DesktopLeaseList {
            schema_version: 1,
            conversation_id: conversation.clone(),
            binding,
            leases,
        })
    }

    /// Checks binding, slug and V2-side exclusivity before contacting V1.
    /// An active V2 row past its V2-observed expiry is marked lost; V1 still
    /// decides whether the desktop is free.
    pub async fn prepare_desktop_acquire(
        &self,
        caller: DesktopCaller<'_>,
        conversation: &ConversationId,
        slug: &str,
    ) -> Result<PreparedAcquire> {
        if !desktop_slug_valid(slug) {
            return Err(ResourceError::Invalid);
        }
        let (mut tx, owner) = self.desktop_scope(caller, conversation, true).await?;
        let binding = binding(&mut tx, conversation)
            .await?
            .ok_or(ResourceError::Conflict("desktop_binding_required"))?;
        if !binding.desktop_slugs.iter().any(|s| s == slug) {
            return Err(ResourceError::Conflict("desktop_not_granted"));
        }
        let now = now_ms();
        sqlx::query("UPDATE desktop_leases SET state='lost',ended_at_ms=?,end_reason='expired' WHERE owner_id=? AND desktop_slug=? AND state='active' AND expires_at_ms<=?")
            .bind(now).bind(owner.to_string()).bind(slug).bind(now)
            .execute(&mut *tx).await.map_err(unavailable)?;
        let holder: Option<String> = sqlx::query_scalar(
            "SELECT conversation_id FROM desktop_leases WHERE owner_id=? AND desktop_slug=? AND state='active'",
        )
        .bind(owner.to_string())
        .bind(slug)
        .fetch_optional(&mut *tx)
        .await
        .map_err(unavailable)?;
        match holder {
            Some(h) if h == conversation.to_string() => {
                return Err(ResourceError::Conflict("desktop_lease_held"))
            }
            Some(_) => return Err(ResourceError::Conflict("desktop_leased")),
            None => {}
        }
        tx.commit().await.map_err(unavailable)?;
        Ok(PreparedAcquire {
            v1_thread_id: binding.v1_thread_id,
            binding_revision: binding.revision,
        })
    }

    /// Records a V1 grant. On any error the caller must release it at V1.
    pub async fn record_desktop_acquired(
        &self,
        caller: DesktopCaller<'_>,
        conversation: &ConversationId,
        prepared: &PreparedAcquire,
        slug: &str,
        grant: &V1LeaseGrant,
        ttl_ms: u64,
    ) -> Result<DesktopLeaseGranted> {
        if !fencing_token_valid(&grant.fencing_token)
            || grant.lease_id.is_empty()
            || grant.lease_id.len() > 512
        {
            return Err(ResourceError::Invalid);
        }
        let (mut tx, owner) = self.desktop_scope(caller, conversation, true).await?;
        let current = binding(&mut tx, conversation).await?;
        if current.as_ref().map(|b| b.revision) != Some(prepared.binding_revision) {
            return Err(ResourceError::Conflict("binding_revision_mismatch"));
        }
        let now = now_ms();
        let inserted = sqlx::query(
            "INSERT INTO desktop_leases(owner_id,conversation_id,desktop_slug,v1_thread_id,v1_lease_id,fencing_version,token_hash,state,expires_at,expires_at_ms,acquired_at_ms,heartbeat_at_ms)
             VALUES(?,?,?,?,?,?,?,'active',?,?,?,?)",
        )
        .bind(owner.to_string()).bind(conversation.to_string()).bind(slug)
        .bind(&prepared.v1_thread_id).bind(&grant.lease_id).bind(grant.fencing_version)
        .bind(fence_hash(&grant.fencing_token)).bind(&grant.expires_at)
        .bind(now.saturating_add(ttl_ms as i64)).bind(now).bind(now)
        .execute(&mut *tx)
        .await;
        let row = match inserted {
            Ok(done) => done.last_insert_rowid(),
            Err(sqlx::Error::Database(e)) if e.is_unique_violation() => {
                return Err(ResourceError::Conflict("desktop_leased"))
            }
            Err(e) => return Err(unavailable(e)),
        };
        let lease = lease_row(&mut tx, row).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(DesktopLeaseGranted {
            lease,
            fencing_token: grant.fencing_token.clone(),
        })
    }

    /// The active lease of this conversation and slug matching the token.
    pub async fn desktop_fence(
        &self,
        caller: DesktopCaller<'_>,
        conversation: &ConversationId,
        slug: &str,
        fencing_token: &str,
    ) -> Result<DesktopFence> {
        if !desktop_slug_valid(slug) || !fencing_token_valid(fencing_token) {
            return Err(ResourceError::Invalid);
        }
        let (mut tx, _) = self.desktop_scope(caller, conversation, false).await?;
        let row = sqlx::query("SELECT row_sequence,token_hash,v1_thread_id,v1_lease_id,fencing_version FROM desktop_leases WHERE conversation_id=? AND desktop_slug=? AND state='active'")
            .bind(conversation.to_string()).bind(slug)
            .fetch_optional(&mut *tx).await.map_err(unavailable)?
            .ok_or(ResourceError::NotFound)?;
        tx.commit().await.map_err(unavailable)?;
        let expected = fence_hash(fencing_token);
        // Both sides are SHA-256 digests; comparing digests reveals nothing usable.
        if row.get::<String, _>("token_hash") != expected {
            return Err(ResourceError::Conflict("desktop_fence_rejected"));
        }
        Ok(DesktopFence {
            row: row.get("row_sequence"),
            token_hash: expected,
            v1_thread_id: row.get("v1_thread_id"),
            v1_lease_id: row.get("v1_lease_id"),
            fencing_version: row.get("fencing_version"),
        })
    }

    pub async fn record_desktop_heartbeat(
        &self,
        caller: DesktopCaller<'_>,
        conversation: &ConversationId,
        fence: &DesktopFence,
        extended: Option<(Option<String>, u64)>,
    ) -> Result<DesktopLeaseView> {
        let (mut tx, _) = self.desktop_scope(caller, conversation, true).await?;
        let now = now_ms();
        let (expires_at, expires_ms) = match &extended {
            Some((at, ttl)) => (at.clone(), Some(now.saturating_add(*ttl as i64))),
            None => (None, None),
        };
        let changed = sqlx::query("UPDATE desktop_leases SET heartbeat_at_ms=?,expires_at=coalesce(?,expires_at),expires_at_ms=coalesce(?,expires_at_ms) WHERE row_sequence=? AND conversation_id=? AND state='active' AND token_hash=?")
            .bind(now).bind(expires_at).bind(expires_ms).bind(fence.row)
            .bind(conversation.to_string()).bind(&fence.token_hash)
            .execute(&mut *tx).await.map_err(unavailable)?.rows_affected();
        if changed != 1 {
            return Err(ResourceError::Conflict("desktop_fence_rejected"));
        }
        let lease = lease_row(&mut tx, fence.row).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(lease)
    }

    pub async fn end_desktop_lease(
        &self,
        caller: DesktopCaller<'_>,
        conversation: &ConversationId,
        fence: &DesktopFence,
        state: DesktopLeaseState,
        reason: &str,
    ) -> Result<DesktopLeaseView> {
        if state == DesktopLeaseState::Active || reason.is_empty() || reason.len() > 200 {
            return Err(ResourceError::Invalid);
        }
        let (mut tx, _) = self.desktop_scope(caller, conversation, true).await?;
        let changed = sqlx::query("UPDATE desktop_leases SET state=?,ended_at_ms=?,end_reason=? WHERE row_sequence=? AND conversation_id=? AND state='active' AND token_hash=?")
            .bind(state.as_str()).bind(now_ms()).bind(reason).bind(fence.row)
            .bind(conversation.to_string()).bind(&fence.token_hash)
            .execute(&mut *tx).await.map_err(unavailable)?.rows_affected();
        if changed != 1 {
            return Err(ResourceError::Conflict("desktop_fence_rejected"));
        }
        let lease = lease_row(&mut tx, fence.row).await?;
        tx.commit().await.map_err(unavailable)?;
        Ok(lease)
    }
}
