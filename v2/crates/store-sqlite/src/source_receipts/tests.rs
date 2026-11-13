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
            None,
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

#[path = "completed_source_tests.rs"]
mod completed_source_tests;

#[path = "continuation_dispatch_tests.rs"]
mod continuation_dispatch;

#[path = "superseded_source_tests.rs"]
mod superseded_source;

#[path = "continuation_group_tests.rs"]
mod continuation_groups;

// ORK-792: a run cut by a Root-recorded release interruption gets exactly one
// continuation. Stop cancelled the run and released its binding to `ready`
// one generation ahead (the state the live cut runs showed on 2026-11-11).
async fn release_cut(f: &Case, source: &ProviderAdmission, binding_state: &str) {
    sqlx::query("UPDATE production_runs SET state='cancelled' WHERE id=?")
        .bind(source.run.run_id.to_string())
        .execute(&f.store.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE session_bindings SET state=?, generation=generation+1 WHERE id=?")
        .bind(binding_state)
        .bind(source.run.session_id.to_string())
        .execute(&f.store.pool)
        .await
        .unwrap();
}
fn grant(run: &RunId, provider_generation: i64) -> crate::ReleasedContinuation {
    crate::ReleasedContinuation {
        source_run_id: run.clone(),
        provider_generation,
    }
}
async fn admit_released(
    f: &Case,
    message: &MessageInput,
    query: &SourceReceiptQuery,
    released: Option<&crate::ReleasedContinuation>,
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
            released,
        )
        .await
}

#[tokio::test]
async fn release_record_allows_exactly_one_continuation_of_the_cut_run() {
    let (f, source, message, query) = fixture().await;
    release_cut(&f, &source, "ready").await;
    // No record: today's refusal.
    assert!(matches!(
        admit(&f, &message, &query).await,
        Err(StoreError::ProviderGenerationMismatch)
    ));
    let recorded = grant(&source.run.run_id, 0);
    let first = admit_released(&f, &message, &query, Some(&recorded))
        .await
        .unwrap();
    assert!(!first.duplicate);
    let fences: i64 =
        sqlx::query_scalar("SELECT count(*) FROM source_admission_fences WHERE source_run_id=?")
            .bind(source.run.run_id.to_string())
            .fetch_one(&f.store.pool)
            .await
            .unwrap();
    assert_eq!(fences, 1);
    // The exact replay is the same input, not a second continuation.
    assert!(
        admit_released(&f, &message, &query, Some(&recorded))
            .await
            .unwrap()
            .duplicate
    );
    // A second continuation of the same cut run is refused: the first consumed it.
    let second = MessageInput {
        client_message_id: "release-continuation-second".into(),
        text: "Synthetic second continuation".into(),
    };
    assert!(matches!(
        admit_released(&f, &second, &query, Some(&recorded)).await,
        Err(StoreError::ProviderGenerationMismatch)
    ));
    close(f).await;
}

#[tokio::test]
async fn release_record_must_name_the_exact_run_and_provider_generation() {
    let (f, source, message, query) = fixture().await;
    release_cut(&f, &source, "ready").await;
    let other = grant(&RunId(Uuid::new_v4()), 0);
    assert!(matches!(
        admit_released(&f, &message, &query, Some(&other)).await,
        Err(StoreError::ProviderGenerationMismatch)
    ));
    let generation = grant(&source.run.run_id, 1);
    assert!(admit_released(&f, &message, &query, Some(&generation))
        .await
        .is_err());
    close(f).await;
}

#[tokio::test]
async fn release_record_is_refused_after_a_later_turn_used_the_session() {
    let (f, source, message, query) = fixture().await;
    // A later turn took the native session one generation ahead.
    release_cut(&f, &source, "busy").await;
    assert!(matches!(
        admit_released(&f, &message, &query, Some(&grant(&source.run.run_id, 0))).await,
        Err(StoreError::ProviderGenerationMismatch)
    ));
    close(f).await;
}

#[tokio::test]
async fn release_record_never_applies_to_a_run_that_was_not_cut() {
    let (f, source, message, query) = fixture().await;
    sqlx::query("UPDATE session_bindings SET state='ready', generation=generation+1 WHERE id=?")
        .bind(source.run.session_id.to_string())
        .execute(&f.store.pool)
        .await
        .unwrap();
    assert!(matches!(
        admit_released(&f, &message, &query, Some(&grant(&source.run.run_id, 0))).await,
        Err(StoreError::ProviderGenerationMismatch)
    ));
    close(f).await;
}

// A real release cut: the train's Stop request, then the provider's stopped
// observation, which cancels the run, records its terminal evidence and
// releases the binding to `ready` one generation ahead in one transaction.
async fn stopped_for_release(f: &Case, source: &ProviderAdmission) {
    f.handle
        .append_provider_event(&f.owner, source, &input(source, 1, ProviderEvent::Started))
        .await
        .unwrap();
    let cancel = f
        .handle
        .request_cancel(&f.owner, &source.run.run_id, "release-cut")
        .await
        .unwrap();
    let mut control = source.clone();
    control.run = cancel.new_fenced_admission;
    f.handle
        .append_provider_event(
            &f.owner,
            &control,
            &input(&control, 2, ProviderEvent::Stopped),
        )
        .await
        .unwrap();
}

// 2026-11-13: two force-cut chats had host-tool results admitted (fenced to the
// running Deep run) shortly before the cut. Those fences consumed the release
// continuation, so the adapter's continuation got 409 and the chats stayed
// silent. A fence admitted while the run was live is an ordinary continuation
// of that run: it neither consumes nor dispatches through the release grant.
#[tokio::test]
async fn release_continuation_ignores_results_admitted_before_the_cut() {
    let (f, source, message, query) = fixture().await;
    let host = MessageInput {
        client_message_id: "automatic-host-result-synthetic".into(),
        text: "Synthetic host tool result".into(),
    };
    let live = admit(&f, &host, &query).await.unwrap();
    stopped_for_release(&f, &source).await;
    let terminal: i64 =
        sqlx::query_scalar("SELECT count(*) FROM production_terminal_evidence WHERE run_id=?")
            .bind(source.run.run_id.to_string())
            .fetch_one(&f.store.pool)
            .await
            .unwrap();
    assert_eq!(terminal, 1);
    // No record: still today's refusal.
    assert!(matches!(
        admit(&f, &message, &query).await,
        Err(StoreError::ProviderGenerationMismatch)
    ));
    // The pre-cut result never dispatches through the release grant.
    let mut tx = f.store.pool.begin().await.unwrap();
    assert!(matches!(
        crate::source_continuation::validate(
            &mut tx,
            &f.owner,
            &f.conversation,
            &live.receipt.message_id
        )
        .await,
        Err(StoreError::ProviderGenerationMismatch)
    ));
    drop(tx);
    let recorded = grant(&source.run.run_id, 0);
    let released = admit_released(&f, &message, &query, Some(&recorded))
        .await
        .unwrap();
    assert!(!released.duplicate);
    // Still exactly one continuation after the cut.
    let second = MessageInput {
        client_message_id: "release-continuation-second".into(),
        text: "Synthetic second continuation".into(),
    };
    assert!(matches!(
        admit_released(&f, &second, &query, Some(&recorded)).await,
        Err(StoreError::ProviderGenerationMismatch)
    ));
    let mut tx = f.store.pool.begin().await.unwrap();
    crate::source_continuation::validate(
        &mut tx,
        &f.owner,
        &f.conversation,
        &released.receipt.message_id,
    )
    .await
    .unwrap();
    assert!(matches!(
        crate::source_continuation::validate(
            &mut tx,
            &f.owner,
            &f.conversation,
            &live.receipt.message_id
        )
        .await,
        Err(StoreError::ProviderGenerationMismatch)
    ));
    drop(tx);
    close(f).await;
}
