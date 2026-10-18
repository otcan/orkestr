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
        let mut db = sqlx::SqliteConnection::connect_with(
            &sqlx::sqlite::SqliteConnectOptions::new()
                .filename(self.root.join("core.sqlite3"))
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
            "production_readiness",
            "production_runs",
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
    async fn finish(self) {
        self.store.close().await;
        std::fs::remove_dir_all(self.root).unwrap();
    }
}
#[tokio::test]
async fn independent_ordinary_race_capability_and_reopen_no_reissue() {
    let c = Case::new().await;
    let h = c
        .store
        .authorize_supervisor(&c.token, config())
        .await
        .unwrap();
    let (b, claim) = c.ready_claim(&h).await;
    let reopened = Store::open(&c.root.join("core.sqlite3")).await.unwrap();
    let other = h.reattach_supervisor(&reopened).await.unwrap();
    let (a, z) = tokio::join!(
        h.admit_run(&claim, &b.session_id, b.generation, "run:1"),
        other.admit_run(&claim, &b.session_id, b.generation, "run:1")
    );
    let (a, z) = (a.unwrap(), z.unwrap());
    assert_eq!(a.provider, z.provider);
    let fresh = match (a.disposition, z.disposition) {
        (AdmissionDisposition::FreshCandidate, AdmissionDisposition::Replay) => {
            assert!(z.candidate_key.is_none());
            a
        }
        (AdmissionDisposition::Replay, AdmissionDisposition::FreshCandidate) => {
            assert!(a.candidate_key.is_none());
            z
        }
        _ => panic!("exactly one fresh"),
    };
    let (a, z) = tokio::join!(
        h.claim_provider_dispatch(&fresh, "reserve:1"),
        other.claim_provider_dispatch(&fresh, "reserve:1")
    );
    let reserved = match (a.unwrap(), z.unwrap()) {
        (DispatchClaimResult::Reserved(c), DispatchClaimResult::Replay)
        | (DispatchClaimResult::Replay, DispatchClaimResult::Reserved(c)) => c,
        _ => panic!("exactly one reservation"),
    };
    let (a, z) = tokio::join!(
        h.consume_execution(&reserved),
        other.consume_execution(&reserved)
    );
    let cap = match (a.unwrap(), z.unwrap()) {
        (ExecutionConsumption::Dispatch(c), ExecutionConsumption::ReconciliationRequired)
        | (ExecutionConsumption::ReconciliationRequired, ExecutionConsumption::Dispatch(c)) => c,
        _ => panic!("exactly one private capability"),
    };
    assert_eq!(cap.text(), "durable synthetic input");
    assert_eq!(cap.message_id(), &claim.message_id);
    assert_eq!(cap.provider(), &fresh.provider);
    let before = c.rows().await;
    assert!(matches!(
        h.consume_execution(&reserved).await.unwrap(),
        ExecutionConsumption::ReconciliationRequired
    ));
    reopened.close().await;
    let reopened = Store::open(&c.root.join("core.sqlite3")).await.unwrap();
    let attached = h.reattach_supervisor(&reopened).await.unwrap();
    assert!(matches!(
        attached.consume_execution(&reserved).await.unwrap(),
        ExecutionConsumption::ReconciliationRequired
    ));
    let replay = attached
        .admit_run(&claim, &b.session_id, b.generation, "run:1")
        .await
        .unwrap();
    assert!(replay.candidate_key.is_none());
    assert_eq!(
        replay.disposition,
        AdmissionDisposition::ReconciliationRequired
    );
    assert_eq!(before, c.rows().await);
    reopened.close().await;
    c.finish().await;
}
#[tokio::test]
async fn independent_revocation_and_forgery_leave_authority_unspent() {
    let c = Case::new().await;
    let h = c
        .store
        .authorize_supervisor(&c.token, config())
        .await
        .unwrap();
    let (b, claim) = c.ready_claim(&h).await;
    let fresh = h
        .admit_run(&claim, &b.session_id, b.generation, "run:1")
        .await
        .unwrap();
    let before = c.rows().await;
    let mut forged = fresh.clone();
    forged.provider.run.purpose = AdmissionPurpose::CancellationAcknowledgement;
    assert!(h
        .claim_provider_dispatch(&forged, "reserve:1")
        .await
        .is_err());
    assert_eq!(before, c.rows().await);
    let DispatchClaimResult::Reserved(reserved) = h
        .claim_provider_dispatch(&fresh, "reserve:1")
        .await
        .unwrap()
    else {
        panic!("valid still usable")
    };
    let before = c.rows().await;
    c.store.revoke_session(&c.token).await.unwrap();
    assert!(matches!(
        h.consume_execution(&reserved).await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert!(matches!(
        h.admit_run(&claim, &b.session_id, b.generation, "run:1")
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert_eq!(before, c.rows().await);
    c.finish().await;
}
#[tokio::test]
async fn independent_machine_namespace_and_unbound_dispatch_refuse() {
    let c = Case::new().await;
    let browser = "cd".repeat(32);
    c.store
        .save_session(&format!("browser:{browser}"), &c.owner)
        .await
        .unwrap();
    let before = c.rows().await;
    for token in [
        browser,
        format!("browser:{}", c.token),
        "a".repeat(63),
        "z".repeat(64),
    ] {
        assert!(matches!(
            c.store.authorize_supervisor(&token, config()).await,
            Err(RuntimeStoreError::Unauthorized)
        ));
        assert_eq!(before, c.rows().await);
    }
    let h = c
        .store
        .authorize_supervisor(&c.token, config())
        .await
        .unwrap();
    let (b, claim) = c.ready_claim(&h).await;
    let before = c.rows().await;
    assert!(matches!(
        c.store
            .admit_run(&claim, &b.session_id, b.generation, "run:1")
            .await,
        Err(RuntimeStoreError::Unavailable)
    ));
    assert_eq!(before, c.rows().await);
    c.finish().await;
}
