use super::*;
use crate::production_runtime::tests as fixtures;

#[tokio::test]
async fn window_eligibility_ignores_old_unadmitted_inputs_without_spending_resume_setup() {
    let f = fixtures::setup().await;
    let _binding = fixtures::ready(&f).await;
    let browser = super::tests::browser(&f).await;
    let _old = super::tests::input(&f, "unadmitted-old").await;
    let request = super::tests::input(&f, "window-input").await;
    let admitted = f
        .store
        .admit_execution_window_authenticated(&browser, &f.conversation, &request)
        .await
        .unwrap();
    let grant = f
        .handle
        .issue_execution_window_credential(
            &f.token,
            admitted.status.window_id,
            1,
            "synthetic-boot",
            admitted.status.expires_at_ms,
            &"a".repeat(64),
        )
        .await
        .unwrap();
    let bound = f
        .handle
        .bind_execution_window(&f.token, &grant)
        .await
        .unwrap();
    // Successor setup checks eligibility while its own window is still opening.
    assert!(
        bound
            .held_owner_inputs_authenticated(grant.credential(), &f.conversation, 0, 1)
            .await
            .unwrap()
            .eligible_input_available
    );
    bound
        .activate_execution_window(
            grant.credential(),
            admitted.status.window_id,
            1,
            "synthetic-boot",
        )
        .await
        .unwrap();
    // Simulate the committed consumption of the admitted turn. Old input is
    // still queued and visible to the browser, but cannot be claimed here.
    sqlx::query("UPDATE reasoning_inbox SET state='consumed' WHERE event_id=?")
        .bind(request.input_event_id.to_string())
        .execute(&f.store.pool)
        .await
        .unwrap();
    assert!(
        f.store
            .held_owner_inputs_for_browser(&browser, &f.conversation, 0, 1)
            .await
            .unwrap()
            .eligible_input_available
    );
    assert!(
        !bound
            .held_owner_inputs_authenticated(grant.credential(), &f.conversation, 0, 1)
            .await
            .unwrap()
            .eligible_input_available
    );
    let mut follow = super::tests::input(&f, "fresh-follow-up").await;
    assert!(
        !bound
            .held_owner_inputs_authenticated(grant.credential(), &f.conversation, 0, 1)
            .await
            .unwrap()
            .eligible_input_available
    );
    follow.expected_generation = 1;
    follow.window_id = Some(admitted.status.window_id);
    f.store
        .admit_execution_window_authenticated(&browser, &f.conversation, &follow)
        .await
        .unwrap();
    assert!(
        bound
            .held_owner_inputs_authenticated(grant.credential(), &f.conversation, 0, 1)
            .await
            .unwrap()
            .eligible_input_available
    );
    let setups: i64 = sqlx::query_scalar("SELECT count(*) FROM production_resume_metadata")
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(setups, 0);
}
