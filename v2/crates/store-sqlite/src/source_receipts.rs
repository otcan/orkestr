//! Authenticated read-only evidence. Never admits, resumes, accepts or replays.
use super::*;
use sqlx::SqliteConnection;

pub(super) fn provider(value: &str) -> Result<ConversationProvider> {
    match value {
        "codex" => Ok(ConversationProvider::Codex),
        "claude" => Ok(ConversationProvider::Claude),
        _ => Err(StoreError::Invalid),
    }
}
impl Store {
    pub async fn source_receipt(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        query: &SourceReceiptQuery,
    ) -> Result<SourceReceiptProjection> {
        if orkestr_v2_domain::request_key(&query.client_message_id).is_err()
            || query.client_message_id.is_empty()
            || query.client_message_id.len() > 128
            || query.text_sha256.len() != 64
            || !query
                .text_sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || query.expected_provider_generation < 0
            || query.continuation_source_run_id.0.is_nil()
            || query.source_native_session_id.is_empty()
            || query.source_native_session_id.len() > 4096
        {
            return Err(StoreError::Invalid);
        }
        let mut tx = self.pool.begin().await.map_err(db)?;
        let authenticated: i64 = sqlx::query_scalar("SELECT count(*) FROM auth_sessions WHERE token_hash=? AND owner_id=? AND expires_at>unixepoch()")
            .bind(digest(credential)).bind(owner.to_string()).fetch_one(&mut *tx).await.map_err(db)?;
        if authenticated != 1 {
            return Err(StoreError::NotFound);
        }
        let owned: i64 =
            sqlx::query_scalar("SELECT count(*) FROM conversations WHERE id=? AND owner_id=?")
                .bind(conversation.to_string())
                .bind(owner.to_string())
                .fetch_one(&mut *tx)
                .await
                .map_err(db)?;
        if owned != 1 {
            return Err(StoreError::NotFound);
        }
        let mut out = SourceReceiptProjection {
            schema_version: 1,
            owner_id: owner.clone(),
            conversation_id: conversation.clone(),
            admission_state: "missing".into(),
            admission: None,
            input_state: None,
            run: None,
            business_state: "unverified".into(),
            work_completed: false,
        };
        let row = sqlx::query("SELECT m.id,m.payload_digest,m.sequence,e.id AS event_id,f.expected_provider_generation,f.source_run_id,f.source_native_session_id,f.source_provider,f.source_binding_generation,a.author,s.session_kind,s.service_credential_id FROM messages m JOIN events e ON e.message_id=m.id AND e.owner_id=m.owner_id AND e.conversation_id=m.conversation_id AND e.kind='message_accepted' LEFT JOIN source_admission_fences f ON f.message_id=m.id LEFT JOIN message_authors a ON a.message_id=m.id LEFT JOIN message_request_sources s ON s.message_id=m.id AND s.owner_id=m.owner_id WHERE m.owner_id=? AND m.conversation_id=? AND m.request_key=?")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(&query.client_message_id)
            .fetch_optional(&mut *tx).await.map_err(db)?;
        let Some(row) = row else {
            return Ok(out);
        };
        if row.get::<String, _>("payload_digest") != query.text_sha256 {
            return Err(StoreError::Conflict);
        }
        let source: Option<String> = row.get("source_run_id");
        let author: Option<String> = row.get("author");
        let authentication: Option<String> = row.get("session_kind");
        if source.is_none() || author.is_none() || authentication.is_none() {
            out.admission_state = "legacy_unproven".into();
            return Ok(out);
        }
        let native: String = row.get("source_native_session_id");
        let source_provider = provider(row.get("source_provider"))?;
        let generation: i64 = row.get("expected_provider_generation");
        if source.as_deref() != Some(query.continuation_source_run_id.to_string().as_str())
            || native != query.source_native_session_id
            || source_provider != query.source_provider
            || generation != query.expected_provider_generation
            || author.as_deref() != Some(query.author.as_str())
        {
            return Err(StoreError::Conflict);
        }
        let message: String = row.get("id");
        let event: String = row.get("event_id");
        out.admission_state = "admitted".into();
        out.admission = Some(SourceAdmissionProof {
            message_id: MessageId(parse(message.clone())?),
            event_id: EventId(parse(event.clone())?),
            sequence: row.get("sequence"),
            client_message_id: query.client_message_id.clone(),
            text_sha256: query.text_sha256.clone(),
            expected_provider_generation: generation,
            continuation_source_run_id: query.continuation_source_run_id.clone(),
            source_native_session_id: native,
            source_provider,
            source_binding_generation: row.get("source_binding_generation"),
            author: query.author,
            authentication_kind: authentication.unwrap(),
            service_credential_id: row.get("service_credential_id"),
        });
        let input = sqlx::query("SELECT state,admitted_run_id FROM reasoning_inbox WHERE conversation_id=? AND message_id=? AND event_id=?")
            .bind(conversation.to_string()).bind(&message).bind(&event).fetch_optional(&mut *tx).await.map_err(db)?;
        if let Some(input) = input {
            out.input_state = Some(input.get("state"));
            let run: Option<String> = input.get("admitted_run_id");
            if out.input_state.as_deref() == Some("consumed") {
                if let Some(run) = run {
                    out.run =
                        run_proof(&mut tx, owner, conversation, &message, &event, &run).await?;
                }
            }
        }
        tx.commit().await.map_err(db)?;
        Ok(out)
    }
}

async fn run_proof(
    tx: &mut SqliteConnection,
    owner: &OwnerId,
    conversation: &ConversationId,
    message: &str,
    event: &str,
    run: &str,
) -> Result<Option<SourceRunProof>> {
    let row = sqlx::query("SELECT r.id,r.native_session_id,r.provider_kind,r.binding_generation,r.state,r.dispatch_state,r.message_id,r.event_id FROM production_runs r WHERE r.id=? AND r.owner_id=? AND r.conversation_id=? AND r.role='deep'")
        .bind(run).bind(owner.to_string()).bind(conversation.to_string()).fetch_optional(&mut *tx).await.map_err(db)?;
    let Some(row) = row else {
        return Ok(None);
    };
    let exact =
        row.get::<String, _>("message_id") == message && row.get::<String, _>("event_id") == event;
    let mut proof = SourceRunProof {
        run_id: RunId(parse(run.to_owned())?),
        native_session_id: row.get("native_session_id"),
        provider: provider(row.get("provider_kind"))?,
        binding_generation: row.get("binding_generation"),
        state: row.get("state"),
        dispatch_state: row.get("dispatch_state"),
        input_relation: if exact {
            "exact_input"
        } else {
            "core_grouped_input"
        }
        .into(),
        completion_event_id: None,
        acceptance_event_id: None,
        payload_id: None,
        payload_sha256: None,
        payload_text: None,
    };
    // Core's actual completion and its last canonical preceding progress payload.
    // An acceptance binds that exact completion, never a model-provided ID.
    let result = sqlx::query("SELECT o.event_id,a.event_id AS acceptance_event_id,(SELECT p.id FROM production_payloads p JOIN production_observations progress ON progress.event_id=p.event_id AND progress.run_id=o.run_id AND progress.kind='progress' WHERE p.run_id=o.run_id AND p.owner_id=? AND p.conversation_id=? AND progress.run_sequence<o.run_sequence ORDER BY progress.run_sequence DESC LIMIT 1) AS payload_id FROM production_observations o LEFT JOIN production_acceptances a ON a.run_id=o.run_id AND a.completion_event_id=o.event_id AND a.owner_id=? AND a.conversation_id=? WHERE o.run_id=? AND o.kind='completed_proposal' ORDER BY o.run_sequence DESC LIMIT 1")
        .bind(owner.to_string()).bind(conversation.to_string()).bind(owner.to_string()).bind(conversation.to_string())
        .bind(run).fetch_optional(&mut *tx).await.map_err(db)?;
    if let Some(result) = result {
        proof.completion_event_id = Some(EventId(parse(result.get("event_id"))?));
        proof.acceptance_event_id = result
            .get::<Option<String>, _>("acceptance_event_id")
            .map(|id| parse(id).map(EventId))
            .transpose()?;
        proof.payload_id = result.get("payload_id");
        if let Some(id) = &proof.payload_id {
            let text: Option<String> = sqlx::query_scalar("SELECT text FROM production_payloads WHERE id=? AND run_id=? AND owner_id=? AND conversation_id=?")
                .bind(id).bind(run).bind(owner.to_string()).bind(conversation.to_string()).fetch_optional(tx).await.map_err(db)?.flatten();
            proof.payload_sha256 = text.as_deref().map(digest);
            proof.payload_text = text;
        }
    }
    Ok(Some(proof))
}
