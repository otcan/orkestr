use super::*;
use crate::production_runtime::tests::{claim, ready, setup};
use orkestr_v2_application::IntakeStore;
use orkestr_v2_contracts::MessageInput;
#[tokio::test]
async fn stop_holds_old_claim_and_queue_but_new_intent_is_independently_claimable() {
    let f = setup().await;
    let binding = ready(&f).await;
    let initial = claim(&f, &binding).await;
    let run = f
        .handle
        .admit_run(&initial, &binding.session_id, binding.generation, "parent")
        .await
        .unwrap();
    for key in ["old-1", "old-2"] {
        f.store
            .admit(
                &f.owner,
                &f.conversation,
                &MessageInput {
                    client_message_id: key.into(),
                    text: key.into(),
                },
            )
            .await
            .unwrap();
    }
    let old = f
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
    f.handle
        .request_cancel(&f.owner, &run.provider.run.run_id, "stop")
        .await
        .unwrap();
    let before = f
        .handle
        .held_owner_inputs_authenticated(&f.token, &f.conversation, 0, 1)
        .await
        .unwrap();
    assert_eq!(before.held.len(), 1);
    assert_eq!(before.held[0].message_id, old.message_id);
    assert_eq!(before.held[0].boundary_run_id, run.provider.run.run_id);
    assert!(before.held[0].through_scope_sequence >= before.held[0].scope_sequence);
    assert!(!before.eligible_input_available);
    let after = before.next_after_sequence.unwrap();
    let second = f
        .handle
        .held_owner_inputs_authenticated(&f.token, &f.conversation, after, 1)
        .await
        .unwrap();
    assert_eq!(second.held.len(), 1);
    assert_eq!(second.next_after_sequence, None);
    let ready = f
        .handle
        .ensure_role_bindings(&f.owner, &f.conversation)
        .await
        .unwrap()
        .deep;
    assert!(matches!(
        f.handle
            .admit_run(&old, &ready.session_id, ready.generation, "held-cannot-run")
            .await,
        Err(RuntimeStoreError::Fenced)
    ));
    assert!(f
        .handle
        .claim_next(
            &f.owner,
            &f.conversation,
            &ready.session_id,
            std::time::Duration::from_secs(60)
        )
        .await
        .unwrap()
        .is_none());
    let receipt = f
        .store
        .admit(
            &f.owner,
            &f.conversation,
            &MessageInput {
                client_message_id: "fresh-intent".into(),
                text: "fresh".into(),
            },
        )
        .await
        .unwrap();
    let fresh = f
        .handle
        .claim_next(
            &f.owner,
            &f.conversation,
            &ready.session_id,
            std::time::Duration::from_secs(60),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(fresh.message_id, receipt.receipt.message_id);
    assert!(fresh.scope_sequence > before.held[0].through_scope_sequence);
    let next = f
        .handle
        .admit_run(&fresh, &ready.session_id, ready.generation, "only-fresh")
        .await
        .unwrap();
    assert_ne!(next.provider.run.run_id, run.provider.run.run_id);
    let reopened = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let attached = f.handle.reattach_supervisor(&reopened).await.unwrap();
    let held = attached
        .held_owner_inputs_authenticated(&f.token, &f.conversation, 0, 100)
        .await
        .unwrap();
    assert_eq!(held.held.len(), 2);
    assert_eq!(held.held[0], before.held[0]);
    assert!(!held.eligible_input_available);
    f.store.revoke_session(&f.token).await.unwrap();
    assert!(matches!(
        attached
            .held_owner_inputs_authenticated(&f.token, &f.conversation, 0, 100)
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
}
