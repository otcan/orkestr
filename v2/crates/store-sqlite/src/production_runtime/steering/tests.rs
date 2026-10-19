use super::*;
use crate::production_runtime::tests::{claim, ready, setup, Case};
use orkestr_v2_contracts::ExecutionControlRequest;
async fn running() -> (Case, CodexSteeringAuthority) {
    let f = setup().await;
    let b = ready(&f).await;
    let c = claim(&f, &b).await;
    let run = f
        .handle
        .admit_run(&c, &b.session_id, b.generation, "steer-run")
        .await
        .unwrap();
    let DispatchClaimResult::Reserved(r) = f
        .handle
        .claim_provider_dispatch(&run, "steer-reserve")
        .await
        .unwrap()
    else {
        panic!()
    };
    let ExecutionConsumption::Dispatch(cap) = f.handle.consume_execution(&r).await.unwrap() else {
        panic!()
    };
    let a = f.handle.authorize_codex_steering(&cap).await.unwrap();
    assert_eq!(a.provider(), cap.provider());
    f.handle
        .append_provider_event(
            &f.owner,
            &a.provider,
            &ProviderEventInput {
                run_id: a.provider.run.run_id.clone(),
                session_id: b.session_id,
                sequence: 1,
                lease_generation: a.provider.run.lease_generation,
                dispatch_fence: a.provider.run.dispatch_fence,
                event: ProviderEvent::Started,
            },
        )
        .await
        .unwrap();
    f.handle
        .bind_codex_steering_turn(&a, "native-turn:1")
        .await
        .unwrap();
    (f, a)
}
async fn request(f: &Case, a: &CodexSteeringAuthority, key: &str) -> ExecutionSteeringRequest {
    let s = f
        .handle
        .execution_run_status(&f.token, &f.owner, &f.conversation, &a.provider.run.run_id)
        .await
        .unwrap()
        .unwrap();
    ExecutionSteeringRequest {
        control: ExecutionControlRequest {
            run_id: a.provider.run.run_id.clone(),
            expected_revision: s.revision,
            expected_control_revision: s.control_revision,
            request_key: key.into(),
        },
        text: "use the revised bounded requirement".into(),
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn durable_admission_consume_ack_and_original_replay_never_reissue_input() {
    let (f, a) = running().await;
    let req = request(&f, &a, "steer:1").await;
    let (receipt, res) = f
        .handle
        .steer_execution_authenticated(&f.token, &f.conversation, &req, Some(&a))
        .await
        .unwrap();
    assert_eq!(receipt.disposition, SteeringDisposition::Reserved);
    let (replay, none) = f
        .handle
        .steer_execution_authenticated(&f.token, &f.conversation, &req, Some(&a))
        .await
        .unwrap();
    assert_eq!(receipt, replay);
    assert!(none.is_none());
    let SteeringConsumption::Deliver(mut delivery) =
        f.handle.consume_codex_steering(res.unwrap()).await.unwrap()
    else {
        panic!()
    };
    assert_eq!(delivery.text(), req.text);
    assert_eq!(delivery.expected_turn_id(), "native-turn:1");
    assert_eq!(
        f.handle
            .with_codex_steering_fence(&mut delivery, 0, 8, || Ok::<_, ()>(8))
            .unwrap(),
        Ok(8)
    );
    f.handle
        .acknowledge_codex_steering(*delivery, 8, true)
        .await
        .unwrap();
    let after = crate::production_runtime::tests::snapshot(&f.store).await;
    let second = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let handle = f.handle.reattach_supervisor(&second).await.unwrap();
    assert_eq!(
        handle
            .steer_execution_authenticated(&f.token, &f.conversation, &req, Some(&a))
            .await
            .unwrap()
            .0,
        receipt
    );
    let mut changed = req.clone();
    changed.text.push('!');
    assert!(matches!(
        handle
            .steer_execution_authenticated(&f.token, &f.conversation, &changed, Some(&a))
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    assert_eq!(
        after,
        crate::production_runtime::tests::snapshot(&f.store).await
    );
    assert!(f
        .handle
        .claim_next(
            &f.owner,
            &f.conversation,
            &a.provider.run.session_id,
            std::time::Duration::from_secs(30)
        )
        .await
        .unwrap()
        .is_none());
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn partial_suffix_stop_and_revocation_never_write_or_requeue() {
    let (f, a) = running().await;
    let req = request(&f, &a, "steer-stop").await;
    let (_, r) = f
        .handle
        .steer_execution_authenticated(&f.token, &f.conversation, &req, Some(&a))
        .await
        .unwrap();
    let SteeringConsumption::Deliver(mut d) =
        f.handle.consume_codex_steering(r.unwrap()).await.unwrap()
    else {
        panic!()
    };
    f.handle
        .with_codex_steering_fence(&mut d, 0, 2, || Ok::<_, ()>(1))
        .unwrap()
        .unwrap();
    let stop = request(&f, &a, "stop").await.control;
    f.handle
        .stop_execution_authenticated(&f.token, &f.conversation, &stop)
        .await
        .unwrap();
    let mut effects = 0;
    assert!(f
        .handle
        .with_codex_steering_fence(&mut d, 1, 1, || {
            effects += 1;
            Ok::<_, ()>(1)
        })
        .is_err());
    assert_eq!(effects, 0);
    assert!(f
        .handle
        .steer_execution_authenticated(&f.token, &f.conversation, &req, Some(&a))
        .await
        .unwrap()
        .1
        .is_none());
    f.store.revoke_session(&f.token).await.unwrap();
    assert!(matches!(
        f.handle
            .steer_execution_authenticated(&f.token, &f.conversation, &req, Some(&a))
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    let state: String = sqlx::query_scalar("SELECT state FROM production_steering")
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(state, "delivery_unknown");
}
#[tokio::test]
async fn unsupported_or_older_input_stays_ordered_and_stale_control_has_no_writes() {
    let (f, a) = running().await;
    let mut req = request(&f, &a, "unsupported").await;
    let before = crate::production_runtime::tests::snapshot(&f.store).await;
    req.control.expected_revision = i64::MAX;
    assert!(matches!(
        f.handle
            .steer_execution_authenticated(&f.token, &f.conversation, &req, None)
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    assert_eq!(
        before,
        crate::production_runtime::tests::snapshot(&f.store).await
    );
    req = request(&f, &a, "unsupported").await;
    let (queued, res) = f
        .handle
        .steer_execution_authenticated(&f.token, &f.conversation, &req, None)
        .await
        .unwrap();
    assert_eq!(queued.disposition, SteeringDisposition::QueuedUnsupported);
    assert!(res.is_none());
    let next = request(&f, &a, "ordered").await;
    let (queued, res) = f
        .handle
        .steer_execution_authenticated(&f.token, &f.conversation, &next, Some(&a))
        .await
        .unwrap();
    assert_eq!(queued.disposition, SteeringDisposition::QueuedOrdered);
    assert!(res.is_none());
    let rows: Vec<String> = sqlx::query_scalar(
        "SELECT state FROM reasoning_inbox WHERE state!='consumed' ORDER BY sequence",
    )
    .fetch_all(&f.store.pool)
    .await
    .unwrap();
    assert_eq!(rows, vec!["queued", "queued"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn separate_pool_consume_one_winner_and_lost_reply_remains_unknown_after_reopen() {
    let (f, a) = running().await;
    let req = request(&f, &a, "race").await;
    let (_, r) = f
        .handle
        .steer_execution_authenticated(&f.token, &f.conversation, &req, Some(&a))
        .await
        .unwrap();
    let r = r.unwrap();
    // Private test-only duplicate models two requests carrying the same issued
    // locator; there is deliberately no public Clone/constructor.
    let z = SteeringReservation {
        id: r.id,
        authority: CodexSteeringAuthority {
            provider: r.authority.provider.clone(),
            context: r.authority.context.clone(),
            incarnation: r.authority.incarnation.clone(),
        },
        grant: r.grant.clone(),
        turn: r.turn.clone(),
        text: r.text.clone(),
    };
    let other = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let h = f.handle.reattach_supervisor(&other).await.unwrap();
    let (x, y) = tokio::join!(
        f.handle.consume_codex_steering(r),
        h.consume_codex_steering(z)
    );
    let winners = [x.unwrap(), y.unwrap()]
        .into_iter()
        .filter(|v| matches!(v, SteeringConsumption::Deliver(_)))
        .count();
    assert_eq!(winners, 1);
    other.close().await;
    let reopened = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let h = f.handle.reattach_supervisor(&reopened).await.unwrap();
    let (_, none) = h
        .steer_execution_authenticated(&f.token, &f.conversation, &req, Some(&a))
        .await
        .unwrap();
    assert!(none.is_none());
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT state FROM production_steering")
            .fetch_one(&reopened.pool)
            .await
            .unwrap(),
        "delivery_unknown"
    );
    assert!(h
        .claim_next(
            &f.owner,
            &f.conversation,
            &a.provider.run.session_id,
            std::time::Duration::from_secs(30)
        )
        .await
        .unwrap()
        .is_none());
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn browser_logout_and_actual_commit_failure_after_effect_permanently_fence_suffix() {
    let (f, a) = running().await;
    let mut req = request(&f, &a, "browser-fence").await;
    let browser_token = "browser:synthetic-session";
    f.store.save_session(browser_token, &f.owner).await.unwrap();
    let (_, r) = f
        .handle
        .steer_execution_authenticated(browser_token, &f.conversation, &req, Some(&a))
        .await
        .unwrap();
    let SteeringConsumption::Deliver(mut d) =
        f.handle.consume_codex_steering(r.unwrap()).await.unwrap()
    else {
        panic!()
    };
    f.store.revoke_session(browser_token).await.unwrap();
    let mut bytes = 0;
    assert!(f
        .handle
        .with_codex_steering_fence(&mut d, 0, 3, || {
            bytes += 3;
            Ok::<_, ()>(3)
        })
        .is_err());
    assert_eq!(bytes, 0);
    // A second independent run exercises actual deferred COMMIT failure, not a
    // fake fence returning an error before the effect.
    let (f, a) = running().await;
    req = request(&f, &a, "commit-failure").await;
    let (_, r) = f
        .handle
        .steer_execution_authenticated(&f.token, &f.conversation, &req, Some(&a))
        .await
        .unwrap();
    let SteeringConsumption::Deliver(mut d) =
        f.handle.consume_codex_steering(r.unwrap()).await.unwrap()
    else {
        panic!()
    };
    sqlx::raw_sql("CREATE TABLE synthetic_steer_commit_failure(marker TEXT REFERENCES owners(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER synthetic_fail_steer_commit AFTER UPDATE OF written_bytes ON production_steering BEGIN INSERT INTO synthetic_steer_commit_failure VALUES('missing-owner'); END;").execute(&f.store.pool).await.unwrap();
    assert!(f
        .handle
        .with_codex_steering_fence(&mut d, 0, 3, || {
            bytes += 3;
            Ok::<_, ()>(3)
        })
        .is_err());
    assert_eq!(bytes, 3);
    assert!(f
        .handle
        .with_codex_steering_fence(&mut d, 0, 3, || {
            bytes += 3;
            Ok::<_, ()>(3)
        })
        .is_err());
    assert_eq!(bytes, 3);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT written_bytes FROM production_steering")
            .fetch_one(&f.store.pool)
            .await
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn stale_control_forged_authority_and_failed_ledger_insert_leave_no_intake() {
    let (f, mut a) = running().await;
    let req = request(&f, &a, "rollback").await;
    let before = crate::production_runtime::tests::snapshot(&f.store).await;
    let mut stale = req.clone();
    stale.control.expected_control_revision =
        Some(stale.control.expected_control_revision.unwrap() + 1);
    assert!(matches!(
        f.handle
            .steer_execution_authenticated(&f.token, &f.conversation, &stale, Some(&a))
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    a.provider.run.dispatch_fence += 1;
    assert!(f
        .handle
        .steer_execution_authenticated(&f.token, &f.conversation, &req, Some(&a))
        .await
        .is_err());
    a.provider.run.dispatch_fence -= 1;
    sqlx::raw_sql("CREATE TRIGGER synthetic_abort_steering BEFORE INSERT ON production_steering BEGIN SELECT RAISE(ABORT,'synthetic ledger fault'); END;").execute(&f.store.pool).await.unwrap();
    assert!(f
        .handle
        .steer_execution_authenticated(&f.token, &f.conversation, &req, Some(&a))
        .await
        .is_err());
    assert_eq!(
        before,
        crate::production_runtime::tests::snapshot(&f.store).await
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM production_steering")
            .fetch_one(&f.store.pool)
            .await
            .unwrap(),
        0
    );
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn explicit_native_rejection_is_not_completion_and_never_a_new_turn() {
    let (f, a) = running().await;
    let req = request(&f, &a, "reject").await;
    let (_, r) = f
        .handle
        .steer_execution_authenticated(&f.token, &f.conversation, &req, Some(&a))
        .await
        .unwrap();
    let SteeringConsumption::Deliver(mut d) =
        f.handle.consume_codex_steering(r.unwrap()).await.unwrap()
    else {
        panic!()
    };
    f.handle
        .with_codex_steering_fence(&mut d, 0, 1, || Ok::<_, ()>(0))
        .unwrap()
        .unwrap();
    assert_eq!(d.written_bytes(), 0);
    f.handle
        .with_codex_steering_fence(&mut d, 0, 1, || Ok::<_, ()>(1))
        .unwrap()
        .unwrap();
    f.handle
        .acknowledge_codex_steering(*d, 1, false)
        .await
        .unwrap();
    let status = f
        .handle
        .steering_status_authenticated(&f.token, &f.conversation, "reject")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        status.state,
        orkestr_v2_contracts::SteeringDeliveryState::Rejected
    );
    let run = f
        .handle
        .execution_run_status(&f.token, &f.owner, &f.conversation, &a.provider.run.run_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(run.phase, orkestr_v2_contracts::ExecutionPhase::Running);
    assert!(f
        .handle
        .claim_next(
            &f.owner,
            &f.conversation,
            &a.provider.run.session_id,
            std::time::Duration::from_secs(30)
        )
        .await
        .unwrap()
        .is_none());
}
