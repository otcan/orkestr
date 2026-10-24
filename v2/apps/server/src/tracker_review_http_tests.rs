use super::*;
use orkestr_v2_store_sqlite::history_import::timers::{
    authority::DurableTimerEnable, TimerEnableRequest, TimerImportRequest, TimerSchedule,
};

#[tokio::test]
async fn timeout_after_committed_slow_scan_and_slow_triggers_retries_without_controller_exit() {
    let case = enabled().await;
    let (sent, _) = mail_fixture(&case);
    std::fs::write(sent, "").unwrap();
    choose(&case).await;
    case.state
        .timers
        .ready
        .store(true, std::sync::atomic::Ordering::Release);
    let auth = case.auth();
    let (code, check) = send(
        &case.state,
        "POST",
        &case.path("/tracker/check"),
        &[&auth],
        &check_body(&case, "slow-check"),
    )
    .await;
    assert_eq!(code, 200, "{check}");
    let bound = case
        .state
        .store
        .authorize_timer_supervisor(&case.bearer)
        .await
        .unwrap();
    let mut controller =
        DurableTimerController::new(bound).with_tracker_mail(case.state.tracker_mail.clone());
    let trigger_started = Arc::new(std::sync::atomic::AtomicBool::new(false));
    controller.test_scan_delay = Some(Duration::from_secs(2));
    controller.test_trigger_delay = Some((Duration::from_secs(4), trigger_started.clone()));
    tokio::time::sleep(Duration::from_millis(2)).await;
    let result = controller
        .tick()
        .await
        .expect("post-scan pass timeout must not stop the controller");
    assert!(
        trigger_started.load(std::sync::atomic::Ordering::Relaxed),
        "timeout must occur after scan finished and trigger processing began"
    );
    assert_eq!(result.deferred, 1);
    let (_, reports) = send(
        &case.state,
        "GET",
        &case.path("/tracker/scan-reports"),
        &[&auth],
        "",
    )
    .await;
    assert_eq!(
        reports.as_array().unwrap().len(),
        1,
        "committed scan outcome survives the later timeout"
    );
    let next_pass = Arc::new(std::sync::atomic::AtomicBool::new(false));
    controller.test_trigger_delay = Some((Duration::ZERO, next_pass.clone()));
    assert_eq!(
        controller.tick().await.unwrap().deferred,
        1,
        "global timeout backoff is observed"
    );
    assert!(!next_pass.load(std::sync::atomic::Ordering::Relaxed));
    tokio::time::sleep(Duration::from_millis(5100)).await;
    controller
        .tick()
        .await
        .expect("next pass still runs after timeout/backoff");
    assert!(next_pass.load(std::sync::atomic::Ordering::Relaxed));
    let (_, reports) = send(
        &case.state,
        "GET",
        &case.path("/tracker/scan-reports"),
        &[&auth],
        "",
    )
    .await;
    assert_eq!(
        reports.as_array().unwrap().len(),
        1,
        "timeout does not replay the completed scan"
    );
    case.state.shutdown_tracker_reads().await.unwrap();
    case.finish().await;
}

#[tokio::test]
async fn invalid_classified_event_holds_its_occurrence_and_other_timers_continue() {
    let case = enabled().await;
    mail_fixture(&case);
    choose(&case).await;
    case.state
        .timers
        .ready
        .store(true, std::sync::atomic::Ordering::Release);
    case.state
        .tracker_mail
        .reject_classified_event
        .store(true, std::sync::atomic::Ordering::Relaxed);
    let auth = case.auth();
    let (code, check) = send(
        &case.state,
        "POST",
        &case.path("/tracker/check"),
        &[&auth],
        &check_body(&case, "invalid-classified-event"),
    )
    .await;
    assert_eq!(code, 200, "{check}");
    let namespace = Uuid::parse_str(check["authority"]["namespace"].as_str().unwrap()).unwrap();
    let owner = case
        .state
        .store
        .credentials("synthetic-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    let before = case
        .state
        .store
        .dormant_timer_receipt(&case.bearer, &owner, namespace)
        .await
        .unwrap();
    let bound = case
        .state
        .store
        .authorize_timer_supervisor(&case.bearer)
        .await
        .unwrap();
    let mut controller =
        DurableTimerController::new(bound).with_tracker_mail(case.state.tracker_mail.clone());
    tokio::time::sleep(Duration::from_millis(2)).await;
    let tick = controller
        .tick()
        .await
        .expect("invalid scan must never terminate the controller");
    assert_eq!(tick.tracker_actions, 0);
    assert_eq!(tick.deferred, 1);
    assert_eq!(
        case.state
            .store
            .dormant_timer_receipt(&case.bearer, &owner, namespace)
            .await
            .unwrap(),
        before
    );
    let (_, report) = send(
        &case.state,
        "GET",
        &case.path("/tracker/scan-reports"),
        &[&auth],
        "",
    )
    .await;
    assert_eq!(
        report.as_array().unwrap().len(),
        0,
        "rejected result must not advance cursor/outcome"
    );
    assert!(case
        .state
        .tracker_mail
        .alerts()
        .iter()
        .any(|(n, r)| *n == namespace && *r == "tracker_scan_commit_refused"));

    let ordinary = Uuid::new_v4();
    let due = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64)
        + 100;
    case.state
        .store
        .import_dormant_timer(
            &case.bearer,
            &owner,
            &TimerImportRequest {
                namespace: ordinary,
                source_namespace: "synthetic".into(),
                source_timer_id: "ordinary-after-refused-scan".into(),
                source_enabled: false,
                schedule: TimerSchedule::Once { due_ms: due },
            },
        )
        .await
        .unwrap();
    case.state
        .store
        .enable_durable_timer(
            &case.bearer,
            &owner,
            &DurableTimerEnable {
                timer: TimerEnableRequest {
                    namespace: ordinary,
                    expected_revision: 1,
                    request_key: "ordinary".into(),
                    conversation_id: case.conversation.clone(),
                },
                instruction: "Synthetic instruction; no provider dispatch".into(),
            },
        )
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(110)).await;
    let mut admitted = 0;
    for _ in 0..3 {
        admitted += controller
            .tick()
            .await
            .expect("controller stays live")
            .admitted;
    }
    assert_eq!(
        admitted, 1,
        "ordinary timer still admits once; no actual provider runs"
    );
    case.state.shutdown_tracker_reads().await.unwrap();
    case.finish().await;
}

#[tokio::test]
async fn discovery_replays_after_restart_and_busy_metadata_cannot_starve_a_queued_scan() {
    let case = enabled().await;
    mail_fixture(&case);
    let selection = choose(&case).await;
    let auth = case.auth();
    case.state
        .timers
        .ready
        .store(true, std::sync::atomic::Ordering::Release);
    let (code, check) = send(
        &case.state,
        "POST",
        &case.path("/tracker/check"),
        &[&auth],
        &check_body(&case, "before-metadata-pressure"),
    )
    .await;
    assert_eq!(code, 200, "{check}");
    let owner = case
        .state
        .store
        .credentials("synthetic-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    let first = case
        .state
        .tracker_mail
        .metadata_pool
        .reserve(&owner, &case.conversation)
        .unwrap();
    let second = case
        .state
        .tracker_mail
        .metadata_pool
        .reserve(&owner, &ConversationId(Uuid::new_v4()))
        .unwrap();
    let (code, receipt) = send(
        &case.state,
        "POST",
        &case.path("/tracker/mail-sources"),
        &[&auth],
        "{\"request_key\":\"find-mail\"}",
    )
    .await;
    assert_eq!(
        code, 200,
        "same discovery returns before reserving another slot"
    );
    assert_eq!(receipt["duplicate"], true);
    assert_eq!(
        receipt["sources"][0]["id"],
        selection["source"]["source_id"]
    );
    let bound = case
        .state
        .store
        .authorize_timer_supervisor(&case.bearer)
        .await
        .unwrap();
    let mut controller =
        DurableTimerController::new(bound).with_tracker_mail(case.state.tracker_mail.clone());
    tokio::time::sleep(Duration::from_millis(2)).await;
    assert_eq!(controller.tick().await.unwrap().tracker_actions, 1);
    drop((first, second));
    let reopened = AppState::new(
        case.state.store.clone(),
        "e".repeat(64),
        "http://127.0.0.1:19882".into(),
    )
    .unwrap();
    reopened.tracker_mail.metadata_pool.begin_shutdown();
    let (code, replay) = send(
        &reopened,
        "POST",
        &case.path("/tracker/mail-sources"),
        &[&auth],
        "{\"request_key\":\"find-mail\"}",
    )
    .await;
    assert_eq!(
        code, 200,
        "stored metadata receipt survives server composition restart"
    );
    assert_eq!(replay, receipt);
    reopened.shutdown_tracker_reads().await.unwrap();
    case.state.shutdown_tracker_reads().await.unwrap();
    case.finish().await;
}
