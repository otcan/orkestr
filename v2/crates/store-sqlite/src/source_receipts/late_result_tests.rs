//! ORK-843: a Deep turn files two host requests and ends. The first result
//! starts a follow-up turn fenced to that same source turn within seconds;
//! the second result then used to be refused as "moved on" (409) and its chat
//! never got it. A session that only continued the source turn has not moved
//! on: the late result is admitted, and runs as the next continuation. Any
//! other later turn, or a changed binding, still ends the continuations.
use super::continuation_groups::{
    accept, claim, count, hand_back, inbox, result, start, start_claimed,
};
use super::*;
use orkestr_v2_application::{runtime::RunAdmissionResult, IntakeStore};
use orkestr_v2_contracts::{
    ExecutionControlRequest, MessageId, Receipt, SourceContextProof, SourceContextQuery,
    SourceSuccessor,
};

/// The source-run lookup the broker makes before every handback.
async fn lookup(f: &Case, run: &RunId) -> SourceContextProof {
    let message: String = sqlx::query_scalar("SELECT message_id FROM production_runs WHERE id=?")
        .bind(run.to_string())
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    f.store
        .source_context(
            &f.token,
            &f.owner,
            &f.conversation,
            &SourceContextQuery {
                source_run_id: run.clone(),
                source_message_id: MessageId(Uuid::parse_str(&message).unwrap()),
            },
        )
        .await
        .unwrap()
}

async fn eligible(f: &Case, source: &ProviderAdmission) -> bool {
    lookup(f, &source.run.run_id)
        .await
        .eligible_for_continuation
}

/// A handback Core refuses as superseded, committing nothing.
async fn refused(f: &Case, query: &SourceReceiptQuery, input: &MessageInput) {
    let query = SourceReceiptQuery {
        client_message_id: input.client_message_id.clone(),
        text_sha256: crate::digest(&input.text),
        ..query.clone()
    };
    assert!(matches!(
        admit(f, input, &query).await,
        Err(StoreError::SourceSuperseded)
    ));
    assert_eq!(
        count(
            f,
            &format!(
                "SELECT count(*) FROM messages WHERE request_key='{}'",
                input.client_message_id
            )
        )
        .await,
        0
    );
}

/// An ordinary input without a source fence: the owner's message, or a timer
/// firing as the delivery adapter admits it (machine credential, agent
/// author, no continuation).
async fn unfenced(f: &Case, key: &str, timer: bool) -> Receipt {
    let input = MessageInput {
        client_message_id: key.into(),
        text: format!("Synthetic input {key}"),
    };
    if timer {
        f.store
            .admit_authenticated_attributed(
                &f.token,
                &f.owner,
                &f.conversation,
                &input,
                None,
                None,
                None,
                Some(InputAuthor::V1Agent),
                None,
            )
            .await
            .unwrap()
            .receipt
    } else {
        f.store
            .admit(&f.owner, &f.conversation, &input)
            .await
            .unwrap()
            .receipt
    }
}

async fn run_row(f: &Case, run: &ProviderAdmission) -> (String, i64) {
    sqlx::query_as("SELECT session_id,binding_generation FROM production_runs WHERE id=?")
        .bind(run.run.run_id.to_string())
        .fetch_one(&f.store.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn a_late_result_is_admitted_during_and_after_the_follow_up_and_runs_next() {
    let (f, source, _, query) = fixture().await;
    // The turn files two requests and ends; the first result comes back at once.
    let first = hand_back(&f, &query, &result(1)).await;
    accept(&f, &source, "accept-source").await;
    let (follow_up, _, head) = start(&f, "follow-up").await;
    assert_eq!(head, first.message_id);
    // The second result arrives while that follow-up turn runs (2026-11-16).
    assert!(eligible(&f, &source).await);
    let during = hand_back(&f, &query, &result(2)).await;
    accept(&f, &follow_up.provider, "accept-follow-up").await;
    // And a third after the follow-up was accepted.
    assert!(eligible(&f, &source).await);
    let after = hand_back(&f, &query, &result(3)).await;
    let (binding, claim) = claim(&f).await.unwrap();
    assert_eq!(claim.message_id, during.message_id);
    assert!(!f
        .handle
        .retire_superseded_source_claim(&claim)
        .await
        .unwrap());
    let (next, text, _) = start_claimed(&f, &binding, &claim, "next-continuation").await;
    assert!(text.starts_with("[Automatic results: 2 result(s) "));
    for receipt in [&during, &after] {
        assert_eq!(
            inbox(&f, receipt).await,
            (
                "consumed".into(),
                Some(next.provider.run.run_id.to_string()),
                None
            )
        );
    }
    // The follow-up's own follow-up: same session, the next generation.
    let (session, generation) = run_row(&f, &follow_up.provider).await;
    assert_eq!(run_row(&f, &next.provider).await, (session, generation + 1));
    assert_eq!(
        count(&f, "SELECT count(*) FROM owner_input_retirements").await,
        0
    );
    close(f).await;
}

#[tokio::test]
async fn a_turn_an_owner_or_timer_message_started_after_the_source_still_supersedes_it() {
    for timer in [false, true] {
        let (f, source, _, query) = fixture().await;
        accept(&f, &source, "accept-source").await;
        let next = unfenced(&f, "synthetic-next-input", timer).await;
        let (turn, _, head) = start(&f, "next-turn").await;
        assert_eq!(head, next.message_id);
        assert!(!eligible(&f, &source).await);
        refused(&f, &query, &result(1)).await;
        accept(&f, &turn.provider, "accept-next-turn").await;
        assert!(!eligible(&f, &source).await);
        refused(&f, &query, &result(2)).await;
        close(f).await;
    }
}

#[tokio::test]
async fn a_chain_an_unfenced_turn_joined_refuses() {
    let (f, source, _, query) = fixture().await;
    hand_back(&f, &query, &result(1)).await;
    accept(&f, &source, "accept-source").await;
    let (follow_up, _, _) = start(&f, "follow-up").await;
    accept(&f, &follow_up.provider, "accept-follow-up").await;
    assert!(eligible(&f, &source).await);
    // Then the owner writes: the session moved on for good.
    unfenced(&f, "owner-after-follow-up", false).await;
    let (owner_turn, _, _) = start(&f, "owner-turn").await;
    assert!(!eligible(&f, &source).await);
    refused(&f, &query, &result(2)).await;
    accept(&f, &owner_turn.provider, "accept-owner-turn").await;
    assert!(!eligible(&f, &source).await);
    refused(&f, &query, &result(3)).await;
    close(f).await;
}

#[tokio::test]
async fn a_continuation_of_the_follow_up_itself_ends_the_source_continuations() {
    let (f, source, _, query) = fixture().await;
    hand_back(&f, &query, &result(1)).await;
    accept(&f, &source, "accept-source").await;
    let (follow_up, _, _) = start(&f, "follow-up").await;
    // The follow-up files its own request; its result is fenced to the
    // follow-up, not to the source turn.
    let own = SourceReceiptQuery {
        continuation_source_run_id: follow_up.provider.run.run_id.clone(),
        ..query.clone()
    };
    let own_result = MessageInput {
        client_message_id: "automatic-host-result-synthetic-follow-up".into(),
        text: "Synthetic host result of the follow-up".into(),
    };
    let own_receipt = hand_back(&f, &own, &own_result).await;
    accept(&f, &follow_up.provider, "accept-follow-up").await;
    let (_, _, head) = start(&f, "follow-up-continuation").await;
    assert_eq!(head, own_receipt.message_id);
    assert!(!eligible(&f, &source).await);
    refused(&f, &query, &result(2)).await;
    close(f).await;
}

#[tokio::test]
async fn a_retired_reset_or_handed_off_binding_ends_the_continuations() {
    for change in ["retired", "native_reset", "provider_generation", "provider"] {
        let (f, source, _, query) = fixture().await;
        hand_back(&f, &query, &result(1)).await;
        accept(&f, &source, "accept-source").await;
        let (_follow_up, _, _) = start(&f, "follow-up").await;
        assert!(eligible(&f, &source).await);
        // Admitted while the source was current: dispatch must recheck it.
        let queued = hand_back(&f, &query, &result(2)).await;
        let mut query = query.clone();
        match change {
            "retired" => {
                sqlx::query("UPDATE session_bindings SET state='retired' WHERE id=?")
                    .bind(source.run.session_id.to_string())
                    .execute(&f.store.pool)
                    .await
                    .unwrap();
            }
            "native_reset" => {
                sqlx::query(
                    "UPDATE session_bindings SET native_session_id='synthetic-reset-native' WHERE id=?",
                )
                .bind(source.run.session_id.to_string())
                .execute(&f.store.pool)
                .await
                .unwrap();
            }
            _ => {
                let provider = if change == "provider" {
                    "claude"
                } else {
                    "codex"
                };
                sqlx::query("INSERT INTO conversation_settings(conversation_id,owner_id,revision,provider,honor_no_reply,provider_generation,updated_at_ms) VALUES(?,?,1,?,1,1,0)")
                    .bind(f.conversation.to_string()).bind(f.owner.to_string()).bind(provider)
                    .execute(&f.store.pool).await.unwrap();
                // The old generation is the provider check's own refusal.
                assert!(matches!(
                    admit(
                        &f,
                        &result(3),
                        &SourceReceiptQuery {
                            client_message_id: result(3).client_message_id,
                            text_sha256: crate::digest(&result(3).text),
                            ..query.clone()
                        }
                    )
                    .await,
                    Err(StoreError::ProviderGenerationMismatch)
                ));
                query.expected_provider_generation = 1;
            }
        }
        assert!(!eligible(&f, &source).await, "{change}");
        refused(&f, &query, &result(4)).await;
        let mut tx = f.store.pool.begin().await.unwrap();
        assert!(matches!(
            crate::source_continuation::validate(
                &mut tx,
                &f.owner,
                &f.conversation,
                &queued.message_id
            )
            .await,
            Err(StoreError::ProviderGenerationMismatch)
        ));
        drop(tx);
        close(f).await;
    }
}

/// A result whose source turn was superseded (an owner message or a timer
/// started a new turn) is not dropped: the lookup names the Deep run that
/// holds the conversation now, and a handback fenced to that run is admitted
/// and runs as its next continuation. The source fence itself stays strict.
#[tokio::test]
async fn a_superseded_source_names_its_current_successor_which_takes_the_result() {
    for timer in [false, true] {
        let (f, source, _, query) = fixture().await;
        accept(&f, &source, "accept-source").await;
        let current = lookup(&f, &source.run.run_id).await;
        assert!(current.eligible_for_continuation);
        assert_eq!(current.successor, None);
        let next = unfenced(&f, "synthetic-next-input", timer).await;
        let (turn, _, _) = start(&f, "next-turn").await;
        let proof = lookup(&f, &source.run.run_id).await;
        assert!(!proof.eligible_for_continuation);
        let expected = SourceSuccessor {
            run_id: turn.provider.run.run_id.clone(),
            message_id: next.message_id.clone(),
        };
        assert_eq!(proof.successor, Some(expected.clone()));
        let own = lookup(&f, &expected.run_id).await;
        assert!(own.eligible_for_continuation);
        assert_eq!(own.successor, None);
        refused(&f, &query, &result(1)).await;
        let to_successor = SourceReceiptQuery {
            continuation_source_run_id: expected.run_id.clone(),
            ..query.clone()
        };
        let delivered = hand_back(&f, &to_successor, &result(2)).await;
        accept(&f, &turn.provider, "accept-next-turn").await;
        assert_eq!(
            lookup(&f, &source.run.run_id).await.successor,
            Some(expected.clone())
        );
        let (binding, claim) = claim(&f).await.unwrap();
        assert_eq!(claim.message_id, delivered.message_id);
        assert!(!f
            .handle
            .retire_superseded_source_claim(&claim)
            .await
            .unwrap());
        let (continuation, _, _) =
            start_claimed(&f, &binding, &claim, "successor-continuation").await;
        assert_eq!(
            inbox(&f, &delivered).await,
            (
                "consumed".into(),
                Some(continuation.provider.run.run_id.to_string()),
                None
            )
        );
        close(f).await;
    }
}

/// A later run that is not current itself (its binding retired, reset or
/// handed off) is never named: the result stays undeliverable, as before.
#[tokio::test]
async fn a_successor_that_is_not_current_is_not_named() {
    let (f, source, _, _) = fixture().await;
    accept(&f, &source, "accept-source").await;
    unfenced(&f, "synthetic-next-input", false).await;
    let (turn, _, _) = start(&f, "next-turn").await;
    assert!(lookup(&f, &source.run.run_id).await.successor.is_some());
    sqlx::query("UPDATE session_bindings SET state='retired' WHERE id=?")
        .bind(turn.provider.run.session_id.to_string())
        .execute(&f.store.pool)
        .await
        .unwrap();
    let proof = lookup(&f, &source.run.run_id).await;
    assert!(!proof.eligible_for_continuation);
    assert_eq!(proof.successor, None);
    close(f).await;
}

/// Source accepted, then the owner's next message started `turn` on the same
/// session: the plain successor case the variants below change.
async fn superseded_by_a_turn(f: &Case, source: &ProviderAdmission) -> RunAdmissionResult {
    accept(f, source, "accept-source").await;
    unfenced(f, "synthetic-next-input", false).await;
    let (turn, _, _) = start(f, "next-turn").await;
    assert_eq!(
        lookup(f, &source.run.run_id)
            .await
            .successor
            .map(|s| s.run_id),
        Some(turn.provider.run.run_id.clone())
    );
    turn
}

async fn execute(f: &Case, sql: &str, run: &ProviderAdmission) {
    sqlx::query(sql)
        .bind(run.run.run_id.to_string())
        .execute(&f.store.pool)
        .await
        .unwrap();
}

/// Review M3: a read-only parallel slot run is never the successor, even one
/// that would itself be eligible.
#[tokio::test]
async fn a_parallel_slot_run_is_never_named() {
    let (f, source, _, _) = fixture().await;
    let turn = superseded_by_a_turn(&f, &source).await;
    execute(
        &f,
        "UPDATE production_runs SET deep_slot=1 WHERE id=?",
        &turn.provider,
    )
    .await;
    assert!(
        lookup(&f, &turn.provider.run.run_id)
            .await
            .eligible_for_continuation
    );
    assert_eq!(lookup(&f, &source.run.run_id).await.successor, None);
    close(f).await;
}

/// Review M4: the successor continues the source's own session. A turn on a
/// reset native session, or after a provider handoff, is current in its own
/// right but is not the source's successor.
#[tokio::test]
async fn a_reset_or_handed_off_session_names_no_successor() {
    for change in ["native_reset", "provider"] {
        let (f, source, _, _) = fixture().await;
        let turn = superseded_by_a_turn(&f, &source).await;
        let session = turn.provider.run.session_id.to_string();
        let (column, value) = if change == "native_reset" {
            ("native_session_id", "synthetic-reset-native")
        } else {
            sqlx::query("INSERT INTO conversation_settings(conversation_id,owner_id,revision,provider,honor_no_reply,provider_generation,updated_at_ms) VALUES(?,?,1,'claude',1,1,0)")
                .bind(f.conversation.to_string()).bind(f.owner.to_string())
                .execute(&f.store.pool).await.unwrap();
            ("provider_kind", "claude")
        };
        sqlx::query(&format!(
            "UPDATE session_bindings SET {column}=? WHERE id=?"
        ))
        .bind(value)
        .bind(&session)
        .execute(&f.store.pool)
        .await
        .unwrap();
        sqlx::query(&format!("UPDATE production_runs SET {column}=? WHERE id=?"))
            .bind(value)
            .bind(turn.provider.run.run_id.to_string())
            .execute(&f.store.pool)
            .await
            .unwrap();
        assert!(
            lookup(&f, &turn.provider.run.run_id)
                .await
                .eligible_for_continuation,
            "{change}"
        );
        let proof = lookup(&f, &source.run.run_id).await;
        assert!(!proof.eligible_for_continuation, "{change}");
        assert_eq!(proof.successor, None, "{change}");
        close(f).await;
    }
}

/// Stop `source` through the guarded Stop the HTTP route uses (the owner's
/// credential, his expected revisions and `key`), then observe it stopped.
async fn guarded_stop(f: &Case, source: &ProviderAdmission, key: &str) {
    f.handle
        .append_provider_event(&f.owner, source, &input(source, 1, ProviderEvent::Started))
        .await
        .unwrap();
    let status = f
        .store
        .execution_status(&f.owner, &f.conversation)
        .await
        .unwrap()
        .unwrap();
    let (_, cancel) = f
        .handle
        .stop_execution_control_authenticated(
            &f.token,
            &f.conversation,
            &ExecutionControlRequest {
                run_id: source.run.run_id.clone(),
                expected_revision: status.revision,
                expected_control_revision: status.control_revision,
                request_key: key.into(),
            },
        )
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

/// Review R1: only the owner's own Stop ends a source's successors. The
/// release train, an operator and Core itself stop through the same cut, and
/// the result of such a run still goes to the turn after it. Every Stop but
/// the internal one goes through the guarded path the HTTP route takes.
#[tokio::test]
async fn only_an_owner_stop_suppresses_the_successor() {
    for (key, origin) in [
        (
            Some("release-043be0906976-6f9619ff-8b86-4011-b42d-00c04fc964ff"),
            "release",
        ),
        (Some("forced-release-synthetic"), "release"),
        (Some("lead-stop-synthetic"), "operator"),
        (Some("synthetic-unknown-stop"), "other"),
        (None, "internal"),
        (Some("6f9619ff-8b86-4011-b42d-00c04fc964ff"), "owner"),
    ] {
        let (f, source, _, _) = fixture().await;
        match key {
            Some(key) => guarded_stop(&f, &source, key).await,
            None => stopped_for_release(&f, &source).await,
        }
        let recorded: String =
            sqlx::query_scalar("SELECT stop_origin FROM production_cancellations WHERE run_id=?")
                .bind(source.run.run_id.to_string())
                .fetch_one(&f.store.pool)
                .await
                .unwrap();
        assert_eq!(recorded, origin);
        unfenced(&f, "synthetic-next-input", false).await;
        let (turn, _, _) = start(&f, "next-turn").await;
        assert!(
            lookup(&f, &turn.provider.run.run_id)
                .await
                .eligible_for_continuation
        );
        let proof = lookup(&f, &source.run.run_id).await;
        assert!(!proof.eligible_for_continuation);
        let expected = if origin == "owner" {
            None
        } else {
            Some(turn.provider.run.run_id.clone())
        };
        assert_eq!(proof.successor.map(|s| s.run_id), expected, "{origin}");
        close(f).await;
    }
}
