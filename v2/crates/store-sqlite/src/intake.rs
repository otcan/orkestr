use super::*;
use orkestr_v2_application::{Admission, IntakeStore, ProjectAdmission};

fn project(r: &sqlx::sqlite::SqliteRow) -> Result<Project> {
    Ok(Project {
        project_id: ProjectId(parse(r.get("id"))?),
        conversation_id: ConversationId(parse(r.get("conversation_id"))?),
        name: r.get("name"),
        resources: ResourceReadiness {
            local_git: "not_provisioned".into(),
            local_oxrm: "unverified".into(),
        },
    })
}
impl Store {
    async fn scope(&self, owner: &OwnerId, conversation: &ConversationId) -> Result<(Scope, i64)> {
        let row =
            sqlx::query("SELECT project_id,sequence FROM conversations WHERE id=? AND owner_id=?")
                .bind(conversation.to_string())
                .bind(owner.to_string())
                .fetch_optional(&self.pool)
                .await
                .map_err(db)?
                .ok_or(StoreError::NotFound)?;
        let project: Option<String> = row.get(0);
        Ok((
            match project {
                Some(p) => Scope::Project {
                    project_id: ProjectId(parse(p)?),
                },
                None => Scope::Global,
            },
            row.get(1),
        ))
    }
}
impl Store {
    /// Admit an input and, in the same transaction, keep the message it quoted.
    pub async fn admit_with_reply_to(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
        input: &MessageInput,
        reply_to: Option<&ReplyTo>,
    ) -> Result<Admission> {
        if reply_to.is_some_and(|r| !r.valid()) {
            return Err(StoreError::Invalid);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let admission = admit_in_transaction(&mut tx, owner, conversation, input).await?;
        if let Some(reply_to) = reply_to {
            // First writer wins; a retry of the same input never rewrites it.
            sqlx::query("INSERT OR IGNORE INTO message_reply_to(message_id,reply_to) VALUES (?,?)")
                .bind(admission.receipt.message_id.to_string())
                .bind(serde_json::to_string(reply_to).map_err(|_| StoreError::Invalid)?)
                .execute(&mut *tx)
                .await
                .map_err(db)?;
        }
        tx.commit().await.map_err(db)?;
        Ok(admission)
    }
}
impl IntakeStore for Store {
    async fn admit(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
        input: &MessageInput,
    ) -> Result<Admission> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let admission = admit_in_transaction(&mut tx, owner, conversation, input).await?;
        tx.commit().await.map_err(db)?;
        Ok(admission)
    }
    async fn create_project(
        &self,
        owner: &OwnerId,
        input: &ProjectInput,
    ) -> Result<ProjectAdmission> {
        orkestr_v2_domain::project(&input.client_request_id, &input.name)
            .map_err(|_| StoreError::Invalid)?;
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        if let Some(r) = sqlx::query("SELECT p.id,p.name,p.payload_digest,c.id AS conversation_id FROM projects p JOIN conversations c ON c.project_id=p.id WHERE p.owner_id=? AND p.request_key=?")
            .bind(owner.to_string()).bind(&input.client_request_id).fetch_optional(&mut *tx).await.map_err(db)? {
            if r.get::<String,_>("payload_digest") != digest(&input.name) { return Err(StoreError::Conflict); }
            return Ok(ProjectAdmission { project: project(&r)?, duplicate: true });
        }
        let id = ProjectId(Uuid::new_v4());
        let conversation_id = ConversationId(Uuid::new_v4());
        sqlx::query(
            "INSERT INTO projects(id,owner_id,request_key,payload_digest,name) VALUES (?,?,?,?,?)",
        )
        .bind(id.to_string())
        .bind(owner.to_string())
        .bind(&input.client_request_id)
        .bind(digest(&input.name))
        .bind(&input.name)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
        sqlx::query("INSERT INTO conversations(id,owner_id,project_id) VALUES (?,?,?)")
            .bind(conversation_id.to_string())
            .bind(owner.to_string())
            .bind(id.to_string())
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
        Ok(ProjectAdmission {
            duplicate: false,
            project: Project {
                project_id: id,
                conversation_id,
                name: input.name.clone(),
                resources: ResourceReadiness {
                    local_git: "not_provisioned".into(),
                    local_oxrm: "unverified".into(),
                },
            },
        })
    }
    async fn projects(&self, owner: &OwnerId, after: i64, limit: u32) -> Result<ProjectPage> {
        let limit = limit.clamp(1, 100);
        let mut rows = sqlx::query("SELECT p.id,p.name,p.row_sequence,c.id AS conversation_id FROM projects p JOIN conversations c ON c.project_id=p.id WHERE p.owner_id=? AND p.row_sequence>? ORDER BY p.row_sequence LIMIT ?")
            .bind(owner.to_string()).bind(after).bind(limit+1).fetch_all(&self.pool).await.map_err(db)?;
        let more = rows.len() > limit as usize;
        rows.truncate(limit as usize);
        Ok(ProjectPage {
            next_cursor: if more {
                rows.last().map(|r| r.get("row_sequence"))
            } else {
                None
            },
            projects: rows.iter().map(project).collect::<Result<_>>()?,
        })
    }
    async fn snapshot(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
        after: i64,
        limit: u32,
    ) -> Result<ConversationSnapshot> {
        // Snapshot watermark then bounded rows: concurrent later admissions are retrieved by SSE.
        let (scope, last_sequence) = self.scope(owner, conversation).await?;
        if after < 0 || after > last_sequence {
            return Err(StoreError::Invalid);
        }
        let limit = limit.clamp(1, 100);
        let mut rows = sqlx::query("SELECT m.id,m.sequence,m.actor_kind,m.text,m.request_key,r.reply_to FROM messages m LEFT JOIN message_reply_to r ON r.message_id=m.id WHERE m.conversation_id=? AND m.owner_id=? AND m.sequence>? AND m.sequence<=? ORDER BY m.sequence LIMIT ?")
            .bind(conversation.to_string()).bind(owner.to_string()).bind(after).bind(last_sequence).bind(limit+1).fetch_all(&self.pool).await.map_err(db)?;
        let more = rows.len() > limit as usize;
        rows.truncate(limit as usize);
        let messages = rows
            .iter()
            .map(|r| {
                Ok(Message {
                    message_id: MessageId(parse(r.get("id"))?),
                    sequence: r.get("sequence"),
                    actor_kind: r.get("actor_kind"),
                    text: r.get("text"),
                    reply_to: r
                        .get::<Option<String>, _>("reply_to")
                        .and_then(|json| serde_json::from_str(&json).ok()),
                    origin: orkestr_v2_contracts::message_origin(r.get("request_key")),
                })
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(ConversationSnapshot {
            conversation_id: conversation.clone(),
            scope,
            messages,
            next_cursor: if more {
                rows.last().map(|r| r.get("sequence"))
            } else {
                None
            },
            last_sequence,
        })
    }
    async fn events(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
        after: i64,
        limit: u32,
    ) -> Result<Vec<ConversationEvent>> {
        let (scope, last) = self.scope(owner, conversation).await?;
        if after < 0 || after > last {
            return Err(StoreError::Invalid);
        }
        crate::replay::events(&self.pool, owner, conversation, scope, after, limit).await
    }
}

pub(crate) async fn admit_in_transaction(
    tx: &mut sqlx::SqliteConnection,
    owner: &OwnerId,
    conversation: &ConversationId,
    input: &MessageInput,
) -> Result<Admission> {
    orkestr_v2_domain::message(&input.client_message_id, &input.text)
        .map_err(|_| StoreError::Invalid)?;
    let exists: i64 =
        sqlx::query_scalar("SELECT count(*) FROM conversations WHERE id=? AND owner_id=?")
            .bind(conversation.to_string())
            .bind(owner.to_string())
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
    if exists == 0 {
        return Err(StoreError::NotFound);
    }
    let hash = digest(&input.text);
    if let Some(r) = sqlx::query("SELECT m.id,m.payload_digest,m.sequence,e.id AS event_id FROM messages m JOIN events e ON e.message_id=m.id WHERE m.owner_id=? AND m.conversation_id=? AND m.request_key=?")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(&input.client_message_id).fetch_optional(&mut *tx).await.map_err(db)? {
            if r.get::<String,_>("payload_digest") != hash { return Err(StoreError::Conflict); }
            return Ok(Admission { duplicate: true, receipt: Receipt { message_id: MessageId(parse(r.get("id"))?), event_id: EventId(parse(r.get("event_id"))?), sequence: r.get("sequence"), status: AcceptanceStatus::Accepted } });
        }
    let sequence: i64 = sqlx::query_scalar(
        "UPDATE conversations SET sequence=sequence+1 WHERE id=? AND owner_id=? RETURNING sequence",
    )
    .bind(conversation.to_string())
    .bind(owner.to_string())
    .fetch_one(&mut *tx)
    .await
    .map_err(db)?;
    let message_id = MessageId(Uuid::new_v4());
    let event_id = EventId(Uuid::new_v4());
    sqlx::query("INSERT INTO messages(id,owner_id,conversation_id,request_key,payload_digest,text,actor_kind,sequence) VALUES (?,?,?,?,?,?,'owner',?)")
            .bind(message_id.to_string()).bind(owner.to_string()).bind(conversation.to_string()).bind(&input.client_message_id).bind(hash).bind(&input.text).bind(sequence).execute(&mut *tx).await.map_err(db)?;
    sqlx::query(
        "INSERT INTO events(id,owner_id,conversation_id,message_id,sequence) VALUES (?,?,?,?,?)",
    )
    .bind(event_id.to_string())
    .bind(owner.to_string())
    .bind(conversation.to_string())
    .bind(message_id.to_string())
    .bind(sequence)
    .execute(&mut *tx)
    .await
    .map_err(db)?;
    sqlx::query("INSERT INTO reasoning_inbox(conversation_id,sequence,message_id,event_id) VALUES (?,?,?,?)")
            .bind(conversation.to_string()).bind(sequence).bind(message_id.to_string()).bind(event_id.to_string()).execute(&mut *tx).await.map_err(db)?;
    sqlx::query("INSERT INTO outbox(event_id) VALUES (?)")
        .bind(event_id.to_string())
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    Ok(Admission {
        duplicate: false,
        receipt: Receipt {
            message_id,
            event_id,
            sequence,
            status: AcceptanceStatus::Accepted,
        },
    })
}

#[cfg(test)]
#[path = "reply_to_tests.rs"]
mod reply_to_tests;
