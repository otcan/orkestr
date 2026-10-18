//! Ordinary issuer + owned synthetic echo child; no real provider or credentials.
use super::*;
use crate::containment::{Authority, ChildDirectories, Error, Output, TransportBounds};
use orkestr_v2_application::{runtime::*, IntakeStore};
use orkestr_v2_contracts::MessageInput;
use orkestr_v2_store_sqlite::{ExecutionConsumption, Store};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

static NEXT: AtomicU64 = AtomicU64::new(1);

fn ready_rpc(native: &str) -> CodexRpc {
    let mut rpc = CodexRpc::default();
    rpc.initialize().unwrap();
    rpc.receive(r#"{"id":1,"result":{"userAgent":"synthetic","platformFamily":"unix","platformOs":"linux","codexHome":"/synthetic"}}"#).unwrap();
    rpc.account_read().unwrap();
    rpc.receive(r#"{"id":2,"result":{"requiresOpenaiAuth":true,"account":{"type":"chatgpt"}}}"#)
        .unwrap();
    rpc.create_session(Path::new("/synthetic/workspace"))
        .unwrap();
    rpc.receive(
        &json!({"id":3,"result":{
            "thread":{"id":native,"ephemeral":false,"cwd":"/synthetic/workspace"},
            "cwd":"/synthetic/workspace","approvalPolicy":"never","sandbox":{"type":"readOnly"}
        }})
        .to_string(),
    )
    .unwrap();
    rpc
}

async fn exercise(wrong_native: bool, namespace: &str, defer_flush: bool) {
    let root = std::path::PathBuf::from(
        std::env::var_os("ORKESTR_V2_HOME").expect("isolated home"),
    )
    .join(format!(
        "ordinary-bridge-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&root).unwrap();
    for name in ["workspace", "home", "tmp"] {
        std::fs::create_dir(root.join(name)).unwrap();
    }
    let root = root.canonicalize().unwrap();
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
    store.save_session(&token, &owner).await.unwrap();
    let bound = store
        .authorize_supervisor(
            &token,
            ProductionSupervisorConfig {
                provider: ProviderKind::Codex,
                namespace: namespace.into(),
                supervisor_key: "synthetic-deep".into(),
                takeover: ProductionTakeover::First,
            },
        )
        .await
        .unwrap();
    let roles = bound
        .ensure_role_bindings(&owner, &conversation)
        .await
        .unwrap();
    assert_ne!(roles.fast.session_id, roles.deep.session_id);
    let binding = bound
        .confirm_native_session(NativeSessionConfirmation {
            session_id: roles.deep.session_id,
            expected_generation: roles.deep.generation,
            native_session_id: "synthetic-native".into(),
            protocol_version: "codex-rpc-1".into(),
            source_event_key: "ready:1".into(),
        })
        .await
        .unwrap();
    store
        .admit(
            &owner,
            &conversation,
            &MessageInput {
                client_message_id: "input:1".into(),
                text: "durable synthetic text".into(),
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
        .admit_run(&claim, &binding.session_id, binding.generation, "run:1")
        .await
        .unwrap();
    let DispatchClaimResult::Reserved(reservation) = bound
        .claim_provider_dispatch(&candidate, "reserve:1")
        .await
        .unwrap()
    else {
        panic!("fresh reservation")
    };
    let ExecutionConsumption::Dispatch(cap) = bound.consume_execution(&reservation).await.unwrap()
    else {
        panic!("unique consumption")
    };
    let scope = execution_scope(&cap).unwrap();
    let fence = Arc::new(super::fence::StoreFence::from_consumed(bound.clone(), &cap).unwrap());
    let authority = Authority::new(scope.clone(), fence, 1).unwrap();
    let dirs = ChildDirectories::new(
        &root.join("workspace"),
        &root.join("home"),
        &root.join("tmp"),
    )
    .unwrap();
    let executor = authority
        .issue_executor(
            &scope,
            Path::new("/bin/cat"),
            &[],
            dirs,
            TransportBounds::default(),
        )
        .unwrap();
    let child = executor.spawn(&scope).unwrap();
    let mut rpc = ready_rpc(if wrong_native {
        "different-native"
    } else {
        "synthetic-native"
    });
    let result = submit_codex(cap, &mut rpc, &child);
    if wrong_native {
        assert_eq!(result, Err(SubmissionFailure::Protocol(Blocker::Protocol)));
        assert_eq!(child.flush_stdin(&scope).unwrap().written, 0);
        assert_eq!(child.poll_stdout(&scope).unwrap(), Output::Pending);
    } else if defer_flush {
        result.unwrap();
        assert_eq!(child.poll_stdout(&scope).unwrap(), Output::Pending);
    } else {
        result.unwrap();
        child.flush_stdin(&scope).unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        let bytes = loop {
            match child.poll_stdout(&scope).unwrap() {
                Output::Frame(bytes) => break bytes,
                Output::Pending if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(2))
                }
                _ => panic!("bounded owned echo"),
            }
        };
        let frame: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(frame["method"], "turn/start");
        assert_eq!(frame["params"]["threadId"], "synthetic-native");
        assert_eq!(
            frame["params"]["input"][0]["text"],
            "durable synthetic text"
        );
        assert_eq!(
            rpc.claim_turn_request("synthetic-native"),
            Err(Blocker::Protocol)
        );
    }
    // Both successful enqueue and refused association consumed the unique grant.
    let reopened = Store::open(&root.join("state.sqlite3")).await.unwrap();
    let attached = bound.reattach_supervisor(&reopened).await.unwrap();
    assert!(matches!(
        attached.consume_execution(&reservation).await.unwrap(),
        ExecutionConsumption::ReconciliationRequired
    ));
    let replay = attached
        .admit_run(&claim, &binding.session_id, binding.generation, "run:1")
        .await
        .unwrap();
    assert_eq!(
        replay.disposition,
        AdmissionDisposition::ReconciliationRequired
    );
    assert!(replay.candidate_key.is_none());
    // Renewal is serialized against transport flush; only one connection wins.
    tokio::time::sleep(Duration::from_millis(15)).await;
    bound.heartbeat_supervisor().await.unwrap();
    let (first, second) = tokio::join!(
        bound.renew_lease(
            &candidate.provider.run,
            candidate.provider.run.lease_generation
        ),
        attached.renew_lease(
            &candidate.provider.run,
            candidate.provider.run.lease_generation
        )
    );
    assert!(matches!(
        (first, second),
        (Ok(_), Err(RuntimeStoreError::StaleLease)) | (Err(RuntimeStoreError::StaleLease), Ok(_))
    ));
    assert_eq!(child.flush_stdin(&scope), Err(Error::Revoked));
    if defer_flush {
        // The committed-but-unwritten turn cannot cross a renewed fence.
        assert_eq!(child.poll_stdout(&scope).unwrap(), Output::Pending);
    }
    store.revoke_session(&token).await.unwrap();
    assert!(matches!(executor.spawn(&scope), Err(Error::Revoked)));
    authority.revoke().unwrap();
    drop(child);
    reopened.close().await;
    bound.close().await;
    store.close().await;
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ordinary_committed_capability_drives_only_its_durable_synthetic_input() {
    exercise(false, "synthetic-subscription", false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn wrong_native_refuses_io_and_reopen_cannot_reissue_consumed_grant() {
    exercise(true, "synthetic-subscription", false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn issuer_valid_colon_namespace_reaches_owned_transport_without_reissuing_grant() {
    exercise(false, "subscription:local", false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn renewal_before_flush_quarantines_uncertain_queued_turn_without_redispatch() {
    exercise(false, "subscription:local", true).await;
}
