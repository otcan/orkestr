//! Disposable ordinary Store and real broker; no production paths or accounts.
use super::{fast_execution::*, host_identity::HostIdentity};
use orkestr_runtime::containment::{ChildDirectories, ReapedBroker, RetiringBroker};
use orkestr_v2_application::{runtime::*, IntakeStore};
use orkestr_v2_contracts::{
    ConversationId, ExecutionAcceptanceRequest, ExecutionPhase, MessageInput, OwnerId, RunId,
};
use orkestr_v2_store_sqlite::{BoundSessionMetadata, FastAdmissionInput, Store};
use serde_json::{json, Value};
use std::{
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

struct Retained(Arc<AtomicUsize>);
impl Drop for Retained {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

pub struct Case {
    pub root: PathBuf,
    pub store: Store,
    pub bound: Store,
    pub owner: OwnerId,
    pub conversation: ConversationId,
    pub token: String,
    pub browser: String,
    pub retained: Arc<AtomicUsize>,
    pub native: Vec<HostIdentity>,
}

impl Case {
    pub async fn new(label: &str) -> Self {
        let root = PathBuf::from(
            std::env::var_os("ORKESTR_V2_HOME").expect("isolated fixture home required"),
        )
        .join(format!("fast-persistent-{}-{label}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let root = root.canonicalize().unwrap();
        for name in ["workspace", "home", "tmp"] {
            std::fs::create_dir(root.join(name)).unwrap();
        }
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
        let token = "ab".repeat(32);
        let browser = "cd".repeat(32);
        store.save_session(&token, &owner).await.unwrap();
        store.save_session(&browser, &owner).await.unwrap();
        let bound = store
            .authorize_supervisor(&token, Self::config(ProductionTakeover::First))
            .await
            .unwrap();
        let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .canonicalize()
            .unwrap();
        let native = root.join("synthetic-native");
        std::fs::copy(repository.join("tests/fast_persistent_peer.py"), &native).unwrap();
        std::fs::set_permissions(&native, std::fs::Permissions::from_mode(0o700)).unwrap();
        let config = root.join("synthetic-private.json");
        std::fs::write(&config, json!({"codex_executable":native,"codex_home":root.join("home"),
            "home":root.join("home"),"temporary":root.join("tmp"),"workspace":root.join("workspace")}).to_string()).unwrap();
        let launcher = root.join("launcher");
        std::fs::write(&launcher, format!("#!/usr/bin/python3\nimport sys\nsys.path.insert(0,{})\nfrom server import main\nraise SystemExit(main({}))\n",
            serde_json::to_string(&repository.join("provider-broker")).unwrap(), serde_json::to_string(&config).unwrap())).unwrap();
        std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o700)).unwrap();
        Self {
            root,
            store,
            bound,
            owner,
            conversation,
            token,
            browser,
            retained: Arc::new(AtomicUsize::new(0)),
            native: vec![],
        }
    }

    pub fn config(takeover: ProductionTakeover) -> ProductionSupervisorConfig {
        ProductionSupervisorConfig {
            provider: ProviderKind::Codex,
            namespace: "synthetic:fast-only".into(),
            supervisor_key: "synthetic-fast-persistent".into(),
            takeover,
        }
    }

    pub async fn ready(&mut self, grant: Option<BoundSessionMetadata>) -> ReadyFast {
        let grant = match grant {
            Some(grant) => grant,
            None => {
                let binding = self
                    .bound
                    .ensure_role_bindings(&self.owner, &self.conversation)
                    .await
                    .unwrap()
                    .fast;
                self.bound
                    .authorize_session_metadata(&binding)
                    .await
                    .unwrap()
            }
        };
        self.retained.fetch_add(1, Ordering::AcqRel);
        let mut preparing = PreparingFast::open_retained(
            self.bound.clone(),
            grant,
            &self.root.join("launcher"),
            &self.root.join("workspace"),
            ChildDirectories::new(
                &self.root.join("workspace"),
                &self.root.join("home"),
                &self.root.join("tmp"),
            )
            .unwrap(),
            Box::new(Retained(Arc::clone(&self.retained))),
        )
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !preparing.poll_ready().unwrap() {
            assert!(Instant::now() < deadline, "Fast setup deadline");
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        let ready = preparing.confirm().await.unwrap();
        let row = self
            .trace()
            .into_iter()
            .rev()
            .find(|row| row["kind"] == "spawn")
            .unwrap();
        self.native.push(HostIdentity::observe(
            &self.root.join("synthetic-native"),
            row["pid_namespace"].as_u64().unwrap(),
            row["process_start"].as_u64().unwrap(),
        ));
        ready
    }

    pub async fn source(&self, number: u8) -> FastAdmissionInput {
        self.store
            .admit(
                &self.owner,
                &self.conversation,
                &MessageInput {
                    client_message_id: format!("fast-source:{number}"),
                    text: format!("synthetic Fast source {number}"),
                },
            )
            .await
            .unwrap();
        self.selected().await
    }

    pub async fn selected(&self) -> FastAdmissionInput {
        let source = self
            .bound
            .next_fast_source(&self.token, &self.conversation, 0)
            .await
            .unwrap()
            .unwrap();
        let binding = self
            .bound
            .ensure_role_bindings(&self.owner, &self.conversation)
            .await
            .unwrap()
            .fast;
        FastAdmissionInput {
            source_message_id: source.message_id,
            source_event_id: source.event_id.clone(),
            fast_binding_id: binding.session_id,
            expected_binding_generation: binding.generation,
            request_key: format!("fast:{}", source.event_id),
        }
    }

    pub async fn drive(&self, live: &mut LiveFast, phase: ExecutionPhase) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            live.tick().await.unwrap();
            let status = self
                .bound
                .execution_run_status(&self.token, &self.owner, &self.conversation, live.run_id())
                .await
                .unwrap()
                .unwrap();
            if status.phase == phase && status.progress.is_some() {
                return;
            }
            assert!(Instant::now() < deadline, "Fast phase deadline: {phase:?}");
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    }

    pub async fn accept(&self, run: &RunId) {
        let status = self
            .bound
            .execution_run_status(&self.token, &self.owner, &self.conversation, run)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(status.phase, ExecutionPhase::AwaitingAcceptance);
        let event = status.acceptance_candidate.unwrap().completion_event_id;
        let request = ExecutionAcceptanceRequest {
            run_id: run.clone(),
            completion_event_id: event,
            expected_revision: status.revision,
            request_key: format!("accept:{run}"),
        };
        let receipt = self
            .store
            .accept_execution_authenticated(&self.browser, &self.conversation, &request)
            .await
            .unwrap();
        assert_eq!(
            receipt,
            self.store
                .accept_execution_authenticated(&self.browser, &self.conversation, &request)
                .await
                .unwrap()
        );
    }

    pub async fn reaped(&self, mut retiring: RetiringBroker, run: &RunId) -> ReapedBroker {
        let deadline = Instant::now() + Duration::from_secs(5);
        let proof = loop {
            if let Some(proof) = retiring.poll_reaped().unwrap() {
                break proof;
            }
            assert!(Instant::now() < deadline, "Fast broker reap deadline");
            tokio::time::sleep(Duration::from_millis(2)).await;
        };
        assert_eq!(proof.scope().owner(), self.owner.to_string());
        assert_eq!(proof.scope().run(), run.to_string());
        drop(retiring);
        self.gone().await;
        proof
    }

    pub async fn gone(&self) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while self.retained.load(Ordering::Acquire) != 0
            || self.native.iter().any(|identity| !identity.gone())
        {
            assert!(
                Instant::now() < deadline,
                "Fast exact child/resources remain live"
            );
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    }

    pub fn release(&self, number: u8) {
        std::fs::write(
            self.root
                .join(format!("workspace/release-fast-turn-{number}")),
            b"",
        )
        .unwrap();
    }

    pub fn trace(&self) -> Vec<Value> {
        std::fs::read_to_string(self.root.join("workspace/synthetic-peer.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    pub fn query(&self, sql: &str) -> Value {
        let output = std::process::Command::new("python3").arg("-c").arg(
            "import json,sqlite3,sys;from pathlib import Path\np=Path(sys.argv[1]).resolve(strict=True)\nc=sqlite3.connect(p.as_uri()+'?mode=ro',uri=True);c.execute('PRAGMA query_only=ON');c.execute('PRAGMA trusted_schema=OFF');print(json.dumps(c.execute(sys.argv[2]).fetchall()));c.close()")
            .arg(self.root.join("state.sqlite3")).arg(sql).env_clear().env("PATH", "/usr/bin:/bin").output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }
}

impl Drop for Case {
    fn drop(&mut self) {
        if !std::thread::panicking() {
            assert!(self.native.iter().all(|identity| identity.gone()));
            assert_eq!(self.retained.load(Ordering::Acquire), 0);
            if let Some(directory) = std::env::var_os("ORKESTR_V2_TEST_EVIDENCE") {
                let directory = PathBuf::from(directory).canonicalize().unwrap();
                let report = directory
                    .join(self.root.file_name().unwrap())
                    .with_extension("json");
                let report = std::fs::OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(report)
                    .unwrap();
                report
                    .set_permissions(std::fs::Permissions::from_mode(0o600))
                    .unwrap();
                serde_json::to_writer_pretty(report, &json!({
                    "trace":self.trace(), "native_processes_observed":self.native.len(),
                    "all_observed_native_identities_gone":true, "retained_resources":0,
                    "runs":self.query("SELECT id,role,state,session_id,native_session_id,lease_generation FROM production_runs ORDER BY rowid"),
                    "inbox":self.query("SELECT event_id,state,admitted_run_id FROM reasoning_inbox ORDER BY sequence"),
                    "observations":self.query("SELECT run_id,kind,receipt_state FROM production_observations ORDER BY rowid"),
                    "acceptances":self.query("SELECT run_id,completion_event_id FROM production_acceptances ORDER BY rowid"),
                    "cancellations":self.query("SELECT run_id,receipt_state,inflight_status FROM production_cancellations ORDER BY rowid")
                })).unwrap();
            }
            std::fs::remove_dir_all(&self.root).unwrap();
        }
        // Preserve the disposable source/trace on failed assertions. Runtime's
        // actual owned handles still drop and reap; no PID is ever signalled here.
    }
}
