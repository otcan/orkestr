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
impl IntakeStore for Store {
    async fn admit(
        &self,
        owner: &OwnerId,
        conversation: &ConversationId,
        input: &MessageInput,
    ) -> Result<Admission> {
        orkestr_v2_domain::message(&input.client_message_id, &input.text)
            .map_err(|_| StoreError::Invalid)?;
        // Acquire the write reservation before reading: concurrent replays cannot race a deferred upgrade.
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
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
        let sequence: i64 = sqlx::query_scalar("UPDATE conversations SET sequence=sequence+1 WHERE id=? AND owner_id=? RETURNING sequence")
            .bind(conversation.to_string()).bind(owner.to_string()).fetch_one(&mut *tx).await.map_err(db)?;
        let message_id = MessageId(Uuid::new_v4());
        let event_id = EventId(Uuid::new_v4());
        sqlx::query("INSERT INTO messages(id,owner_id,conversation_id,request_key,payload_digest,text,actor_kind,sequence) VALUES (?,?,?,?,?,?,'owner',?)")
            .bind(message_id.to_string()).bind(owner.to_string()).bind(conversation.to_string()).bind(&input.client_message_id).bind(hash).bind(&input.text).bind(sequence).execute(&mut *tx).await.map_err(db)?;
        sqlx::query("INSERT INTO events(id,owner_id,conversation_id,message_id,sequence) VALUES (?,?,?,?,?)")
            .bind(event_id.to_string()).bind(owner.to_string()).bind(conversation.to_string()).bind(message_id.to_string()).bind(sequence).execute(&mut *tx).await.map_err(db)?;
        sqlx::query("INSERT INTO reasoning_inbox(conversation_id,sequence,message_id,event_id) VALUES (?,?,?,?)")
            .bind(conversation.to_string()).bind(sequence).bind(message_id.to_string()).bind(event_id.to_string()).execute(&mut *tx).await.map_err(db)?;
        sqlx::query("INSERT INTO outbox(event_id) VALUES (?)")
            .bind(event_id.to_string())
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        tx.commit().await.map_err(db)?;
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
        let mut rows = sqlx::query("SELECT id,sequence,actor_kind,text FROM messages WHERE conversation_id=? AND owner_id=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?")
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
    ) -> Result<Vec<EventEnvelope>> {
        let (scope, last) = self.scope(owner, conversation).await?;
        if after < 0 || after > last {
            return Err(StoreError::Invalid);
        }
        let rows = sqlx::query("SELECT id,message_id,sequence,occurred_at FROM events WHERE conversation_id=? AND owner_id=? AND sequence>? ORDER BY sequence LIMIT ?")
            .bind(conversation.to_string()).bind(owner.to_string()).bind(after).bind(limit.clamp(1,100)).fetch_all(&self.pool).await.map_err(db)?;
        rows.iter()
            .map(|r| {
                let message_id = MessageId(parse(r.get("message_id"))?);
                let sequence = r.get("sequence");
                Ok(EventEnvelope {
                    event_id: EventId(parse(r.get("id"))?),
                    schema_version: 1,
                    owner_id: owner.clone(),
                    scope: scope.clone(),
                    aggregate_id: conversation.clone(),
                    aggregate_version: sequence,
                    sequence,
                    correlation_id: message_id.clone(),
                    causation_id: message_id.clone(),
                    actor_kind: "owner".into(),
                    source: "http".into(),
                    occurred_at: r.get("occurred_at"),
                    payload_ref_or_safe_payload: MessageAccepted {
                        kind: "message_accepted".into(),
                        message_id,
                    },
                })
            })
            .collect()
    }
}
