//! ORK-795: one chat had 221 held inputs (most of them later retired), so the
//! first page of 50 could not tell whether a later message was held. The
//! lookup by message id answers for any message, however many are held.
use super::*;
use crate::production_runtime::{
    observation_tests::{consumed, input},
    tests::{setup, snapshot, Case},
};
use orkestr_v2_application::IntakeStore;
use orkestr_v2_contracts::{MessageInput, OwnerInputRetirementRequest, Receipt};

async fn owner_input(f: &Case, key: &str) -> Receipt {
    f.store
        .admit(
            &f.owner,
            &f.conversation,
            &MessageInput {
                client_message_id: key.into(),
                text: "synthetic held input".into(),
            },
        )
        .await
        .unwrap()
        .receipt
}

/// `count` owner inputs queued behind a running turn, then the owner's Stop
/// holds every one of them.
async fn held(count: usize) -> (Case, Vec<Receipt>) {
    let f = setup().await;
    let p = consumed(&f).await;
    f.handle
        .append_provider_event(&f.owner, &p, &input(&p, 1, ProviderEvent::Started))
        .await
        .unwrap();
    let mut held = Vec::new();
    for n in 0..count {
        held.push(owner_input(&f, &format!("held-{n}")).await);
    }
    let cancel = f
        .handle
        .request_cancel(&f.owner, &p.run.run_id, "stop-lookup-test")
        .await
        .unwrap();
    let mut stopped = p.clone();
    stopped.run = cancel.new_fenced_admission;
    f.handle
        .append_provider_event(
            &f.owner,
            &stopped,
            &input(&stopped, 2, ProviderEvent::Stopped),
        )
        .await
        .unwrap();
    (f, held)
}

#[tokio::test]
async fn a_message_past_the_first_page_is_found_even_when_most_holds_are_retired() {
    let (f, held) = held(120).await;
    let browser = "browser:synthetic-held-lookup";
    f.store.save_session(browser, &f.owner).await.unwrap();
    // The operator's clean-up retires most held inputs; their holds stay.
    for receipt in held.iter().take(100) {
        f.store
            .retire_owner_input_for_browser(
                browser,
                &f.conversation,
                &receipt.message_id,
                &OwnerInputRetirementRequest {
                    request_key: format!("cleanup:{}", receipt.message_id),
                    reason: "operator_cleanup".into(),
                },
            )
            .await
            .unwrap();
    }
    // The old reading: one page of 50 that does not reach the later inputs.
    let page = f
        .store
        .held_owner_inputs_for_browser(browser, &f.conversation, 0, 50)
        .await
        .unwrap();
    assert_eq!(page.held.len(), 50);
    assert!(page.next_after_sequence.is_some());
    assert!(!page
        .held
        .iter()
        .any(|row| row.message_id == held[110].message_id));
    // Admitted after the Stop: not held.
    let later = owner_input(&f, "after-the-stop").await;
    let before = snapshot(&f.store).await;
    for (message, expected) in [
        (&held[110].message_id, true), // not retired, beyond page 2
        (&held[119].message_id, true), // the last one
        (&held[60].message_id, true),  // retired: still never runs
        (&later.message_id, false),
    ] {
        let found = f
            .store
            .held_owner_input_for_browser(browser, &f.conversation, message)
            .await
            .unwrap();
        assert_eq!(found.next_after_sequence, None);
        assert_eq!(found.held.len(), usize::from(expected), "{message}");
        if expected {
            assert_eq!(&found.held[0].message_id, message);
        }
    }
    // A message of no conversation is simply not held; reading changes nothing.
    let unknown = MessageId(Uuid::new_v4());
    assert!(f
        .store
        .held_owner_input_for_browser(browser, &f.conversation, &unknown)
        .await
        .unwrap()
        .held
        .is_empty());
    assert_eq!(snapshot(&f.store).await, before);
    assert!(matches!(
        f.store
            .held_owner_input_for_browser("browser:unknown", &f.conversation, &unknown)
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert!(matches!(
        f.handle
            .held_owner_input_for_browser(browser, &f.conversation, &unknown)
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
}
