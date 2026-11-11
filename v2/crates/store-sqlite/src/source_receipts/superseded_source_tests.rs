//! ORK-795: two host results handed back to one running turn, then an owner
//! follow-up. The first handback runs as its own turn after the source turn
//! is accepted, which moves the source session on, so the second can never
//! run. Admission refuses it (that refusal used to end the whole window and
//! release the follow-up); now Core retires exactly that input and the
//! follow-up behind it is admitted.
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

#[tokio::test]
async fn a_superseded_handback_is_retired_alone_and_the_follow_up_is_admitted() {
    let (f, source, message, query) = fixture().await;
    // While the source turn runs, two host results come back to it.
    let first = admit(&f, &message, &query).await.unwrap();
    let late = MessageInput {
        client_message_id: "automatic-host-result-synthetic-2".into(),
        text: "Second synthetic host result".into(),
    };
    let late_query = SourceReceiptQuery {
        client_message_id: late.client_message_id.clone(),
        text_sha256: crate::digest(&late.text),
        ..query.clone()
    };
    let second = admit(&f, &late, &late_query).await.unwrap();
    // The owner writes again before any of them ran.
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
        .unwrap();
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
    let runs: i64 = sqlx::query_scalar("SELECT count(*) FROM production_runs")
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
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
    let after: i64 = sqlx::query_scalar("SELECT count(*) FROM production_runs")
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(after, runs, "nothing is replayed");

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
