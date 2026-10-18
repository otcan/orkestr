//! Independent ordinary-store authority tests; no fixture bootstrap or private context.
use orkestr_v2_application::{runtime::*, IntakeStore};
use orkestr_v2_contracts::{ConversationId, MessageInput, OwnerId};
use orkestr_v2_store_sqlite::{ExecutionConsumption, Store};
use sqlx::{Connection, Row};
use std::{path::PathBuf, time::Duration};
use uuid::Uuid;
struct Case {
    root: PathBuf,
    store: Store,
    owner: OwnerId,
    conversation: ConversationId,
    token: String,
}
fn config() -> ProductionSupervisorConfig {
    ProductionSupervisorConfig {
        provider: ProviderKind::Codex,
        namespace: "synthetic-local".into(),
        supervisor_key: "independent".into(),
        takeover: ProductionTakeover::First,
    }
}
impl Case {
    async fn new() -> Self {
        let root = PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").expect("isolated home"))
            .join(Uuid::new_v4().to_string());
        std::fs::create_dir_all(&root).unwrap();
        let store = Store::open(&root.join("core.sqlite3")).await.unwrap();
        let conversation = store
            .setup("synthetic-owner", "synthetic-test-hash")
            .await
            .unwrap();
        let owner = store
            .credentials("synthetic-owner")
            .await
            .unwrap()
            .unwrap()
            .0;
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        store.save_session(&token, &owner).await.unwrap();
        Self {
            root,
            store,
            owner,
            conversation,
            token,
        }
    }
    async fn ready_claim(&self, handle: &Store) -> (Binding, InboxClaim) {
        let roles = handle
            .ensure_role_bindings(&self.owner, &self.conversation)
            .await
            .unwrap();
        let binding = handle
            .confirm_native_session(NativeSessionConfirmation {
                session_id: roles.deep.session_id,
                expected_generation: roles.deep.generation,
                native_session_id: "synthetic-independent-native".into(),
                protocol_version: "synthetic-v1".into(),
                source_event_key: "ready:1".into(),
            })
            .await
            .unwrap();
        self.store
            .admit(
                &self.owner,
                &self.conversation,
                &MessageInput {
                    client_message_id: "input:1".into(),
                    text: "durable synthetic input".into(),
                },
            )
            .await
            .unwrap();
        let claim = handle
            .claim_next(
                &self.owner,
                &self.conversation,
                &binding.session_id,
                Duration::from_secs(60),
            )
            .await
            .unwrap()
            .unwrap();
        (binding, claim)
    }
    async fn rows(&self) -> Vec<String> {
        snapshot_rows(&self.root).await
    }
    async fn finish(self) {
        self.store.close().await;
        std::fs::remove_dir_all(self.root).unwrap();
    }
}
async fn snapshot_rows(root: &std::path::Path) -> Vec<String> {
    let mut db = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new()
            .filename(root.join("core.sqlite3"))
            .read_only(true),
    )
    .await
    .unwrap();
    sqlx::query("PRAGMA query_only=ON")
        .execute(&mut db)
        .await
        .unwrap();
    let mut tx = db.begin().await.unwrap();
    let mut result = Vec::new();
    for table in [
        "production_supervisors",
        "worker_provider_delegations",
        "production_observations",
        "production_cancellations",
        "production_control_outbox",
        "production_control_revisions",
        "production_readiness",
        "production_runs",
        "production_run_leases",
        "reasoning_inbox",
        "session_bindings",
        "messages",
        "events",
        "outbox",
        "conversations",
    ] {
        let columns = sqlx::query(&format!("PRAGMA table_info({table})"))
            .fetch_all(&mut *tx)
            .await
            .unwrap()
            .iter()
            .map(|r| format!("\"{}\"", r.get::<String, _>("name")))
            .collect::<Vec<_>>()
            .join(",");
        result.push(table.into());
        let rows: Vec<String> = sqlx::query_scalar(&format!(
            "SELECT json_array({columns}) FROM {table} ORDER BY rowid"
        ))
        .fetch_all(&mut *tx)
        .await
        .unwrap();
        result.extend(rows);
    }
    tx.commit().await.unwrap();
    db.close().await.unwrap();
    result
}

fn event(p: &ProviderAdmission, sequence: u64, event: ProviderEvent) -> ProviderEventInput {
    ProviderEventInput {
        run_id: p.run.run_id.clone(),
        session_id: p.run.session_id.clone(),
        sequence,
        lease_generation: p.run.lease_generation,
        dispatch_fence: p.run.dispatch_fence,
        event,
    }
}
async fn consumed(
    c: &Case,
    h: &Store,
) -> (
    Box<orkestr_v2_store_sqlite::ConsumedProviderDispatch>,
    InboxClaim,
) {
    let (b, claim) = c.ready_claim(h).await;
    let a = h
        .admit_run(&claim, &b.session_id, b.generation, "independent-renew")
        .await
        .unwrap();
    let DispatchClaimResult::Reserved(r) = h.claim_provider_dispatch(&a, "dispatch").await.unwrap()
    else {
        panic!()
    };
    let ExecutionConsumption::Dispatch(cap) = h.consume_execution(&r).await.unwrap() else {
        panic!()
    };
    (cap, claim)
}
#[tokio::test]
async fn public_cap_cas_replay_stop_and_auth_refusal() {
    let c = Case::new().await;
    let h = c
        .store
        .authorize_supervisor(&c.token, config())
        .await
        .unwrap();
    let (cap, _) = consumed(&c, &h).await;
    let old = cap.provider().clone();
    let mut a = h.authorize_running_renewal(&cap).await.unwrap();
    let mut b = h.authorize_running_renewal(&cap).await.unwrap();
    let started = event(&old, 1, ProviderEvent::Started);
    let receipt = h
        .append_provider_event(&c.owner, &old, &started)
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(25)).await;
    h.heartbeat_supervisor().await.unwrap();
    let pool = Store::open(&c.root.join("core.sqlite3")).await.unwrap();
    let other = h.reattach_supervisor(&pool).await.unwrap();
    let (x, y) = tokio::join!(h.renew_running(&mut a), other.renew_running(&mut b));
    let t = match (x, y) {
        (Ok(t), Err(RuntimeStoreError::StaleLease))
        | (Err(RuntimeStoreError::StaleLease), Ok(t)) => t,
        _ => panic!("one winner"),
    };
    assert_eq!(t.previous(), &old);
    let mut expected = old.clone();
    expected.run.lease_generation += 1;
    expected.run.lease_deadline_ms = t.current().run.lease_deadline_ms;
    assert_eq!(t.current(), &expected);
    let before = c.rows().await;
    let duplicate = h
        .append_provider_event(&c.owner, &old, &started)
        .await
        .unwrap();
    assert_eq!(duplicate.event_id, receipt.event_id);
    assert!(duplicate.duplicate);
    let mut called = false;
    assert!(h
        .with_execution_fence(&old, || {
            called = true;
            Ok::<_, ()>(())
        })
        .is_err());
    assert!(!called);
    assert!(h
        .append_provider_event(
            &c.owner,
            &old,
            &event(&old, 2, ProviderEvent::Progress("old unseen".into()))
        )
        .await
        .is_err());
    assert_eq!(before, c.rows().await);
    h.request_cancel(&c.owner, &old.run.run_id, "independent-stop")
        .await
        .unwrap();
    let before = c.rows().await;
    assert!(h.renew_running(&mut a).await.is_err());
    assert!(other.renew_running(&mut b).await.is_err());
    assert_eq!(before, c.rows().await);
    c.store.revoke_session(&c.token).await.unwrap();
    let before = c.rows().await;
    assert!(matches!(
        h.renew_running(&mut a).await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert!(h
        .append_provider_event(&c.owner, &old, &started)
        .await
        .is_err());
    assert_eq!(before, c.rows().await);
    drop(other);
    pool.close().await;
    drop(h);
    c.finish().await;
}
#[tokio::test]
async fn public_parent_cap_renewal_preserves_original_worker_expiry_and_authority() {
    let c = Case::new().await;
    let h = c
        .store
        .authorize_supervisor(&c.token, config())
        .await
        .unwrap();
    let (cap, claim) = consumed(&c, &h).await;
    let parent = cap.provider().clone();
    let mut renewal = h.authorize_running_renewal(&cap).await.unwrap();
    h.append_provider_event(
        &c.owner,
        &parent,
        &event(&parent, 1, ProviderEvent::Started),
    )
    .await
    .unwrap();
    let worker = h
        .create_worker_binding(
            &c.owner,
            &c.conversation,
            Some(&parent.run.session_id),
            "worker",
        )
        .await
        .unwrap();
    let metadata = h
        .authorize_worker_metadata(&c.token, &parent.run.run_id, &worker)
        .await
        .unwrap();
    let ready = h
        .confirm_metadata_session(
            metadata,
            NativeSessionConfirmation {
                session_id: worker.session_id,
                expected_generation: worker.generation,
                native_session_id: "synthetic-worker".into(),
                protocol_version: "synthetic-v1".into(),
                source_event_key: "worker-ready".into(),
            },
        )
        .await
        .unwrap();
    let binding = ready.binding();
    let input = orkestr_v2_store_sqlite::WorkerAdmissionInput {
        worker_binding_id: binding.session_id.clone(),
        expected_binding_generation: binding.generation,
        source_message_id: claim.message_id,
        source_event_id: claim.event_id,
        request_key: "child".into(),
        lifetime_ms: 30_000,
    };
    let orkestr_v2_store_sqlite::WorkerDelegationResult::Fresh(d) = h
        .delegate_worker(&c.token, &parent.run.run_id, &input)
        .await
        .unwrap()
    else {
        panic!()
    };
    let child = h.admit_worker(&c.token, d).await.unwrap();
    let DispatchClaimResult::Reserved(r) = h
        .claim_provider_dispatch(&child, "child-dispatch")
        .await
        .unwrap()
    else {
        panic!()
    };
    let ExecutionConsumption::Dispatch(childcap) = h.consume_execution(&r).await.unwrap() else {
        panic!()
    };
    let childold = childcap.provider().clone();
    tokio::time::sleep(Duration::from_millis(25)).await;
    h.heartbeat_supervisor().await.unwrap();
    let transition = h.renew_running(&mut renewal).await.unwrap();
    assert!(transition.current().run.lease_deadline_ms > parent.run.lease_deadline_ms);
    h.append_provider_event(
        &c.owner,
        &childold,
        &event(&childold, 1, ProviderEvent::Started),
    )
    .await
    .unwrap();
    assert_eq!(childcap.provider(), &childold);
    let mut childrenew = h.authorize_running_renewal(&childcap).await.unwrap();
    let before = c.rows().await;
    assert!(matches!(
        h.renew_running(&mut childrenew).await,
        Err(RuntimeStoreError::Busy)
    ));
    assert_eq!(before, c.rows().await);
    h.request_cancel(&c.owner, &parent.run.run_id, "parent-stop")
        .await
        .unwrap();
    let before = c.rows().await;
    assert!(h
        .with_execution_fence(&childold, || Ok::<_, ()>(()))
        .is_err());
    assert!(h.renew_running(&mut childrenew).await.is_err());
    assert_eq!(before, c.rows().await);
    drop(h);
    c.finish().await;
}
