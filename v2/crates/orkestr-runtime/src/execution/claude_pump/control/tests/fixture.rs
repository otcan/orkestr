use super::*;
use orkestr_v2_application::{
    runtime::{DispatchClaimResult, ProductionSupervisorConfig, ProductionTakeover},
    IntakeStore,
};
use orkestr_v2_contracts::{ConversationId, MessageInput, OwnerId, RunId};
use orkestr_v2_store_sqlite::ExecutionConsumption;
use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

pub(super) struct Case {
    pub root: PathBuf,
    pub store: Store,
    pub bound: Store,
    pub token: String,
    pub owner: OwnerId,
    pub conversation: ConversationId,
    pub run: RunId,
    pub authority: Option<crate::containment::Authority>,
    pub pump: Option<ClaudePump>,
    pub native: Option<(u32, String)>,
}
static COUNTER: AtomicU64 = AtomicU64::new(0);

impl Case {
    pub async fn new(mode: &str) -> Self {
        let root = PathBuf::from(std::env::var("ORKESTR_V2_HOME").unwrap()).join(format!(
            "claude-stop-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        for dir in ["workspace", "home", "tmp", "account"] {
            std::fs::create_dir(root.join(dir)).unwrap();
        }
        std::fs::write(root.join("workspace/mode"), mode).unwrap();
        let native = root.join("native");
        std::fs::write(&native, include_str!("native.py")).unwrap();
        std::fs::set_permissions(&native, std::fs::Permissions::from_mode(0o700)).unwrap();
        let config = root.join("config.json");
        std::fs::write(&config, serde_json::json!({"executable":native,"account":root.join("account"),
            "workspace":root.join("workspace"),"home":root.join("home"),"temporary":root.join("tmp")}).to_string()).unwrap();
        std::fs::set_permissions(&config, std::fs::Permissions::from_mode(0o600)).unwrap();
        let modules = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../provider-broker")
            .canonicalize()
            .unwrap();
        let launcher = root.join("launcher");
        std::fs::write(&launcher, format!("#!/usr/bin/python3\nimport sys\nsys.path.insert(0,{:?})\nfrom claude_server import main\nraise SystemExit(main({:?}))\n", modules.to_str().unwrap(), config.to_str().unwrap())).unwrap();
        std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o700)).unwrap();
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
        let token = "cd".repeat(32);
        store.save_session(&token, &owner).await.unwrap();
        let bound = store
            .authorize_supervisor(
                &token,
                ProductionSupervisorConfig {
                    provider: orkestr_v2_application::runtime::ProviderKind::Claude,
                    namespace: "subscription:synthetic".into(),
                    supervisor_key: "synthetic-claude-stop".into(),
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
        let grant = bound.authorize_session_metadata(&binding).await.unwrap();
        let dirs = crate::containment::ChildDirectories::new(
            &root.join("workspace"),
            &root.join("home"),
            &root.join("tmp"),
        )
        .unwrap();
        let mut setup =
            crate::execution::PreparingClaude::open(bound.clone(), grant, &launcher, dirs).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !setup.poll().unwrap() {
            pause(deadline).await;
        }
        let ready = setup.confirm().await.unwrap();
        let binding = bound
            .ensure_role_bindings(&owner, &conversation)
            .await
            .unwrap()
            .deep;
        store
            .admit(
                &owner,
                &conversation,
                &MessageInput {
                    client_message_id: "first".into(),
                    text: "synthetic isolated input".into(),
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
            .admit_run(
                &claim,
                &binding.session_id,
                binding.generation,
                "claude-stop-run",
            )
            .await
            .unwrap();
        let run = admission.provider.run.run_id.clone();
        let DispatchClaimResult::Reserved(reservation) = bound
            .claim_provider_dispatch(&admission, "claude-stop-reservation")
            .await
            .unwrap()
        else {
            panic!("fresh reservation")
        };
        let ExecutionConsumption::Dispatch(cap) =
            bound.consume_execution(&reservation).await.unwrap()
        else {
            panic!("one dispatch")
        };
        let (authority, mut pump) = ready.attach(bound.clone(), cap).unwrap();
        assert!(!pump.can_stop());
        loop {
            pump.flush().unwrap();
            pump.step(&bound).await.unwrap();
            let state = store
                .execution_status(&owner, &conversation)
                .await
                .unwrap()
                .unwrap();
            if state.progress.is_some() && pump.can_stop() {
                break;
            }
            pause(deadline).await;
        }
        let mut case = Self {
            root,
            store,
            bound,
            token,
            owner,
            conversation,
            run,
            authority: Some(authority),
            pump: Some(pump),
            native: None,
        };
        loop {
            if let Some(identity) = native_identity(&case.root.join("native")) {
                case.native = Some(identity);
                break;
            }
            pause(deadline).await;
        }
        case
    }
    pub async fn cancel(&self) -> CancelReceipt {
        use orkestr_v2_contracts::MessageInput;
        self.store
            .admit(
                &self.owner,
                &self.conversation,
                &MessageInput {
                    client_message_id: "pre-stop-held".into(),
                    text: "must remain held".into(),
                },
            )
            .await
            .unwrap();
        let receipt = self
            .bound
            .request_cancel(&self.owner, &self.run, "owner-stop")
            .await
            .unwrap();
        let held = self
            .bound
            .held_owner_inputs_authenticated(&self.token, &self.conversation, 0, 100)
            .await
            .unwrap();
        assert_eq!(held.held.len(), 1);
        assert_eq!(held.held[0].boundary_run_id, self.run);
        assert!(!held.eligible_input_available);
        receipt
    }
    pub async fn phase(&self) -> orkestr_v2_contracts::ExecutionPhase {
        self.store
            .execution_status(&self.owner, &self.conversation)
            .await
            .unwrap()
            .unwrap()
            .phase
    }
    pub fn bytes(&self) -> Vec<u8> {
        std::fs::read(self.root.join("workspace/native-inputs")).unwrap()
    }
    pub fn gone(&self) -> bool {
        let (pid, start) = self.native.as_ref().unwrap();
        process_start(*pid).as_ref() != Some(start)
    }
    pub async fn cleanup(mut self) {
        self.pump = None;
        self.authority = None;
        let deadline = Instant::now() + Duration::from_secs(10);
        while !self.gone() {
            pause(deadline).await;
        }
        drop(self.bound);
        drop(self.store);
        std::fs::remove_dir_all(self.root).unwrap();
    }
}
pub(super) async fn pause(deadline: Instant) {
    assert!(Instant::now() < deadline, "bounded synthetic deadline");
    tokio::time::sleep(Duration::from_millis(2)).await;
}
fn process_start(pid: u32) -> Option<String> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    stat.rsplit_once(')')?
        .1
        .split_whitespace()
        .nth(19)
        .map(str::to_owned)
}
fn native_identity(path: &Path) -> Option<(u32, String)> {
    use std::os::unix::ffi::OsStrExt;
    for entry in std::fs::read_dir("/proc").ok()?.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let Ok(args) = std::fs::read(entry.path().join("cmdline")) else {
            continue;
        };
        if !args
            .split(|b| *b == 0)
            .any(|part| part == path.as_os_str().as_bytes())
        {
            continue;
        }
        let Ok(exe) = std::fs::read_link(entry.path().join("exe")) else {
            continue;
        };
        if !exe
            .file_name()
            .is_some_and(|s| s.to_string_lossy().starts_with("python3"))
        {
            continue;
        }
        if let Some(start) = process_start(pid) {
            return Some((pid, start));
        }
    }
    None
}
