//! Test executable only: stdin commands against a marked, isolated browser DB.
//! No routes, SQL, provider processes or production binary integration.
use orkestr_v2_application::{runtime::*, IntakeStore};
use orkestr_v2_contracts::{ConversationId, ExecutionPhase, MessageInput, OwnerId};
use orkestr_v2_store_sqlite::Store;
use serde_json::{json, Value};
use std::{
    io::{BufRead, Read, Write},
    path::PathBuf,
    time::Duration,
};

struct Driver {
    store: Store,
    bound: Store,
    owner: OwnerId,
    conversation: ConversationId,
    provider: Option<ProviderAdmission>,
    sequence: u64,
}
impl Driver {
    async fn open(db: PathBuf, username: &str, conversation: ConversationId) -> Self {
        assert!(db.is_absolute() && db.is_file());
        let parent = db.parent().unwrap().canonicalize().unwrap();
        let temporary = std::env::temp_dir().canonicalize().unwrap();
        let relative = parent
            .strip_prefix(temporary)
            .expect("temporary fixture home");
        assert!(relative
            .components()
            .next()
            .unwrap()
            .as_os_str()
            .to_str()
            .unwrap()
            .starts_with("orkestr-v2-browser-"));
        assert_eq!(
            std::fs::read_to_string(parent.join("browser-fixture.marker")).unwrap(),
            "synthetic-browser-fixture-v1\n"
        );
        assert!(!std::fs::symlink_metadata(&db)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(username.starts_with("synthetic-"));
        let store = Store::open(&db).await.unwrap();
        let owner = store.credentials(username).await.unwrap().unwrap().0;
        store.execution_status(&owner, &conversation).await.unwrap(); // owner/scope check
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        store.save_session(&token, &owner).await.unwrap();
        let bound = store
            .authorize_supervisor(
                &token,
                ProductionSupervisorConfig {
                    provider: ProviderKind::Codex,
                    namespace: "synthetic-browser-fixture".into(),
                    supervisor_key: "synthetic-browser-deep".into(),
                    takeover: ProductionTakeover::First,
                },
            )
            .await
            .unwrap();
        Self {
            store,
            bound,
            owner,
            conversation,
            provider: None,
            sequence: 0,
        }
    }
    async fn start_if_needed(&mut self) {
        let status = self
            .store
            .execution_status(&self.owner, &self.conversation)
            .await
            .unwrap();
        if status.as_ref().is_some_and(|s| {
            matches!(
                s.phase,
                ExecutionPhase::Running | ExecutionPhase::AwaitingAcceptance
            )
        }) {
            assert_eq!(
                status.unwrap().run_id,
                self.provider.as_ref().map(|p| p.run.run_id.clone())
            );
            return;
        }
        let binding = self
            .bound
            .ensure_role_bindings(&self.owner, &self.conversation)
            .await
            .unwrap()
            .deep;
        let binding = if binding.native_session_id.is_some() {
            binding
        } else {
            self.bound
                .confirm_native_session(NativeSessionConfirmation {
                    session_id: binding.session_id,
                    expected_generation: binding.generation,
                    native_session_id: "synthetic-browser-native".into(),
                    protocol_version: "codex-rpc-1".into(),
                    source_event_key: format!("synthetic-ready:{}", uuid::Uuid::new_v4()),
                })
                .await
                .unwrap()
        };
        self.followup().await;
        let claim = self
            .bound
            .claim_next(
                &self.owner,
                &self.conversation,
                &binding.session_id,
                Duration::from_secs(60),
            )
            .await
            .unwrap()
            .unwrap();
        let admission = self
            .bound
            .admit_run(
                &claim,
                &binding.session_id,
                binding.generation,
                &format!("synthetic-run:{}", uuid::Uuid::new_v4()),
            )
            .await
            .unwrap();
        let DispatchClaimResult::Reserved(dispatch) = self
            .bound
            .claim_provider_dispatch(
                &admission,
                &format!("synthetic-dispatch:{}", uuid::Uuid::new_v4()),
            )
            .await
            .unwrap()
        else {
            panic!("fresh synthetic reservation required")
        };
        assert!(matches!(
            self.bound.consume_execution(&dispatch).await.unwrap(),
            orkestr_v2_store_sqlite::ExecutionConsumption::Dispatch(_)
        ));
        self.provider = Some(admission.provider);
        self.sequence = 0;
        self.append(ProviderEvent::Started).await;
    }
    async fn append(&mut self, event: ProviderEvent) {
        self.sequence += 1;
        let provider = self.provider.as_ref().unwrap();
        self.bound
            .append_provider_event(
                &self.owner,
                provider,
                &ProviderEventInput {
                    run_id: provider.run.run_id.clone(),
                    session_id: provider.run.session_id.clone(),
                    lease_generation: provider.run.lease_generation,
                    dispatch_fence: provider.run.dispatch_fence,
                    sequence: self.sequence,
                    event,
                },
            )
            .await
            .unwrap();
    }
    async fn followup(&self) {
        self.store
            .admit(
                &self.owner,
                &self.conversation,
                &MessageInput {
                    client_message_id: format!("synthetic-followup:{}", uuid::Uuid::new_v4()),
                    text: "Synthetic browser followup; no provider inference.".into(),
                },
            )
            .await
            .unwrap();
    }
    async fn command(&mut self, input: Value) -> Value {
        match input["action"].as_str().unwrap() {
            "completed" => {
                self.start_if_needed().await;
                let status = self
                    .store
                    .execution_status(&self.owner, &self.conversation)
                    .await
                    .unwrap()
                    .unwrap();
                if status.phase != ExecutionPhase::AwaitingAcceptance {
                    // A synthetic producer exercises ordinary committed metadata,
                    // not a real provider or any claim of native readiness.
                    self.append(ProviderEvent::CompletedProposal { synthetic: false })
                        .await;
                }
                let status = self
                    .store
                    .execution_status(&self.owner, &self.conversation)
                    .await
                    .unwrap()
                    .unwrap();
                let candidate = status.acceptance_candidate.unwrap();
                json!({"conversation_id":self.conversation,"run_id":candidate.run_id,"completion_event_id":candidate.completion_event_id})
            }
            "progress" => {
                self.start_if_needed().await;
                let text = format!("Synthetic removable output {}", uuid::Uuid::new_v4());
                self.append(ProviderEvent::Progress(text.clone())).await;
                let status = self
                    .store
                    .execution_status(&self.owner, &self.conversation)
                    .await
                    .unwrap()
                    .unwrap();
                json!({"conversation_id":self.conversation,"payload_id":status.progress.unwrap().payload_id,"text":text})
            }
            "advanceRevision" => {
                let before = self
                    .store
                    .execution_status(&self.owner, &self.conversation)
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(before.phase, ExecutionPhase::AwaitingAcceptance);
                self.followup().await;
                let after = self
                    .store
                    .execution_status(&self.owner, &self.conversation)
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(after.phase, before.phase);
                assert_eq!(after.run_id, before.run_id);
                assert_eq!(after.acceptance_candidate, before.acceptance_candidate);
                assert!(after.revision > before.revision);
                json!({"revision":after.revision,"acceptance_candidate":after.acceptance_candidate})
            }
            "revokeBrowserSession" => {
                let token = input["browser_token"].as_str().unwrap();
                assert!(token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit()));
                let credential = format!("browser:{token}");
                assert_eq!(
                    self.store.authenticate(&credential).await.unwrap(),
                    Some(self.owner.clone())
                );
                self.store.revoke_session(&credential).await.unwrap();
                json!({"revoked":true})
            }
            _ => panic!("unknown synthetic fixture command"),
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Explicit synthetic browser fixture driver; requires marked isolated DB and stdin protocol"]
async fn browser_fixture_driver() {
    let db = PathBuf::from(std::env::var("ORKESTR_V2_BROWSER_FIXTURE_DB").unwrap());
    let username = std::env::var("ORKESTR_V2_BROWSER_FIXTURE_USERNAME").unwrap();
    let conversation = ConversationId(
        std::env::var("ORKESTR_V2_BROWSER_FIXTURE_CONVERSATION")
            .unwrap()
            .parse()
            .unwrap(),
    );
    let mut driver = Driver::open(db, &username, conversation).await;
    println!("\nFIXTURE {}", json!({"ready":true}));
    std::io::stdout().flush().unwrap();
    loop {
        let line = tokio::task::spawn_blocking(|| {
            let mut bytes = Vec::new();
            let stdin = std::io::stdin();
            let mut input = stdin.lock();
            let count = input
                .by_ref()
                .take(8193)
                .read_until(b'\n', &mut bytes)
                .unwrap();
            assert!(count <= 8192, "fixture command exceeds bound");
            bytes
        })
        .await
        .unwrap();
        if line.is_empty() {
            break;
        }
        let input: Value = serde_json::from_slice(&line).unwrap();
        let result = driver.command(input).await;
        println!("FIXTURE {result}");
        std::io::stdout().flush().unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fixture_operations_use_durable_candidates_and_real_conflict() {
    use orkestr_v2_contracts::ExecutionAcceptanceRequest;
    let root = std::env::temp_dir().join(format!(
        "orkestr-v2-browser-driver-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir(&root).unwrap();
    std::fs::write(
        root.join("browser-fixture.marker"),
        "synthetic-browser-fixture-v1\n",
    )
    .unwrap();
    let store = Store::open(&root.join("core.sqlite3")).await.unwrap();
    let conversation = store
        .setup("synthetic-driver-owner", "synthetic-unused-hash")
        .await
        .unwrap();
    let mut driver = Driver::open(
        root.join("core.sqlite3"),
        "synthetic-driver-owner",
        conversation.clone(),
    )
    .await;
    let browser = "ab".repeat(32);
    store
        .save_session(&format!("browser:{browser}"), &driver.owner)
        .await
        .unwrap();
    let progress = driver.command(json!({"action":"progress"})).await;
    let payload = serde_json::from_value(progress["payload_id"].clone()).unwrap();
    assert!(store
        .provider_payload(&driver.owner, &conversation, &payload)
        .await
        .unwrap()
        .text
        .is_some());
    store
        .remove_provider_payload(&driver.owner, &conversation, &payload)
        .await
        .unwrap();
    assert!(store
        .provider_payload(&driver.owner, &conversation, &payload)
        .await
        .unwrap()
        .text
        .is_none());
    let candidate = driver.command(json!({"action":"completed"})).await;
    let status = store
        .execution_status(&driver.owner, &conversation)
        .await
        .unwrap()
        .unwrap();
    let request = ExecutionAcceptanceRequest {
        run_id: serde_json::from_value(candidate["run_id"].clone()).unwrap(),
        completion_event_id: serde_json::from_value(candidate["completion_event_id"].clone())
            .unwrap(),
        expected_revision: status.revision,
        request_key: "synthetic-stale-key".into(),
    };
    let newer = driver.command(json!({"action":"advanceRevision"})).await;
    assert_eq!(
        store
            .accept_execution_authenticated(&format!("browser:{browser}"), &conversation, &request)
            .await,
        Err(RuntimeStoreError::Conflict)
    );
    let updated = ExecutionAcceptanceRequest {
        expected_revision: newer["revision"].as_i64().unwrap(),
        ..request
    };
    let receipt = store
        .accept_execution_authenticated(&format!("browser:{browser}"), &conversation, &updated)
        .await
        .unwrap();
    assert_eq!(
        store
            .accept_execution_authenticated(&format!("browser:{browser}"), &conversation, &updated)
            .await
            .unwrap(),
        receipt
    );
    let second_progress = driver.command(json!({"action":"progress"})).await;
    let third_progress = driver.command(json!({"action":"progress"})).await;
    assert_ne!(second_progress["payload_id"], third_progress["payload_id"]);
    let next = driver.command(json!({"action":"completed"})).await;
    assert_ne!(next["run_id"], candidate["run_id"]);
    driver
        .command(json!({"action":"revokeBrowserSession","browser_token":browser}))
        .await;
    assert_eq!(
        store
            .accept_execution_authenticated(&format!("browser:{browser}"), &conversation, &updated)
            .await,
        Err(RuntimeStoreError::Unauthorized)
    );
    drop(driver);
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn fixture_stdio_protocol_uses_real_store() {
    use std::process::{Command, Stdio};
    let root =
        std::env::temp_dir().join(format!("orkestr-v2-browser-stdio-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    std::fs::write(
        root.join("browser-fixture.marker"),
        "synthetic-browser-fixture-v1\n",
    )
    .unwrap();
    let db = root.join("core.sqlite3");
    let store = Store::open(&db).await.unwrap();
    let conversation = store
        .setup("synthetic-stdio-owner", "synthetic-unused-hash")
        .await
        .unwrap();
    drop(store);
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "fixture_driver::browser_fixture_driver",
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ])
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("ORKESTR_V2_BROWSER_FIXTURE_DB", &db)
        .env(
            "ORKESTR_V2_BROWSER_FIXTURE_USERNAME",
            "synthetic-stdio-owner",
        )
        .env(
            "ORKESTR_V2_BROWSER_FIXTURE_CONVERSATION",
            conversation.to_string(),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    input.write_all(b"{\"action\":\"progress\"}\n{\"action\":\"completed\"}\n{\"action\":\"advanceRevision\"}\n").unwrap();
    drop(input);
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    let replies: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .filter_map(|line| line.strip_prefix("FIXTURE "))
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(replies.len(), 4);
    assert_eq!(replies[0]["ready"], true);
    assert!(replies[1]["payload_id"].is_string());
    assert_eq!(
        replies[2]["completion_event_id"],
        replies[3]["acceptance_candidate"]["completion_event_id"]
    );
    std::fs::remove_dir_all(root).unwrap();
}
