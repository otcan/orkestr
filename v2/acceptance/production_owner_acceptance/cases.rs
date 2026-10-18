//! Owner decisions use the ordinary server Store; provider authority cannot accept.
use super::*;
use orkestr_v2_contracts::{ExecutionAcceptanceRequest, ExecutionPhase};
async fn proposal() -> (Case, Store, ProviderAdmission, ExecutionAcceptanceRequest) {
    let (c, h, p) = active().await;
    let receipt = h
        .append_provider_event(
            &c.owner,
            &p,
            &event(&p, 2, ProviderEvent::CompletedProposal { synthetic: false }),
        )
        .await
        .unwrap();
    let status = c
        .store
        .execution_status(&c.owner, &c.conversation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status.phase, ExecutionPhase::AwaitingAcceptance);
    let request = ExecutionAcceptanceRequest {
        run_id: p.run.run_id.clone(),
        completion_event_id: receipt.event_id,
        expected_revision: status.revision,
        request_key: "owner-decision:1".into(),
    };
    (c, h, p, request)
}
#[tokio::test]
async fn independent_owner_race_and_committed_receipt_cannot_release_active_successor() {
    let (c, h, p, input) = proposal().await;
    let other = Store::open(&c.root.join("core.sqlite3")).await.unwrap();
    let (a, b) = tokio::join!(
        c.store.accept_execution(&c.owner, &c.conversation, &input),
        other.accept_execution(&c.owner, &c.conversation, &input)
    );
    let receipt = a.unwrap();
    assert_eq!(receipt, b.unwrap());
    assert!(receipt.is_valid());
    let binding = h
        .ensure_role_bindings(&c.owner, &c.conversation)
        .await
        .unwrap()
        .deep;
    assert_eq!(binding.session_id, p.run.session_id);
    assert_eq!(binding.state, SessionState::Ready);
    c.store
        .admit(
            &c.owner,
            &c.conversation,
            &MessageInput {
                client_message_id: "successor-message".into(),
                text: "synthetic next input".into(),
            },
        )
        .await
        .unwrap();
    let claim = h
        .claim_next(
            &c.owner,
            &c.conversation,
            &binding.session_id,
            Duration::from_secs(60),
        )
        .await
        .unwrap()
        .unwrap();
    let next = h
        .admit_run(
            &claim,
            &binding.session_id,
            binding.generation,
            "successor-turn",
        )
        .await
        .unwrap();
    let DispatchClaimResult::Reserved(reservation) = h
        .claim_provider_dispatch(&next, "successor-reservation")
        .await
        .unwrap()
    else {
        panic!("fresh reservation")
    };
    assert!(matches!(
        h.consume_execution(&reservation).await.unwrap(),
        ExecutionConsumption::Dispatch(_)
    ));
    h.append_provider_event(
        &c.owner,
        &next.provider,
        &event(&next.provider, 1, ProviderEvent::Started),
    )
    .await
    .unwrap();
    let stable = oracle::rows(&c.root).await;
    for _ in 0..2 {
        assert_eq!(
            other
                .accept_execution(&c.owner, &c.conversation, &input)
                .await
                .unwrap(),
            receipt
        );
    }
    assert!(
        oracle::rows(&c.root).await == stable,
        "historical decision changed successor ledger"
    );
    let mut changed = input.clone();
    changed.expected_revision += 1;
    assert!(matches!(
        other
            .accept_execution(&c.owner, &c.conversation, &changed)
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    changed = input.clone();
    changed.request_key = "different-decision".into();
    assert!(other
        .accept_execution(&c.owner, &c.conversation, &changed)
        .await
        .is_err());
    assert!(h
        .append_provider_event(
            &c.owner,
            &p,
            &event(&p, 3, ProviderEvent::Progress("obsolete callback".into()))
        )
        .await
        .is_err());
    assert!(
        oracle::rows(&c.root).await == stable,
        "refusal changed successor ledger"
    );
    let history = c
        .store
        .events(&c.owner, &c.conversation, 0, 100)
        .await
        .unwrap();
    let decisions: Vec<_> = history
        .iter()
        .filter(|e| e.sse_name() == "execution_accepted")
        .collect();
    assert_eq!(decisions.len(), 1);
    let status = c
        .store
        .execution_status(&c.owner, &c.conversation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status.run_id, Some(next.provider.run.run_id));
    assert_eq!(status.phase, ExecutionPhase::Running);
}
#[tokio::test]
async fn independent_owner_refusal_and_late_write_failure_preserve_every_execution_row() {
    let (c, h, _, input) = proposal().await;
    let stable = oracle::rows(&c.root).await;
    assert!(matches!(
        h.accept_execution(&c.owner, &c.conversation, &input).await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    for mutation in 0..5 {
        let mut bad = input.clone();
        let mut owner = c.owner.clone();
        let mut conversation = c.conversation.clone();
        match mutation {
            0 => bad.completion_event_id = orkestr_v2_contracts::EventId(Uuid::new_v4()),
            1 => bad.expected_revision += 1,
            2 => bad.run_id = orkestr_v2_contracts::RunId(Uuid::new_v4()),
            3 => owner = OwnerId(Uuid::new_v4()),
            _ => conversation = ConversationId(Uuid::new_v4()),
        };
        assert!(c
            .store
            .accept_execution(&owner, &conversation, &bad)
            .await
            .is_err());
        assert!(
            oracle::rows(&c.root).await == stable,
            "refusal changed complete ledger"
        );
    }
    let mut db = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new().filename(c.root.join("core.sqlite3")),
    )
    .await
    .unwrap();
    sqlx::query("CREATE TRIGGER independent_acceptance_failure BEFORE INSERT ON production_acceptances BEGIN SELECT RAISE(ABORT,'synthetic decision write failure'); END").execute(&mut db).await.unwrap();
    assert!(matches!(
        c.store
            .accept_execution(&c.owner, &c.conversation, &input)
            .await,
        Err(RuntimeStoreError::Unavailable)
    ));
    assert!(
        oracle::rows(&c.root).await == stable,
        "late insert failure leaked release/event/revision"
    );
    sqlx::query("DROP TRIGGER independent_acceptance_failure")
        .execute(&mut db)
        .await
        .unwrap();
    db.close().await.unwrap();
    let receipt = c
        .store
        .accept_execution(&c.owner, &c.conversation, &input)
        .await
        .unwrap();
    let committed = oracle::rows(&c.root).await;
    let reopened = Store::open(&c.root.join("core.sqlite3")).await.unwrap();
    assert_eq!(
        reopened
            .accept_execution(&c.owner, &c.conversation, &input)
            .await
            .unwrap(),
        receipt
    );
    assert!(
        oracle::rows(&c.root).await == committed,
        "reopened replay changed ledger"
    );
}
