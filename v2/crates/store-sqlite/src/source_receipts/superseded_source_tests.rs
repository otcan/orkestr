//! ORK-795: host results handed back to one running turn, then owner input.
//! A handback whose source session moved on can never run. Admission refuses
//! it (that refusal used to end the whole window and release the follow-up);
//! now Core retires exactly that input and the follow-up behind it is
//! admitted. ORK-843: a session moved on only when a turn that did not
//! continue the same source turn used it. A later handback that only follows
//! the first handback's turn still runs. (The second result is too large to
//! join the first one's continuation turn, see `continuation_groups`; a
//! smaller one would be answered in that same turn.)
use super::*;
use orkestr_v2_application::{
    runtime::{InboxClaim, RunAdmissionResult},
    IntakeStore,
};

async fn claim_head(f: &Case) -> (Binding, InboxClaim) {
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
    (binding, claim)
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

async fn run(f: &Case, claim: &InboxClaim, binding: &Binding, key: &str) -> RunAdmissionResult {
    let admitted = f
        .handle
        .admit_run(claim, &binding.session_id, binding.generation, key)
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
    assert!(matches!(
        f.handle.consume_execution(&reservation).await.unwrap(),
        ExecutionConsumption::Dispatch(_)
    ));
    admitted
}

async fn inbox(f: &Case, message: &orkestr_v2_contracts::MessageId) -> (String, Option<String>) {
    sqlx::query_as("SELECT i.state,r.reason FROM reasoning_inbox i LEFT JOIN owner_input_retirements r ON r.event_id=i.event_id WHERE i.message_id=?")
        .bind(message.to_string())
        .fetch_one(&f.store.pool)
        .await
        .unwrap()
}

fn large_result() -> MessageInput {
    MessageInput {
        client_message_id: "automatic-host-result-synthetic-2".into(),
        text: "Second synthetic host result ".repeat(1024),
    }
}

async fn admit_large(f: &Case, query: &SourceReceiptQuery) -> orkestr_v2_application::Admission {
    let late = large_result();
    let late_query = SourceReceiptQuery {
        client_message_id: late.client_message_id.clone(),
        text_sha256: crate::digest(&late.text),
        ..query.clone()
    };
    admit(f, &late, &late_query).await.unwrap()
}

async fn owner_input(f: &Case, key: &str) -> orkestr_v2_application::Admission {
    f.store
        .admit(
            &f.owner,
            &f.conversation,
            &MessageInput {
                client_message_id: key.into(),
                text: format!("Synthetic owner input {key}"),
            },
        )
        .await
        .unwrap()
}

async fn runs(f: &Case) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM production_runs")
        .fetch_one(&f.store.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn a_later_handback_of_the_same_turn_runs_after_the_first_one() {
    let (f, source, message, query) = fixture().await;
    // While the source turn runs, two host results come back to it.
    let first = admit(&f, &message, &query).await.unwrap();
    let second = admit_large(&f, &query).await;
    // The owner writes again before any of them ran.
    let follow_up = owner_input(&f, "owner-follow-up").await;
    accept(&f, &source, "accept-source").await;

    let (binding, claim) = claim_head(&f).await;
    assert_eq!(claim.message_id, first.receipt.message_id);
    let handback = run(&f, &claim, &binding, "first-handback").await;
    accept(&f, &handback.provider, "accept-first-handback").await;

    // The first handback's turn only continued the source turn: the second
    // one is not superseded by it (it was on 2026-11-16, ORK-843).
    let (binding, claim) = claim_head(&f).await;
    assert_eq!(claim.message_id, second.receipt.message_id);
    assert!(!f
        .handle
        .retire_superseded_source_claim(&claim)
        .await
        .unwrap());
    let late = run(&f, &claim, &binding, "second-handback").await;
    assert_eq!(
        inbox(&f, &second.receipt.message_id).await,
        ("consumed".into(), None)
    );
    accept(&f, &late.provider, "accept-second-handback").await;

    // Then the owner's follow-up, with its own turn.
    let (binding, claim) = claim_head(&f).await;
    assert_eq!(claim.message_id, follow_up.receipt.message_id);
    run(&f, &claim, &binding, "follow-up").await;
    let retired: i64 = sqlx::query_scalar("SELECT count(*) FROM owner_input_retirements")
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(retired, 0);
    close(f).await;
}

#[tokio::test]
async fn a_superseded_handback_is_retired_alone_and_the_follow_up_is_admitted() {
    let (f, source, message, query) = fixture().await;
    // While the source turn runs, a host result comes back to it; then the
    // owner writes, then a second, larger result arrives, then the owner
    // writes again.
    let first = admit(&f, &message, &query).await.unwrap();
    let between = owner_input(&f, "owner-between").await;
    let second = admit_large(&f, &query).await;
    let follow_up = owner_input(&f, "owner-follow-up").await;
    accept(&f, &source, "accept-source").await;

    // The first handback still passes its fence and runs as its own turn.
    let (binding, claim) = claim_head(&f).await;
    assert_eq!(claim.message_id, first.receipt.message_id);
    assert!(!f
        .handle
        .retire_superseded_source_claim(&claim)
        .await
        .unwrap());
    let handback = run(&f, &claim, &binding, "first-handback").await;
    accept(&f, &handback.provider, "accept-first-handback").await;

    // The owner's message gets the next turn: the source session moved on.
    let (binding, claim) = claim_head(&f).await;
    assert_eq!(claim.message_id, between.receipt.message_id);
    let owner_turn = run(&f, &claim, &binding, "owner-between").await;
    accept(&f, &owner_turn.provider, "accept-owner-between").await;

    // The second one is fenced for good: the same admission refusal as on
    // 2026-11-11, which used to end the window.
    let (binding, claim) = claim_head(&f).await;
    assert_eq!(claim.message_id, second.receipt.message_id);
    assert!(matches!(
        f.handle
            .admit_run(&claim, &binding.session_id, binding.generation, "second")
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    let before = runs(&f).await;
    assert!(f
        .handle
        .retire_superseded_source_claim(&claim)
        .await
        .unwrap());
    assert_eq!(
        inbox(&f, &second.receipt.message_id).await,
        ("retired".into(), Some("source_superseded".into()))
    );
    // Retired once: a repeat finds no live claim and changes nothing.
    assert!(!f
        .handle
        .retire_superseded_source_claim(&claim)
        .await
        .unwrap());
    assert_eq!(runs(&f).await, before, "nothing is replayed");

    // The follow-up is next, has no fence, and is admitted normally.
    let (binding, claim) = claim_head(&f).await;
    assert_eq!(claim.message_id, follow_up.receipt.message_id);
    assert!(!f
        .handle
        .retire_superseded_source_claim(&claim)
        .await
        .unwrap());
    run(&f, &claim, &binding, "follow-up").await;
    assert_eq!(
        inbox(&f, &follow_up.receipt.message_id).await,
        ("consumed".into(), None)
    );
    assert_eq!(
        inbox(&f, &first.receipt.message_id).await,
        ("consumed".into(), None)
    );
    close(f).await;
}
