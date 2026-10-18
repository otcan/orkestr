use super::*;
use orkestr_v2_store_sqlite::{
    OfflinePythonNativeCall, OfflinePythonNativeRequestId, OfflinePythonParent,
    OfflinePythonResultConsumption, WorkerAdmissionInput, WorkerDelegationResult,
};

async fn started(f: &Case, p: &ProviderAdmission) {
    f.handle
        .append_provider_event(
            &f.owner,
            p,
            &ProviderEventInput {
                run_id: p.run.run_id.clone(),
                session_id: p.run.session_id.clone(),
                lease_generation: p.run.lease_generation,
                dispatch_fence: p.run.dispatch_fence,
                sequence: 1,
                event: ProviderEvent::Started,
            },
        )
        .await
        .unwrap();
}
async fn worker(f: &Case) -> OfflinePythonParent {
    started(f, f.parent.provider()).await;
    let b = f
        .handle
        .create_worker_binding(
            &f.owner,
            &f.conversation,
            Some(&f.parent.provider().run.session_id),
            "native-tool-worker",
        )
        .await
        .unwrap();
    let metadata = f
        .handle
        .authorize_worker_metadata(&f.token, &f.parent.provider().run.run_id, &b)
        .await
        .unwrap();
    let b = f
        .handle
        .confirm_metadata_session(
            metadata,
            NativeSessionConfirmation {
                session_id: b.session_id,
                expected_generation: b.generation,
                native_session_id: "synthetic-tool-worker-native".into(),
                protocol_version: "codex-rpc-1".into(),
                source_event_key: "worker-ready".into(),
            },
        )
        .await
        .unwrap()
        .binding()
        .clone();
    let WorkerDelegationResult::Fresh(g) = f
        .handle
        .delegate_worker(
            &f.token,
            &f.parent.provider().run.run_id,
            &WorkerAdmissionInput {
                worker_binding_id: b.session_id,
                expected_binding_generation: b.generation,
                source_message_id: f.parent.message_id().clone(),
                source_event_id: f.parent.source_event_id().clone(),
                request_key: "native-tool-worker".into(),
                lifetime_ms: 30_000,
            },
        )
        .await
        .unwrap()
    else {
        panic!("Worker delegation")
    };
    let admitted = f.handle.admit_worker(&f.token, g).await.unwrap();
    let DispatchClaimResult::Reserved(r) = f
        .handle
        .claim_provider_dispatch(&admitted, "worker-dispatch")
        .await
        .unwrap()
    else {
        panic!("Worker reservation")
    };
    let ExecutionConsumption::Dispatch(cap) = f.handle.consume_execution(&r).await.unwrap() else {
        panic!("Worker consumption")
    };
    let parent = f
        .handle
        .authorize_offline_python_parent(&f.token, &cap)
        .await
        .unwrap();
    started(f, cap.provider()).await;
    parent
}
fn call(number: u64) -> OfflinePythonNativeCall {
    OfflinePythonNativeCall {
        request_id: OfflinePythonNativeRequestId::Integer(number),
        call_id: format!("call:{number}"),
        thread_id: "synthetic-tool-worker-native".into(),
        turn_id: "turn:1".into(),
    }
}
async fn grant(
    f: &Case,
    parent: &OfflinePythonParent,
    number: u64,
    source: &str,
) -> OfflinePythonDelegation {
    let OfflinePythonAdmission::Fresh(g) = f
        .handle
        .delegate_native_offline_python(&f.token, parent, &call(number), source, 10_000)
        .await
        .unwrap()
    else {
        panic!("native grant")
    };
    g
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actual_worker_sandbox_output_issues_one_correlated_native_result() {
    let _serial = SERIAL.lock().await;
    let f = Case::new().await;
    let parent = worker(&f).await;
    let dispatcher = f.dispatcher();
    let children = crate::owned_children::ChildSet::default();
    for (number, source, success) in [
        (1, "print(6 * 7)", true),
        (
            2,
            "import sys\nprint('bounded failure')\nsys.exit(3)",
            false,
        ),
    ] {
        let g = grant(&f, &parent, number, source).await;
        let id = g.id();
        let (_, signals) = offline_python_controls();
        let OfflinePythonResult::Prepared(r) =
            dispatcher.run_native(g, signals, children.retain()).await
        else {
            panic!("native prepared result")
        };
        let OfflinePythonResultConsumption::Deliver(d) = f
            .handle
            .consume_offline_python_result(&f.token, r)
            .await
            .unwrap()
        else {
            panic!("native result consume")
        };
        assert_eq!(d.delegation_id(), id);
        assert_eq!(d.native_call().call_id, format!("call:{number}"));
        assert_eq!(d.success(), success);
        assert!(d
            .text()
            .contains(if success { "42\n" } else { "bounded failure" }));
        assert_eq!(
            d.written_bytes(),
            0,
            "this checkpoint does not write native stdin"
        );
        drop(d);
        assert!(children.wait_empty(Duration::from_secs(2)).await);
    }
    assert_eq!(dispatcher.spawned.load(Ordering::Acquire), 2);
    f.cleanup().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_future_abort_retains_cleanup_ownership_through_actual_reap() {
    let _serial = SERIAL.lock().await;
    let f = Case::new().await;
    let parent = worker(&f).await;
    let dispatcher = Arc::new(f.dispatcher());
    let g = grant(&f, &parent, 1, "while True: pass").await;
    let children = crate::owned_children::ChildSet::default();
    let retained = children.retain();
    let (_, signals) = offline_python_controls();
    let cloned = dispatcher.clone();
    let work = tokio::spawn(async move { cloned.run_native(g, signals, retained).await });
    wait_started(&dispatcher).await;
    assert!(!children.wait_empty(Duration::from_millis(1)).await);
    work.abort();
    assert!(matches!(work.await, Err(error) if error.is_cancelled()));
    assert!(
        children.wait_empty(Duration::from_secs(3)).await,
        "actual owned sandbox wait must release retained guard"
    );
    wait_reaped().await;
    let OfflinePythonAdmission::Existing(receipt) = f
        .handle
        .delegate_native_offline_python(&f.token, &parent, &call(1), "while True: pass", 10_000)
        .await
        .unwrap()
    else {
        panic!("historical receipt")
    };
    assert_eq!(receipt.state, OfflinePythonState::DeliveryUnknown);
    f.cleanup().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_result_stop_before_write_exposes_no_sandbox_output_to_provider() {
    let _serial = SERIAL.lock().await;
    let f = Case::new().await;
    let parent = worker(&f).await;
    let dispatcher = f.dispatcher();
    let g = grant(&f, &parent, 1, "print('must-stay-private-after-stop')").await;
    let (_, signals) = offline_python_controls();
    let OfflinePythonResult::Prepared(r) = dispatcher.run_native(g, signals, Box::new(())).await
    else {
        panic!("result")
    };
    let OfflinePythonResultConsumption::Deliver(mut d) = f
        .handle
        .consume_offline_python_result(&f.token, r)
        .await
        .unwrap()
    else {
        panic!("delivery")
    };
    f.handle
        .request_cancel(&f.owner, &d.parent().run.run_id, "stop-before-result")
        .await
        .unwrap();
    let mut bytes = 0;
    assert!(f
        .handle
        .with_offline_python_result_fence(&f.token, &mut d, 0, 1, || {
            bytes += 1;
            Ok::<_, ()>(1)
        })
        .is_err());
    assert_eq!(bytes, 0);
    f.cleanup().await;
}
