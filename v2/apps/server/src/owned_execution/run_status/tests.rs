//! Real Store projections; only historical ordering is seeded synthetically.
use super::*;
use orkestr_v2_application::{IntakeStore, runtime::*};
use orkestr_v2_contracts::{ExecutionPhase, MessageInput};
use orkestr_v2_store_sqlite::ExecutionConsumption;
use sqlx::{Connection, Row};
use uuid::Uuid;

struct Case {
    root: PathBuf,
    store: Store,
    bound: Store,
    owner: OwnerId,
    conversation: ConversationId,
    credential: String,
    current: RunId,
}

impl Case {
    async fn new() -> Self {
        let root = std::env::temp_dir().join(format!("owned-status-{}", Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
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
        let credential = "ab".repeat(32);
        store.save_session(&credential, &owner).await.unwrap();
        let bound = store
            .authorize_supervisor(
                &credential,
                ProductionSupervisorConfig {
                    provider: ProviderKind::Codex,
                    namespace: "subscription:synthetic-owned".into(),
                    supervisor_key: "synthetic-owned".into(),
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
                native_session_id: "synthetic-native".into(),
                protocol_version: "codex-rpc-1".into(),
                source_event_key: "synthetic-ready".into(),
            })
            .await
            .unwrap();
        store
            .admit(
                &owner,
                &conversation,
                &MessageInput {
                    client_message_id: "older-released-input".into(),
                    text: "Synthetic older input.".into(),
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
        let candidate = bound
            .admit_run(
                &claim,
                &binding.session_id,
                binding.generation,
                "synthetic-current",
            )
            .await
            .unwrap();
        let DispatchClaimResult::Reserved(reservation) = bound
            .claim_provider_dispatch(&candidate, "synthetic-dispatch")
            .await
            .unwrap()
        else {
            panic!("fresh reservation")
        };
        let ExecutionConsumption::Dispatch(capability) =
            bound.consume_execution(&reservation).await.unwrap()
        else {
            panic!("one dispatch")
        };
        let current = capability.provider().run.run_id.clone();
        Self {
            root,
            store,
            bound,
            owner,
            conversation,
            credential,
            current,
        }
    }

    async fn connection(&self) -> sqlx::SqliteConnection {
        sqlx::SqliteConnection::connect(&format!(
            "sqlite://{}",
            self.root.join("core.sqlite3").display()
        ))
        .await
        .unwrap()
    }

    async fn status(&self) -> std::result::Result<ExecutionStatus, RuntimeStoreError> {
        read(
            &self.bound,
            &self.credential,
            &self.owner,
            &self.conversation,
            &self.current,
        )
        .await
    }

    async fn close(self) {
        self.store.close().await;
        drop(self.bound);
        std::fs::remove_dir_all(self.root).unwrap();
    }
}

#[tokio::test]
async fn older_owned_input_is_not_replaced_by_newer_terminal_history() {
    let c = Case::new().await;
    let newer = c
        .store
        .admit(
            &c.owner,
            &c.conversation,
            &MessageInput {
                client_message_id: "newer-previous-input".into(),
                text: "Synthetic newer input.".into(),
            },
        )
        .await
        .unwrap()
        .receipt;
    let historical = Uuid::new_v4().to_string();
    let mut connection = c.connection().await;
    // A prior closed window can have a newer input sequence than the older
    // released input now owned by this runtime. Preserve the original schema
    // and use a different historical incarnation, without modifying the run.
    let columns = sqlx::query("PRAGMA table_info(production_runs)")
        .fetch_all(&mut connection)
        .await
        .unwrap();
    let mut names = Vec::new();
    let mut expressions = Vec::new();
    for column in columns {
        let name: String = column.get("name");
        expressions.push(match name.as_str() {
            "id" => "?1".to_owned(),
            "message_id" => "?2".to_owned(),
            "event_id" => "?3".to_owned(),
            "scope_sequence" => "?4".to_owned(),
            "incarnation_id" => "?5".to_owned(),
            "state" => "'cancelled'".to_owned(),
            "request_key" => "'historical-newer'".to_owned(),
            _ => format!("\"{name}\""),
        });
        names.push(format!("\"{name}\""));
    }
    sqlx::query(&format!(
        "INSERT INTO production_runs({}) SELECT {} FROM production_runs WHERE id=?6",
        names.join(","),
        expressions.join(",")
    ))
    .bind(&historical)
    .bind(newer.message_id.to_string())
    .bind(newer.event_id.to_string())
    .bind(newer.sequence)
    .bind(Uuid::new_v4().to_string())
    .bind(c.current.to_string())
    .execute(&mut connection)
    .await
    .unwrap();
    drop(connection);
    let browser = c
        .store
        .execution_status(&c.owner, &c.conversation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        browser.run_id.unwrap().to_string(),
        historical,
        "conversation history retains its existing ordering"
    );
    let owned = c.status().await.unwrap();
    assert_eq!(
        owned.run_id.as_ref(),
        Some(&c.current),
        "runtime must observe its consumed run even when its input is older"
    );
    assert_eq!(owned.phase, ExecutionPhase::Starting);
    c.close().await;
}

#[tokio::test]
async fn exact_owned_status_keeps_stop_visible() {
    let c = Case::new().await;
    c.bound
        .request_cancel(&c.owner, &c.current, "synthetic-stop")
        .await
        .unwrap();
    let status = c.status().await.unwrap();
    assert_eq!(status.run_id.as_ref(), Some(&c.current));
    assert_eq!(status.phase, ExecutionPhase::CancelRequested);
    c.close().await;
}

#[tokio::test]
async fn credential_owner_and_conversation_must_still_match() {
    let c = Case::new().await;
    for (credential, owner, conversation) in [
        ("cd".repeat(32), c.owner.clone(), c.conversation.clone()),
        (
            c.credential.clone(),
            OwnerId(Uuid::new_v4()),
            c.conversation.clone(),
        ),
        (
            c.credential.clone(),
            c.owner.clone(),
            ConversationId(Uuid::new_v4()),
        ),
    ] {
        assert!(
            read(&c.bound, &credential, &owner, &conversation, &c.current)
                .await
                .is_err()
        );
    }
    c.store.revoke_session(&c.credential).await.unwrap();
    assert!(matches!(
        c.status().await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    c.close().await;
}

#[tokio::test]
async fn an_independent_supervisor_cannot_observe_the_owned_run() {
    let c = Case::new().await;
    let other = c
        .store
        .authorize_supervisor(
            &c.credential,
            ProductionSupervisorConfig {
                provider: ProviderKind::Codex,
                namespace: "subscription:synthetic-other".into(),
                supervisor_key: "synthetic-other".into(),
                takeover: ProductionTakeover::First,
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        read(&other, &c.credential, &c.owner, &c.conversation, &c.current).await,
        Err(RuntimeStoreError::NotFound)
    ));
    drop(other);
    c.close().await;
}

#[tokio::test]
async fn superseded_supervisor_generation_cannot_keep_reading_a_run() {
    let c = Case::new().await;
    let mut connection = c.connection().await;
    let changed = sqlx::query("UPDATE production_supervisors SET generation=generation+1 WHERE context_id=(SELECT context_id FROM production_runs WHERE id=?)")
        .bind(c.current.to_string()).execute(&mut connection).await.unwrap().rows_affected();
    assert_eq!(changed, 1);
    drop(connection);
    assert!(matches!(c.status().await, Err(RuntimeStoreError::Fenced)));
    c.close().await;
}
