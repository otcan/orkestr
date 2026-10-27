//! Owner auto-acceptance by the server's window-bound system principal: no
//! browser credential, Workers before their Deep parent, audited, and only
//! while the conversation leaves `review_before_accepting` off.
use super::*;
use crate::production_runtime::acceptance::Principal;
use orkestr_v2_contracts::{ConversationProvider, ConversationSettingsUpdate};

async fn propose_worker(b: &Workbench) -> EventId {
    let w = &b.p.w;
    w.bound
        .append_provider_event(
            &w.f.owner,
            &b.worker,
            &observation(
                &b.worker,
                2,
                ProviderEvent::CompletedProposal { synthetic: false },
            ),
        )
        .await
        .unwrap()
        .event_id
}

async fn state(store: &Store, run: &ProviderAdmission) -> String {
    scalar(
        store,
        "SELECT state FROM production_runs WHERE id=?",
        &run.run.run_id.to_string(),
    )
    .await
}

async fn review(w: &Window) {
    let update = ConversationSettingsUpdate {
        expected_revision: 0,
        provider: ConversationProvider::Codex,
        model: None,
        reasoning_effort: None,
        honor_no_reply: true,
        reply_prefix: None,
        reply_footer: None,
        review_before_accepting: true,
        deep_grouping: None,
        parallel_deep: None,
    };
    w.f.store
        .update_conversation_settings(
            &w.browser_credential,
            &w.f.owner,
            &w.f.conversation,
            &update,
        )
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn worker_fast_and_deep_are_accepted_in_order_without_a_browser_and_audited() {
    let b = workbench_with(WorkerEnd::Running).await;
    propose_worker(&b).await;
    let w = &b.p.w;
    let receipts = w
        .bound
        .auto_accept_window_proposals(&w.f.conversation)
        .await
        .unwrap();
    let runs: Vec<_> = receipts.iter().map(|r| r.run_id.clone()).collect();
    assert_eq!(
        runs,
        vec![
            b.worker.run.run_id.clone(),
            b.p.fast.run.run_id.clone(),
            b.p.deep.run.run_id.clone()
        ],
        "a decided Worker never holds its Deep parent"
    );
    for receipt in &receipts {
        assert_eq!(
            receipt.request_key,
            auto_accept_request_key(&receipt.run_id)
        );
    }
    for run in [&b.worker, &b.p.fast, &b.p.deep] {
        assert_eq!(state(&w.f.store, run).await, "succeeded");
    }
    assert_eq!(
        count(
            &w.f.store,
            "SELECT count(*) FROM production_auto_acceptances WHERE actor='auto_accept'"
        )
        .await,
        3
    );
    assert_eq!(
        scalar(
            &w.f.store,
            "SELECT window_id FROM production_auto_acceptances WHERE run_id=?",
            &b.p.deep.run.run_id.to_string(),
        )
        .await,
        w.status.window_id.to_string()
    );
    let history =
        w.f.store
            .accepted_results_authenticated(&w.browser_credential, &w.f.conversation, 0, 50)
            .await
            .unwrap();
    assert_eq!(history.results.len(), 3);
    assert!(history.results.iter().all(|r| r.auto_accepted));
    // Nothing left: a later pass is a no-op.
    assert!(w
        .bound
        .auto_accept_window_proposals(&w.f.conversation)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_running_worker_holds_only_its_parent() {
    let b = workbench_with(WorkerEnd::Running).await;
    let w = &b.p.w;
    let receipts = w
        .bound
        .auto_accept_window_proposals(&w.f.conversation)
        .await
        .unwrap();
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0].run_id, b.p.fast.run.run_id);
    assert_eq!(state(&w.f.store, &b.p.deep).await, "awaiting_acceptance");
    // The Worker proposes; the next pass accepts it, then its parent.
    propose_worker(&b).await;
    let next = w
        .bound
        .auto_accept_window_proposals(&w.f.conversation)
        .await
        .unwrap();
    assert_eq!(
        next.iter().map(|r| r.run_id.clone()).collect::<Vec<_>>(),
        vec![b.worker.run.run_id.clone(), b.p.deep.run.run_id.clone()]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn review_or_a_foreign_principal_accepts_nothing() {
    let b = workbench_with(WorkerEnd::Running).await;
    propose_worker(&b).await;
    let w = &b.p.w;
    review(w).await;
    let before = fixtures::snapshot(&w.f.store).await;
    assert!(w
        .bound
        .auto_accept_window_proposals(&w.f.conversation)
        .await
        .unwrap()
        .is_empty());
    // The unbound owner Store holds no window authority.
    assert!(w
        .f
        .store
        .auto_accept_window_proposals(&w.f.conversation)
        .await
        .is_err());
    let request = ExecutionAcceptanceRequest {
        run_id: b.p.fast.run.run_id.clone(),
        completion_event_id: b.p.fast_done.clone(),
        expected_revision: 0,
        request_key: "forged-auto".into(),
    };
    assert!(matches!(
        w.f.store
            .accept_as(
                &w.f.owner,
                &w.f.conversation,
                &request,
                Principal::AutoAccept
            )
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    // Review on: even the window principal is refused at the decision itself.
    assert!(matches!(
        w.bound
            .accept_as(
                &w.f.owner,
                &w.f.conversation,
                &request,
                Principal::AutoAccept
            )
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    // The bound Store never takes the owner's browser path either.
    assert!(matches!(
        w.bound
            .accept_execution_authenticated(&w.browser_credential, &w.f.conversation, &request)
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert_eq!(before, fixtures::snapshot(&w.f.store).await);
    // A manual owner decision still works and is not marked automatic.
    let revision: i64 =
        sqlx::query_scalar("SELECT revision FROM execution_revisions WHERE conversation_id=?")
            .bind(w.f.conversation.to_string())
            .fetch_one(&w.f.store.pool)
            .await
            .unwrap();
    w.f.store
        .accept_execution_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            &ExecutionAcceptanceRequest {
                expected_revision: revision,
                request_key: "owner-fast".into(),
                ..request
            },
        )
        .await
        .unwrap();
    let history =
        w.f.store
            .accepted_results_authenticated(&w.browser_credential, &w.f.conversation, 0, 50)
            .await
            .unwrap();
    assert_eq!(history.results.len(), 1);
    assert!(!history.results[0].auto_accepted);
    assert_eq!(
        count(
            &w.f.store,
            "SELECT count(*) FROM production_auto_acceptances"
        )
        .await,
        0
    );
}
