//! Property: a stranded window (no owner, no live manager budget, past its
//! hard deadline) always becomes terminal, whatever role × state ×
//! observation its runs were left in, and the conversation opens its next
//! window. Within the acceptance grace the owner first accepts every proposal
//! it can read; nothing else needs an operator.
use super::*;
use crate::production_runtime::execution_window::stranded::ACCEPTANCE_GRACE_MS;
use orkestr_v2_application::runtime::RuntimeStore;

/// How a run was left when its process vanished.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Left {
    /// Consumed, never started.
    Starting,
    /// Started with progress, then nothing.
    Running,
    /// Its broker died: `lost` observation.
    Lost,
    /// Provider-reported failure observation.
    Failed,
    /// Completed proposal awaiting the owner.
    Proposed,
    /// Stop requested, never acknowledged.
    CancelRequested,
}
const ALL: [Left; 6] = [
    Left::Starting,
    Left::Running,
    Left::Lost,
    Left::Failed,
    Left::Proposed,
    Left::CancelRequested,
];

async fn leave(w: &Window, run: &ProviderAdmission, left: Left, started: bool) {
    let mut kinds = Vec::new();
    if !started && left != Left::Starting {
        kinds.push(ProviderEvent::Started);
    }
    match left {
        Left::Starting | Left::CancelRequested => {}
        Left::Running => kinds.push(ProviderEvent::Progress("synthetic".into())),
        Left::Lost => kinds.push(ProviderEvent::Lost),
        Left::Failed => kinds.push(ProviderEvent::Failed),
        Left::Proposed => kinds.push(ProviderEvent::CompletedProposal { synthetic: false }),
    }
    let first = if started { 2 } else { 1 };
    let events: Vec<_> = kinds
        .into_iter()
        .enumerate()
        .map(|(i, kind)| observation(run, first + i as u64, kind))
        .collect();
    for input in events {
        w.bound
            .append_provider_event(&w.f.owner, run, &input)
            .await
            .unwrap();
    }
    if left == Left::CancelRequested {
        w.bound
            .request_cancel(&w.f.owner, &run.run.run_id, "property-stop")
            .await
            .unwrap();
    }
}

async fn worker_under(w: &Window, deep: &ProviderAdmission) -> ProviderAdmission {
    let binding = w
        .bound
        .create_worker_binding(
            &w.f.owner,
            &w.f.conversation,
            Some(&deep.binding.session_id),
            "property-worker",
        )
        .await
        .unwrap();
    let metadata = w
        .bound
        .authorize_worker_metadata(w.credential.credential(), &deep.run.run_id, &binding)
        .await
        .unwrap();
    let binding = w
        .bound
        .confirm_metadata_session(
            metadata,
            NativeSessionConfirmation {
                session_id: binding.session_id.clone(),
                expected_generation: binding.generation,
                native_session_id: "synthetic-property-worker".into(),
                protocol_version: "codex-rpc-1".into(),
                source_event_key: "property-worker-ready".into(),
            },
        )
        .await
        .unwrap()
        .binding()
        .clone();
    let WorkerDelegationResult::Fresh(delegation) = w
        .bound
        .delegate_worker(
            w.credential.credential(),
            &deep.run.run_id,
            &WorkerAdmissionInput {
                worker_binding_id: binding.session_id.clone(),
                expected_binding_generation: binding.generation,
                source_message_id: w.source.input_message_id.clone(),
                source_event_id: w.source.input_event_id.clone(),
                request_key: "property-worker".into(),
                lifetime_ms: 30_000,
            },
        )
        .await
        .unwrap()
    else {
        panic!("fresh delegation")
    };
    let admission = w
        .bound
        .admit_worker(w.credential.credential(), delegation)
        .await
        .unwrap();
    w.consume(&admission).await.provider().clone()
}

/// Time passes: every lease and the window's hard deadline (and, if asked,
/// the acceptance grace) lie in the past. Lineage snapshots move with their
/// parents, exactly as elapsed time leaves them consistent.
async fn elapse(w: &Window, past_grace: bool) {
    let lease = 3_600_000;
    let window = 900_001 + if past_grace { ACCEPTANCE_GRACE_MS } else { 0 };
    sqlx::query("UPDATE worker_provider_delegations SET parent_deadline_ms=parent_deadline_ms-?,expires_at_ms=expires_at_ms-? WHERE owner_id=?")
        .bind(lease).bind(lease).bind(w.f.owner.to_string())
        .execute(&w.f.store.pool).await.unwrap();
    sqlx::query(
        "UPDATE production_runs SET lease_deadline_ms=lease_deadline_ms-? WHERE owner_id=?",
    )
    .bind(lease)
    .bind(w.f.owner.to_string())
    .execute(&w.f.store.pool)
    .await
    .unwrap();
    sqlx::query("UPDATE execution_windows SET opened_at_ms=opened_at_ms-?,work_deadline_ms=work_deadline_ms-?,expires_at_ms=expires_at_ms-? WHERE id=?")
        .bind(window).bind(window).bind(window).bind(w.status.window_id.to_string())
        .execute(&w.f.store.pool).await.unwrap();
}

async fn proposals(store: &Store, w: &Window) -> Vec<(String, String, String)> {
    sqlx::query_as("SELECT r.id,r.role,o.event_id FROM production_runs r JOIN production_observations o ON o.run_id=r.id AND o.kind='completed_proposal' WHERE r.conversation_id=? AND r.state='awaiting_acceptance' ORDER BY CASE r.role WHEN 'worker' THEN 0 WHEN 'fast' THEN 1 ELSE 2 END")
        .bind(w.f.conversation.to_string()).fetch_all(&store.pool).await.unwrap()
}

/// What the server does: mark, settle, then the automatic decision.
async fn automatic(store: &Store, w: &Window) -> Result<ExecutionWindowReconciliation> {
    store
        .settle_lapsed_runs_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            w.status.window_id,
            1,
            Actor::Startup,
        )
        .await?;
    reconcile(store, w, Decision::AbandonUnaccepted, Actor::Startup).await
}

async fn case(fast: Option<Left>, deep: Left, worker: Option<Left>, past_grace: bool) -> String {
    let label = format!("fast={fast:?} deep={deep:?} worker={worker:?} past_grace={past_grace}");
    let w = Window::open().await;
    let fast_binding = w.ready_fast().await;
    w.activate().await;
    let fast_run = match fast {
        Some(_) => {
            let admission = w
                .bound
                .admit_fast(
                    w.credential.credential(),
                    &FastAdmissionInput {
                        source_message_id: w.source.input_message_id.clone(),
                        source_event_id: w.source.input_event_id.clone(),
                        fast_binding_id: fast_binding.session_id.clone(),
                        expected_binding_generation: fast_binding.generation,
                        request_key: "property-fast".into(),
                    },
                )
                .await
                .unwrap();
            Some(w.consume(&admission).await.provider().clone())
        }
        None => None,
    };
    let deep_run = deep_dispatch(&w, "property-deep").await.provider().clone();
    let mut started = false;
    if let Some(left) = worker {
        w.bound
            .append_provider_event(
                &w.f.owner,
                &deep_run,
                &observation(&deep_run, 1, ProviderEvent::Started),
            )
            .await
            .unwrap();
        started = true;
        let worker_run = worker_under(&w, &deep_run).await;
        leave(&w, &worker_run, left, false).await;
    }
    leave(&w, &deep_run, deep, started).await;
    if let (Some(left), Some(run)) = (fast, &fast_run) {
        leave(&w, run, left, false).await;
    }
    elapse(&w, past_grace).await;
    let fresh = Store::open(&w.f.root.join("core.sqlite3")).await.unwrap();
    fresh
        .reconcile_execution_window_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            w.status.window_id,
            1,
        )
        .await
        .unwrap();
    let receipt = match automatic(&fresh, &w).await {
        Ok(receipt) => receipt,
        Err(RuntimeStoreError::Fenced) if !past_grace => {
            // Only a proposal the owner can read and accept may hold the
            // window within the grace: the owner accepts it.
            let pending = proposals(&fresh, &w).await;
            assert!(
                pending.iter().any(|(_, role, _)| role != "fast"),
                "{label}: held without an acceptable proposal"
            );
            for (run, role, event) in pending.iter().filter(|(_, role, _)| role != "fast") {
                let revision: i64 = sqlx::query_scalar(
                    "SELECT revision FROM execution_revisions WHERE conversation_id=?",
                )
                .bind(w.f.conversation.to_string())
                .fetch_one(&fresh.pool)
                .await
                .unwrap();
                fresh
                    .accept_execution_authenticated(
                        &w.browser_credential,
                        &w.f.conversation,
                        &ExecutionAcceptanceRequest {
                            run_id: RunId(run.parse().unwrap()),
                            completion_event_id: EventId(event.parse().unwrap()),
                            expected_revision: revision,
                            request_key: format!("property-accept-{role}"),
                        },
                    )
                    .await
                    .unwrap_or_else(|e| panic!("{label}: owner cannot accept {role}: {e:?}"));
            }
            automatic(&fresh, &w)
                .await
                .unwrap_or_else(|e| panic!("{label}: not terminal after acceptance: {e:?}"))
        }
        Err(e) => panic!("{label}: not terminal: {e:?}"),
    };
    assert_eq!(
        window_state(&fresh, w.status.window_id).await,
        "closed",
        "{label}"
    );
    assert_eq!(
        count(&fresh, &format!("SELECT count(*) FROM production_runs r WHERE r.conversation_id='{}' AND NOT EXISTS(SELECT 1 FROM production_terminal_evidence t WHERE t.run_id=r.id)", w.f.conversation)).await,
        0,
        "{label}: nonterminal run left"
    );
    // The next window opens from this window's Deep turn.
    let retired = fresh
        .recover_retired_execution_window_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            fixtures::config(ProductionTakeover::First),
        )
        .await
        .unwrap_or_else(|e| panic!("{label}: no successor lineage: {e:?}"));
    assert_eq!(retired.prior_run_id(), &deep_run.run.run_id, "{label}");
    let mut request = input(&w.f, "property-next").await;
    request.expected_generation = 1;
    request.predecessor_window_id = Some(w.status.window_id);
    let next = fresh
        .admit_execution_window_authenticated(&w.browser_credential, &w.f.conversation, &request)
        .await
        .unwrap_or_else(|e| panic!("{label}: next admission: {e:?}"));
    let grant = retired
        .store()
        .issue_idle_execution_window_credential_authenticated(
            &w.browser_credential,
            next.status.window_id,
            2,
            "property-boot",
            next.status.expires_at_ms,
            &"f".repeat(64),
        )
        .await
        .unwrap_or_else(|e| panic!("{label}: next credential: {e:?}"));
    fresh
        .reattach_terminal_supervisor(
            grant.credential(),
            fixtures::config(ProductionTakeover::ExpiredPredecessor {
                incarnation_id: retired.predecessor_incarnation().into(),
            }),
            &deep_run.run.run_id,
        )
        .await
        .unwrap_or_else(|e| panic!("{label}: next reattach: {e:?}"));
    format!("{label} -> {:?}", receipt.outcome)
}

fn combinations() -> Vec<(Option<Left>, Left, Option<Left>)> {
    let mut all = Vec::new();
    for fast in std::iter::once(None).chain(ALL.iter().copied().map(Some)) {
        for deep in ALL {
            let workers: Vec<Option<Left>> = if deep == Left::Starting {
                vec![None]
            } else {
                std::iter::once(None)
                    .chain(ALL.iter().copied().map(Some))
                    .collect()
            };
            for worker in workers {
                all.push((fast, deep, worker));
            }
        }
    }
    all
}

async fn property(past_grace: bool) {
    let all = combinations();
    let mut outcomes = Vec::with_capacity(all.len());
    for &(fast, deep, worker) in &all {
        outcomes.push(case(fast, deep, worker, past_grace).await);
    }
    assert_eq!(outcomes.len(), all.len());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn every_stranded_shape_becomes_terminal_after_the_grace() {
    property(true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn every_stranded_shape_becomes_terminal_within_the_grace_once_the_owner_accepts() {
    property(false).await;
}

/// The live fitness window (52f37d5b gen1) as a schema-54 release left it:
/// its Deep already settled `failed` by 0054, its Worker fenced `blocked`
/// after a `progress` observation, its Fast proposal unreadable to the owner.
/// After the upgrade the window becomes terminal within the grace and the
/// conversation opens its next window.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn schema54_fitness_window_becomes_terminal_after_upgrade() {
    let w = Window::open().await;
    let fast_binding = w.ready_fast().await;
    w.activate().await;
    let admission = w
        .bound
        .admit_fast(
            w.credential.credential(),
            &FastAdmissionInput {
                source_message_id: w.source.input_message_id.clone(),
                source_event_id: w.source.input_event_id.clone(),
                fast_binding_id: fast_binding.session_id.clone(),
                expected_binding_generation: fast_binding.generation,
                request_key: "fitness-fast".into(),
            },
        )
        .await
        .unwrap();
    let fast = w.consume(&admission).await.provider().clone();
    let deep = deep_dispatch(&w, "fitness-deep").await.provider().clone();
    w.bound
        .append_provider_event(
            &w.f.owner,
            &deep,
            &observation(&deep, 1, ProviderEvent::Started),
        )
        .await
        .unwrap();
    let worker = worker_under(&w, &deep).await;
    leave(&w, &worker, Left::Running, false).await;
    leave(&w, &deep, Left::Lost, true).await;
    leave(&w, &fast, Left::Proposed, false).await;
    elapse(&w, false).await;
    // 0054 settled the lost Deep only (Workers `blocked` were left alone);
    // its terminal update fenced the Worker `blocked`.
    let fresh = Store::open(&w.f.root.join("core.sqlite3")).await.unwrap();
    fresh
        .reconcile_execution_window_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            w.status.window_id,
            1,
        )
        .await
        .unwrap();
    let pool = &w.f.store.pool;
    sqlx::query("UPDATE session_bindings SET state='ready',generation=generation+1 WHERE id=?")
        .bind(deep.binding.session_id.to_string())
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("UPDATE production_runs SET state='cancelled' WHERE id=?")
        .bind(deep.run.run_id.to_string())
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO production_run_lapses(run_id,window_id,owner_id,conversation_id,actor,cause,prior_state,evidence_event_id,lease_generation,dispatch_fence,lease_deadline_ms,binding_generation,failed_at_ms) SELECT r.id,?,r.owner_id,r.conversation_id,'startup','lease_expired_process_gone','blocked',(SELECT event_id FROM production_observations WHERE run_id=r.id ORDER BY run_sequence DESC LIMIT 1),r.lease_generation,r.dispatch_fence,r.lease_deadline_ms,r.binding_generation+1,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) FROM production_runs r WHERE r.id=?")
        .bind(w.status.window_id.to_string()).bind(deep.run.run_id.to_string()).execute(pool).await.unwrap();
    assert_eq!(
        scalar(
            &w.f.store,
            "SELECT state FROM production_runs WHERE id=?",
            &worker.run.run_id.to_string()
        )
        .await,
        "blocked"
    );
    super::upgrade::downgrade_to_schema54(&w.f.store).await;
    let before = fixtures::snapshot(&w.f.store).await;
    let upgraded = Store::open(&w.f.root.join("core.sqlite3")).await.unwrap();
    assert_eq!(
        count(&upgraded, "SELECT max(version) FROM _sqlx_migrations").await,
        68
    );
    assert_eq!(
        before,
        fixtures::snapshot(&upgraded).await,
        "upgrade changes no row"
    );
    let receipt = automatic(&upgraded, &w).await.unwrap();
    assert_eq!(receipt.outcome, Outcome::Failed);
    assert_eq!(receipt.prior_run_id, Some(deep.run.run_id.clone()));
    assert_eq!(receipt.abandoned_run_ids, vec![fast.run.run_id.clone()]);
    assert_eq!(
        scalar(
            &upgraded,
            "SELECT cause FROM production_abandonment_causes WHERE run_id=?",
            &fast.run.run_id.to_string()
        )
        .await,
        "proposal_execution_missing"
    );
    assert_eq!(
        scalar(
            &upgraded,
            "SELECT cause||':'||prior_state FROM production_run_lapses WHERE run_id=?",
            &worker.run.run_id.to_string()
        )
        .await,
        "lease_expired_process_gone:blocked"
    );
    upgraded
        .recover_retired_execution_window_authenticated(
            &w.browser_credential,
            &w.f.conversation,
            fixtures::config(ProductionTakeover::First),
        )
        .await
        .unwrap();
}
