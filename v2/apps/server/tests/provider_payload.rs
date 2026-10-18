//! Actual HTTP against ordinary supervisor-bound Store; no provider process.
use orkestr_v2_application::{runtime::*, IntakeStore};
use orkestr_v2_contracts::MessageInput;
use orkestr_v2_server::{router, AppState};
use orkestr_v2_store_sqlite::Store;
use std::time::Duration;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cookie_scoped_progress_read_and_csrf_removal() {
    for consumed in [true] {
        let root = std::env::temp_dir().join(format!("stop-http-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let store = Store::open(&root.join("state.sqlite3")).await.unwrap();
        let conversation = store
            .setup("synthetic-owner", "synthetic-hash")
            .await
            .unwrap();
        let owner = store
            .credentials("synthetic-owner")
            .await
            .unwrap()
            .unwrap()
            .0;
        let token = "ad".repeat(32);
        store.save_session(&token, &owner).await.unwrap();
        store
            .save_session(&format!("browser:{token}"), &owner)
            .await
            .unwrap();
        let bound = store
            .authorize_supervisor(
                &token,
                ProductionSupervisorConfig {
                    provider: ProviderKind::Codex,
                    namespace: "synthetic-http".into(),
                    supervisor_key: "synthetic-deep".into(),
                    takeover: ProductionTakeover::First,
                },
            )
            .await
            .unwrap();
        let binding = bound
            .ensure_role_bindings(&owner, &conversation)
            .await
            .unwrap()
            .deep;
        let binding = bound
            .confirm_native_session(NativeSessionConfirmation {
                session_id: binding.session_id,
                expected_generation: binding.generation,
                native_session_id: "synthetic-http-native".into(),
                protocol_version: "codex-rpc-1".into(),
                source_event_key: "ready:1".into(),
            })
            .await
            .unwrap();
        store
            .admit(
                &owner,
                &conversation,
                &MessageInput {
                    client_message_id: "input:1".into(),
                    text: "synthetic input".into(),
                },
            )
            .await
            .unwrap();
        let claim = bound
            .claim_next(
                &owner,
                &conversation,
                &binding.session_id,
                Duration::from_secs(60),
            )
            .await
            .unwrap()
            .unwrap();
        let admission = bound
            .admit_run(&claim, &binding.session_id, binding.generation, "run:1")
            .await
            .unwrap();
        if consumed {
            let reserved = bound
                .claim_provider_dispatch(&admission, "reserve:1")
                .await
                .unwrap();
            let DispatchClaimResult::Reserved(claim) = reserved else {
                panic!("fresh reservation required")
            };
            let cap = bound.consume_execution(&claim).await.unwrap();
            assert!(matches!(
                cap,
                orkestr_v2_store_sqlite::ExecutionConsumption::Dispatch(_)
            ));
        }
        let provider = &admission.provider;
        for (sequence, event) in [
            (1, ProviderEvent::Started),
            (
                2,
                ProviderEvent::Progress("synthetic progress <untrusted>".into()),
            ),
        ] {
            bound
                .append_provider_event(
                    &owner,
                    provider,
                    &ProviderEventInput {
                        run_id: provider.run.run_id.clone(),
                        session_id: provider.run.session_id.clone(),
                        lease_generation: provider.run.lease_generation,
                        dispatch_fence: provider.run.dispatch_fence,
                        sequence,
                        event,
                    },
                )
                .await
                .unwrap();
        }
        let payload_id = store
            .execution_status(&owner, &conversation)
            .await
            .unwrap()
            .unwrap()
            .progress
            .unwrap()
            .payload_id;
        let port = std::env::var("ORKESTR_V2_TEST_PORT").unwrap_or_else(|_| "0".into());
        let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{port}"))
            .await
            .unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let state = AppState::new(
            store.clone(),
            "synthetic-bootstrap-token-at-least-32-bytes".into(),
            origin.clone(),
        )
        .unwrap()
        .with_execution_store(bound);
        let task = tokio::spawn(async move {
            axum::serve(listener, router(state)).await.unwrap();
        });
        let command_origin = origin.clone();
        let command_conversation = conversation.to_string();
        let command_payload = payload_id.to_string();
        let output = tokio::task::spawn_blocking(move || {
            std::process::Command::new("python3")
                .arg(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/../../tests/provider_payload.py"
                ))
                .arg(&command_origin)
                .arg(command_conversation)
                .arg(command_payload)
                .output()
                .unwrap()
        })
        .await
        .unwrap();
        task.abort();
        let _ = task.await;
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }
}
