use super::*;
use crate::production_runtime::{
    observation_tests::input as event,
    tests::{claim, config, ready, setup, snapshot, Case},
};
use orkestr_v2_application::IntakeStore;
use orkestr_v2_contracts::{MessageInput, RunId};

fn copy_config(c: &ProductionSupervisorConfig) -> ProductionSupervisorConfig {
    ProductionSupervisorConfig {
        provider: c.provider,
        namespace: c.namespace.clone(),
        supervisor_key: c.supervisor_key.clone(),
        takeover: match &c.takeover {
            ProductionTakeover::First => ProductionTakeover::First,
            ProductionTakeover::ExpiredPredecessor { incarnation_id } => {
                ProductionTakeover::ExpiredPredecessor {
                    incarnation_id: incarnation_id.clone(),
                }
            }
        },
    }
}
async fn consumed(f: &Case, role: Role) -> ProviderAdmission {
    let provider = f.handle.context().unwrap().provider;
    let roles = f
        .handle
        .ensure_role_bindings(&f.owner, &f.conversation)
        .await
        .unwrap();
    let starting = if role == Role::Deep {
        roles.deep
    } else {
        roles.fast
    };
    let link = if provider == ProviderKind::Claude {
        let metadata = f
            .handle
            .authorize_session_metadata(&starting)
            .await
            .unwrap();
        Some(
            f.handle
                .initialize_claude_session(
                    metadata,
                    crate::production_runtime::claude_identity::ClaudeProcessInitialization {
                        requested_native_session_id: Uuid::new_v4().to_string(),
                        protocol_version: "claude-control-v1".into(),
                        source_event_key: "stopped-retirement-init".into(),
                    },
                )
                .await
                .unwrap(),
        )
    } else {
        None
    };
    let b = if let Some(link) = &link {
        link.binding().clone()
    } else if role == Role::Deep {
        ready(f).await
    } else {
        f.handle
            .confirm_native_session(NativeSessionConfirmation {
                session_id: starting.session_id,
                expected_generation: starting.generation,
                native_session_id: "synthetic-native-retired-fast".into(),
                protocol_version: "synthetic-1".into(),
                source_event_key: "fast-retired-ready".into(),
            })
            .await
            .unwrap()
    };
    let a = if role == Role::Deep {
        let input = claim(f, &b).await;
        f.handle
            .admit_run(&input, &b.session_id, b.generation, "stopped-retire")
            .await
            .unwrap()
    } else {
        let input = f
            .store
            .admit(
                &f.owner,
                &f.conversation,
                &MessageInput {
                    client_message_id: "stopped-fast".into(),
                    text: "synthetic presentation".into(),
                },
            )
            .await
            .unwrap();
        f.handle
            .admit_fast(
                &f.token,
                &FastAdmissionInput {
                    source_message_id: input.receipt.message_id,
                    source_event_id: input.receipt.event_id,
                    fast_binding_id: b.session_id,
                    expected_binding_generation: b.generation,
                    request_key: "fast-retire".into(),
                },
            )
            .await
            .unwrap()
    };
    let DispatchClaimResult::Reserved(reservation) = f
        .handle
        .claim_provider_dispatch(&a, "retire-reserve")
        .await
        .unwrap()
    else {
        panic!()
    };
    let ExecutionConsumption::Dispatch(dispatch) =
        f.handle.consume_execution(&reservation).await.unwrap()
    else {
        panic!()
    };
    let dispatch = if let Some(link) = link {
        link.attach_execution(*dispatch).unwrap()
    } else {
        *dispatch
    };
    if provider == ProviderKind::Claude {
        f.handle
            .observe_claude_session(
                dispatch.provider(),
                b.native_session_id.as_deref().unwrap(),
                "stopped-retirement-native-init",
            )
            .await
            .unwrap();
    }
    f.handle
        .append_provider_event(
            &f.owner,
            &a.provider,
            &event(&a.provider, 1, ProviderEvent::Started),
        )
        .await
        .unwrap();
    a.provider
}
async fn stopped(f: &Case, p: &ProviderAdmission) -> ProviderAdmission {
    let cancel = f
        .handle
        .request_cancel(&f.owner, &p.run.run_id, "retire-stop")
        .await
        .unwrap();
    let mut control = p.clone();
    control.run = cancel.new_fenced_admission;
    f.handle
        .append_provider_event(
            &f.owner,
            &control,
            &event(&control, 2, ProviderEvent::Stopped),
        )
        .await
        .unwrap();
    control
}
async fn assert_refused(f: &Case, run: &RunId) {
    let before = snapshot(&f.store).await;
    assert!(f
        .handle
        .retire_terminal_supervisor(&f.token, run)
        .await
        .is_err());
    assert_eq!(before, snapshot(&f.store).await);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stopped_deep_fast_and_provider_preserving_restart_never_reissues_input() {
    for (role, provider) in [
        (Role::Deep, ProviderKind::Codex),
        (Role::Fast, ProviderKind::Codex),
        (Role::Deep, ProviderKind::Claude),
        (Role::Fast, ProviderKind::Claude),
    ] {
        let mut f = setup().await;
        let mut cfg = config(ProductionTakeover::First);
        if provider == ProviderKind::Claude {
            cfg.provider = provider;
            cfg.supervisor_key = "synthetic-claude-retirement".into();
            f.handle = f
                .store
                .authorize_supervisor(&f.token, copy_config(&cfg))
                .await
                .unwrap();
        }
        let p = consumed(&f, role).await;
        f.store
            .admit(
                &f.owner,
                &f.conversation,
                &MessageInput {
                    client_message_id: "pre-stop-held".into(),
                    text: "old input".into(),
                },
            )
            .await
            .unwrap();
        let control = stopped(&f, &p).await;
        let before = snapshot(&f.store).await;
        assert!(f
            .store
            .terminal_supervisor_candidate(&f.token, &cfg, &f.conversation)
            .await
            .unwrap()
            .is_none());
        f.handle
            .retire_terminal_supervisor(&f.token, &p.run.run_id)
            .await
            .unwrap();
        f.handle
            .retire_terminal_supervisor(&f.token, &p.run.run_id)
            .await
            .unwrap();
        let retired = snapshot(&f.store).await;
        let unchanged = |rows: Vec<String>| {
            rows.into_iter()
                .filter(|r| {
                    !r.starts_with("production_supervisors:")
                        && !r.starts_with("production_stopped_retirements:")
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(unchanged(before), unchanged(retired));
        let reopened = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
        let candidate = reopened
            .terminal_supervisor_candidate(&f.token, &cfg, &f.conversation)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(candidate.0, p.run.run_id);
        cfg.takeover = ProductionTakeover::ExpiredPredecessor {
            incarnation_id: candidate.1,
        };
        let (next, grant) = reopened
            .reattach_terminal_supervisor(&f.token, copy_config(&cfg), &p.run.run_id)
            .await
            .unwrap();
        assert_eq!(grant.binding().role, role);
        assert_eq!(grant.binding().provider_kind, provider);
        assert_eq!(
            grant.binding().native_session_id,
            p.binding.native_session_id
        );
        next.with_metadata_fence(&grant, || Ok::<_, ()>(()))
            .unwrap()
            .unwrap();
        assert!(reopened
            .reattach_terminal_supervisor(&f.token, cfg, &p.run.run_id)
            .await
            .is_err());
        assert!(f
            .handle
            .with_cancellation_fence(&control, || Ok::<_, ()>(()))
            .is_err());
        assert_refused(&f, &p.run.run_id).await;
        assert!(reopened
            .terminal_supervisor_candidate(
                &f.token,
                &config(ProductionTakeover::First),
                &f.conversation
            )
            .await
            .unwrap()
            .is_none());
        let held: i64 = sqlx::query_scalar("SELECT count(*) FROM production_held_inputs")
            .fetch_one(&f.store.pool)
            .await
            .unwrap();
        assert_eq!(held, if role == Role::Deep { 1 } else { 0 });
        if role == Role::Deep {
            assert!(
                !next
                    .held_owner_inputs_authenticated(&f.token, &f.conversation, 0, 50)
                    .await
                    .unwrap()
                    .eligible_input_available
            );
        }
    }
}

#[tokio::test]
async fn stop_intent_and_not_dispatched_never_establish_retirement() {
    let f = setup().await;
    let p = consumed(&f, Role::Deep).await;
    assert_refused(&f, &p.run.run_id).await;
    f.handle
        .request_cancel(&f.owner, &p.run.run_id, "ack-only")
        .await
        .unwrap();
    assert_refused(&f, &p.run.run_id).await;
    let f = setup().await;
    let b = ready(&f).await;
    let input = claim(&f, &b).await;
    let a = f
        .handle
        .admit_run(&input, &b.session_id, b.generation, "not-dispatched")
        .await
        .unwrap();
    f.handle
        .request_cancel(&f.owner, &a.provider.run.run_id, "before-io")
        .await
        .unwrap();
    assert_refused(&f, &a.provider.run.run_id).await;
}

#[tokio::test]
async fn stopped_retirement_requires_exact_issued_control_and_current_binding() {
    let f = setup().await;
    let p = consumed(&f, Role::Deep).await;
    stopped(&f, &p).await;
    for (damage,repair) in [
        ("UPDATE production_control_outbox SET state='pending'","UPDATE production_control_outbox SET state='acknowledged'"),
        ("UPDATE production_run_leases SET purpose='execution' WHERE purpose='cancellation_acknowledgement'","UPDATE production_run_leases SET purpose='cancellation_acknowledgement' WHERE generation=2"),
        ("UPDATE production_cancellations SET dispatch_fence=dispatch_fence+1","UPDATE production_cancellations SET dispatch_fence=dispatch_fence-1"),
        ("UPDATE production_observations SET lease_generation=lease_generation+1 WHERE kind='stopped'","UPDATE production_observations SET lease_generation=lease_generation-1 WHERE kind='stopped'"),
        ("UPDATE session_bindings SET generation=generation+1 WHERE role='deep'","UPDATE session_bindings SET generation=generation-1 WHERE role='deep'"),
    ] {
        sqlx::query(damage).execute(&f.store.pool).await.unwrap();
        assert_refused(&f,&p.run.run_id).await;
        sqlx::query(repair).execute(&f.store.pool).await.unwrap();
    }
    assert_refused(&f, &RunId(Uuid::new_v4())).await;
    f.store.revoke_session(&f.token).await.unwrap();
    assert_refused(&f, &p.run.run_id).await;
}

#[tokio::test]
async fn stopped_without_graceful_marker_or_with_unresolved_sibling_cannot_restart() {
    let f = setup().await;
    let p = consumed(&f, Role::Deep).await;
    stopped(&f, &p).await;
    // A newer candidate is unresolved, even though the selected predecessor is Stopped.
    let b = f
        .handle
        .ensure_role_bindings(&f.owner, &f.conversation)
        .await
        .unwrap()
        .deep;
    f.store
        .admit(
            &f.owner,
            &f.conversation,
            &MessageInput {
                client_message_id: "new-sibling".into(),
                text: "new intent".into(),
            },
        )
        .await
        .unwrap();
    let input = f
        .handle
        .claim_next(
            &f.owner,
            &f.conversation,
            &b.session_id,
            std::time::Duration::from_secs(60),
        )
        .await
        .unwrap()
        .unwrap();
    let a = f
        .handle
        .admit_run(&input, &b.session_id, b.generation, "sibling-candidate")
        .await
        .unwrap();
    assert_refused(&f, &p.run.run_id).await;
    f.handle
        .request_cancel(&f.owner, &a.provider.run.run_id, "sibling-not-dispatched")
        .await
        .unwrap();
    assert_refused(&f, &p.run.run_id).await;
    sqlx::query("UPDATE production_supervisors SET lease_deadline_ms=0")
        .execute(&f.store.pool)
        .await
        .unwrap();
    let before = snapshot(&f.store).await;
    assert!(f
        .store
        .terminal_supervisor_candidate(
            &f.token,
            &config(ProductionTakeover::First),
            &f.conversation
        )
        .await
        .unwrap()
        .is_none());
    assert!(f
        .store
        .reattach_terminal_supervisor(
            &f.token,
            config(ProductionTakeover::ExpiredPredecessor {
                incarnation_id: f.handle.supervisor_incarnation().unwrap().into()
            }),
            &p.run.run_id
        )
        .await
        .is_err());
    assert_eq!(before, snapshot(&f.store).await);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stopped_setup_and_retirement_serialize_and_expiry_cannot_mint_provenance() {
    let f = setup().await;
    let p = consumed(&f, Role::Deep).await;
    stopped(&f, &p).await;
    let binding = f
        .handle
        .ensure_role_bindings(&f.owner, &f.conversation)
        .await
        .unwrap()
        .deep;
    let pool = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let other = f.handle.reattach_supervisor(&pool).await.unwrap();
    let (retirement, reservation) = tokio::join!(
        f.handle.retire_terminal_supervisor(&f.token, &p.run.run_id),
        other.authorize_stopped_session_metadata(&f.token, &p.run.run_id, &binding)
    );
    assert_ne!(retirement.is_ok(), reservation.is_ok());
    let f = setup().await;
    let p = consumed(&f, Role::Deep).await;
    stopped(&f, &p).await;
    // Test-only clock boundary mutation: the public API must not treat expiry as reap.
    sqlx::query("UPDATE production_supervisors SET lease_deadline_ms=1")
        .execute(&f.store.pool)
        .await
        .unwrap();
    assert_refused(&f, &p.run.run_id).await;
}

#[tokio::test]
async fn recorded_stopped_restart_rechecks_control_auth_and_exact_predecessor() {
    let f = setup().await;
    let p = consumed(&f, Role::Deep).await;
    stopped(&f, &p).await;
    f.handle
        .retire_terminal_supervisor(&f.token, &p.run.run_id)
        .await
        .unwrap();
    let cfg = config(ProductionTakeover::ExpiredPredecessor {
        incarnation_id: f.handle.supervisor_incarnation().unwrap().into(),
    });
    let before = snapshot(&f.store).await;
    let wrong = config(ProductionTakeover::ExpiredPredecessor {
        incarnation_id: Uuid::new_v4().to_string(),
    });
    assert!(f
        .store
        .reattach_terminal_supervisor(&f.token, wrong, &p.run.run_id)
        .await
        .is_err());
    assert_eq!(before, snapshot(&f.store).await);
    sqlx::query("UPDATE production_control_outbox SET state='pending'")
        .execute(&f.store.pool)
        .await
        .unwrap();
    let before = snapshot(&f.store).await;
    assert!(f
        .store
        .terminal_supervisor_candidate(&f.token, &cfg, &f.conversation)
        .await
        .unwrap()
        .is_none());
    assert!(f
        .store
        .reattach_terminal_supervisor(&f.token, copy_config(&cfg), &p.run.run_id)
        .await
        .is_err());
    assert_eq!(before, snapshot(&f.store).await);
    sqlx::query("UPDATE production_control_outbox SET state='acknowledged'")
        .execute(&f.store.pool)
        .await
        .unwrap();
    f.store.revoke_session(&f.token).await.unwrap();
    let before = snapshot(&f.store).await;
    assert!(f
        .store
        .terminal_supervisor_candidate(&f.token, &cfg, &f.conversation)
        .await
        .is_err());
    assert!(f
        .store
        .reattach_terminal_supervisor(&f.token, cfg, &p.run.run_id)
        .await
        .is_err());
    assert_eq!(before, snapshot(&f.store).await);
}
