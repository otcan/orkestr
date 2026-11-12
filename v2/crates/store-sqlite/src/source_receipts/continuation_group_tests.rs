//! ORK-733 / ORK-783: automatic results handed back to the Deep turn that
//! requested them. The turn could read each one while it ran, and Core has no
//! record of that, so after the turn is accepted its queued results get one
//! continuation turn together, which may stay silent (NO_REPLY). A result
//! that arrives after the turn ended gets that one turn too. A queued result
//! that can never run is retired with a receipt, never left queued.
use super::*;
use orkestr_v2_application::{
    runtime::{InboxClaim, RunAdmissionResult},
    IntakeStore,
};
use orkestr_v2_contracts::{ExecutionWindowRequest, MessageId, QueuedWindowWithdrawal, Receipt};

fn result(n: usize) -> MessageInput {
    MessageInput {
        client_message_id: format!("automatic-host-result-synthetic-group-{n}"),
        text: format!("Synthetic host result {n}"),
    }
}

async fn hand_back(f: &Case, query: &SourceReceiptQuery, input: &MessageInput) -> Receipt {
    let query = SourceReceiptQuery {
        client_message_id: input.client_message_id.clone(),
        text_sha256: crate::digest(&input.text),
        ..query.clone()
    };
    admit(f, input, &query).await.unwrap().receipt
}

async fn claim(f: &Case) -> Option<(Binding, InboxClaim)> {
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
        .unwrap()?;
    Some((binding, claim))
}

/// Admit, reserve and consume the claimed input: the run, the exact text the
/// provider receives, and the claimed (head) input.
async fn start(f: &Case, key: &str) -> (RunAdmissionResult, String, MessageId) {
    let (binding, claim) = claim(f).await.expect("a claimable input");
    let admitted = f
        .handle
        .admit_run(&claim, &binding.session_id, binding.generation, key)
        .await
        .unwrap();
    assert_eq!(admitted.disposition, AdmissionDisposition::FreshCandidate);
    let DispatchClaimResult::Reserved(reservation) = f
        .handle
        .claim_provider_dispatch(&admitted, &format!("{key}-reserve"))
        .await
        .unwrap()
    else {
        panic!("fresh reservation")
    };
    let ExecutionConsumption::Dispatch(capability) =
        f.handle.consume_execution(&reservation).await.unwrap()
    else {
        panic!("dispatch")
    };
    let text = capability.text().to_owned();
    (admitted, text, claim.message_id)
}

async fn accept(f: &Case, run: &ProviderAdmission, key: &str) {
    for (sequence, event) in [
        (1, ProviderEvent::Started),
        (2, ProviderEvent::CompletedProposal { synthetic: false }),
    ] {
        let receipt = f
            .handle
            .append_provider_event(&f.owner, run, &input(run, sequence, event))
            .await
            .unwrap();
        if sequence != 2 {
            continue;
        }
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
                    run_id: run.run.run_id.clone(),
                    completion_event_id: receipt.event_id,
                    expected_revision: revision,
                    request_key: key.into(),
                },
            )
            .await
            .unwrap();
    }
}

/// Inbox state, the run that consumed it, and a retirement reason.
async fn inbox(f: &Case, receipt: &Receipt) -> (String, Option<String>, Option<String>) {
    sqlx::query_as("SELECT i.state,i.admitted_run_id,r.reason FROM reasoning_inbox i LEFT JOIN owner_input_retirements r ON r.event_id=i.event_id WHERE i.message_id=?")
        .bind(receipt.message_id.to_string())
        .fetch_one(&f.store.pool)
        .await
        .unwrap()
}

async fn count(f: &Case, sql: &str) -> i64 {
    sqlx::query_scalar(sql)
        .fetch_one(&f.store.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn results_of_an_accepted_turn_share_one_continuation_that_may_stay_silent() {
    let (f, source, _, query) = fixture().await;
    // While the source turn runs, three results come back to it (it may read
    // them then; Core cannot tell), and the owner writes again.
    let mut results = Vec::new();
    for n in 1..=3 {
        results.push(hand_back(&f, &query, &result(n)).await);
    }
    let follow_up = f
        .store
        .admit(
            &f.owner,
            &f.conversation,
            &MessageInput {
                client_message_id: "owner-follow-up".into(),
                text: "Synthetic owner follow-up".into(),
            },
        )
        .await
        .unwrap()
        .receipt;
    accept(&f, &source, "accept-source").await;

    // One continuation turn takes all three, under one note that lets the
    // agent stay silent when its previous answer already used them.
    let (continuation, text, head) = start(&f, "continuation").await;
    assert_eq!(head, results[0].message_id);
    assert!(text.starts_with("[Automatic results: 3 result(s) of requests your previous turn made"));
    assert!(text.contains("answer exactly NO_REPLY and nothing else.]"));
    for (n, receipt) in results.iter().enumerate() {
        assert!(text.contains(&format!(
            "{}. [source: message {}, sequence {}]\nSynthetic host result {}",
            n + 1,
            receipt.message_id,
            receipt.sequence,
            n + 1
        )));
        assert_eq!(
            inbox(&f, receipt).await,
            (
                "consumed".into(),
                Some(continuation.provider.run.run_id.to_string()),
                None
            )
        );
    }
    accept(&f, &continuation.provider, "accept-continuation").await;

    // No second result turn: the owner's follow-up is next, with its own text.
    let (_, text, head) = start(&f, "follow-up").await;
    assert_eq!(head, follow_up.message_id);
    assert_eq!(text, "Synthetic owner follow-up");
    assert_eq!(count(&f, "SELECT count(*) FROM production_runs").await, 3);
    // Nothing was retired unseen.
    assert_eq!(
        count(&f, "SELECT count(*) FROM owner_input_retirements").await,
        0
    );
    close(f).await;
}

#[tokio::test]
async fn a_result_that_arrives_after_its_turn_was_accepted_runs_exactly_once() {
    let (f, source, _, query) = fixture().await;
    accept(&f, &source, "accept-source").await;
    // The turn already ended: this result is genuinely late.
    let late = hand_back(&f, &query, &result(1)).await;
    let replay = admit(
        &f,
        &result(1),
        &SourceReceiptQuery {
            client_message_id: result(1).client_message_id,
            text_sha256: crate::digest(&result(1).text),
            ..query.clone()
        },
    )
    .await
    .unwrap();
    assert!(replay.duplicate);
    let (continuation, text, head) = start(&f, "late-continuation").await;
    assert_eq!(head, late.message_id);
    assert!(text.starts_with("[Automatic results: 1 result(s) "));
    assert!(text.ends_with(&format!(
        "1. [source: message {}, sequence {}]\nSynthetic host result 1",
        late.message_id, late.sequence
    )));
    accept(&f, &continuation.provider, "accept-late").await;
    assert!(claim(&f).await.is_none(), "delivered once, nothing left");
    assert_eq!(
        inbox(&f, &late).await,
        (
            "consumed".into(),
            Some(continuation.provider.run.run_id.to_string()),
            None
        )
    );
    close(f).await;
}

#[tokio::test]
async fn a_release_continuation_keeps_its_own_turn_and_text() {
    let (f, source, message, query) = fixture().await;
    // ORK-792: the continuation of a run a release cut continues a cancelled
    // run. It is not a result: no note, no grouping.
    release_cut(&f, &source, "ready").await;
    admit_released(&f, &message, &query, Some(&grant(&source.run.run_id, 0)))
        .await
        .unwrap();
    let (_, text, _) = start(&f, "release-continuation").await;
    assert_eq!(text, message.text);
    close(f).await;
}

#[tokio::test]
async fn results_beyond_the_text_budget_wait_and_are_retired_once_superseded() {
    let (f, source, _, query) = fixture().await;
    let first = hand_back(&f, &query, &result(1)).await;
    let big = MessageInput {
        client_message_id: "automatic-host-result-synthetic-big".into(),
        text: "x".repeat(crate::production_runtime::deep_groups::DEEP_GROUP_TEXT_BUDGET),
    };
    let overflow = hand_back(&f, &query, &big).await;
    accept(&f, &source, "accept-source").await;
    let (continuation, text, _) = start(&f, "continuation").await;
    assert!(text.starts_with("[Automatic results: 1 result(s) "));
    assert_eq!(inbox(&f, &first).await.0, "consumed");
    assert_eq!(inbox(&f, &overflow).await.0, "queued");
    accept(&f, &continuation.provider, "accept-continuation").await;
    // The session moved on: the overflow can never run (ORK-795 retires it).
    let (_, claim) = claim(&f).await.unwrap();
    assert_eq!(claim.message_id, overflow.message_id);
    assert!(f
        .handle
        .retire_superseded_source_claim(&claim)
        .await
        .unwrap());
    assert_eq!(
        inbox(&f, &overflow).await,
        ("retired".into(), None, Some("source_superseded".into()))
    );
    close(f).await;
}

fn window_request(receipt: &Receipt, input: &MessageInput) -> ExecutionWindowRequest {
    ExecutionWindowRequest {
        request_key: format!("source-continuation:{}", receipt.event_id.0),
        input_message_id: receipt.message_id.clone(),
        input_event_id: receipt.event_id.clone(),
        input_request_key: input.client_message_id.clone(),
        expected_generation: 0,
        window_id: None,
        predecessor_window_id: None,
    }
}

#[tokio::test]
async fn a_result_the_window_queue_drops_as_superseded_is_retired_not_stranded() {
    let (f, _, _, query) = fixture().await;
    let stale = hand_back(&f, &query, &result(1)).await;
    let request = window_request(&stale, &result(1));
    // The provider changed before any window took it: its fence fails for good.
    sqlx::query("INSERT INTO conversation_settings(conversation_id,owner_id,revision,provider,honor_no_reply,provider_generation,updated_at_ms) VALUES(?,?,1,'codex',1,1,0)")
        .bind(f.conversation.to_string()).bind(f.owner.to_string())
        .execute(&f.store.pool).await.unwrap();
    assert!(matches!(
        f.store
            .inspect_execution_window_request_authenticated(&f.token, &f.conversation, &request)
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    // The dispatcher withdraws its intent; the input used to stay queued
    // forever. Now it is retired with a receipt, once.
    let withdrawn = f
        .store
        .withdraw_queued_execution_window_authenticated(
            &f.token,
            &f.conversation,
            &request.request_key,
            QueuedWindowWithdrawal::InputUnavailable,
        )
        .await
        .unwrap();
    assert_eq!(
        withdrawn.withdrawal,
        Some(QueuedWindowWithdrawal::InputUnavailable)
    );
    assert_eq!(
        inbox(&f, &stale).await,
        ("retired".into(), None, Some("source_superseded".into()))
    );
    f.store
        .withdraw_queued_execution_window_authenticated(
            &f.token,
            &f.conversation,
            &request.request_key,
            QueuedWindowWithdrawal::InputUnavailable,
        )
        .await
        .unwrap();
    assert_eq!(
        count(&f, "SELECT count(*) FROM owner_input_retirements").await,
        1
    );
    assert_eq!(count(&f, "SELECT count(*) FROM production_runs").await, 1);
    close(f).await;
}

#[tokio::test]
async fn a_withdrawn_result_whose_fence_still_holds_stays_queued() {
    let (f, _, _, query) = fixture().await;
    let live = hand_back(&f, &query, &result(1)).await;
    let request = window_request(&live, &result(1));
    f.store
        .withdraw_queued_execution_window_authenticated(
            &f.token,
            &f.conversation,
            &request.request_key,
            QueuedWindowWithdrawal::InputUnavailable,
        )
        .await
        .unwrap();
    assert_eq!(inbox(&f, &live).await, ("queued".into(), None, None));
    close(f).await;
}
