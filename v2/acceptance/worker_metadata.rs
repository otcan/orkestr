// Independent tests for Core 5698537783f4c9b4cfd75465aae74f1c543fe5ea.
// Register as a test-only module inside production_runtime/worker in an owned export.
use super::tests::{ledger, running};
use super::*;
use crate::production_runtime::observation_tests::input as event;
use crate::production_runtime::tests::setup;

fn evidence(b: &Binding) -> NativeSessionConfirmation {
    NativeSessionConfirmation {
        session_id: b.session_id.clone(),
        expected_generation: b.generation,
        native_session_id: "synthetic-parent-bound-worker".into(),
        protocol_version: "codex-rpc-1".into(),
        source_event_key: "parent-bound-ready".into(),
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn independent_setup_stop_proposal_revocation_refuse_without_callback_or_writes() {
    for mode in 0..3 {
        let f = setup().await;
        let (parent, _) = running(&f).await;
        let b = f.handle.create_worker_binding(&f.owner, &f.conversation,
            Some(&parent.binding.session_id), "independent-setup").await.unwrap();
        let grant = f.handle.authorize_worker_metadata(&f.token, &parent.run.run_id, &b).await.unwrap();
        match mode {
            0 => { f.handle.request_cancel(&f.owner, &parent.run.run_id, "independent-stop").await.unwrap(); }
            1 => { f.handle.append_provider_event(&f.owner, &parent,
                &event(&parent, 2, ProviderEvent::CompletedProposal { synthetic: false })).await.unwrap(); }
            _ => { f.store.revoke_session(&f.token).await.unwrap(); }
        }
        let before = ledger(&f.store).await;
        let mut called = false;
        assert!(f.handle.with_metadata_fence(&grant, || { called = true; Ok::<_, ()>(()) }).is_err());
        assert!(!called);
        assert!(f.handle.confirm_metadata_session(grant, evidence(&b)).await.is_err());
        assert_eq!(ledger(&f.store).await, before);
    }
}

#[tokio::test]
async fn independent_exact_run_owner_and_conversation_scope_refuse_without_writes() {
    let f = setup().await;
    let (parent, _) = running(&f).await;
    let before = ledger(&f.store).await;
    assert!(matches!(f.handle.execution_run_status(&f.token, &OwnerId(Uuid::new_v4()),
        &f.conversation, &parent.run.run_id).await, Err(RuntimeStoreError::Unauthorized)));
    assert!(f.handle.execution_run_status(&f.token, &f.owner,
        &ConversationId(Uuid::new_v4()), &parent.run.run_id).await.is_err());
    assert_eq!(ledger(&f.store).await, before);
}
