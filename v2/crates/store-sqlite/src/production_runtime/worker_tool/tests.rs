use super::*;
use crate::production_runtime::tests::{claim, ready, setup, snapshot, Case};
use std::{sync::Arc, time::Duration};

async fn parent(f: &Case) -> ConsumedProviderDispatch {
    let binding = ready(f).await;
    let input = claim(f, &binding).await;
    let candidate = f
        .handle
        .admit_run(
            &input,
            &binding.session_id,
            binding.generation,
            "worker-parent",
        )
        .await
        .unwrap();
    let DispatchClaimResult::Reserved(reserved) = f
        .handle
        .claim_provider_dispatch(&candidate, "worker-parent-dispatch")
        .await
        .unwrap()
    else {
        panic!("reservation");
    };
    let ExecutionConsumption::Dispatch(parent) =
        f.handle.consume_execution(&reserved).await.unwrap()
    else {
        panic!("parent consume");
    };
    *parent
}
async fn grant(
    f: &Case,
    parent: &ConsumedProviderDispatch,
    key: &str,
    ttl: u32,
) -> OfflinePythonDelegation {
    let OfflinePythonAdmission::Fresh(grant) = f
        .handle
        .delegate_offline_python(&f.token, parent, key, "print('synthetic')", ttl)
        .await
        .unwrap()
    else {
        panic!("fresh");
    };
    grant
}
async fn launch(f: &Case, grant: OfflinePythonDelegation) -> ConsumedOfflinePython {
    let OfflinePythonConsumption::Launch(launch) = f
        .handle
        .consume_offline_python(&f.token, grant)
        .await
        .unwrap()
    else {
        panic!("launch");
    };
    launch
}
fn duplicate(grant: &OfflinePythonDelegation) -> OfflinePythonDelegation {
    // Only issuing-crate tests can model a lost-ACK duplicate. No public constructor.
    OfflinePythonDelegation {
        id: grant.id,
        parent: grant.parent.clone(),
        context_id: grant.context_id.clone(),
        incarnation: grant.incarnation.clone(),
        locator: grant.locator.clone(),
        source_digest: grant.source_digest.clone(),
        expires_at_ms: grant.expires_at_ms,
    }
}
async fn cleanup(f: Case) {
    f.store.close().await;
    std::fs::remove_dir_all(f.root).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn worker_grant_is_explicit_one_use_and_reopen_never_reissues() {
    let f = setup().await;
    let parent = parent(&f).await;
    let before = snapshot(&f.store).await;
    let grant = grant(&f, &parent, "tool", 5000).await;
    let id = grant.id();
    assert_eq!(grant.source_digest(), crate::digest("print('synthetic')"));
    let OfflinePythonAdmission::Existing(receipt) = f
        .handle
        .delegate_offline_python(&f.token, &parent, "tool", "print('synthetic')", 5000)
        .await
        .unwrap()
    else {
        panic!("metadata replay");
    };
    assert_eq!(receipt.state, OfflinePythonState::Delegated);
    assert_eq!(receipt.delegation_id, id);
    for (source, ttl) in [("different", 5000), ("print('synthetic')", 5001)] {
        assert!(matches!(
            f.handle
                .delegate_offline_python(&f.token, &parent, "tool", source, ttl)
                .await,
            Err(RuntimeStoreError::Conflict)
        ));
    }
    let duplicate = duplicate(&grant);
    let second = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let attached = f.handle.reattach_supervisor(&second).await.unwrap();
    let (a, b) = tokio::join!(
        f.handle.consume_offline_python(&f.token, grant),
        attached.consume_offline_python(&f.token, duplicate)
    );
    let launch = match (a.unwrap(), b.unwrap()) {
        (OfflinePythonConsumption::Launch(g), OfflinePythonConsumption::ReconciliationRequired)
        | (OfflinePythonConsumption::ReconciliationRequired, OfflinePythonConsumption::Launch(g)) => {
            g
        }
        _ => panic!("one consume winner"),
    };
    assert_eq!(launch.source(), "print('synthetic')");
    assert_eq!(launch.receipt().state, OfflinePythonState::DeliveryUnknown);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM worker_tool_delegations WHERE id=? AND grant_hash IS NULL AND revision=2").bind(id.to_string()).fetch_one(&f.store.pool).await.unwrap();
    assert_eq!(count, 1);
    second.close().await;
    let reopened = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let attached = f.handle.reattach_supervisor(&reopened).await.unwrap();
    assert!(matches!(
        attached
            .delegate_offline_python(&f.token, &parent, "tool", "print('synthetic')", 5000)
            .await
            .unwrap(),
        OfflinePythonAdmission::Existing(OfflinePythonReceipt {
            state: OfflinePythonState::DeliveryUnknown,
            ..
        })
    ));
    assert_eq!(
        before,
        snapshot(&f.store).await,
        "tool ledger cannot mutate parent/inbox/events"
    );
    reopened.close().await;
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn worker_fence_runs_once_and_completion_is_only_current_metadata() {
    let f = setup().await;
    let parent = parent(&f).await;
    let launch = launch(&f, grant(&f, &parent, "tool", 5000).await).await;
    let called = AtomicBool::new(false);
    let action = || {
        called.store(true, Ordering::Release);
        Ok::<_, ()>(())
    };
    f.handle
        .with_offline_python_fence(&f.token, &launch, action)
        .unwrap()
        .unwrap();
    assert!(called.load(Ordering::Acquire));
    assert!(matches!(
        f.handle
            .with_offline_python_fence(&f.token, &launch, || -> std::result::Result<(), ()> {
                panic!("duplicate spawn")
            }),
        Err(RuntimeStoreError::Fenced)
    ));
    let digest = crate::digest("synthetic-output-encoding");
    let receipt = f
        .handle
        .finish_offline_python(&f.token, &launch, OfflinePythonOutcome::Completed, &digest)
        .await
        .unwrap();
    assert_eq!(receipt.state, OfflinePythonState::Completed);
    assert_eq!(receipt.revision, 3);
    assert_eq!(
        f.handle
            .finish_offline_python(&f.token, &launch, OfflinePythonOutcome::Completed, &digest)
            .await
            .unwrap(),
        receipt
    );
    assert!(matches!(
        f.handle
            .finish_offline_python(
                &f.token,
                &launch,
                OfflinePythonOutcome::Completed,
                &"0".repeat(64)
            )
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    assert!(matches!(
        f.handle
            .finish_offline_python(&f.token, &launch, OfflinePythonOutcome::Cancelled, &digest)
            .await,
        Err(RuntimeStoreError::InvalidInput)
    ));
    let state: String = sqlx::query_scalar("SELECT state FROM production_runs WHERE id=?")
        .bind(parent.provider().run.run_id.to_string())
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(
        state, "starting",
        "tool completion must not accept a parent"
    );
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn worker_parent_stop_and_revocation_deny_spawn_and_quarantine_output() {
    for revoke in [false, true] {
        let f = setup().await;
        let parent = parent(&f).await;
        let launch = launch(&f, grant(&f, &parent, "tool", 5000).await).await;
        if revoke {
            f.store.revoke_session(&f.token).await.unwrap();
        } else {
            f.handle
                .request_cancel(&f.owner, &parent.provider().run.run_id, "stop")
                .await
                .unwrap();
        }
        assert!(f
            .handle
            .with_offline_python_fence(&f.token, &launch, || -> std::result::Result<(), ()> {
                panic!("fenced child spawned")
            })
            .is_err());
        assert!(f
            .handle
            .check_offline_python(&f.token, &launch)
            .await
            .is_err());
        assert!(f
            .handle
            .finish_offline_python(
                &f.token,
                &launch,
                OfflinePythonOutcome::Completed,
                &"0".repeat(64)
            )
            .await
            .is_err());
        let state: String =
            sqlx::query_scalar("SELECT state FROM worker_tool_delegations WHERE id=?")
                .bind(launch.id().to_string())
                .fetch_one(&f.store.pool)
                .await
                .unwrap();
        assert_eq!(state, "delivery_unknown");
        cleanup(f).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn worker_cancel_ack_requires_exact_current_control_not_a_parent_id() {
    let f = setup().await;
    let parent = parent(&f).await;
    let launch = launch(&f, grant(&f, &parent, "tool", 5000).await).await;
    f.handle
        .with_offline_python_fence(&f.token, &launch, || Ok::<_, ()>(()))
        .unwrap()
        .unwrap();
    let cancelled = f
        .handle
        .request_cancel(&f.owner, &parent.provider().run.run_id, "stop")
        .await
        .unwrap();
    let mut control = parent.provider().clone();
    control.run = cancelled.new_fenced_admission;
    let mut forged = control.clone();
    forged.run.dispatch_fence += 1;
    assert!(f
        .handle
        .acknowledge_offline_python_cancel(&f.token, &launch, &forged)
        .await
        .is_err());
    assert!(f
        .handle
        .acknowledge_offline_python_cancel(&f.token, &launch, parent.provider())
        .await
        .is_err());
    // Store unit test attests no external child. Real kill/reap is a server oracle.
    let receipt = f
        .handle
        .acknowledge_offline_python_cancel(&f.token, &launch, &control)
        .await
        .unwrap();
    assert_eq!(receipt.state, OfflinePythonState::Cancelled);
    assert_eq!(
        receipt,
        f.handle
            .acknowledge_offline_python_cancel(&f.token, &launch, &control)
            .await
            .unwrap()
    );
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn worker_expiry_credential_and_locator_fail_closed() {
    let f = setup().await;
    let parent = parent(&f).await;
    let expired = grant(&f, &parent, "expires", 10).await;
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(matches!(
        f.handle.consume_offline_python(&f.token, expired).await,
        Err(RuntimeStoreError::Expired)
    ));
    f.store
        .save_session(&"cd".repeat(32), &f.owner)
        .await
        .unwrap();
    assert!(matches!(
        f.handle
            .delegate_offline_python(&"cd".repeat(32), &parent, "wrong-token", "pass", 5000)
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    let mut forged = grant(&f, &parent, "forged", 5000).await;
    forged.locator = "0".repeat(64);
    assert!(matches!(
        f.handle.consume_offline_python(&f.token, forged).await,
        Err(RuntimeStoreError::Conflict)
    ));
    cleanup(f).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actual_spawn_fence_serializes_parent_stop_commit() {
    let f = setup().await;
    let parent = parent(&f).await;
    let launch = Arc::new(launch(&f, grant(&f, &parent, "race", 5000).await).await);
    let handle = f.handle.clone();
    let credential = f.token.clone();
    let cap = launch.clone();
    let (started, waiting) = std::sync::mpsc::channel();
    let (release, released) = std::sync::mpsc::channel();
    let work = tokio::task::spawn_blocking(move || {
        handle.with_offline_python_fence(&credential, &cap, || {
            started.send(()).unwrap();
            released.recv_timeout(Duration::from_secs(2)).unwrap();
            Ok::<_, ()>(())
        })
    });
    tokio::task::spawn_blocking(move || waiting.recv_timeout(Duration::from_secs(2)).unwrap())
        .await
        .unwrap();
    let handle = f.handle.clone();
    let owner = f.owner.clone();
    let run = parent.provider().run.run_id.clone();
    let stop = tokio::spawn(async move { handle.request_cancel(&owner, &run, "stop-race").await });
    tokio::time::sleep(Duration::from_millis(25)).await;
    assert!(
        !stop.is_finished(),
        "Stop committed ahead of fenced spawn action"
    );
    release.send(()).unwrap();
    work.await.unwrap().unwrap().unwrap();
    stop.await.unwrap().unwrap();
    assert!(matches!(
        f.handle.check_offline_python(&f.token, &launch).await,
        Err(RuntimeStoreError::Fenced)
    ));
    cleanup(f).await;
}
