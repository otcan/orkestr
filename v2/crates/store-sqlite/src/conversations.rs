//! Owner-authenticated native thread directory; no supervisor/window is issued.
use crate::Store;
use orkestr_v2_application::runtime::RuntimeStoreError as Error;
use orkestr_v2_contracts::{
    ConversationId, ConversationInput, ConversationPage, ConversationSummary, ProjectId, Scope,
};
use sqlx::{sqlite::SqliteRow, Row, SqliteConnection};
use uuid::Uuid;

type Result<T> = std::result::Result<T, Error>;
fn db(_: impl std::fmt::Display) -> Error {
    Error::Unavailable
}

fn summary(row: &SqliteRow) -> Result<ConversationSummary> {
    let project: Option<String> = row.get("project_id");
    Ok(ConversationSummary {
        conversation_id: ConversationId(
            row.get::<String, _>("conversation_id")
                .parse()
                .map_err(db)?,
        ),
        name: row.get("name"),
        scope: match project {
            Some(id) => Scope::Project {
                project_id: ProjectId(id.parse().map_err(db)?),
            },
            None => Scope::Global,
        },
        last_sequence: row.get("sequence"),
    })
}

async fn owner(tx: &mut SqliteConnection, credential: &str) -> Result<String> {
    sqlx::query_scalar(
        "SELECT owner_id FROM auth_sessions WHERE token_hash=? AND expires_at>unixepoch()",
    )
    .bind(crate::digest(credential))
    .fetch_optional(tx)
    .await
    .map_err(db)?
    .ok_or(Error::Unauthorized)
}

impl Store {
    fn conversation_directory_authority(&self, credential: &str) -> Result<()> {
        if self.authority.is_some() || credential.is_empty() || credential.len() > 1024 {
            return Err(Error::Unauthorized);
        }
        Ok(())
    }

    pub async fn conversations_authenticated(
        &self,
        credential: &str,
        after: i64,
        limit: u32,
    ) -> Result<ConversationPage> {
        self.conversation_directory_authority(credential)?;
        if after < 0 || !(1..=100).contains(&limit) {
            return Err(Error::InvalidInput);
        }
        let mut tx = self.pool.begin().await.map_err(db)?;
        let owner = owner(&mut tx, credential).await?;
        let mut rows = sqlx::query("SELECT d.conversation_id,d.name,d.row_sequence,c.project_id,c.sequence FROM conversation_directory d JOIN conversations c ON c.id=d.conversation_id AND c.owner_id=d.owner_id WHERE d.owner_id=? AND d.row_sequence>? ORDER BY d.row_sequence LIMIT ?")
            .bind(owner).bind(after).bind(limit+1).fetch_all(&mut *tx).await.map_err(db)?;
        let more = rows.len() > limit as usize;
        rows.truncate(limit as usize);
        let next_cursor = if more {
            rows.last().map(|r| r.get("row_sequence"))
        } else {
            None
        };
        let conversations = rows.iter().map(summary).collect::<Result<_>>()?;
        tx.commit().await.map_err(db)?;
        Ok(ConversationPage {
            conversations,
            next_cursor,
        })
    }

    /// Returns whether an identical, previously committed creation was replayed.
    /// Authentication, idempotency and the new empty thread commit share one TX.
    pub async fn create_conversation_authenticated(
        &self,
        credential: &str,
        input: &ConversationInput,
    ) -> Result<(ConversationSummary, bool)> {
        self.conversation_directory_authority(credential)?;
        if !input.is_valid() {
            return Err(Error::InvalidInput);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let owner = owner(&mut tx, credential).await?;
        let digest = crate::digest(&input.name);
        if let Some(row) = sqlx::query("SELECT d.conversation_id,d.name,d.payload_digest,c.project_id,c.sequence FROM conversation_directory d JOIN conversations c ON c.id=d.conversation_id AND c.owner_id=d.owner_id WHERE d.owner_id=? AND d.request_key=?")
            .bind(&owner).bind(&input.client_request_id).fetch_optional(&mut *tx).await.map_err(db)? {
            if row.get::<String,_>("payload_digest") != digest { return Err(Error::Conflict); }
            let result = summary(&row)?;
            tx.commit().await.map_err(db)?;
            return Ok((result,true));
        }
        let id = ConversationId(Uuid::new_v4());
        sqlx::query("INSERT INTO conversations(id,owner_id,standalone) VALUES(?,?,1)")
            .bind(id.to_string())
            .bind(&owner)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        sqlx::query("UPDATE conversation_directory SET name=?,request_key=?,payload_digest=? WHERE conversation_id=? AND owner_id=?")
            .bind(input.name.trim()).bind(&input.client_request_id).bind(digest).bind(id.to_string()).bind(owner)
            .execute(&mut *tx).await.map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok((
            ConversationSummary {
                conversation_id: id,
                name: input.name.trim().into(),
                scope: Scope::Global,
                last_sequence: 0,
            },
            false,
        ))
    }
}

#[cfg(test)]
#[path = "conversations_tests.rs"]
mod tests;
