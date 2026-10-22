use super::*;
use orkestr_v2_application::IntakeStore;
use orkestr_v2_contracts::{ConversationId, MessageInput};
use std::{path::PathBuf, time::Duration};
pub(super) struct Case {
    pub store: Store,
    pub handle: Store,
    pub root: PathBuf,
    pub owner: OwnerId,
    pub conversation: ConversationId,
    pub token: String,
}
pub(super) fn config(takeover: ProductionTakeover) -> ProductionSupervisorConfig {
    ProductionSupervisorConfig {
        provider: ProviderKind::Codex,
        namespace: "synthetic-subscription".into(),
        supervisor_key: "deep-supervisor".into(),
        takeover,
    }
}
pub(super) async fn setup() -> Case {
    let root = PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").expect("isolated home"))
        .join(format!("production-authority-test-{}", Uuid::new_v4()));
    setup_at(root).await
}
pub(super) async fn setup_at(root: PathBuf) -> Case {
    std::fs::create_dir_all(&root).unwrap();
    let store = Store::open(&root.join("core.sqlite3")).await.unwrap();
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
    let token = "ab".repeat(32);
    store.save_session(&token, &owner).await.unwrap();
    let handle = store
        .authorize_supervisor(&token, config(ProductionTakeover::First))
        .await
        .unwrap();
    Case {
        store,
        handle,
        root,
        owner,
        conversation,
        token,
    }
}
pub(super) async fn ready(f: &Case) -> Binding {
    let roles = f
        .handle
        .ensure_role_bindings(&f.owner, &f.conversation)
        .await
        .unwrap();
    f.handle
        .confirm_native_session(NativeSessionConfirmation {
            session_id: roles.deep.session_id,
            expected_generation: roles.deep.generation,
            native_session_id: "synthetic-native-deep".into(),
            protocol_version: "codex-rpc-1".into(),
            source_event_key: "thread-ready:1".into(),
        })
        .await
        .unwrap()
}
pub(super) async fn claim(f: &Case, b: &Binding) -> InboxClaim {
    f.store
        .admit(
            &f.owner,
            &f.conversation,
            &MessageInput {
                client_message_id: "synthetic-input:1".into(),
                text: "synthetic execution payload".into(),
            },
        )
        .await
        .unwrap();
    f.handle
        .claim_next(
            &f.owner,
            &f.conversation,
            &b.session_id,
            Duration::from_secs(60),
        )
        .await
        .unwrap()
        .unwrap()
}
pub(super) async fn snapshot(store: &Store) -> Vec<String> {
    let mut tx = store.pool.begin().await.unwrap();
    let mut result = Vec::new();
    for (table,projection) in [
        ("production_stop_boundaries","event_id,owner_id,conversation_id,run_id,through_scope_sequence"),
        ("production_held_inputs","event_id,conversation_id,scope_sequence,message_id,boundary_event_id,reason"),
        ("worker_provider_delegations","id,owner_id,conversation_id,parent_run_id,parent_session_id,context_id,incarnation_id,parent_binding_generation,parent_lease_generation,parent_dispatch_fence,parent_deadline_ms,worker_session_id,worker_binding_generation,source_message_id,source_event_id,request_key,input_digest,requested_lifetime_ms,expires_at_ms,state,grant_hash,admitted_run_id"),
        ("production_stopped_retirements","context_id,incarnation_id,supervisor_generation,prior_run_id,stopped_event_id,session_id,binding_generation,retired_at_ms"),
        ("production_graceful_retirements","context_id,incarnation_id,supervisor_generation,prior_run_id,acceptance_event_id,session_id,binding_generation,retired_at_ms"),
        ("production_acceptances","run_id,owner_id,conversation_id,completion_event_id,event_id,request_key,requested_revision,receipt_revision"),
        ("production_cancellations","run_id,event_id,request_key,lease_generation,dispatch_fence,lease_deadline_ms,receipt_state,inflight_status,request_revision,receipt_revision,request_control_revision"),
        ("production_control_revisions","run_id,revision"),
        ("production_control_outbox","event_id,run_id,state"),
        ("production_payloads","id,event_id,owner_id,conversation_id,run_id,text"),
        ("production_observations","event_id,run_id,run_sequence,semantic_digest,kind,lease_generation,dispatch_fence,receipt_state"),
        ("conversations","id,owner_id,sequence"),
        ("events","id,owner_id,conversation_id,message_id,sequence,occurred_at,kind,schema_version"),
        ("outbox","event_id"),
        ("execution_revisions","conversation_id,revision"),
        ("production_run_leases","run_id,generation,lease_deadline_ms,dispatch_fence,purpose"),
        ("production_supervisors","context_id,owner_id,provider_kind,namespace,supervisor_key,incarnation_id,generation,lease_deadline_ms"),
        ("production_requested_native","session_id,binding_generation,context_id,incarnation_id,requested_native_id,initialization_key,observed_run_id,observed_event_key"),
        ("production_readiness","session_id,context_id,incarnation_id,protocol_version,source_event_key,evidence_digest"),
        ("production_runs","id,context_id,incarnation_id,owner_id,conversation_id,session_id,native_session_id,provider_kind,binding_generation,message_id,event_id,scope_sequence,claim_generation,request_key,input_digest,lease_generation,dispatch_fence,lease_deadline_ms,attempt,state,dispatch_state,candidate_hash,reservation_hash,reserve_key,role,parent_session_id,worker_delegation_id"),
        ("reasoning_inbox","conversation_id,sequence,message_id,event_id,state,claimant_session_id,claim_generation,claim_deadline_ms,admitted_fixture_run_id,admitted_run_id"),
        ("session_bindings","id,owner_id,conversation_id,role,provider_kind,provider_namespace,native_session_id,parent_session_id,generation,state,request_key,request_digest")
    ] {
        let columns=projection.split(',').map(|c|format!("'{c}',{c}")).collect::<Vec<_>>().join(",");
        let rows:Vec<String>=sqlx::query_scalar(&format!("SELECT json_object({columns}) FROM {table} ORDER BY 1")).fetch_all(&mut *tx).await.unwrap();
        result.push(format!("{table}:{rows:?}"));
    }
    tx.commit().await.unwrap();
    result
}
#[tokio::test]
async fn concurrent_admit_reserve_consume_reopen_never_redispatches() {
    let f = setup().await;
    let b = ready(&f).await;
    let claim = claim(&f, &b).await;
    let second = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let attached = f.handle.reattach_supervisor(&second).await.unwrap();
    let (a, z) = tokio::join!(
        f.handle
            .admit_run(&claim, &b.session_id, b.generation, "run:1"),
        attached.admit_run(&claim, &b.session_id, b.generation, "run:1")
    );
    let a = a.unwrap();
    let z = z.unwrap();
    assert_eq!(a.provider, z.provider);
    let (fresh, replay) = if a.disposition == AdmissionDisposition::FreshCandidate {
        (a, z)
    } else {
        (z, a)
    };
    assert_eq!(replay.disposition, AdmissionDisposition::Replay);
    assert!(replay.candidate_key.is_none());
    let (x, y) = tokio::join!(
        f.handle.claim_provider_dispatch(&fresh, "reserve:1"),
        attached.claim_provider_dispatch(&fresh, "reserve:1")
    );
    let reservation = match (x.unwrap(), y.unwrap()) {
        (DispatchClaimResult::Reserved(c), DispatchClaimResult::Replay)
        | (DispatchClaimResult::Replay, DispatchClaimResult::Reserved(c)) => c,
        _ => panic!("one reservation"),
    };
    let (x, y) = tokio::join!(
        f.handle.consume_provider_dispatch(&reservation),
        attached.consume_provider_dispatch(&reservation)
    );
    assert!(matches!(
        (x.unwrap(), y.unwrap()),
        (
            DispatchConsumption::DispatchNow,
            DispatchConsumption::ReconciliationRequired
        ) | (
            DispatchConsumption::ReconciliationRequired,
            DispatchConsumption::DispatchNow
        )
    ));
    let before = snapshot(&f.store).await;
    second.close().await;
    let reopened = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let live = f.handle.reattach_supervisor(&reopened).await.unwrap();
    let replay = live
        .admit_run(&claim, &b.session_id, b.generation, "run:1")
        .await
        .unwrap();
    assert_eq!(
        replay.disposition,
        AdmissionDisposition::ReconciliationRequired
    );
    assert!(replay.candidate_key.is_none());
    assert_eq!(
        live.consume_provider_dispatch(&reservation).await.unwrap(),
        DispatchConsumption::ReconciliationRequired
    );
    assert_eq!(before, snapshot(&reopened).await);
    reopened.close().await;
    f.store.close().await;
    std::fs::remove_dir_all(f.root).unwrap();
}
#[tokio::test]
async fn readiness_authentication_and_native_alias_refusals_preserve_rows() {
    let f = setup().await;
    let roles = f
        .handle
        .ensure_role_bindings(&f.owner, &f.conversation)
        .await
        .unwrap();
    let b = ready(&f).await;
    let before = snapshot(&f.store).await;
    assert!(matches!(
        f.store
            .authorize_supervisor(
                &format!("browser:{}", f.token),
                config(ProductionTakeover::First)
            )
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert_eq!(
        f.handle
            .confirm_native_session(NativeSessionConfirmation {
                session_id: roles.fast.session_id,
                expected_generation: 1,
                native_session_id: b.native_session_id.unwrap(),
                protocol_version: "codex-rpc-1".into(),
                source_event_key: "ready:2".into()
            })
            .await
            .unwrap_err(),
        RuntimeStoreError::Conflict
    );
    assert_eq!(before, snapshot(&f.store).await);
    f.store.revoke_session(&f.token).await.unwrap();
    assert_eq!(
        f.handle
            .ensure_role_bindings(&f.owner, &f.conversation)
            .await
            .unwrap_err(),
        RuntimeStoreError::Unauthorized
    );
    assert_eq!(before, snapshot(&f.store).await);
    f.store.close().await;
    std::fs::remove_dir_all(f.root).unwrap();
}
#[tokio::test]
async fn forged_envelopes_do_not_spend_candidate_or_reservation() {
    let f = setup().await;
    let b = ready(&f).await;
    let claim = claim(&f, &b).await;
    let fresh = f
        .handle
        .admit_run(&claim, &b.session_id, b.generation, "run:1")
        .await
        .unwrap();
    let before = snapshot(&f.store).await;
    for n in 0..9 {
        let mut bad = fresh.clone();
        mutate(&mut bad.provider, n);
        assert!(f
            .handle
            .claim_provider_dispatch(&bad, "reserve:1")
            .await
            .is_err());
        assert_eq!(before, snapshot(&f.store).await);
    }
    let DispatchClaimResult::Reserved(reserved) = f
        .handle
        .claim_provider_dispatch(&fresh, "reserve:1")
        .await
        .unwrap()
    else {
        panic!("fresh")
    };
    let before = snapshot(&f.store).await;
    for n in 0..9 {
        let mut bad = reserved.as_ref().clone();
        mutate(&mut bad.provider, n);
        assert!(f.handle.consume_provider_dispatch(&bad).await.is_err());
        assert_eq!(before, snapshot(&f.store).await);
    }
    assert_eq!(
        f.handle.consume_provider_dispatch(&reserved).await.unwrap(),
        DispatchConsumption::DispatchNow
    );
    f.store.close().await;
    std::fs::remove_dir_all(f.root).unwrap();
}
fn mutate(p: &mut ProviderAdmission, n: usize) {
    match n {
        0 => p.run.owner_id = OwnerId(Uuid::new_v4()),
        1 => p.run.conversation_id = ConversationId(Uuid::new_v4()),
        2 => p.run.session_id = orkestr_v2_contracts::SessionId(Uuid::new_v4()),
        3 => p.run.role = Role::Fast,
        4 => p.run.purpose = AdmissionPurpose::CancellationAcknowledgement,
        5 => p.run.lease_generation += 1,
        6 => p.run.dispatch_fence += 1,
        7 => p.run.lease_deadline_ms += 1,
        _ => p.binding.provider_kind = ProviderKind::Claude,
    }
}

#[tokio::test]
async fn consumed_capability_contains_only_authoritative_durable_input() {
    let f = setup().await;
    let b = ready(&f).await;
    let claim = claim(&f, &b).await;
    let fresh = f
        .handle
        .admit_run(&claim, &b.session_id, b.generation, "run:1")
        .await
        .unwrap();
    let DispatchClaimResult::Reserved(reserved) = f
        .handle
        .claim_provider_dispatch(&fresh, "reserve:1")
        .await
        .unwrap()
    else {
        panic!("fresh")
    };
    let ExecutionConsumption::Dispatch(cap) = f.handle.consume_execution(&reserved).await.unwrap()
    else {
        panic!("first consume")
    };
    assert_eq!(cap.text(), "synthetic execution payload");
    assert_eq!(cap.message_id(), &claim.message_id);
    assert_eq!(cap.provider(), &fresh.provider);
    assert_eq!(cap.namespace(), "synthetic-subscription");
    assert_eq!(
        Some(cap.incarnation_id()),
        f.handle.supervisor_incarnation()
    );
    let state: String = sqlx::query_scalar("SELECT dispatch_state FROM production_runs WHERE id=?")
        .bind(cap.provider().run.run_id.to_string())
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(state, "delivery_unknown");
    assert!(matches!(
        f.handle.consume_execution(&reserved).await.unwrap(),
        ExecutionConsumption::ReconciliationRequired
    ));
    f.store.close().await;
    std::fs::remove_dir_all(f.root).unwrap();
}
#[tokio::test]
async fn exact_expired_predecessor_cas_fences_without_recreating_native_identity() {
    let f = setup().await;
    let b = ready(&f).await;
    let claim = claim(&f, &b).await;
    let fresh = f
        .handle
        .admit_run(&claim, &b.session_id, b.generation, "run:1")
        .await
        .unwrap();
    let DispatchClaimResult::Reserved(reserved) = f
        .handle
        .claim_provider_dispatch(&fresh, "reserve:1")
        .await
        .unwrap()
    else {
        panic!("fresh")
    };
    f.handle.consume_provider_dispatch(&reserved).await.unwrap();
    let predecessor = f.handle.supervisor_incarnation().unwrap().to_owned();
    assert!(matches!(
        f.store
            .authorize_supervisor(
                &f.token,
                config(ProductionTakeover::ExpiredPredecessor {
                    incarnation_id: predecessor.clone()
                })
            )
            .await,
        Err(RuntimeStoreError::Busy)
    ));
    sqlx::query("UPDATE production_supervisors SET lease_deadline_ms=0 WHERE context_id=?")
        .bind(&f.handle.context().unwrap().id)
        .execute(&f.store.pool)
        .await
        .unwrap();
    let other = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let (a, b) = tokio::join!(
        f.store.authorize_supervisor(
            &f.token,
            config(ProductionTakeover::ExpiredPredecessor {
                incarnation_id: predecessor.clone()
            })
        ),
        other.authorize_supervisor(
            &f.token,
            config(ProductionTakeover::ExpiredPredecessor {
                incarnation_id: predecessor
            })
        )
    );
    let successor = match (a, b) {
        (Ok(h), Err(RuntimeStoreError::Conflict)) | (Err(RuntimeStoreError::Conflict), Ok(h)) => h,
        _ => panic!("one successor"),
    };
    assert_eq!(
        f.handle
            .consume_provider_dispatch(&reserved)
            .await
            .unwrap_err(),
        RuntimeStoreError::Fenced
    );
    let replay = successor
        .admit_run(
            &claim,
            &claim.consumer_session_id,
            fresh.provider.binding.generation,
            "run:1",
        )
        .await
        .unwrap();
    assert_eq!(
        replay.disposition,
        AdmissionDisposition::ReconciliationRequired
    );
    assert!(replay.candidate_key.is_none());
    assert_eq!(replay.provider, fresh.provider);
    assert_eq!(replay.run_state, RunState::Blocked);
    let state: String = sqlx::query_scalar("SELECT dispatch_state FROM production_runs WHERE id=?")
        .bind(fresh.provider.run.run_id.to_string())
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(state, "delivery_unknown");
    other.close().await;
    f.store.close().await;
    std::fs::remove_dir_all(f.root).unwrap();
}

/// Undo 0068 (one archived open-failure row per failure), 0067 (sidebar hidden entries), 0066 (conversation posts), 0065 (attachment encryption), 0064 (restricted threads), 0063 (calendar timers: policies, pauses, outcomes, digests, trigger events), 0062 (quoted-reply context), 0061 (auto-acceptance audit), 0060 (review-before-accepting setting), 0059 (read-path indexes), 0058 (WhatsApp chat provisions) and 0057
/// (sidebar read marks and lineage); tests never write them. Then undo 0056 exactly: rebuild `execution_windows` under the fixed-deadline
/// definition that migrations up to 0055 produce, keeping every row.
pub(super) async fn downgrade_window_deadlines(store: &Store) {
    let v52 = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/migrations/0052_stranded_window_failures.sql"
    ));
    let start = v52
        .find("CREATE TABLE execution_window_open_failure_inputs")
        .unwrap();
    let end = start + v52[start..].find(");").unwrap() + 2;
    for statement in [
        "CREATE TABLE open_failure_inputs_copy AS SELECT * FROM execution_window_open_failure_inputs",
        "DROP TABLE execution_window_open_failure_inputs",
        &v52[start..end],
        "INSERT INTO execution_window_open_failure_inputs SELECT * FROM open_failure_inputs_copy",
        "DROP TABLE open_failure_inputs_copy",
        "DELETE FROM _sqlx_migrations WHERE version=68",
        "DROP TABLE sidebar_hidden_entries",
        "DELETE FROM _sqlx_migrations WHERE version=67",
        "DROP TABLE conversation_posts",
        "DELETE FROM _sqlx_migrations WHERE version=66",
        "DROP TABLE attachment_sealed_objects",
        "DROP TABLE attachment_encryption_policies",
        "DROP TABLE attachment_recipients",
        "DELETE FROM _sqlx_migrations WHERE version=65",
        "DROP TABLE restricted_grants",
        "DROP TABLE restricted_approvals",
        "DROP TABLE restricted_audit",
        "DROP TABLE restricted_messages",
        "DROP TABLE restricted_threads",
        "DELETE FROM _sqlx_migrations WHERE version=64",
        "DROP TABLE timer_trigger_events",
        "DROP TABLE timer_digests",
        "DROP TABLE timer_outcomes",
        "DROP TABLE conversation_timer_pauses",
        "DROP TABLE timer_policies",
        "DELETE FROM _sqlx_migrations WHERE version=63",
        "DROP TABLE message_reply_to",
        "DELETE FROM _sqlx_migrations WHERE version=62",
        "DROP TABLE production_auto_acceptances",
        "DELETE FROM _sqlx_migrations WHERE version=61",
        "ALTER TABLE conversation_settings DROP COLUMN review_before_accepting",
        "DELETE FROM _sqlx_migrations WHERE version=60",
        "DROP INDEX archived_history_messages_created",
        "DROP INDEX production_payloads_run",
        "DELETE FROM _sqlx_migrations WHERE version=59",
        "DROP TABLE whatsapp_chat_provisions",
        "DELETE FROM _sqlx_migrations WHERE version=58",
        "DROP TABLE sidebar_read_marks",
        "DROP TABLE conversation_lineage",
        "DELETE FROM _sqlx_migrations WHERE version=57",
    ] {
        sqlx::query(statement).execute(&store.pool).await.unwrap();
    }
    use sqlx::{migrate::Migrate, Connection};
    let mut reference = sqlx::SqliteConnection::connect("sqlite::memory:")
        .await
        .unwrap();
    reference.ensure_migrations_table().await.unwrap();
    for migration in sqlx::migrate!("./migrations").iter() {
        if migration.version < 56 {
            sqlx::raw_sql(&migration.sql)
                .execute(&mut reference)
                .await
                .unwrap();
        }
    }
    let definition = |name: &'static str| {
        sqlx::query_scalar::<_, String>("SELECT sql FROM sqlite_schema WHERE name=?").bind(name)
    };
    let table = definition("execution_windows")
        .fetch_one(&mut reference)
        .await
        .unwrap();
    let index = definition("execution_window_unresolved")
        .fetch_one(&mut reference)
        .await
        .unwrap();
    reference.close().await.unwrap();
    let mut tx = store.pool.begin().await.unwrap();
    sqlx::query("PRAGMA defer_foreign_keys = ON")
        .execute(&mut *tx)
        .await
        .unwrap();
    for statement in [
        "CREATE TEMP TABLE windows_copy AS SELECT * FROM execution_windows",
        "DROP TABLE execution_windows",
        &table,
        "INSERT INTO execution_windows SELECT * FROM windows_copy",
        "DROP TABLE windows_copy",
        &index,
        "DELETE FROM _sqlx_migrations WHERE version=56",
    ] {
        sqlx::query(statement).execute(&mut *tx).await.unwrap();
    }
    tx.commit().await.unwrap();
}
