//! Bounded, owner-scoped conversation export. No admission or runtime authority.
use crate::{digest, Store};
use orkestr_v2_contracts::{
    ConversationId, ConversationSnapshot, Message, MessageId, OwnerId, ProjectId, Scope,
};
use sqlx::{Connection, Row, SqlitePool};
use std::{
    io,
    time::{Duration, Instant},
};
use uuid::Uuid;

pub const MAX_EXPORT_ROWS: usize = 100_000;
pub const MAX_EXPORT_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_EXPORT_PAGES: usize = 1_000;
pub const MAX_EXPORT_LIFETIME: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy)]
pub struct ConversationExportLimits {
    pub lifetime: Duration,
    pub max_rows: usize,
    pub max_bytes: usize,
}
impl Default for ConversationExportLimits {
    fn default() -> Self {
        Self {
            lifetime: MAX_EXPORT_LIFETIME,
            max_rows: MAX_EXPORT_ROWS,
            max_bytes: MAX_EXPORT_BYTES,
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConversationExportError {
    Invalid,
    Unauthorized,
    NotFound,
    WrongCut,
    Cursor,
    Expired,
    Released,
    LimitExceeded,
    Unavailable,
}
type Result<T> = std::result::Result<T, ConversationExportError>;
use ConversationExportError as Error;

/// Internal receipt metadata, not a portable capability or multi-authority cut.
#[derive(Debug, Clone)]
pub struct ConversationExportReceipt {
    pub cut_id: Uuid,
    pub owner_id: OwnerId,
    pub conversation_id: ConversationId,
    pub scope: Scope,
    pub last_sequence: i64,
    pub storage_schema_version: i64,
    pub package_version: &'static str,
}

/// Intentionally not Clone, Debug or serializable. Only Store constructs a handle.
/// No open transaction or reserved pool connection survives construction.
pub struct ConversationExport {
    pool: SqlitePool,
    token_hash: String,
    receipt: ConversationExportReceipt,
    snapshot: Option<ConversationSnapshot>,
    deadline: Instant,
    next_after: i64,
    next_index: usize,
    delivered_bytes: usize,
    delivered_pages: usize,
    max_bytes: usize,
}

fn unavailable(_: impl std::fmt::Display) -> Error {
    Error::Unavailable
}
fn token_hash(token: &str) -> Result<String> {
    if token.is_empty() || token.len() > 1024 {
        return Err(Error::Invalid);
    }
    Ok(digest(token))
}
async fn current_auth(
    pool: &SqlitePool,
    hash: &str,
    owner: &OwnerId,
    conversation: &ConversationId,
) -> Result<()> {
    // This is always a fresh autocommit read, never the historical export transaction.
    let allowed: i64 = sqlx::query_scalar("SELECT count(*) FROM auth_sessions a JOIN conversations c ON c.owner_id=a.owner_id WHERE a.token_hash=? AND a.owner_id=? AND a.expires_at>unixepoch() AND c.id=?")
        .bind(hash).bind(owner.to_string()).bind(conversation.to_string())
        .fetch_one(pool).await.map_err(unavailable)?;
    if allowed != 1 {
        return Err(Error::Unauthorized);
    }
    Ok(())
}

impl Store {
    /// Freeze published message fields under one database read transaction, then
    /// release the connection. The caller must keep this private handle in process.
    pub async fn begin_conversation_export(
        &self,
        token: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        limits: ConversationExportLimits,
    ) -> Result<ConversationExport> {
        if limits.lifetime.is_zero()
            || limits.lifetime > MAX_EXPORT_LIFETIME
            || !(1..=MAX_EXPORT_ROWS).contains(&limits.max_rows)
            || !(1..=MAX_EXPORT_BYTES).contains(&limits.max_bytes)
        {
            return Err(Error::Invalid);
        }
        let hash = token_hash(token)?;
        let deadline = Instant::now() + limits.lifetime;
        let operation = async {
            current_auth(&self.pool, &hash, owner, conversation).await?;
            // Use an existing Store connection, not a reopened caller-selected path.
            // Closing it on every exit prevents read-only pragmas leaking to writers.
            let mut connection = self.pool.acquire().await.map_err(unavailable)?;
            connection.close_on_drop();
            sqlx::query("PRAGMA query_only=ON")
                .execute(&mut *connection)
                .await
                .map_err(unavailable)?;
            sqlx::query("PRAGMA trusted_schema=OFF")
                .execute(&mut *connection)
                .await
                .map_err(unavailable)?;
            let mut tx = connection.begin().await.map_err(unavailable)?;
            let row = sqlx::query(
                "SELECT project_id,sequence FROM conversations WHERE id=? AND owner_id=?",
            )
            .bind(conversation.to_string())
            .bind(owner.to_string())
            .fetch_optional(&mut *tx)
            .await
            .map_err(unavailable)?
            .ok_or(Error::NotFound)?;
            let scope = match row.get::<Option<String>, _>("project_id") {
                Some(value) => Scope::Project {
                    project_id: ProjectId(Uuid::parse_str(&value).map_err(unavailable)?),
                },
                None => Scope::Global,
            };
            let last_sequence: i64 = row.get("sequence");
            if last_sequence < 0 {
                return Err(Error::Unavailable);
            }
            let storage_schema_version: i64 = sqlx::query_scalar(
                "SELECT coalesce(max(version),0) FROM _sqlx_migrations WHERE success=1",
            )
            .fetch_one(&mut *tx)
            .await
            .map_err(unavailable)?;
            // Bound raw fields before loading them into Rust. The later serializer
            // also accounts for escaping, identifiers and published envelope bytes.
            let size = sqlx::query("SELECT count(*) AS rows,coalesce(sum(length(CAST(id AS BLOB))+length(CAST(actor_kind AS BLOB))+length(CAST(text AS BLOB))),0) AS bytes FROM (SELECT id,actor_kind,text FROM messages WHERE conversation_id=? AND owner_id=? AND sequence>0 AND sequence<=? ORDER BY sequence LIMIT ?)")
                .bind(conversation.to_string()).bind(owner.to_string()).bind(last_sequence)
                .bind((limits.max_rows + 1) as i64).fetch_one(&mut *tx).await.map_err(unavailable)?;
            if size.get::<i64, _>("rows") > limits.max_rows as i64
                || size.get::<i64, _>("bytes") > limits.max_bytes as i64
            {
                return Err(Error::LimitExceeded);
            }
            let rows = sqlx::query("SELECT id,sequence,actor_kind,text FROM messages WHERE conversation_id=? AND owner_id=? AND sequence>0 AND sequence<=? ORDER BY sequence LIMIT ?")
                .bind(conversation.to_string()).bind(owner.to_string()).bind(last_sequence)
                .bind(limits.max_rows as i64).fetch_all(&mut *tx).await.map_err(unavailable)?;
            let mut messages = Vec::with_capacity(rows.len());
            for row in rows {
                messages.push(Message {
                    message_id: MessageId(Uuid::parse_str(row.get("id")).map_err(unavailable)?),
                    sequence: row.get("sequence"),
                    actor_kind: row.get("actor_kind"),
                    text: row.get("text"),
                    reply_to: None,
                    origin: None,
                });
            }
            let snapshot = ConversationSnapshot {
                conversation_id: conversation.clone(),
                scope: scope.clone(),
                messages,
                last_sequence,
                next_cursor: None,
            };
            canonical_size(&snapshot, limits.max_bytes)?;
            tx.commit().await.map_err(unavailable)?;
            connection.close().await.map_err(unavailable)?;
            // Revocation during capture cannot authorize a completed export handle.
            current_auth(&self.pool, &hash, owner, conversation).await?;
            Ok(ConversationExport {
                pool: self.pool.clone(),
                token_hash: hash,
                receipt: ConversationExportReceipt {
                    cut_id: Uuid::new_v4(),
                    owner_id: owner.clone(),
                    conversation_id: conversation.clone(),
                    scope,
                    last_sequence,
                    storage_schema_version,
                    package_version: env!("CARGO_PKG_VERSION"),
                },
                snapshot: Some(snapshot),
                deadline,
                next_after: 0,
                next_index: 0,
                delivered_bytes: 0,
                delivered_pages: 0,
                max_bytes: limits.max_bytes,
            })
        };
        tokio::time::timeout_at(deadline.into(), operation)
            .await
            .map_err(|_| Error::Expired)?
    }
}

impl ConversationExport {
    pub fn receipt(&self) -> &ConversationExportReceipt {
        &self.receipt
    }

    /// Release payload memory and permanently invalidate paging. Idempotent.
    pub fn release(&mut self) {
        self.snapshot = None;
    }

    /// Sequential pages only: after=0 first, then exactly the prior next_cursor.
    /// A cut UUID selects this already-owned handle; it cannot construct authority.
    pub async fn page(
        &mut self,
        token: &str,
        owner: &OwnerId,
        cut_id: Uuid,
        after: i64,
        limit: u32,
    ) -> Result<ConversationSnapshot> {
        self.live()?;
        if owner != &self.receipt.owner_id || token_hash(token)? != self.token_hash {
            return Err(Error::Unauthorized);
        }
        if cut_id != self.receipt.cut_id {
            return Err(Error::WrongCut);
        }
        if after != self.next_after {
            return Err(Error::Cursor);
        }
        if !(1..=100).contains(&limit) {
            return Err(Error::Invalid);
        }
        if self.delivered_pages >= MAX_EXPORT_PAGES {
            self.release();
            return Err(Error::LimitExceeded);
        }
        let snapshot = self.snapshot.as_ref().ok_or(Error::Released)?;
        let end = (self.next_index + limit as usize).min(snapshot.messages.len());
        let messages = snapshot.messages[self.next_index..end].to_vec();
        let next_cursor = if end < snapshot.messages.len() {
            messages.last().map(|m| m.sequence)
        } else {
            None
        };
        let page = ConversationSnapshot {
            conversation_id: self.receipt.conversation_id.clone(),
            scope: self.receipt.scope.clone(),
            messages,
            last_sequence: self.receipt.last_sequence,
            next_cursor,
        };
        let bytes = match canonical_size(&page, self.max_bytes.saturating_sub(self.delivered_bytes))
        {
            Ok(bytes) => bytes,
            Err(error) => {
                self.release();
                return Err(error);
            }
        };
        // Last awaited operation before delivery: auth is not pinned with old rows.
        // The fresh auth read is the authorization linearization point; revocation
        // committed before it must refuse. No response can undo earlier delivery.
        let auth = tokio::time::timeout_at(
            self.deadline.into(),
            current_auth(
                &self.pool,
                &self.token_hash,
                &self.receipt.owner_id,
                &self.receipt.conversation_id,
            ),
        )
        .await
        .map_err(|_| Error::Expired)
        .and_then(|result| result);
        if let Err(error) = auth {
            self.release();
            return Err(error);
        }
        self.live()?;
        self.next_index = end;
        self.delivered_pages += 1;
        self.delivered_bytes += bytes;
        if let Some(after) = next_cursor {
            self.next_after = after;
        } else {
            self.release();
        }
        Ok(page)
    }

    fn live(&mut self) -> Result<()> {
        if self.snapshot.is_none() {
            return Err(Error::Released);
        }
        if Instant::now() >= self.deadline {
            self.release();
            return Err(Error::Expired);
        }
        Ok(())
    }
}

fn canonical_size(value: &ConversationSnapshot, limit: usize) -> Result<usize> {
    struct Counter {
        size: usize,
        limit: usize,
    }
    impl io::Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            // Migration canonical JSON uses ensure_ascii=True. Count escaped
            // Unicode length from UTF-8 leaders, independently of write boundaries.
            // serde_json emits valid UTF-8; continuation bytes add no further cost.
            let canonical: usize = bytes
                .iter()
                .map(|b| match b {
                    0..=126 => 1,
                    127 => 6,
                    128..=191 => 0,
                    192..=239 => 6,
                    _ => 12, // supplementary scalar -> two escaped UTF-16 surrogates
                })
                .sum();
            let next = self
                .size
                .checked_add(canonical)
                .filter(|n| *n <= self.limit)
                .ok_or_else(|| io::Error::other("export byte limit"))?;
            self.size = next;
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter { size: 0, limit };
    serde_json::to_writer(&mut counter, value).map_err(|_| Error::LimitExceeded)?;
    Ok(counter.size)
}

#[cfg(test)]
#[path = "conversation_export_tests.rs"]
mod tests;
