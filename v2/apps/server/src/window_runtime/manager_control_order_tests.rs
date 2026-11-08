//! Actual Root-parent transport must never await an empty outer control socket.
use super::*;
use orkestr_v2_application::{runtime::*, IntakeStore};
use orkestr_v2_contracts::{ExecutionWindowRequest, MessageInput};
use orkestr_v2_store_sqlite::{
    ExecutionConsumption, ManagedOperationParent, ManagedOperationSetup, RootWorkspaceCustody,
    Store, WorkspaceDirectoryIdentity, WorkspaceOperatorAllowlist,
};
use std::{
    fs::File,
    io::{Read, Write},
    os::unix::{fs::PermissionsExt, net::UnixListener},
    path::Path,
    process::{Child, Command, Stdio},
    sync::Arc,
    time::Duration,
};

const SOCKET_ENV: &str = "ORKESTR_TEST_CONTROL_ORDER_SOCKET";
const HOME_ENV: &str = "ORKESTR_TEST_CONTROL_ORDER_HOME";

// Use the real authenticated Root client for the callback, while keeping the
// fake Root protocol limited to status. Descriptor validation is tested by the
// workspace snapshot tests; this regression isolates the control-socket order.
struct RootRoundTrip(ManagerClient);
impl RootWorkspaceCustody for RootRoundTrip {
    fn check_original_actor(&self) -> std::result::Result<(), RuntimeStoreError> {
        self.0.parent().map_err(|_| RuntimeStoreError::Fenced)
    }

    fn check(
        &self,
        _: &[PathBuf; 3],
        _: [WorkspaceDirectoryIdentity; 3],
    ) -> std::result::Result<(), RuntimeStoreError> {
        let check = || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(
                    self.0
                        .status("custody-attest", Instant::now() + Duration::from_secs(2)),
                )
        };
        let result = match tokio::runtime::Handle::try_current() {
            Ok(handle) if handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread => {
                tokio::task::block_in_place(check)
            }
            Ok(_) => return Err(RuntimeStoreError::Unavailable),
            Err(_) => check(),
        };
        result.map(|_| ()).map_err(|_| RuntimeStoreError::Fenced)
    }
}

async fn prepared(
    root: &Path,
    socket: PathBuf,
) -> (ManagerClient, Store, String, Window, ManagedOperationParent) {
    let database = root.join("database");
    std::fs::create_dir(&database).unwrap();
    let store = Store::open(&database.join("core.sqlite3")).await.unwrap();
    let conversation = store.setup("owner", "synthetic-hash").await.unwrap();
    let owner = store.credentials("owner").await.unwrap().unwrap().0;
    let token = "ab".repeat(32);
    store.save_session(&token, &owner).await.unwrap();
    let handle = store
        .authorize_supervisor(
            &token,
            ProductionSupervisorConfig {
                provider: ProviderKind::Codex,
                namespace: "synthetic-control-order".into(),
                supervisor_key: "synthetic-deep".into(),
                takeover: ProductionTakeover::First,
            },
        )
        .await
        .unwrap();
    let binding = handle
        .ensure_role_bindings(&owner, &conversation)
        .await
        .unwrap()
        .deep;
    let input = store
        .admit(
            &owner,
            &conversation,
            &MessageInput {
                client_message_id: "synthetic-input".into(),
                text: "Synthetic control ordering fixture".into(),
            },
        )
        .await
        .unwrap()
        .receipt;
    let admitted = store
        .admit_execution_window_authenticated(
            &token,
            &conversation,
            &ExecutionWindowRequest {
                request_key: "synthetic-window".into(),
                input_message_id: input.message_id,
                input_event_id: input.event_id,
                input_request_key: "synthetic-input".into(),
                expected_generation: 0,
                window_id: None,
                predecessor_window_id: None,
            },
        )
        .await
        .unwrap();
    let window = Window {
        window_id: admitted.status.window_id,
        generation: 1,
    };
    let grant = handle
        .issue_execution_window_credential(
            &token,
            window.window_id,
            window.generation,
            "synthetic-boot",
            admitted.status.expires_at_ms,
            &"a".repeat(64),
        )
        .await
        .unwrap();
    let bound = handle.bind_execution_window(&token, &grant).await.unwrap();
    bound
        .activate_execution_window(
            grant.credential(),
            window.window_id,
            window.generation,
            "synthetic-boot",
        )
        .await
        .unwrap();
    let parent = process(std::process::id()).unwrap().0;
    let client = ManagerClient::new(socket, owner.clone(), conversation.clone(), parent).unwrap();
    let project = root.join("project");
    let git = project.join(".git");
    std::fs::create_dir_all(&git).unwrap();
    for path in [&project, &git] {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let allowlist =
        WorkspaceOperatorAllowlist::new(vec![project.clone()], vec![database], 0).unwrap();
    let paths = [project, git.clone(), git];
    let descriptors = paths.clone().map(|path| File::open(path).unwrap().into());
    let installation = allowlist
        .installation_from_root(paths, descriptors, Arc::new(RootRoundTrip(client.clone())))
        .unwrap();
    let project = bound
        .register_workspace(
            grant.credential(),
            &conversation,
            Uuid::from_u128(5),
            installation,
        )
        .await
        .unwrap();
    bound
        .bind_workspace_session(grant.credential(), &project, &binding)
        .await
        .unwrap();
    let metadata = bound.authorize_session_metadata(&binding).await.unwrap();
    let setup = ManagedOperationSetup::from_metadata(&metadata).unwrap();
    let ready = bound
        .confirm_metadata_session(
            metadata,
            NativeSessionConfirmation {
                session_id: binding.session_id,
                expected_generation: binding.generation,
                native_session_id: "synthetic-native".into(),
                protocol_version: "codex-rpc-1".into(),
                source_event_key: "synthetic-ready".into(),
            },
        )
        .await
        .unwrap();
    let binding = ready.binding();
    let claim = bound
        .claim_next(
            &owner,
            &conversation,
            &binding.session_id,
            Duration::from_secs(30),
        )
        .await
        .unwrap()
        .unwrap();
    let run = bound
        .admit_run(
            &claim,
            &binding.session_id,
            binding.generation,
            "synthetic-run",
        )
        .await
        .unwrap();
    let DispatchClaimResult::Reserved(reservation) = bound
        .claim_provider_dispatch(&run, "synthetic-dispatch")
        .await
        .unwrap()
    else {
        panic!("fresh dispatch required")
    };
    let ExecutionConsumption::Dispatch(consumed) =
        bound.consume_execution(&reservation).await.unwrap()
    else {
        panic!("one consumed dispatch required")
    };
    let parent = bound
        .authorize_managed_operation_parent(grant.credential(), &consumed, &setup)
        .await
        .unwrap();
    (client, bound, grant.credential().into(), window, parent)
}

#[test]
fn control_order_child() {
    let Some(socket) = std::env::var_os(SOCKET_ENV) else {
        return;
    };
    let root = PathBuf::from(std::env::var_os(HOME_ENV).unwrap());
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let (client, store, credential, window, parent) = prepared(&root, socket.into()).await;
        client
            .status("fixture-ready", Instant::now() + Duration::from_secs(2))
            .await
            .unwrap();
        // Each separate operation needs a fresh Root round-trip. The nested
        // Store fence must reuse only that operation's live preflight proof.
        for _ in 0..2 {
            client
                .open_managed_run(
                    &store,
                    &credential,
                    &window,
                    &parent,
                    Instant::now() + Duration::from_secs(4),
                )
                .await
                .unwrap();
        }
        client
            .status("fixture-done", Instant::now() + Duration::from_secs(2))
            .await
            .unwrap();
    });
}

struct Owned(Child);
impl Drop for Owned {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}
struct Directory(PathBuf);
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn output(child: &mut Child) -> String {
    let mut output = String::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut output)
        .unwrap();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut output)
        .unwrap();
    output
}

fn receipt(request: &Value) -> Value {
    json!({"owner_id":request["owner_id"],"conversation_id":request["conversation_id"],
        "window_id":request.get("window_id").cloned().unwrap_or(json!(Uuid::from_u128(3))),
        "generation":1,"state":"active","attempts":0,"reserved_bytes":0,"boot_id":Uuid::from_u128(4),
        "opened_at_ms":1000,"work_deadline_ms":871000,"expires_at_ms":901000,
        "limits":ExecutionWindowLimits::default(),"reason":null,"outcome":null,"run_id":null,"terminal_event_id":null})
}

#[test]
#[ignore = "requires root synthetic peer; run focused executable with --include-ignored"]
fn managed_run_attests_before_connecting_single_thread_root() {
    assert!(
        std::fs::read_to_string("/proc/self/status")
            .unwrap()
            .lines()
            .any(|line| line == "Uid:\t0\t0\t0\t0"),
        "root fixture required; no skipped peer checks"
    );
    let root = Directory(std::env::temp_dir().join(format!("control-order-{}", Uuid::new_v4())));
    std::fs::create_dir(&root.0).unwrap();
    std::fs::set_permissions(&root.0, std::fs::Permissions::from_mode(0o700)).unwrap();
    let socket = root.0.join("control.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    listener.set_nonblocking(true).unwrap();
    let name = format!(
        "{}::control_order_child",
        module_path!().split_once("::").unwrap().1
    );
    let mut child = Owned(
        Command::new(std::env::current_exe().unwrap())
            .args(["--exact", &name, "--nocapture"])
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("LANG", "C.UTF-8")
            .env(SOCKET_ENV, &socket)
            .env(HOME_ENV, &root.0)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut armed = false;
    let mut operations = 0;
    let mut attestations = 0;
    loop {
        let (mut stream, _) = loop {
            match listener.accept() {
                Ok(pair) => break pair,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(
                        Instant::now() < deadline,
                        "control fixture exceeded deadline"
                    );
                    if let Some(status) = child.0.try_wait().unwrap() {
                        panic!(
                            "client exited before final receipt ({status}): {}",
                            output(&mut child.0)
                        );
                    }
                    std::thread::sleep(Duration::from_millis(1));
                }
                Err(error) => panic!("accept: {error}"),
            }
        };
        // Deliberately one reader, no second accept while the current request
        // lacks its frame: this is the production Root control service model.
        stream
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        let mut header = [0; 4];
        stream.read_exact(&mut header).expect(
            "Root accepted an empty outer socket while its client awaited nested custody IPC",
        );
        let length = u32::from_be_bytes(header) as usize;
        assert!((1..=MAX_FRAME).contains(&length));
        let mut raw = vec![0; length];
        stream.read_exact(&mut raw).unwrap();
        let request: Value = serde_json::from_slice(&raw).unwrap();
        assert_eq!(canonical(request.clone()).unwrap(), raw);
        let mut reply = json!({"ok":true,"receipt":receipt(&request)});
        let done = request["request_id"] == "fixture-done";
        match request["operation"].as_str().unwrap() {
            "status" if request["request_id"] == "fixture-ready" => {
                assert!(!armed);
                armed = true;
            }
            "status" if request["request_id"] == "custody-attest" => {
                if armed {
                    attestations += 1;
                    assert_eq!(
                        attestations,
                        operations + 1,
                        "nested fence fetched Root again"
                    );
                }
            }
            "status" if done => {
                assert_eq!((operations, attestations), (2, 2));
            }
            "managed_run_open" => {
                assert!(armed);
                assert_eq!(
                    attestations,
                    operations + 1,
                    "fresh attestation must precede outer connect"
                );
                operations += 1;
                reply["managed_run"] = json!({"run_id":request["run"]["run_id"]});
            }
            _ => panic!("unexpected synthetic control operation"),
        }
        let raw = canonical(reply).unwrap();
        stream.write_all(&(raw.len() as u32).to_be_bytes()).unwrap();
        stream.write_all(&raw).unwrap();
        drop(stream);
        if done {
            break;
        }
    }
    let finish = Instant::now() + Duration::from_secs(3);
    let status = loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            break status;
        }
        assert!(
            Instant::now() < finish,
            "client did not finish after final receipt"
        );
        std::thread::sleep(Duration::from_millis(1));
    };
    assert!(
        status.success(),
        "synthetic client failed: {}",
        output(&mut child.0)
    );
    assert!(
        matches!(listener.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock),
        "no extra IPC after final receipt"
    );
}
