use super::*;

#[test]
fn rejects_cross_owner_and_generation_before_spawn() {
    let fixture = Fixture::new();
    let scope = scope("synthetic-owner", 1);
    let (authority, _) = authority(&scope);
    let executor = fixture.executor(
        &authority,
        &scope,
        "raise SystemExit(0)",
        TransportBounds::default(),
    );
    assert!(matches!(
        executor.spawn(&super::scope("other-owner", 1)),
        Err(Error::WrongScope)
    ));
    assert!(matches!(
        executor.spawn(&super::scope("synthetic-owner", 2)),
        Err(Error::WrongScope)
    ));
    for (namespace, incarnation) in [
        ("other-namespace", "synthetic-incarnation"),
        ("synthetic-namespace", "other-incarnation"),
    ] {
        let foreign = ExecutionScope::new(
            namespace,
            incarnation,
            scope.owner(),
            scope.session(),
            scope.run(),
            scope.generation(),
        )
        .unwrap();
        assert!(matches!(executor.spawn(&foreign), Err(Error::WrongScope)));
    }
    assert_eq!(authority.shared.active.load(Ordering::Acquire), 0);
}

#[test]
fn local_and_durable_revoke_before_dispatch_create_no_child() {
    let fixture = Fixture::new();
    let scope = scope("synthetic-owner", 1);
    let (authority, fence) = authority(&scope);
    let executor = fixture.executor(
        &authority,
        &scope,
        "raise SystemExit(0)",
        TransportBounds::default(),
    );
    fence.0.store(false, Ordering::SeqCst);
    assert!(matches!(executor.spawn(&scope), Err(Error::Revoked)));
    fence.0.store(true, Ordering::SeqCst);
    authority.revoke().unwrap();
    assert!(matches!(executor.spawn(&scope), Err(Error::Revoked)));
    assert_eq!(authority.shared.active.load(Ordering::Acquire), 0);
}

#[test]
fn child_environment_is_exact_allowlist_and_subscription_is_broker_only() {
    let fixture = Fixture::new();
    let scope = scope("synthetic-owner", 1);
    let (authority, _) = authority(&scope);
    let handle = authority
        .issue_subscription(&scope, "synthetic-authorized-subscription".into())
        .unwrap();
    assert_eq!(
        authority.with_subscription(&scope, &handle, |locator| Ok(
            locator == "synthetic-authorized-subscription"
        )),
        Ok(true)
    );
    let executor = fixture.executor(
        &authority,
        &scope,
        "import os,json; print(json.dumps(dict(os.environ)),flush=True)",
        TransportBounds::default(),
    );
    let child = executor.spawn(&scope).unwrap();
    let env: serde_json::Value = serde_json::from_slice(&frame(&child, &scope).unwrap()).unwrap();
    let keys: std::collections::BTreeSet<_> = env
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        ["HOME", "LANG", "LC_ALL", "PATH", "TMPDIR"]
            .into_iter()
            .collect()
    );
    assert_eq!(env["HOME"], fixture.0.join("home").to_str().unwrap());
    assert_eq!(env["PATH"], "/usr/bin:/bin");
    assert_eq!(exit(&child, &scope).code, Some(0));
}

#[test]
fn subscription_handles_reject_other_authority_and_revocation() {
    let scope = scope("synthetic-owner", 1);
    let (first, _) = authority(&scope);
    let (second, _) = authority(&scope);
    let handle = first
        .issue_subscription(&scope, "synthetic-subscription".into())
        .unwrap();
    let mut calls = 0;
    assert_eq!(
        second.with_subscription(&scope, &handle, |_| {
            calls += 1;
            Ok(())
        }),
        Err(Error::WrongScope)
    );
    first.revoke().unwrap();
    assert_eq!(
        first.with_subscription(&scope, &handle, |_| {
            calls += 1;
            Ok(())
        }),
        Err(Error::Revoked)
    );
    assert_eq!(calls, 0);
}

#[test]
fn metadata_rejects_inference_refresh_and_writable_or_foreign_cwd() {
    let fixture = Fixture::new();
    let scope = scope("synthetic-owner", 1);
    let (authority, _) = authority(&scope);
    let child = fixture
        .executor(
            &authority,
            &scope,
            "import time; time.sleep(10)",
            TransportBounds::default(),
        )
        .spawn(&scope)
        .unwrap();
    let unsafe_frames = [
        json!({"id":1,"method":"turn/start","params":{}}),
        json!({"id":1,"method":"tool/run","params":{}}),
        json!({"id":1,"method":"account/read","params":{"refreshToken":true}}),
        json!({"id":1,"method":"account/read","params":{}}),
        json!({"id":1,"method":"thread/start","params":{"cwd":"/synthetic-other","approvalPolicy":"never","sandbox":"read-only","ephemeral":false}}),
        json!({"id":1,"method":"thread/start","params":{"cwd":fixture.0.join("workspace"),"approvalPolicy":"never","sandbox":"workspace-write","ephemeral":false}}),
        json!({"method":"initialized","params":{"method":"turn/start"}}),
    ];
    for value in unsafe_frames {
        assert_eq!(
            child.enqueue_metadata(&scope, &serde_json::to_vec(&value).unwrap()),
            Err(Error::InvalidFrame)
        );
    }
    assert_eq!(
        child.enqueue_metadata(&super::scope("other-owner", 1), &metadata()),
        Err(Error::WrongScope)
    );
}

#[test]
fn bounded_input_consumed_turn_failure_has_no_retry_capability() {
    let fixture = Fixture::new();
    let scope = scope("synthetic-owner", 1);
    let (authority, _) = authority(&scope);
    let bounds = TransportBounds {
        max_pending_frames: 1,
        ..TransportBounds::default()
    };
    let child = fixture
        .executor(&authority, &scope, "import time; time.sleep(10)", bounds)
        .spawn(&scope)
        .unwrap();
    child.enqueue_metadata(&scope, &metadata()).unwrap();
    assert_eq!(
        child.enqueue_metadata(&scope, &metadata()),
        Err(Error::Backpressure)
    );
    let count = Arc::new(AtomicU64::new(0));
    let failure = child
        .enqueue_turn(SyntheticConsumed {
            scope: scope.clone(),
            count: count.clone(),
        })
        .unwrap_err();
    assert_eq!(failure.cause, Error::Backpressure);
    assert_eq!(count.load(Ordering::SeqCst), 1);
    authority.revoke().unwrap();
    assert_eq!(child.flush_stdin(&scope), Err(Error::Revoked));
}

#[test]
fn fence_that_does_not_invoke_callback_cannot_dispatch() {
    struct Refuses;
    impl DispatchFence for Refuses {
        fn dispatch(
            &self,
            _: &ExecutionScope,
            _: &mut dyn FnMut() -> Result<(), Error>,
        ) -> Result<(), Error> {
            Ok(())
        }
    }
    let fixture = Fixture::new();
    let scope = scope("synthetic-owner", 1);
    let authority = Authority::new(scope.clone(), Arc::new(Refuses), 1).unwrap();
    let executor = fixture.executor(
        &authority,
        &scope,
        "raise SystemExit(0)",
        TransportBounds::default(),
    );
    assert!(matches!(
        executor.spawn(&scope),
        Err(Error::AuthorityProtocol)
    ));
    assert_eq!(authority.shared.active.load(Ordering::Acquire), 0);
}

#[test]
fn revoke_after_consumed_turn_enqueue_discards_pending_input() {
    let fixture = Fixture::new();
    let scope = scope("synthetic-owner", 1);
    let (authority, _) = authority(&scope);
    let child = fixture
        .executor(
            &authority,
            &scope,
            "import time; time.sleep(10)",
            TransportBounds::default(),
        )
        .spawn(&scope)
        .unwrap();
    let count = Arc::new(AtomicU64::new(0));
    child
        .enqueue_turn(SyntheticConsumed {
            scope: scope.clone(),
            count: count.clone(),
        })
        .unwrap();
    authority.revoke().unwrap();
    assert_eq!(child.flush_stdin(&scope), Err(Error::Revoked));
    assert_eq!(count.load(Ordering::SeqCst), 1);
}
