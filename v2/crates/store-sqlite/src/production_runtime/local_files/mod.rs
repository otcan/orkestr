//! Local folder relay (ORK-750, proof of concept).
//!
//! The agent of a conversation (a running Deep turn holding the
//! conversation's local-files grant) queues file requests. The owner's
//! browser tab that granted a folder for this conversation polls, takes the
//! queued requests, performs them inside that folder only and posts the
//! result. The server never touches the owner's files; it only records the
//! request, the tab's result and, for reads and packages, the encrypted
//! upload the tab made.
//!
//! - Authority: the grant (shown once, stored as a hash) only works while its
//!   conversation has a dispatched Deep run, which each request is pinned to.
//!   The conversation always comes from the grant. The tab side needs an
//!   interactive browser session of the owner (`kind='browser'`): never a
//!   machine bearer or a service credential. CSRF is enforced for it by the
//!   server's browser guard.
//! - Connection: one tab per conversation; it is connected while it polled
//!   within `LOCAL_FILE_CONNECTION_TTL_MS`. Another tab replaces it only when
//!   the owner chooses that tab (`takeover`). Without a connected tab a new
//!   request is refused with `local_files_not_connected`.
//! - Lifetime: every request has a deadline (default two minutes, at most
//!   ten). Unfinished requests fail as `expired` after it, and as
//!   `local_files_disconnected` when the tab disconnects or stops polling.
//!   Transitions are written before any read returns them, so a request the
//!   agent was told failed can never be performed later.
//! - Log: every request stays as a row; write content is cleared once it is
//!   finished (its size and SHA-256 stay).
use super::thread_asks::{running_deep, unavailable_conversation};
use super::*;
use crate::conversation_resources::{now_ms, owned};
use crate::ResourceError;
use orkestr_v2_contracts::{
    local_file_name, local_file_path, ConversationId, LocalFileConnection, LocalFileDisconnect,
    LocalFileFinish, LocalFileGrant, LocalFileGrantIssued, LocalFileMember, LocalFileOperation,
    LocalFileOutcome, LocalFilePoll, LocalFilePollReply, LocalFileReceipt, LocalFileRequestCreate,
    LocalFileRequestView, LocalFileResult, LocalFileState, LocalFileUploadFacts, LocalFileUploaded,
    LocalFilesOverview, LOCAL_FILE_CONNECTION_TTL_MS, LOCAL_FILE_HASH_MAX, LOCAL_FILE_LIST_MAX,
    LOCAL_FILE_OPEN_MAX, LOCAL_FILE_PACKAGE_MAX, LOCAL_FILE_READ_MAX, LOCAL_FILE_RECENT_MAX,
    LOCAL_FILE_TIMEOUT_MS, LOCAL_FILE_WRITE_MAX,
};
use sha2::{Digest, Sha256};
use sqlx::{sqlite::SqliteRow, Sqlite, Transaction};
mod grant;
#[cfg(test)]
mod tests;
mod view;
use view::{result_json, view};

type R<T> = std::result::Result<T, ResourceError>;
fn unavailable(_: impl std::fmt::Display) -> ResourceError {
    ResourceError::Unavailable
}
fn uuid(value: &str) -> R<Uuid> {
    Uuid::parse_str(value).map_err(unavailable)
}
fn grant_hash(grant: &str) -> String {
    crate::digest(&format!("orkestr-v2-local-files-grant:{grant}"))
}
/// Session kinds that may manage the grant: the owner's browser or machine
/// login, or a live, unrevoked service credential of the owner (operator
/// provisioning, like agent-timer grants). Never the folder tab itself.
const OWNER_KINDS: &[&str] = &["browser", "machine", "service_browser"];
/// Session kinds that may act as the folder tab: an interactive browser only.
const BROWSER_KINDS: &[&str] = &["browser"];
const RECENT_WINDOW_MS: i64 = 10 * 60_000;

/// Grant holder's derived scope; never constructed from request fields.
struct Caller {
    owner: OwnerId,
    generation: i64,
}
async fn caller_in(
    tx: &mut Transaction<'_, Sqlite>,
    grant: &str,
    conversation: &ConversationId,
) -> R<Caller> {
    let row = sqlx::query(
        "SELECT owner_id,generation FROM local_file_grants WHERE conversation_id=? AND grant_hash=?",
    )
    .bind(conversation.to_string())
    .bind(grant_hash(grant))
    .fetch_optional(&mut **tx)
    .await
    .map_err(unavailable)?
    .ok_or(ResourceError::Unauthorized)?;
    let owner = OwnerId(uuid(row.get("owner_id")).map_err(|_| ResourceError::Unauthorized)?);
    owned(tx, &owner, conversation).await?;
    Ok(Caller {
        owner,
        generation: row.get("generation"),
    })
}

/// Fail every unfinished request of the conversation with `error`.
async fn fail_open(tx: &mut SqliteConnection, conversation: &str, error: &str, now: i64) -> R<()> {
    sqlx::query("UPDATE local_file_requests SET state='failed',error=?,finished_ms=?,content=NULL WHERE conversation_id=? AND state IN ('queued','working')")
        .bind(error).bind(now).bind(conversation)
        .execute(tx).await.map_err(unavailable)?;
    Ok(())
}
/// The current connection: `(connection_id, live)`.
async fn connection(
    tx: &mut SqliteConnection,
    conversation: &str,
    now: i64,
) -> R<Option<(Uuid, bool)>> {
    let row = sqlx::query(
        "SELECT connection_id,seen_ms FROM local_file_connections WHERE conversation_id=?",
    )
    .bind(conversation)
    .fetch_optional(tx)
    .await
    .map_err(unavailable)?;
    row.map(|r| {
        Ok((
            uuid(r.get("connection_id"))?,
            r.get::<i64, _>("seen_ms") > now - LOCAL_FILE_CONNECTION_TTL_MS,
        ))
    })
    .transpose()
}
/// Write the time-driven transitions before anything is read: past the
/// deadline is `expired`; a stale connection is removed and its unfinished
/// requests fail as `local_files_disconnected`.
async fn settle(tx: &mut SqliteConnection, conversation: &str, now: i64) -> R<()> {
    sqlx::query("UPDATE local_file_requests SET state='failed',error='expired',finished_ms=?,content=NULL WHERE conversation_id=? AND state IN ('queued','working') AND deadline_ms<=?")
        .bind(now).bind(conversation).bind(now)
        .execute(&mut *tx).await.map_err(unavailable)?;
    if !matches!(connection(tx, conversation, now).await?, Some((_, true))) {
        fail_open(tx, conversation, "local_files_disconnected", now).await?;
        sqlx::query("DELETE FROM local_file_connections WHERE conversation_id=?")
            .bind(conversation)
            .execute(&mut *tx)
            .await
            .map_err(unavailable)?;
    }
    Ok(())
}
fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn request_digest(request: &LocalFileRequestCreate, content: Option<&str>) -> R<String> {
    let body = serde_json::to_string(&serde_json::json!([
        "orkestr.local-files.request.v1",
        request.operation.as_str(),
        request.path,
        request.paths,
        content,
        request.timeout_ms,
    ]))
    .map_err(unavailable)?;
    Ok(crate::digest(&body))
}
async fn one(tx: &mut SqliteConnection, conversation: &str, id: Uuid) -> R<SqliteRow> {
    sqlx::query("SELECT * FROM local_file_requests WHERE id=? AND conversation_id=?")
        .bind(id.to_string())
        .bind(conversation)
        .fetch_optional(tx)
        .await
        .map_err(unavailable)?
        .ok_or(ResourceError::NotFound)
}

impl Store {
    /// Exact owner credential of one of `kinds`, plus conversation ownership,
    /// inside one transaction.
    async fn local_files_scope(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        write: bool,
        kinds: &[&str],
    ) -> R<Transaction<'_, Sqlite>> {
        if self.authority.is_some() || credential.is_empty() || credential.len() > 1024 {
            return Err(ResourceError::Unauthorized);
        }
        if conversation.0.is_nil() {
            return Err(ResourceError::Invalid);
        }
        let mut tx = self
            .pool
            .begin_with(if write { "BEGIN IMMEDIATE" } else { "BEGIN" })
            .await
            .map_err(unavailable)?;
        // A service session counts only while its credential is live; any
        // other kind never carries a service credential.
        let kind: Option<String> = sqlx::query_scalar(
            "SELECT s.kind FROM auth_sessions s LEFT JOIN service_credentials k ON k.id=s.service_credential_id AND k.owner_id=s.owner_id WHERE s.token_hash=? AND s.owner_id=? AND s.expires_at>unixepoch() AND ((s.kind='service_browser' AND k.revoked=0 AND k.expires_at>unixepoch()) OR (s.kind<>'service_browser' AND s.service_credential_id IS NULL))",
        )
        .bind(crate::digest(credential))
        .bind(owner.to_string())
        .fetch_optional(&mut *tx)
        .await
        .map_err(unavailable)?;
        if !kind.is_some_and(|k| kinds.contains(&k.as_str())) {
            return Err(ResourceError::Unauthorized);
        }
        owned(&mut tx, owner, conversation).await?;
        Ok(tx)
    }

    /// Queue one request of the grant's conversation (agent side).
    pub async fn create_local_file_request(
        &self,
        grant: &str,
        conversation: &ConversationId,
        request: &LocalFileRequestCreate,
        content: Option<&[u8]>,
    ) -> R<LocalFileReceipt> {
        let write = request.operation == LocalFileOperation::Write;
        if !request.is_valid()
            || write != content.is_some()
            || content.is_some_and(|c| c.len() > LOCAL_FILE_WRITE_MAX)
        {
            return Err(ResourceError::Invalid);
        }
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(unavailable)?;
        let caller = caller_in(&mut tx, grant, conversation).await?;
        let id = conversation.to_string();
        if unavailable_conversation(&mut tx, &caller.owner, &id).await? {
            return Err(ResourceError::Conflict(
                "local_files_conversation_unavailable",
            ));
        }
        let (run, _) = running_deep(&mut tx, &caller.owner, conversation)
            .await?
            .ok_or(ResourceError::Conflict("local_files_no_running_turn"))?;
        let now = now_ms();
        settle(&mut tx, &id, now).await?;
        let content_sha = content.map(sha256_hex);
        let digest = request_digest(request, content_sha.as_deref())?;
        let replay = sqlx::query("SELECT * FROM local_file_requests WHERE conversation_id=? AND run_id=? AND request_key=?")
            .bind(&id).bind(&run).bind(&request.request_key)
            .fetch_optional(&mut *tx).await.map_err(unavailable)?;
        if let Some(row) = replay {
            if row.get::<&str, _>("request_digest") != digest {
                return Err(ResourceError::Conflict("local_file_request_conflict"));
            }
            let request = view(&row)?;
            tx.commit().await.map_err(unavailable)?;
            return Ok(LocalFileReceipt {
                created: false,
                request,
            });
        }
        if !matches!(connection(&mut tx, &id, now).await?, Some((_, true))) {
            return Err(ResourceError::Conflict("local_files_not_connected"));
        }
        let (open, recent): (i64, i64) = sqlx::query_as("SELECT (SELECT count(*) FROM local_file_requests WHERE conversation_id=?1 AND state IN ('queued','working')),(SELECT count(*) FROM local_file_requests WHERE conversation_id=?1 AND created_ms>?2)")
            .bind(&id).bind(now - RECENT_WINDOW_MS)
            .fetch_one(&mut *tx).await.map_err(unavailable)?;
        if open >= LOCAL_FILE_OPEN_MAX || recent >= LOCAL_FILE_RECENT_MAX {
            return Err(ResourceError::Conflict("local_files_rate_limited"));
        }
        let request_id = Uuid::new_v4();
        let deadline = now + request.timeout_ms.unwrap_or(LOCAL_FILE_TIMEOUT_MS);
        sqlx::query("INSERT INTO local_file_requests(id,owner_id,conversation_id,run_id,grant_generation,request_key,request_digest,operation,path,paths_json,content,content_bytes,content_sha256,state,created_ms,deadline_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'queued',?,?)")
            .bind(request_id.to_string()).bind(caller.owner.to_string()).bind(&id).bind(&run)
            .bind(caller.generation).bind(&request.request_key).bind(&digest)
            .bind(request.operation.as_str()).bind(&request.path)
            .bind(serde_json::to_string(&request.paths).map_err(unavailable)?)
            .bind(content).bind(content.map(|c| c.len() as i64)).bind(&content_sha)
            .bind(now).bind(deadline)
            .execute(&mut *tx).await.map_err(unavailable)?;
        let row = one(&mut tx, &id, request_id).await?;
        let request = view(&row)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(LocalFileReceipt {
            created: true,
            request,
        })
    }

    /// One request of the grant's conversation (agent side, read-only for
    /// the caller; time-driven transitions are written first).
    pub async fn local_file_request(
        &self,
        grant: &str,
        conversation: &ConversationId,
        request: Uuid,
    ) -> R<LocalFileRequestView> {
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(unavailable)?;
        caller_in(&mut tx, grant, conversation).await?;
        let id = conversation.to_string();
        settle(&mut tx, &id, now_ms()).await?;
        let value = view(&one(&mut tx, &id, request).await?)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(value)
    }

    /// The tab's heartbeat: (re)connect this tab, take every queued request
    /// and return all unfinished requests this tab holds.
    pub async fn poll_local_files(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        poll: &LocalFilePoll,
    ) -> R<LocalFilePollReply> {
        if !poll.is_valid() {
            return Err(ResourceError::Invalid);
        }
        let mut tx = self
            .local_files_scope(credential, owner, conversation, true, BROWSER_KINDS)
            .await?;
        let id = conversation.to_string();
        let now = now_ms();
        settle(&mut tx, &id, now).await?;
        let tab = poll.connection_id.to_string();
        match connection(&mut tx, &id, now).await? {
            Some((current, _)) if current == poll.connection_id => {
                sqlx::query("UPDATE local_file_connections SET seen_ms=?,folder_name=? WHERE conversation_id=?")
                    .bind(now).bind(&poll.folder_name).bind(&id)
                    .execute(&mut *tx).await.map_err(unavailable)?;
            }
            Some(_) if !poll.takeover => {
                return Err(ResourceError::Conflict("local_files_connected_elsewhere"));
            }
            _ => {
                // A new tab (or the owner chose this one): what another tab
                // took but did not finish is offered to this one again.
                sqlx::query("UPDATE local_file_requests SET state='queued',connection_id=NULL,claimed_ms=NULL WHERE conversation_id=? AND state='working'")
                    .bind(&id).execute(&mut *tx).await.map_err(unavailable)?;
                sqlx::query("INSERT INTO local_file_connections(conversation_id,owner_id,connection_id,folder_name,connected_ms,seen_ms) VALUES(?,?,?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET connection_id=excluded.connection_id,folder_name=excluded.folder_name,connected_ms=excluded.connected_ms,seen_ms=excluded.seen_ms")
                    .bind(&id).bind(owner.to_string()).bind(&tab).bind(&poll.folder_name).bind(now).bind(now)
                    .execute(&mut *tx).await.map_err(unavailable)?;
            }
        }
        sqlx::query("UPDATE local_file_requests SET state='working',connection_id=?,claimed_ms=? WHERE conversation_id=? AND state='queued'")
            .bind(&tab).bind(now).bind(&id)
            .execute(&mut *tx).await.map_err(unavailable)?;
        let rows = sqlx::query("SELECT * FROM local_file_requests WHERE conversation_id=? AND state='working' AND connection_id=? ORDER BY created_ms,rowid")
            .bind(&id).bind(&tab).fetch_all(&mut *tx).await.map_err(unavailable)?;
        let requests = rows.iter().map(view).collect::<R<Vec<_>>>()?;
        tx.commit().await.map_err(unavailable)?;
        Ok(LocalFilePollReply {
            requests,
            ttl_ms: LOCAL_FILE_CONNECTION_TTL_MS,
        })
    }

    /// The queued content of a write this tab holds (after the owner looked
    /// at it, the tab writes exactly these bytes).
    pub async fn local_file_content(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        request: Uuid,
        connection_id: Uuid,
    ) -> R<Vec<u8>> {
        let mut tx = self
            .local_files_scope(credential, owner, conversation, true, BROWSER_KINDS)
            .await?;
        let id = conversation.to_string();
        settle(&mut tx, &id, now_ms()).await?;
        let content: Option<Option<Vec<u8>>> = sqlx::query_scalar("SELECT content FROM local_file_requests WHERE id=? AND conversation_id=? AND operation='write' AND state='working' AND connection_id=?")
            .bind(request.to_string()).bind(&id).bind(connection_id.to_string())
            .fetch_optional(&mut *tx).await.map_err(unavailable)?;
        tx.commit().await.map_err(unavailable)?;
        content.flatten().ok_or(ResourceError::NotFound)
    }

    /// The tab's result for one request it holds. `upload` is what the server
    /// verified about the encrypted upload of a read or package.
    pub async fn finish_local_file_request(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        request: Uuid,
        finish: &LocalFileFinish,
        upload: Option<&LocalFileUploadFacts>,
    ) -> R<LocalFileRequestView> {
        if !finish.error_valid() {
            return Err(ResourceError::Invalid);
        }
        let mut tx = self
            .local_files_scope(credential, owner, conversation, true, BROWSER_KINDS)
            .await?;
        let id = conversation.to_string();
        let now = now_ms();
        settle(&mut tx, &id, now).await?;
        let row = one(&mut tx, &id, request).await?;
        let tab = finish.connection_id.to_string();
        let held = row.get::<Option<&str>, _>("connection_id") == Some(tab.as_str());
        let retried = match finish.outcome {
            LocalFileOutcome::Done => row.get::<&str, _>("state") == "done",
            LocalFileOutcome::Failed => {
                row.get::<&str, _>("state") == "failed"
                    && row.get::<Option<String>, _>("error") == finish.error
            }
        };
        match row.get::<&str, _>("state") {
            "working" if held => {}
            // A retried result after a lost answer returns what was recorded.
            "done" | "failed" if held && retried => {
                let value = view(&row)?;
                tx.commit().await.map_err(unavailable)?;
                return Ok(value);
            }
            "done" | "failed" => {
                tx.commit().await.map_err(unavailable)?;
                return Err(ResourceError::Conflict("local_file_request_finished"));
            }
            _ => return Err(ResourceError::Conflict("local_file_request_not_held")),
        }
        let (state, error, result) = match finish.outcome {
            LocalFileOutcome::Failed => ("failed", finish.error.clone(), None),
            LocalFileOutcome::Done => ("done", None, Some(result_json(&row, finish, upload)?)),
        };
        sqlx::query("UPDATE local_file_requests SET state=?,error=?,result_json=?,finished_ms=?,content=NULL WHERE id=?")
            .bind(state).bind(error).bind(result).bind(now).bind(request.to_string())
            .execute(&mut *tx).await.map_err(unavailable)?;
        let value = view(&one(&mut tx, &id, request).await?)?;
        tx.commit().await.map_err(unavailable)?;
        Ok(value)
    }

    /// The owner disconnected the folder in this tab: its unfinished
    /// requests fail as `local_files_disconnected`. Another tab's connection
    /// is left alone.
    pub async fn disconnect_local_files(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        disconnect: &LocalFileDisconnect,
    ) -> R<()> {
        let mut tx = self
            .local_files_scope(credential, owner, conversation, true, BROWSER_KINDS)
            .await?;
        let id = conversation.to_string();
        let now = now_ms();
        settle(&mut tx, &id, now).await?;
        if let Some((current, _)) = connection(&mut tx, &id, now).await? {
            if current == disconnect.connection_id {
                fail_open(&mut tx, &id, "local_files_disconnected", now).await?;
                sqlx::query("DELETE FROM local_file_connections WHERE conversation_id=?")
                    .bind(&id)
                    .execute(&mut *tx)
                    .await
                    .map_err(unavailable)?;
            }
        }
        tx.commit().await.map_err(unavailable)?;
        Ok(())
    }

    /// Grant state, connection and the newest requests (the owner's log).
    pub async fn local_files_overview(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        limit: u16,
    ) -> R<LocalFilesOverview> {
        let mut tx = self
            .local_files_scope(credential, owner, conversation, true, BROWSER_KINDS)
            .await?;
        let id = conversation.to_string();
        let now = now_ms();
        settle(&mut tx, &id, now).await?;
        let grant = grant::grant_state(&mut tx, conversation).await?;
        let connection = sqlx::query("SELECT folder_name,connected_ms,seen_ms FROM local_file_connections WHERE conversation_id=?")
            .bind(&id).fetch_optional(&mut *tx).await.map_err(unavailable)?
            .map(|r| LocalFileConnection {
                folder_name: r.get("folder_name"),
                connected_ms: r.get("connected_ms"),
                seen_ms: r.get("seen_ms"),
                live: r.get::<i64, _>("seen_ms") > now - LOCAL_FILE_CONNECTION_TTL_MS,
            });
        let rows = sqlx::query("SELECT * FROM local_file_requests WHERE conversation_id=? ORDER BY created_ms DESC,rowid DESC LIMIT ?")
            .bind(&id).bind(i64::from(limit.clamp(1, 100)))
            .fetch_all(&mut *tx).await.map_err(unavailable)?;
        let requests = rows.iter().map(view).collect::<R<Vec<_>>>()?;
        tx.commit().await.map_err(unavailable)?;
        Ok(LocalFilesOverview {
            grant,
            connection,
            requests,
        })
    }
}
