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
use orkestr_v2_contracts::{MessageId, Receipt, SourceContextQuery};

/// The source-run lookup the broker makes before every handback.
async fn eligible(f: &Case, source: &ProviderAdmission) -> bool {
    let message: String = sqlx::query_scalar("SELECT message_id FROM production_runs WHERE id=?")
        .bind(source.run.run_id.to_string())
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    f.store
        .source_context(
            &f.token,
            &f.owner,
            &f.conversation,
            &SourceContextQuery {
                source_run_id: source.run.run_id.clone(),
                source_message_id: MessageId(Uuid::parse_str(&message).unwrap()),
            },
        )
        .await
        .unwrap()
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
