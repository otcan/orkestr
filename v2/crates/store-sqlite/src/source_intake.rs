//! Resolve the original consumed Root submission without modifying its lineage.
use super::*;
use crate::production_runtime::{ManagedCallerEvidence, ManagedOperationRequest};

impl Store {
    pub async fn root_intake(
        &self,
        credential: &str,
        owner: &OwnerId,
        conversation: &ConversationId,
        query: &RootIntakeQuery,
    ) -> Result<RootIntakeProof> {
        if query.operation_id.is_nil() {
            return Err(StoreError::Invalid);
        }
        let mut tx = self.pool.begin().await.map_err(db)?;
        let authenticated: i64 = sqlx::query_scalar("SELECT count(*) FROM auth_sessions WHERE token_hash=? AND owner_id=? AND expires_at>unixepoch()")
            .bind(digest(credential)).bind(owner.to_string()).fetch_one(&mut *tx).await.map_err(db)?;
        if authenticated != 1 {
            return Err(StoreError::NotFound);
        }
        let row = sqlx::query("SELECT o.request_json,o.evidence_sha256,o.state AS operation_state,o.created_at_ms,o.binding_generation,r.id AS run_id,r.session_id,r.message_id,r.event_id,r.provider_kind,r.native_session_id,m.text,m.payload_digest,a.author,s.session_kind,s.service_credential_id FROM managed_operations o JOIN production_runs r ON r.id=o.run_id AND r.owner_id=o.owner_id AND r.conversation_id=o.conversation_id AND r.session_id=o.session_id AND r.context_id=o.context_id AND r.incarnation_id=o.incarnation_id AND r.binding_generation=o.binding_generation AND r.role='deep' AND r.dispatch_state IN ('delivery_unknown','quarantined') JOIN messages m ON m.id=r.message_id AND m.owner_id=r.owner_id AND m.conversation_id=r.conversation_id JOIN events e ON e.id=r.event_id AND e.message_id=m.id AND e.owner_id=r.owner_id AND e.conversation_id=r.conversation_id AND e.kind='message_accepted' LEFT JOIN message_authors a ON a.message_id=m.id LEFT JOIN message_request_sources s ON s.message_id=m.id AND s.owner_id=m.owner_id WHERE o.id=? AND o.owner_id=? AND o.conversation_id=? AND o.operation='root_request_submit'")
            .bind(query.operation_id.to_string()).bind(owner.to_string()).bind(conversation.to_string())
            .fetch_optional(&mut *tx).await.map_err(db)?.ok_or(StoreError::NotFound)?;
        let envelope: serde_json::Value =
            serde_json::from_str(row.get("request_json")).map_err(db)?;
        let evidence = &envelope["evidence"];
        let source: ManagedCallerEvidence =
            serde_json::from_value(evidence["source"].clone()).map_err(db)?;
        let request: ManagedOperationRequest =
            serde_json::from_value(evidence["request"].clone()).map_err(db)?;
        let evidence_sha256: String = row.get("evidence_sha256");
        let encoded = serde_json::to_string(evidence).map_err(db)?;
        let binding_generation: i64 = row.get("binding_generation");
        if digest(&encoded) != evidence_sha256
            || source.owner_id != owner.to_string()
            || source.conversation_id != conversation.to_string()
            || source.run_id != row.get::<String, _>("run_id")
            || source.session_id != row.get::<String, _>("session_id")
            || source.provider != row.get::<String, _>("provider_kind")
            || source.generation == 0
            || u64::try_from(binding_generation)
                .ok()
                .is_none_or(|g| source.generation > g)
            || request.operation != "root_request_submit"
        {
            return Err(StoreError::Conflict);
        }
        let inputs = sqlx::query("SELECT i.message_id,i.event_id,i.sequence,m.request_key,m.text,m.payload_digest,a.author,s.session_kind,s.service_credential_id FROM reasoning_inbox i JOIN messages m ON m.id=i.message_id AND m.owner_id=? AND m.conversation_id=i.conversation_id JOIN events e ON e.id=i.event_id AND e.message_id=m.id AND e.owner_id=m.owner_id AND e.conversation_id=m.conversation_id AND e.kind='message_accepted' LEFT JOIN message_authors a ON a.message_id=m.id LEFT JOIN message_request_sources s ON s.message_id=m.id AND s.owner_id=m.owner_id WHERE i.conversation_id=? AND i.admitted_run_id=? AND i.state='consumed' ORDER BY i.sequence LIMIT 13")
            .bind(owner.to_string()).bind(conversation.to_string()).bind(source.run_id.clone())
            .fetch_all(&mut *tx).await.map_err(db)?;
        if inputs.is_empty()
            || inputs.len() > 12
            || !inputs.iter().any(|input| {
                input.get::<String, _>("message_id") == row.get::<String, _>("message_id")
                    && input.get::<String, _>("event_id") == row.get::<String, _>("event_id")
            })
        {
            return Err(StoreError::Conflict);
        }
        let consumed_inputs = inputs
            .iter()
            .map(|input| {
                let original_text: String = input.get("text");
                let original_text_sha256: String = input.get("payload_digest");
                if digest(&original_text) != original_text_sha256 {
                    return Err(StoreError::Conflict);
                }
                Ok(RootIntakeInput {
                    message_id: MessageId(parse(input.get("message_id"))?),
                    event_id: EventId(parse(input.get("event_id"))?),
                    sequence: input.get("sequence"),
                    client_message_id: input.get("request_key"),
                    authentication_kind: input.get("session_kind"),
                    service_credential_id: input.get("service_credential_id"),
                    author: input
                        .get::<Option<String>, _>("author")
                        .map(|v| serde_json::from_value(serde_json::Value::String(v)))
                        .transpose()
                        .map_err(db)?,
                    original_text,
                    original_text_sha256,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let proof = RootIntakeProof {
            schema_version: 1,
            operation_id: query.operation_id,
            owner_id: owner.clone(),
            conversation_id: conversation.clone(),
            source_run_id: RunId(parse(row.get("run_id"))?),
            source_message_id: MessageId(parse(row.get("message_id"))?),
            source_event_id: EventId(parse(row.get("event_id"))?),
            source_session_id: SessionId(parse(row.get("session_id"))?),
            source_provider: crate::source_receipts::provider(row.get("provider_kind"))?,
            source_native_session_id: row.get("native_session_id"),
            source_setup_generation: source.generation,
            source_resume_setup_id: source.resume_setup_id,
            binding_generation,
            evidence_sha256,
            operation_state: row.get("operation_state"),
            recorded_at_ms: row.get("created_at_ms"),
            agent_request: serde_json::from_value(request.arguments).map_err(db)?,
            consumed_inputs,
        };
        tx.commit().await.map_err(db)?;
        Ok(proof)
    }
}
