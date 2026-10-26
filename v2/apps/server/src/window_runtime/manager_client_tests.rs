use super::*;
use std::io::{Read, Write};
use std::os::unix::process::CommandExt;
use std::os::unix::{fs::PermissionsExt, net::UnixListener};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

fn owner() -> OwnerId {
    OwnerId(Uuid::from_u128(1))
}
fn conversation() -> ConversationId {
    ConversationId(Uuid::from_u128(2))
}
fn window() -> Window {
    Window {
        window_id: Uuid::from_u128(3),
        generation: 1,
    }
}
fn receipt() -> Value {
    json!({"owner_id":owner(),"conversation_id":conversation(),"window_id":window().window_id,
        "generation":1,"state":"active","attempts":0,"reserved_bytes":0,"boot_id":Uuid::from_u128(4),
        "opened_at_ms":1000,"work_deadline_ms":871000,"expires_at_ms":901000,
        "limits":ExecutionWindowLimits::default(),"reason":null,"outcome":null,"run_id":null,"terminal_event_id":null})
}
fn admission() -> Admission {
    Admission {
        request_id: "synthetic-input".into(),
        window: window(),
        expected_generation: 0,
        input_message_id: MessageId(Uuid::from_u128(5)),
        input_event_id: EventId(Uuid::from_u128(6)),
        input_request_key: "synthetic-ä-界".into(),
        predecessor_window_id: None,
        opened_at_ms: 1000,
        work_deadline_ms: 871000,
        expires_at_ms: 901000,
    }
}
fn client() -> ManagerClient {
    let parent = process(std::process::id()).unwrap().0;
    ManagerClient::new(
        PathBuf::from("/unused-synthetic.sock"),
        owner(),
        conversation(),
        parent,
    )
    .unwrap()
}

#[test]
fn exact_receipt_refusals_and_retired_provenance() {
    let client = client();
    for (field, bad) in [
        ("owner_id", json!(Uuid::from_u128(99))),
        ("generation", json!(INTEGER_LIMIT)),
        ("generation", json!(true)),
        ("attempts", json!(33)),
        ("reserved_bytes", json!(67_108_865u64)),
        ("state", json!("completed")),
        ("reason", json!("Not A Token")),
        ("reason", json!("")),
        ("run_id", json!(Uuid::from_u128(8))),
        ("boot_id", json!(Uuid::nil())),
        ("expires_at_ms", json!(901001)),
        ("unexpected", json!(false)),
    ] {
        let mut value = receipt();
        value[field] = bad;
        assert!(
            matches!(client.receipt(&value), Err(ManagerError::Protocol)),
            "{field}"
        );
    }
    // An unknown but closed reason token is a diagnostic only: accepted.
    let mut value = receipt();
    value["reason"] = json!("owned_child_observation");
    assert!(client.receipt(&value).is_ok());
    value = receipt();
    value["limits"]["cleanup_ms"] = json!(15000);
    assert!(client.receipt(&value).is_err());
    value = receipt();
    value["state"] = json!("retired");
    assert!(client.receipt(&value).is_err());
    value["outcome"] = json!("accepted");
    value["run_id"] = json!(Uuid::from_u128(7));
    value["terminal_event_id"] = json!(Uuid::from_u128(8));
    assert!(client.receipt(&value).is_ok());
    value["outcome"] = json!("abandoned");
    value["reason"] = json!("manager_stopped");
    assert!(client.receipt(&value).is_ok());
    value["outcome"] = json!("succeeded");
    assert!(client.receipt(&value).is_err());
    // A failed window may name its lapsed Deep turn, or (a failed open) no
    // run at all; nothing else may omit it.
    value["outcome"] = json!("failed");
    assert!(client.receipt(&value).is_ok());
    value["run_id"] = json!(null);
    assert!(client.receipt(&value).is_err());
    value["terminal_event_id"] = json!(null);
    assert!(matches!(
        client.receipt(&value),
        Ok(ManagerReceipt::Window(receipt)) if receipt.outcome == Some(TerminalOutcome::Failed)
    ));
    value["outcome"] = json!("abandoned");
    assert!(client.receipt(&value).is_err());
    let mut idle = json!({"owner_id":owner(),"conversation_id":conversation(),"state":"idle","generation":0,"window_id":null});
    assert!(matches!(
        client.receipt(&idle),
        Ok(ManagerReceipt::Idle { .. })
    ));
    idle["generation"] = json!(false);
    assert!(client.receipt(&idle).is_err());
}

#[tokio::test]
async fn abandonment_is_reconcile_only_and_refused_before_io() {
    let client = client();
    let deadline = Instant::now() + Duration::from_secs(1);
    assert_eq!(
        client
            .retire(
                "synthetic",
                &window(),
                TerminalOutcome::Abandoned,
                Uuid::from_u128(7),
                EventId(Uuid::from_u128(8)),
                deadline,
            )
            .await
            .unwrap_err(),
        ManagerError::InvalidRequest
    );
    assert_eq!(
        client
            .reconcile(
                "synthetic",
                &window(),
                TerminalOutcome::Abandoned,
                Some((Uuid::nil(), EventId(Uuid::from_u128(8)))),
                deadline,
            )
            .await
            .unwrap_err(),
        ManagerError::InvalidRequest
    );
    // Only a failed window may name no run, and none retires.
    for (outcome, run) in [
        (TerminalOutcome::Abandoned, None),
        (
            TerminalOutcome::Failed,
            Some((Uuid::nil(), EventId(Uuid::from_u128(8)))),
        ),
    ] {
        assert_eq!(
            client
                .reconcile("synthetic", &window(), outcome, run, deadline)
                .await
                .unwrap_err(),
            ManagerError::InvalidRequest
        );
    }
    assert_eq!(
        client
            .retire(
                "synthetic",
                &window(),
                TerminalOutcome::Failed,
                Uuid::from_u128(7),
                EventId(Uuid::from_u128(8)),
                deadline,
            )
            .await
            .unwrap_err(),
        ManagerError::InvalidRequest
    );
}

#[test]
fn construction_and_request_edges_refuse_before_io() {
    assert!(matches!(
        ManagerClient::new(PathBuf::from("relative"), owner(), conversation(), 2),
        Err(ManagerError::InvalidRequest)
    ));
    assert!(matches!(
        ManagerClient::new(
            PathBuf::from("/unused"),
            owner(),
            conversation(),
            std::process::id()
        ),
        Err(ManagerError::Peer)
    ));
    let mut c = client();
    c.manager_start += 1;
    assert_eq!(c.parent(), Err(ManagerError::Peer));
    let c = client();
    for key in ["", "space key", "line\nkey", "unicode-界"] {
        assert!(c.request("status", key, None).is_err());
    }
    assert!(c.request("status", &"x".repeat(129), None).is_err());
    let mut w = window();
    w.generation = INTEGER_LIMIT;
    assert!(c.request("drain", "x", Some(&w)).is_err());
    assert!(c.binding("x", &window(), 2, INTEGER_LIMIT).is_err());
    assert!(c.binding("x", &window(), 1, 1).is_err());
    assert!(!dates(0, 870_001, 900_000));
    assert!(dates(0, 3_570_000, 3_600_000));
    assert!(!dates(0, 14_370_001, 14_400_001));
    assert!(!dates(0, 869_000, 899_000));
    assert!(!dates(-1, 869_999, 899_999));
}

#[test]
fn canonical_utf8_matches_python_contract_and_rejects_suffix_aliases() {
    assert_eq!(
        canonical(json!({"z":"界","a":"ä"})).unwrap(),
        "{\"a\":\"ä\",\"z\":\"界\"}".as_bytes()
    );
    for raw in [
        br#"{"ok":false,"ok":true}"#.as_slice(),
        br#"{ "ok":true}"#,
        br#"{"generation":1e0}"#,
    ] {
        let value: Value = serde_json::from_slice(raw).unwrap();
        assert_ne!(canonical(value).unwrap(), raw);
    }
    assert!(id(&json!("AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA")).is_err());
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
fn test_name(name: &str) -> String {
    format!("{}::{name}", module_path!().split_once("::").unwrap().1)
}
fn spawn(name: &str, case: &str, path: &std::path::Path) -> Owned {
    Owned(
        Command::new(std::env::current_exe().unwrap())
            .args(["--exact", &test_name(name), "--nocapture"])
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("LANG", "C.UTF-8")
            .env("ORKESTR_TEST_MANAGER_CASE", case)
            .env("ORKESTR_TEST_MANAGER_SOCKET", path)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    )
}
fn finish(child: &mut Owned) {
    let deadline = Instant::now() + Duration::from_secs(4);
    let status = loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            break status;
        }
        assert!(
            Instant::now() < deadline,
            "owned test child exceeded deadline"
        );
        std::thread::sleep(Duration::from_millis(2));
    };
    let mut output = String::new();
    child
        .0
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut output)
        .unwrap();
    child
        .0
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut output)
        .unwrap();
    assert!(status.success(), "synthetic client failed: {output}");
    assert!(!PathBuf::from(format!("/proc/{}", child.0.id())).exists());
}
fn run_case(case: &str) {
    // Success requires an actual UID0 manager parent, as production does. Run
    // this focused test executable under the explicitly authorized root runner.
    assert!(
        std::fs::read_to_string("/proc/self/status")
            .unwrap()
            .lines()
            .any(|l| l == "Uid:\t0\t0\t0\t0"),
        "root fixture required; no skipped peer checks"
    );
    let dir = Directory(std::env::temp_dir().join(format!("manager-client-{}", Uuid::new_v4())));
    std::fs::create_dir(&dir.0).unwrap();
    std::fs::set_permissions(&dir.0, std::fs::Permissions::from_mode(0o700)).unwrap();
    let path = dir.0.join("control.sock");
    let listener = UnixListener::bind(&path).unwrap();
    listener.set_nonblocking(true).unwrap();
    let mut child = spawn("transport_child", case, &path);
    let deadline = Instant::now() + Duration::from_secs(3);
    let (mut socket, _) = loop {
        match listener.accept() {
            Ok(pair) => break pair,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                assert!(Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(1));
            }
            Err(e) => panic!("accept: {e}"),
        }
    };
    socket
        .set_read_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    socket
        .set_write_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    if case == "wrong_peer" {
        drop(socket);
        finish(&mut child);
        return;
    }
    let mut header = [0; 4];
    socket.read_exact(&mut header).unwrap();
    let size = u32::from_be_bytes(header) as usize;
    assert!(size <= 8192);
    let mut raw = vec![0; size];
    socket.read_exact(&mut raw).unwrap();
    let request: Value = serde_json::from_slice(&raw).unwrap();
    assert_eq!(canonical(request.clone()).unwrap(), raw);
    assert_eq!(request["owner_id"], json!(owner()));
    assert_eq!(request["conversation_id"], json!(conversation()));
    let mut reply = json!({"ok":true,"receipt":receipt()});
    match case {
        "admit" | "historical" => {
            assert_eq!(request["operation"], "admit");
            assert_eq!(request["input_request_key"], "synthetic-ä-界");
            reply["fresh_window"] = json!(case == "admit");
            if case == "historical" {
                reply["receipt"]["state"] = json!("reconciliation");
                reply["receipt"]["reason"] = json!("manager_restarted");
            }
        }
        "drain" => reply["receipt"]["state"] = json!("draining"),
        "uncertain" => reply["receipt"]["state"] = json!("reconciliation"),
        "reconcile_failed" => {
            assert_eq!(request["operation"], "reconcile");
            assert_eq!(request["outcome"], "failed");
            assert_eq!(request["run_id"], Value::Null);
            assert_eq!(request["terminal_event_id"], Value::Null);
            reply["receipt"]["state"] = json!("retired");
            reply["receipt"]["reason"] = json!("runtime_refused");
            reply["receipt"]["outcome"] = json!("failed");
        }
        "reconcile" => {
            assert_eq!(request["operation"], "reconcile");
            assert_eq!(request["outcome"], "abandoned");
            reply["receipt"]["state"] = json!("retired");
            reply["receipt"]["reason"] = json!("manager_stopped");
            reply["receipt"]["outcome"] = json!("abandoned");
            reply["receipt"]["run_id"] = json!(Uuid::from_u128(7));
            reply["receipt"]["terminal_event_id"] = json!(Uuid::from_u128(8));
        }
        "retire" => {
            reply["receipt"]["state"] = json!("retired");
            reply["receipt"]["outcome"] = json!("stopped");
            reply["receipt"]["run_id"] = json!(Uuid::from_u128(7));
            reply["receipt"]["terminal_event_id"] = json!(Uuid::from_u128(8));
        }
        "wrong_scope" => reply["receipt"]["conversation_id"] = json!(Uuid::from_u128(99)),
        "unknown" => reply["request_id"] = json!("invented-echo"),
        "refused" => reply = json!({"ok":false,"code":"control_refused","receipt":receipt()}),
        "unavailable" => reply = json!({"ok":false,"code":"control_unavailable"}),
        "wrong_window" => {
            reply["receipt"]["window_id"] = json!(Uuid::from_u128(99));
            reply["receipt"]["state"] = json!("draining");
        }
        _ => {}
    }
    let mut raw = canonical(reply.clone()).unwrap();
    if case == "duplicate" {
        raw = br#"{"ok":false,"ok":true,"receipt":{}}"#.to_vec();
    }
    if case == "noncanonical" {
        raw.insert(0, b' ');
    }
    let length = if case == "oversized" {
        8193
    } else {
        raw.len() as u32
    };
    if case == "partial_deadline" {
        socket.write_all(&[0, 0]).unwrap();
        std::thread::sleep(Duration::from_millis(250));
        drop(socket);
    } else if case == "truncated" {
        socket.write_all(&length.to_be_bytes()).unwrap();
        socket.write_all(&raw[..raw.len() / 2]).unwrap();
        drop(socket);
    } else if case == "deadline" {
        std::thread::sleep(Duration::from_millis(250));
        drop(socket);
    } else {
        socket.write_all(&length.to_be_bytes()).unwrap();
        if case != "oversized" {
            for chunk in raw.chunks(7) {
                socket.write_all(chunk).unwrap();
            }
            if case == "suffix" {
                socket.write_all(b"x").unwrap();
            }
        }
        drop(socket);
    }
    finish(&mut child);
    assert!(
        matches!(listener.accept(),Err(e) if e.kind()==std::io::ErrorKind::WouldBlock),
        "no second attempt after ambiguous result"
    );
}

#[test]
fn transport_child() {
    let Ok(case) = std::env::var("ORKESTR_TEST_MANAGER_CASE") else {
        return;
    };
    let path = PathBuf::from(std::env::var("ORKESTR_TEST_MANAGER_SOCKET").unwrap());
    let parent = process(std::process::id()).unwrap().0;
    let client = ManagerClient::new(path, owner(), conversation(), parent).unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let deadline =
        Instant::now() + Duration::from_millis(if case.contains("deadline") { 100 } else { 1500 });
    let result = runtime.block_on(async {
        match case.as_str() {
            "admit" | "historical" => {
                let ack = client.admit(&admission(), deadline).await?;
                assert_eq!(ack.fresh_window, case == "admit");
                let mut expected =
                    json!({"ok":true,"receipt":receipt(),"fresh_window":case=="admit"});
                if case == "historical" {
                    expected["receipt"]["state"] = json!("reconciliation");
                    expected["receipt"]["reason"] = json!("manager_restarted");
                }
                assert_eq!(
                    ack.reply_sha256,
                    format!("{:x}", Sha256::digest(canonical(expected).unwrap()))
                );
                Ok(())
            }
            "drain" | "wrong_window" => client
                .drain("synthetic", &window(), deadline)
                .await
                .map(|_| ()),
            "uncertain" => client
                .uncertain(
                    "synthetic",
                    &window(),
                    Uncertainty::CleanupUnknown,
                    deadline,
                )
                .await
                .map(|_| ()),
            "retire" => client
                .retire(
                    "synthetic",
                    &window(),
                    TerminalOutcome::Stopped,
                    Uuid::from_u128(7),
                    EventId(Uuid::from_u128(8)),
                    deadline,
                )
                .await
                .map(|_| ()),
            "reconcile" => client
                .reconcile(
                    "synthetic",
                    &window(),
                    TerminalOutcome::Abandoned,
                    Some((Uuid::from_u128(7), EventId(Uuid::from_u128(8)))),
                    deadline,
                )
                .await
                .map(|_| ()),
            "reconcile_failed" => client
                .reconcile(
                    "synthetic",
                    &window(),
                    TerminalOutcome::Failed,
                    None,
                    deadline,
                )
                .await
                .map(|_| ()),
            _ => client.status("synthetic", deadline).await.map(|_| ()),
        }
    });
    match case.as_str() {
        "status" | "admit" | "historical" | "drain" | "uncertain" | "retire" | "reconcile"
        | "reconcile_failed" => {
            assert_eq!(result, Ok(()))
        }
        "deadline" | "partial_deadline" => assert_eq!(result, Err(ManagerError::Deadline)),
        "refused" | "unavailable" => assert_eq!(result, Err(ManagerError::Refused)),
        "wrong_peer" => assert_eq!(result, Err(ManagerError::Peer)),
        _ => assert_eq!(result, Err(ManagerError::Protocol)),
    }
}
#[test]
#[ignore = "requires root synthetic peer; run focused executable with --include-ignored"]
fn foreign_root_peer_gets_no_request_bytes() {
    let dir = Directory(std::env::temp_dir().join(format!("manager-peer-{}", Uuid::new_v4())));
    std::fs::create_dir(&dir.0).unwrap();
    std::fs::set_permissions(&dir.0, std::fs::Permissions::from_mode(0o700)).unwrap();
    let path = dir.0.join("foreign.sock");
    let script="import socket,sys; s=socket.socket(socket.AF_UNIX);s.bind(sys.argv[1]);s.listen(1);s.settimeout(2);print('ready',flush=True);c,_=s.accept();c.settimeout(2);assert c.recv(1)==b'';c.close();s.close()";
    let mut peer = Owned(
        Command::new("/usr/bin/python3")
            .args(["-I", "-S", "-B", "-c", script])
            .arg(&path)
            .env_clear()
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let mut ready = [0; 6];
    peer.0
        .stdout
        .as_mut()
        .unwrap()
        .read_exact(&mut ready)
        .unwrap();
    assert_eq!(&ready, b"ready\n");
    let mut child = spawn("transport_child", "wrong_peer", &path);
    finish(&mut child);
    finish(&mut peer);
}

#[test]
fn nonroot_manager_child() {
    if std::env::var("ORKESTR_TEST_MANAGER_CASE").as_deref() != Ok("nonroot_manager") {
        return;
    }
    let path = PathBuf::from(std::env::var("ORKESTR_TEST_MANAGER_SOCKET").unwrap());
    let listener = UnixListener::bind(&path).unwrap();
    listener.set_nonblocking(true).unwrap();
    let mut child = spawn("transport_child", "wrong_peer", &path);
    let deadline = Instant::now() + Duration::from_secs(2);
    let (mut socket, _) = loop {
        match listener.accept() {
            Ok(pair) => break pair,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                assert!(Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(1));
            }
            Err(e) => panic!("accept: {e}"),
        }
    };
    socket
        .set_read_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    assert_eq!(
        socket.read(&mut [0]).unwrap(),
        0,
        "root UID check must precede request bytes"
    );
    finish(&mut child);
}

#[test]
#[ignore = "requires root to drop the synthetic manager UID; run with --include-ignored"]
fn actual_parent_with_nonroot_uid_gets_no_request() {
    let dir = Directory(std::env::temp_dir().join(format!("manager-uid-{}", Uuid::new_v4())));
    std::fs::create_dir(&dir.0).unwrap();
    let executable = dir.0.join("client-test");
    std::fs::copy(std::env::current_exe().unwrap(), &executable).unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o555)).unwrap();
    std::os::unix::fs::chown(&dir.0, Some(65534), Some(65534)).unwrap();
    std::fs::set_permissions(&dir.0, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut child = Owned(
        Command::new(executable)
            .args([
                "--exact",
                &test_name("nonroot_manager_child"),
                "--nocapture",
            ])
            .uid(65534)
            .gid(65534)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("ORKESTR_TEST_MANAGER_CASE", "nonroot_manager")
            .env("ORKESTR_TEST_MANAGER_SOCKET", dir.0.join("control.sock"))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    finish(&mut child);
}
macro_rules! transport_cases { ($($name:ident => $case:literal),+ $(,)?) => { $(#[test] #[ignore = "requires root synthetic peer; run focused executable with --include-ignored"] fn $name(){run_case($case);})+ }; }
transport_cases! {
    status_actual_parent => "status", admission_unicode_and_digest => "admit", historical_ack_does_not_activate => "historical",
    drain_exact_window => "drain", uncertainty_exact_window => "uncertain", retired_exact_provenance => "retire", reconciled_stranded_window => "reconcile", reconciled_failed_open => "reconcile_failed",
    foreign_scope_refused => "wrong_scope", foreign_window_refused => "wrong_window", unknown_success_fields_refused => "unknown",
    duplicate_fields_refused => "duplicate", noncanonical_reply_refused => "noncanonical", oversized_reply_refused => "oversized",
    truncated_reply_refused => "truncated", trailing_reply_refused => "suffix", ambiguous_timeout_is_not_retried => "deadline",
    partial_read_shares_deadline => "partial_deadline", explicit_refusal_stays_refused => "refused", unavailable_stays_refused => "unavailable",
}
