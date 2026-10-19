//! Browser evidence survives the supervisor; machine reads keep their fences.
use super::*;
use crate::production_runtime::{
    observation_tests::{consumed, input},
    tests::{setup, snapshot, Case},
};
use orkestr_v2_application::IntakeStore;
use orkestr_v2_contracts::MessageInput;

async fn stopped() -> (Case, Vec<orkestr_v2_contracts::Receipt>, RunId) {
    let f = setup().await;
    let p = consumed(&f).await;
    f.handle
        .append_provider_event(&f.owner, &p, &input(&p, 1, ProviderEvent::Started))
        .await
        .unwrap();
    let mut old = Vec::new();
    for key in ["held-one", "held-two"] {
        old.push(
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
                .receipt,
        );
    }
    let cancel = f
        .handle
        .request_cancel(&f.owner, &p.run.run_id, "stop-held-test")
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
    // Store fixture models the trusted retirement call after native reap. This
    // test neither starts a provider nor asserts actual process cleanup.
    f.handle
        .retire_terminal_supervisor(&f.token, &p.run.run_id)
        .await
        .unwrap();
    (f, old, p.run.run_id)
}

#[tokio::test]
async fn retired_browser_projection_survives_close_reopen_without_reissuing_authority() {
    let (f, old, run) = stopped().await;
    let browser = "browser:synthetic-independent-session";
    f.store.save_session(browser, &f.owner).await.unwrap();
    let before = snapshot(&f.store).await;
    let page = f
        .store
        .held_owner_inputs_for_browser(browser, &f.conversation, 0, 100)
        .await
        .unwrap();
    assert_eq!(snapshot(&f.store).await, before);
    assert_eq!(page.held.len(), 2);
    assert!(!page.eligible_input_available);
    for (row, receipt) in page.held.iter().zip(&old) {
        assert_eq!(row.message_id, receipt.message_id);
        assert_eq!(row.source_event_id, receipt.event_id);
        assert_eq!(row.scope_sequence, receipt.sequence);
        assert_eq!(row.boundary_run_id, run);
        assert!(row.through_scope_sequence >= receipt.sequence);
    }
    assert!(f
        .handle
        .held_owner_inputs_authenticated(&f.token, &f.conversation, 0, 100)
        .await
        .is_err());
    assert!(matches!(
        f.handle
            .held_owner_inputs_for_browser(browser, &f.conversation, 0, 100)
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    f.store.close().await;
    drop(f.handle);
    let reopened = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let again = reopened
        .held_owner_inputs_for_browser(browser, &f.conversation, 0, 100)
        .await
        .unwrap();
    assert_eq!(page.held, again.held);
    assert_eq!(page.revision, again.revision);
    assert_eq!(snapshot(&reopened).await, before);
    let fresh = reopened
        .admit(
            &f.owner,
            &f.conversation,
            &MessageInput {
                client_message_id: "new-independent-intent".into(),
                text: "synthetic fresh input".into(),
            },
        )
        .await
        .unwrap()
        .receipt;
    let before_read = snapshot(&reopened).await;
    let next = reopened
        .held_owner_inputs_for_browser(browser, &f.conversation, 0, 100)
        .await
        .unwrap();
    assert_eq!(next.held, page.held);
    assert!(next.eligible_input_available);
    assert!(fresh.sequence > next.held[0].through_scope_sequence);
    assert_eq!(snapshot(&reopened).await, before_read);
    reopened.close().await;
    std::fs::remove_dir_all(f.root).unwrap();
}

#[tokio::test]
async fn pagination_scope_current_session_and_bounds_refuse_without_mutation() {
    let (f, _, _) = stopped().await;
    let browser = "browser:synthetic-page-session";
    f.store.save_session(browser, &f.owner).await.unwrap();
    // Each ledger enforces a singleton owner. A real foreign owner/session
    // belongs to another ledger; do not weaken that schema to build a fixture.
    let foreign = setup().await;
    let foreign_conversation = foreign.conversation.clone();
    foreign
        .store
        .save_session("browser:foreign", &foreign.owner)
        .await
        .unwrap();
    let before = snapshot(&f.store).await;
    let first = f
        .store
        .held_owner_inputs_for_browser(browser, &f.conversation, 0, 1)
        .await
        .unwrap();
    assert_eq!(first.held.len(), 1);
    let cursor = first.next_after_sequence.unwrap();
    let last = f
        .store
        .held_owner_inputs_for_browser(browser, &f.conversation, cursor, 1)
        .await
        .unwrap();
    assert_eq!(last.held.len(), 1);
    assert!(last.held[0].scope_sequence > cursor);
    assert!(last.next_after_sequence.is_none());
    for (credential, conversation, after, limit, error) in [
        (
            browser,
            &foreign_conversation,
            0,
            1,
            RuntimeStoreError::NotFound,
        ),
        (
            "browser:foreign",
            &f.conversation,
            0,
            1,
            RuntimeStoreError::Unauthorized,
        ),
        (
            "missing",
            &f.conversation,
            0,
            1,
            RuntimeStoreError::Unauthorized,
        ),
        (
            browser,
            &f.conversation,
            -1,
            1,
            RuntimeStoreError::InvalidInput,
        ),
        (
            browser,
            &f.conversation,
            0,
            0,
            RuntimeStoreError::InvalidInput,
        ),
        (
            browser,
            &f.conversation,
            0,
            101,
            RuntimeStoreError::InvalidInput,
        ),
    ] {
        assert_eq!(
            f.store
                .held_owner_inputs_for_browser(credential, conversation, after, limit)
                .await
                .unwrap_err(),
            error
        );
    }
    assert_eq!(snapshot(&f.store).await, before);
    // Recheck in the projection transaction even if an earlier route-level
    // authentication succeeded before revocation.
    assert_eq!(
        f.store.authenticate(browser).await.unwrap(),
        Some(f.owner.clone())
    );
    f.store.revoke_session(browser).await.unwrap();
    assert_eq!(
        f.store
            .held_owner_inputs_for_browser(browser, &f.conversation, 0, 10)
            .await
            .unwrap_err(),
        RuntimeStoreError::Unauthorized
    );
    f.store.save_session(browser, &f.owner).await.unwrap();
    sqlx::query("UPDATE auth_sessions SET expires_at=0 WHERE token_hash=?")
        .bind(crate::digest(browser))
        .execute(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(
        f.store
            .held_owner_inputs_for_browser(browser, &f.conversation, 0, 10)
            .await
            .unwrap_err(),
        RuntimeStoreError::Unauthorized
    );
    assert_eq!(snapshot(&f.store).await, before);
    f.store.close().await;
    std::fs::remove_dir_all(f.root).unwrap();
    foreign.store.close().await;
    std::fs::remove_dir_all(foreign.root).unwrap();
}
