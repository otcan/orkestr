use super::{
    observation_tests::{consumed, input},
    tests::{setup_at, Case},
    *,
};
use crate::StoreError;
use orkestr_v2_contracts::{
    ConversationId, ConversationProvider, ExecutionAcceptanceRequest, InputAuthor, MessageInput,
    RunId, SourceReceiptQuery,
};

async fn fixture() -> (Case, ProviderAdmission, MessageInput, SourceReceiptQuery) {
    let root = std::env::temp_dir().join(format!("source-receipt-{}", Uuid::new_v4()));
    let f = setup_at(root).await;
    let source = consumed(&f).await;
    let message = MessageInput {
        client_message_id: "approval-handoff-synthetic".into(),
        text: "Synthetic agent-attributed scoped decision".into(),
    };
    let query = SourceReceiptQuery {
        client_message_id: message.client_message_id.clone(),
        text_sha256: crate::digest(&message.text),
        expected_provider_generation: 0,
        continuation_source_run_id: source.run.run_id.clone(),
        source_native_session_id: source.run.native_session_id.clone().unwrap(),
        source_provider: ConversationProvider::Codex,
        author: InputAuthor::V1Agent,
    };
    (f, source, message, query)
}
async fn close(f: Case) {
    f.store.close().await;
    std::fs::remove_dir_all(f.root).unwrap();
}
async fn admit(
    f: &Case,
    message: &MessageInput,
    query: &SourceReceiptQuery,
) -> crate::Result<orkestr_v2_application::Admission> {
    f.store
        .admit_authenticated_attributed(
            &f.token,
            &f.owner,
            &f.conversation,
            message,
            None,
            Some(query.expected_provider_generation),
            Some(&query.continuation_source_run_id),
            Some(query.author),
        )
        .await
}

#[tokio::test]
async fn source_receipt_is_readonly_scoped_and_binds_original_fresh_fences() {
    let (f, _, message, query) = fixture().await;
    let missing = f
        .store
        .source_receipt(&f.token, &f.owner, &f.conversation, &query)
        .await
        .unwrap();
    assert_eq!(missing.admission_state, "missing");
    assert!(!missing.work_completed);
    let accepted = admit(&f, &message, &query).await.unwrap();
    let proof = f
        .store
        .source_receipt(&f.token, &f.owner, &f.conversation, &query)
        .await
        .unwrap();
    assert_eq!(proof.admission_state, "admitted");
    let evidence = proof.admission.unwrap();
    assert_eq!(evidence.message_id, accepted.receipt.message_id);
    assert_eq!(evidence.event_id, accepted.receipt.event_id);
    assert_eq!(evidence.sequence, accepted.receipt.sequence);
    assert_eq!(evidence.authentication_kind, "machine");
    assert_eq!(evidence.author, InputAuthor::V1Agent);
    assert_eq!(proof.business_state, "unverified");
    assert!(proof.run.is_none());
    assert!(!proof.work_completed);
    let before = super::tests::snapshot(&f.store).await;
    for changed in [
        SourceReceiptQuery {
            text_sha256: "a".repeat(64),
            ..query.clone()
        },
        SourceReceiptQuery {
            expected_provider_generation: 1,
            ..query.clone()
        },
        SourceReceiptQuery {
            continuation_source_run_id: RunId(Uuid::new_v4()),
            ..query.clone()
        },
        SourceReceiptQuery {
            source_native_session_id: "foreign-native".into(),
            ..query.clone()
        },
        SourceReceiptQuery {
            source_provider: ConversationProvider::Claude,
            ..query.clone()
        },
        SourceReceiptQuery {
            author: InputAuthor::Owner,
            ..query.clone()
        },
    ] {
        assert!(matches!(
            f.store
                .source_receipt(&f.token, &f.owner, &f.conversation, &changed)
                .await,
            Err(StoreError::Conflict)
        ));
    }
    assert!(f
        .store
        .source_receipt("wrong-token", &f.owner, &f.conversation, &query)
        .await
        .is_err());
    assert!(f
        .store
        .source_receipt(&f.token, &OwnerId(Uuid::new_v4()), &f.conversation, &query)
        .await
        .is_err());
    assert!(f
        .store
        .source_receipt(&f.token, &f.owner, &ConversationId(Uuid::new_v4()), &query)
        .await
        .is_err());
    assert_eq!(before, super::tests::snapshot(&f.store).await);
    close(f).await;
}

#[tokio::test]
async fn source_receipt_replay_never_upgrades_legacy_or_changes_original_fences() {
    let (f, _, message, query) = fixture().await;
    f.store
        .admit_attributed(
            &f.owner,
            &f.conversation,
            &message,
            None,
            None,
            None,
            Some(InputAuthor::V1Agent),
        )
        .await
        .unwrap();
    assert!(admit(&f, &message, &query).await.unwrap().duplicate);
    assert_eq!(
        f.store
            .source_receipt(&f.token, &f.owner, &f.conversation, &query)
            .await
            .unwrap()
            .admission_state,
        "legacy_unproven"
    );
    let fresh = MessageInput {
        client_message_id: "fresh-continuation".into(),
        text: message.text.clone(),
    };
    let mut q = SourceReceiptQuery {
        client_message_id: fresh.client_message_id.clone(),
        ..query
    };
    admit(&f, &fresh, &q).await.unwrap();
    let original = q.clone();
    q.expected_provider_generation = 99;
    q.continuation_source_run_id = RunId(Uuid::new_v4());
    q.author = InputAuthor::Owner;
    assert!(admit(&f, &fresh, &q).await.unwrap().duplicate);
    assert!(f
        .store
        .source_receipt(&f.token, &f.owner, &f.conversation, &original)
        .await
        .unwrap()
        .admission
        .is_some());
    let immutable =
        sqlx::query("UPDATE source_admission_fences SET expected_provider_generation=7")
            .execute(&f.store.pool)
            .await;
    assert!(immutable.is_err());
    close(f).await;
}

#[tokio::test]
async fn source_receipt_generation_mismatch_rolls_back_message_provenance_and_fence() {
    let (f, _, message, mut query) = fixture().await;
    query.expected_provider_generation = 1;
    assert!(matches!(
        admit(&f, &message, &query).await,
        Err(StoreError::ProviderGenerationMismatch)
    ));
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM source_admission_fences")
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM messages WHERE request_key=?")
        .bind(&message.client_message_id)
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
    close(f).await;
}

#[tokio::test]
async fn source_context_requires_exact_original_input_and_current_native_binding() {
    let (f, source, message, receipt_query) = fixture().await;
    let original_message_id: String =
        sqlx::query_scalar("SELECT message_id FROM production_runs WHERE id=?")
            .bind(source.run.run_id.to_string())
            .fetch_one(&f.store.pool)
            .await
            .unwrap();
    let mut query = orkestr_v2_contracts::SourceContextQuery {
        source_run_id: source.run.run_id.clone(),
        source_message_id: orkestr_v2_contracts::MessageId(
            Uuid::parse_str(&original_message_id).unwrap(),
        ),
    };
    let proof = f
        .store
        .source_context(&f.token, &f.owner, &f.conversation, &query)
        .await
        .unwrap();
    assert_eq!(proof.owner_id, f.owner);
    assert_eq!(proof.source_provider, ConversationProvider::Codex);
    assert_eq!(proof.source_native_session_id, "synthetic-native-deep");
    assert!(proof.eligible_for_continuation);
    query.source_message_id = orkestr_v2_contracts::MessageId(Uuid::new_v4());
    assert!(f
        .store
        .source_context(&f.token, &f.owner, &f.conversation, &query)
        .await
        .is_err());
    query.source_message_id =
        orkestr_v2_contracts::MessageId(Uuid::parse_str(&original_message_id).unwrap());
    sqlx::query(
        "UPDATE session_bindings SET native_session_id='synthetic-changed-native' WHERE id=?",
    )
    .bind(source.run.session_id.to_string())
    .execute(&f.store.pool)
    .await
    .unwrap();
    assert!(
        !f.store
            .source_context(&f.token, &f.owner, &f.conversation, &query)
            .await
            .unwrap()
            .eligible_for_continuation
    );
    assert!(matches!(
        admit(&f, &message, &receipt_query).await,
        Err(StoreError::ProviderGenerationMismatch)
    ));
    close(f).await;
}

#[tokio::test]
async fn source_receipt_links_actual_continuation_run_and_accepted_report_not_business_success() {
    let (f, source, message, query) = fixture().await;
    let admitted = admit(&f, &message, &query).await.unwrap();
    // Finish the original source turn; its accepted output must not be mistaken
    // for a result of the newly admitted continuation.
    f.handle
        .append_provider_event(
            &f.owner,
            &source,
            &input(&source, 1, ProviderEvent::Started),
        )
        .await
        .unwrap();
    let done = f
        .handle
        .append_provider_event(
            &f.owner,
            &source,
            &input(
                &source,
                2,
                ProviderEvent::CompletedProposal { synthetic: false },
            ),
        )
        .await
        .unwrap();
    let revision = f
        .store
        .execution_status(&f.owner, &f.conversation)
        .await
        .unwrap()
        .unwrap()
        .revision;
    f.store
        .accept_execution(
            &f.owner,
            &f.conversation,
            &ExecutionAcceptanceRequest {
                run_id: source.run.run_id.clone(),
                completion_event_id: done.event_id,
                expected_revision: revision,
                request_key: "accept-original-source".into(),
            },
        )
        .await
        .unwrap();
    assert!(f
        .store
        .source_receipt(&f.token, &f.owner, &f.conversation, &query)
        .await
        .unwrap()
        .run
        .is_none());
    let binding = f
        .handle
        .ensure_role_bindings(&f.owner, &f.conversation)
        .await
        .unwrap()
        .deep;
    let claim = f
        .handle
        .claim_next(
            &f.owner,
            &f.conversation,
            &binding.session_id,
            std::time::Duration::from_secs(60),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claim.message_id, admitted.receipt.message_id);
    let admission = f
        .handle
        .admit_run(
            &claim,
            &binding.session_id,
            binding.generation,
            "continuation-run",
        )
        .await
        .unwrap();
    let DispatchClaimResult::Reserved(reservation) = f
        .handle
        .claim_provider_dispatch(&admission, "continuation-dispatch")
        .await
        .unwrap()
    else {
        panic!()
    };
    assert!(matches!(
        f.handle.consume_execution(&reservation).await.unwrap(),
        ExecutionConsumption::Dispatch(_)
    ));
    let run = admission.provider;
    f.handle
        .append_provider_event(&f.owner, &run, &input(&run, 1, ProviderEvent::Started))
        .await
        .unwrap();
    f.handle
        .append_provider_event(
            &f.owner,
            &run,
            &input(
                &run,
                2,
                ProviderEvent::Progress("Agent claims all business work succeeded".into()),
            ),
        )
        .await
        .unwrap();
    let done = f
        .handle
        .append_provider_event(
            &f.owner,
            &run,
            &input(
                &run,
                3,
                ProviderEvent::CompletedProposal { synthetic: false },
            ),
        )
        .await
        .unwrap();
    let p = f
        .store
        .source_receipt(&f.token, &f.owner, &f.conversation, &query)
        .await
        .unwrap();
    let observed = p.run.unwrap();
    assert_eq!(observed.run_id, run.run.run_id);
    assert_eq!(observed.completion_event_id, Some(done.event_id.clone()));
    assert!(observed.acceptance_event_id.is_none());
    let revision = f
        .store
        .execution_status(&f.owner, &f.conversation)
        .await
        .unwrap()
        .unwrap()
        .revision;
    let accepted = f
        .store
        .accept_execution(
            &f.owner,
            &f.conversation,
            &ExecutionAcceptanceRequest {
                run_id: run.run.run_id.clone(),
                completion_event_id: done.event_id,
                expected_revision: revision,
                request_key: "accept-continuation-proposal".into(),
            },
        )
        .await
        .unwrap();
    let p = f
        .store
        .source_receipt(&f.token, &f.owner, &f.conversation, &query)
        .await
        .unwrap();
    let report = p.run.unwrap();
    assert_eq!(
        report.acceptance_event_id,
        Some(accepted.acceptance_event_id)
    );
    assert_eq!(
        report.payload_text.as_deref(),
        Some("Agent claims all business work succeeded")
    );
    assert_eq!(p.business_state, "unverified");
    assert!(!p.work_completed);
    close(f).await;
}
