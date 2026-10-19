use super::*;
use crate::production_runtime::tests as fixtures;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn retained_recovery_cannot_issue_or_reattach_after_reconciliation() {
    for before_issue in [true, false] {
        let root = std::path::PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap())
            .join(format!("retired-revalidate-{}", Uuid::new_v4()));
        super::retired_process_tests::seed_closed(root.clone(), false).await;
        let store = Store::open(&root.join("core.sqlite3")).await.unwrap();
        let conversation = ConversationId(
            std::fs::read_to_string(root.join("conversation"))
                .unwrap()
                .parse()
                .unwrap(),
        );
        let browser = "synthetic-browser-window";
        let recovered = store
            .recover_retired_execution_window_authenticated(
                browser,
                &conversation,
                fixtures::config(ProductionTakeover::First),
            )
            .await
            .unwrap();
        let owner = store
            .credentials("synthetic-owner")
            .await
            .unwrap()
            .unwrap()
            .0;
        let case = fixtures::Case {
            store: store.clone(),
            handle: store.clone(),
            root,
            owner,
            conversation: conversation.clone(),
            token: String::new(),
        };
        let previous = store
            .execution_window_status_authenticated(browser, &conversation)
            .await
            .unwrap()
            .unwrap();
        let mut request = super::tests::input(&case, "revalidation-next-source").await;
        request.expected_generation = previous.generation;
        request.predecessor_window_id = Some(previous.window_id);
        let next = store
            .admit_execution_window_authenticated(browser, &conversation, &request)
            .await
            .unwrap();
        let cap = if before_issue {
            None
        } else {
            Some(
                recovered
                    .store()
                    .issue_idle_execution_window_credential_authenticated(
                        browser,
                        next.status.window_id,
                        next.status.generation,
                        "revalidation-boot",
                        next.status.expires_at_ms,
                        &"b".repeat(64),
                    )
                    .await
                    .unwrap(),
            )
        };
        // Ordinary negative-only API changes the history after discovery/ACK.
        store
            .reconcile_execution_window_authenticated(
                browser,
                &conversation,
                next.status.window_id,
                next.status.generation,
            )
            .await
            .unwrap();
        if let Some(cap) = cap {
            assert!(store
                .reattach_terminal_supervisor(
                    cap.credential(),
                    fixtures::config(ProductionTakeover::ExpiredPredecessor {
                        incarnation_id: recovered.predecessor_incarnation().into(),
                    }),
                    recovered.prior_run()
                )
                .await
                .is_err());
        } else {
            assert!(recovered
                .store()
                .issue_idle_execution_window_credential_authenticated(
                    browser,
                    next.status.window_id,
                    next.status.generation,
                    "revalidation-boot",
                    next.status.expires_at_ms,
                    &"b".repeat(64)
                )
                .await
                .is_err());
        }
        let bound: i64 =
            sqlx::query_scalar("SELECT credential_bound FROM execution_windows WHERE id=?")
                .bind(next.status.window_id.to_string())
                .fetch_one(&store.pool)
                .await
                .unwrap();
        assert_eq!(bound, 0);
        let generation: i64 = sqlx::query_scalar("SELECT generation FROM production_supervisors")
            .fetch_one(&store.pool)
            .await
            .unwrap();
        assert_eq!(generation, 1);
        let reservations: i64 =
            sqlx::query_scalar("SELECT count(*) FROM production_resume_metadata")
                .fetch_one(&store.pool)
                .await
                .unwrap();
        assert_eq!(reservations, 0);
    }
}
