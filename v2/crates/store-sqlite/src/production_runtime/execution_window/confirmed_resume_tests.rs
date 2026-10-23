//! A confirmed but unused native setup survives a proven closed-window cut.
use super::*;
use crate::production_runtime::tests as fixtures;

#[tokio::test]
async fn confirmed_idle_setup_gets_one_new_reservation_only_in_a_proven_successor_window() {
    for provider in [ProviderKind::Codex, ProviderKind::Claude] {
        let selected = |takeover| {
            let mut config = fixtures::config(takeover);
            config.provider = provider;
            config
        };
        for metadata_state in ["issued", "confirmed", "wrong_binding"] {
            let root = std::path::PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap())
                .join(format!("confirmed-window-resume-{}", Uuid::new_v4()));
            super::retired_process_tests::seed_closed_provider(root.clone(), false, provider).await;
            let store = Store::open(&root.join("core.sqlite3")).await.unwrap();
            let conversation = ConversationId(
                std::fs::read_to_string(root.join("conversation"))
                    .unwrap()
                    .parse()
                    .unwrap(),
            );
            let browser = &"de".repeat(32);
            let owner = store
                .credentials("synthetic-owner")
                .await
                .unwrap()
                .unwrap()
                .0;
            store.save_session(browser, &owner).await.unwrap();
            // Reproduce the exact durable cut left by a confirmed setup with no
            // subsequent Deep run. No production writer or grant is synthesized.
            let row = sqlx::query("SELECT r.id,r.context_id,r.incarnation_id,r.session_id,t.event_id,b.generation,b.native_session_id FROM execution_windows w JOIN production_runs r ON r.id=w.terminal_run_id JOIN production_terminal_evidence t ON t.run_id=r.id JOIN session_bindings b ON b.id=r.session_id WHERE w.conversation_id=?")
            .bind(conversation.to_string()).fetch_one(&store.pool).await.unwrap();
            let prior_run = RunId(row.get::<String, _>("id").parse().unwrap());
            let original_id = Uuid::new_v4().to_string();
            let state = if metadata_state == "issued" {
                "issued"
            } else {
                "confirmed"
            };
            let confirmation = (state == "confirmed").then(|| "c".repeat(64));
            let generation =
                row.get::<i64, _>("generation") + i64::from(metadata_state == "wrong_binding");
            sqlx::query("INSERT INTO production_resume_metadata(id,prior_run_id,terminal_event_id,context_id,incarnation_id,session_id,binding_generation,state,confirmation_digest) VALUES(?,?,?,?,?,?,?,?,?)")
            .bind(&original_id).bind(prior_run.to_string()).bind(row.get::<String, _>("event_id"))
            .bind(row.get::<String, _>("context_id")).bind(row.get::<String, _>("incarnation_id"))
            .bind(row.get::<String, _>("session_id")).bind(generation).bind(state).bind(&confirmation)
            .execute(&store.pool).await.unwrap();
            if provider == ProviderKind::Claude {
                sqlx::query("INSERT INTO production_requested_native(session_id,binding_generation,context_id,incarnation_id,requested_native_id,initialization_key) VALUES(?,?,?,?,?,'old-idle-setup')")
                .bind(row.get::<String, _>("session_id")).bind(row.get::<i64, _>("generation"))
                .bind(row.get::<String, _>("context_id")).bind(row.get::<String, _>("incarnation_id"))
                .bind(row.get::<String, _>("native_session_id")).execute(&store.pool).await.unwrap();
            }
            let recovered = store
                .recover_retired_execution_window_authenticated(
                    browser,
                    &conversation,
                    selected(ProductionTakeover::First),
                )
                .await;
            if metadata_state != "confirmed" {
                assert!(matches!(recovered, Err(RuntimeStoreError::Fenced)));
                continue;
            }
            let recovered = recovered.unwrap();
            // The generic non-window restart port still never reissues a setup.
            assert!(store
                .terminal_supervisor_candidate(
                    browser,
                    &selected(ProductionTakeover::First),
                    &conversation
                )
                .await
                .unwrap()
                .is_none());
            assert!(
                store
                    .reattach_terminal_supervisor(
                        browser,
                        selected(ProductionTakeover::ExpiredPredecessor {
                            incarnation_id: recovered.predecessor_incarnation().into(),
                        }),
                        &prior_run,
                    )
                    .await
                    .is_err(),
                "a confirmed setup cannot reopen through a non-window browser credential"
            );
            let previous = store
                .execution_window_status_authenticated(browser, &conversation)
                .await
                .unwrap()
                .unwrap();
            let f = fixtures::Case {
                store: store.clone(),
                handle: store.clone(),
                root,
                owner,
                conversation: conversation.clone(),
                token: String::new(),
            };
            let mut request = super::tests::input(&f, "next-timer-input").await;
            request.expected_generation = previous.generation;
            request.predecessor_window_id = Some(previous.window_id);
            let next = store
                .admit_execution_window_authenticated(browser, &conversation, &request)
                .await
                .unwrap();
            let cap = recovered
                .store()
                .issue_idle_execution_window_credential_authenticated(
                    browser,
                    next.status.window_id,
                    next.status.generation,
                    "successor-boot",
                    next.status.expires_at_ms,
                    &"b".repeat(64),
                )
                .await
                .unwrap();
            let config = || {
                selected(ProductionTakeover::ExpiredPredecessor {
                    incarnation_id: recovered.predecessor_incarnation().into(),
                })
            };
            let (bound, metadata) = store
                .reattach_terminal_supervisor(cap.credential(), config(), &prior_run)
                .await
                .unwrap();
            assert!(store
                .reattach_terminal_supervisor(cap.credential(), config(), &prior_run)
                .await
                .is_err());
            let binding = metadata.binding().clone();
            let ready = if provider == ProviderKind::Claude {
                bound
                    .initialize_claude_session(
                        metadata,
                        super::super::claude_identity::ClaudeProcessInitialization {
                            requested_native_session_id: binding.native_session_id.clone().unwrap(),
                            protocol_version: "claude-control-v1".into(),
                            source_event_key: "successor-claude-init".into(),
                        },
                    )
                    .await
                    .unwrap()
            } else {
                bound
                    .confirm_metadata_session(
                        metadata,
                        NativeSessionConfirmation {
                            session_id: binding.session_id.clone(),
                            expected_generation: binding.generation,
                            native_session_id: binding.native_session_id.clone().unwrap(),
                            protocol_version: "synthetic-successor".into(),
                            source_event_key: "successor-native-ready".into(),
                        },
                    )
                    .await
                    .unwrap()
            };
            assert!(bound
                .authorize_accepted_session_metadata(cap.credential(), &prior_run, ready.binding())
                .await
                .is_err());
            if provider == ProviderKind::Claude {
                bound
                    .activate_execution_window(
                        cap.credential(),
                        next.status.window_id,
                        next.status.generation,
                        "successor-boot",
                    )
                    .await
                    .unwrap();
                let claim = bound
                    .claim_next(
                        &f.owner,
                        &conversation,
                        &binding.session_id,
                        std::time::Duration::from_secs(30),
                    )
                    .await
                    .unwrap()
                    .unwrap();
                let run = bound
                    .admit_run(
                        &claim,
                        &binding.session_id,
                        binding.generation,
                        "successor-claude-run",
                    )
                    .await
                    .unwrap();
                let DispatchClaimResult::Reserved(reservation) = bound
                    .claim_provider_dispatch(&run, "successor-claude-dispatch")
                    .await
                    .unwrap()
                else {
                    panic!()
                };
                let ExecutionConsumption::Dispatch(dispatch) =
                    bound.consume_execution(&reservation).await.unwrap()
                else {
                    panic!()
                };
                let dispatch = ready.attach_execution(*dispatch).unwrap();
                let p = dispatch.provider();
                let started = crate::production_runtime::observation_tests::input(
                    p,
                    1,
                    ProviderEvent::Started,
                );
                assert!(matches!(
                    bound.append_provider_event(&f.owner, p, &started).await,
                    Err(RuntimeStoreError::Fenced)
                ));
                // Absence of this incarnation's initialization must also fail
                // closed; old observed/unobserved history supplies no identity.
                let current_request=sqlx::query("SELECT * FROM production_requested_native WHERE session_id=? AND binding_generation=? AND incarnation_id!=?")
                    .bind(binding.session_id.to_string()).bind(i64::try_from(binding.generation).unwrap())
                    .bind(row.get::<String,_>("incarnation_id")).fetch_one(&store.pool).await.unwrap();
                sqlx::query("DELETE FROM production_requested_native WHERE session_id=? AND binding_generation=? AND incarnation_id=?")
                    .bind(binding.session_id.to_string()).bind(i64::try_from(binding.generation).unwrap())
                    .bind(current_request.get::<String,_>("incarnation_id")).execute(&store.pool).await.unwrap();
                assert!(matches!(
                    bound.append_provider_event(&f.owner, p, &started).await,
                    Err(RuntimeStoreError::Fenced)
                ));
                sqlx::query("INSERT INTO production_requested_native(session_id,binding_generation,context_id,incarnation_id,requested_native_id,initialization_key) VALUES(?,?,?,?,?,?)")
                    .bind(binding.session_id.to_string()).bind(i64::try_from(binding.generation).unwrap())
                    .bind(current_request.get::<String,_>("context_id")).bind(current_request.get::<String,_>("incarnation_id"))
                    .bind(current_request.get::<String,_>("requested_native_id")).bind(current_request.get::<String,_>("initialization_key"))
                    .execute(&store.pool).await.unwrap();
                bound
                    .observe_claude_session(
                        p,
                        binding.native_session_id.as_deref().unwrap(),
                        "new-window-native-init",
                    )
                    .await
                    .unwrap();
                bound
                    .append_provider_event(&f.owner, p, &started)
                    .await
                    .unwrap();
                let old_unobserved:i64=sqlx::query_scalar("SELECT count(*) FROM production_requested_native WHERE session_id=? AND binding_generation=? AND incarnation_id=? AND observed_run_id IS NULL AND observed_event_key IS NULL")
                .bind(binding.session_id.to_string()).bind(i64::try_from(binding.generation).unwrap()).bind(row.get::<String,_>("incarnation_id")).fetch_one(&store.pool).await.unwrap();
                assert_eq!(
                    old_unobserved, 1,
                    "the new run must never promote the old idle initialization"
                );
                let observed:i64=sqlx::query_scalar("SELECT count(*) FROM production_requested_native WHERE session_id=? AND binding_generation=? AND observed_run_id=?")
                .bind(binding.session_id.to_string()).bind(i64::try_from(binding.generation).unwrap()).bind(p.run.run_id.to_string()).fetch_one(&store.pool).await.unwrap();
                assert_eq!(
                    observed, 1,
                    "only this incarnation gets actual identity evidence"
                );
            }
            let saved = sqlx::query("SELECT state,confirmation_digest,incarnation_id FROM production_resume_metadata WHERE id=?").bind(&original_id).fetch_one(&store.pool).await.unwrap();
            assert_eq!(saved.get::<String, _>("state"), "confirmed");
            assert_eq!(
                saved.get::<Option<String>, _>("confirmation_digest"),
                confirmation
            );
            assert_eq!(
                saved.get::<String, _>("incarnation_id"),
                row.get::<String, _>("incarnation_id")
            );
            let count: i64 = sqlx::query_scalar("SELECT count(*) FROM production_resume_metadata WHERE prior_run_id=? AND state='confirmed'").bind(prior_run.to_string()).fetch_one(&store.pool).await.unwrap();
            assert_eq!(
                count, 2,
                "distinct immutable reservations across proven incarnation cut"
            );
        }
    }
}
