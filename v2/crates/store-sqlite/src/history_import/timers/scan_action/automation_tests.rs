use super::*;
use crate::conversation_resources::tests_settings::Case;
use orkestr_v2_contracts::tracker_automation::*;

fn request(key: &str) -> TrackerAutomationEnable {
    TrackerAutomationEnable {
        request_key: key.into(),
        expected_revision: 0,
        expected_timer_revision: None,
        expected_source_revision: 1,
        expected_recipe: "job-tracker".into(),
        expected_classifier_id: "synthetic-rules".into(),
        expected_classifier_digest: "ab".repeat(32),
        calendar: CalendarRule {
            timezone: "Europe/Berlin".into(),
            weekdays: vec![1, 2, 3, 4, 5],
            start_minute: 540,
            end_minute: 540,
            every_hours: 1,
            minutes: vec![0],
        },
        acknowledge_automation: true,
    }
}
async fn enable(
    case: &Case,
    request: &TrackerAutomationEnable,
) -> Result<TrackerAutomationReceipt> {
    case.store
        .enable_tracker_automation(
            &case.token,
            &case.owner,
            &case.conversation,
            request,
            ("synthetic-rules", &"ab".repeat(32)),
        )
        .await
}
async fn status(case: &Case) -> TrackerAutomationStatus {
    case.store
        .tracker_automation_status(&case.token, &case.owner, &case.conversation)
        .await
        .unwrap()
}
async fn disable(case: &Case, key: &str) -> TrackerAutomationReceipt {
    let before = status(case).await;
    case.store
        .disable_tracker_automation(
            &case.token,
            &case.owner,
            &case.conversation,
            &TrackerAutomationDisable {
                request_key: key.into(),
                expected_revision: before.revision,
                expected_timer_revision: before.timer_revision,
            },
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn recurring_scan_requires_separate_opt_in_and_exact_enable_never_rearms_after_stop() {
    let (case, _) = enable_tests::fixture().await;
    let mut unchecked = request("unchecked");
    unchecked.acknowledge_automation = false;
    assert_eq!(enable(&case, &unchecked).await, Err(HistoryError::Invalid));
    assert_eq!(status(&case).await.revision, 0);
    let first = enable(&case, &request("enable-once")).await.unwrap();
    let current = status(&case).await;
    assert!(current.enabled && current.source_current);
    assert_eq!(current.revision, 1);
    assert_eq!(current.timer_revision, Some(2));
    let disabled = disable(&case, "stop").await;
    assert!(!disabled.enabled);
    assert_eq!(disabled.revision, 2);
    let before = status(&case).await;
    assert!(!before.enabled);
    let replay = enable(&case, &request("enable-once")).await.unwrap();
    assert!(replay.duplicate);
    assert_eq!(replay.authority, first.authority);
    assert_eq!(status(&case).await, before);
    // Rule upgrades do not hide the receipt of the exact reviewed old intent.
    let replay = case
        .store
        .enable_tracker_automation(
            &case.token,
            &case.owner,
            &case.conversation,
            &request("enable-once"),
            ("upgraded-rules", &"cd".repeat(32)),
        )
        .await
        .unwrap();
    assert!(replay.duplicate);
    assert_eq!(replay.revision, 1);
    let mut conflicting = request("enable-once");
    conflicting.calendar.timezone = "UTC".into();
    assert_eq!(
        enable(&case, &conflicting).await,
        Err(HistoryError::Conflict)
    );
    action_tests::assert_no_model_or_chat_work(&case).await;
    case.finish().await;
}

#[tokio::test]
async fn initial_disable_blocks_a_delayed_enable_and_stale_timer_revision_cannot_replace_stop() {
    let (case, _) = enable_tests::fixture().await;
    let stopped = disable(&case, "initial-stop").await;
    assert_eq!(stopped.revision, 1);
    assert!(stopped.authority.is_none());
    assert_eq!(
        enable(&case, &request("delayed-enable")).await,
        Err(HistoryError::Conflict)
    );
    let mut new = request("fresh-enable");
    new.expected_revision = 1;
    let enabled = enable(&case, &new).await.unwrap();
    let before = status(&case).await;
    case.store
        .control_dormant_timer(
            &case.token,
            &case.owner,
            &TimerControlRequest {
                namespace: enabled.authority.as_ref().unwrap().namespace,
                expected_revision: before.timer_revision.unwrap(),
                request_key: "ordinary-stop".into(),
                action: TimerControl::Stop,
            },
        )
        .await
        .unwrap();
    let mut stale = request("stale-replacement");
    stale.expected_revision = before.revision;
    stale.expected_timer_revision = before.timer_revision;
    assert_eq!(enable(&case, &stale).await, Err(HistoryError::Conflict));
    assert!(!status(&case).await.enabled);
    assert_eq!(
        case.count("SELECT count(*) FROM tracker_scan_authorities")
            .await,
        1
    );
    case.finish().await;
}

#[tokio::test]
async fn automation_factory_failure_rolls_back_old_stop_new_schedule_and_receipt() {
    let (case, _) = enable_tests::fixture().await;
    enable(&case, &request("first")).await.unwrap();
    let before = status(&case).await;
    let timers = case.count("SELECT count(*) FROM dormant_timers").await;
    sqlx::raw_sql("CREATE TRIGGER synthetic_automation_failure BEFORE INSERT ON tracker_automation_decisions BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;")
        .execute(&case.store.pool).await.unwrap();
    let mut replace = request("replace");
    replace.expected_revision = before.revision;
    replace.expected_timer_revision = before.timer_revision;
    assert!(enable(&case, &replace).await.is_err());
    assert_eq!(status(&case).await, before);
    assert_eq!(
        case.count("SELECT count(*) FROM dormant_timers").await,
        timers
    );
    assert_eq!(
        case.count("SELECT count(*) FROM tracker_scan_authorities")
            .await,
        1
    );
    assert_eq!(
        case.count("SELECT count(*) FROM tracker_automation_decisions")
            .await,
        1
    );
    case.finish().await;
}

#[tokio::test]
async fn source_removal_disables_old_actions_without_erasing_automation_audit() {
    let (case, _) = enable_tests::fixture().await;
    enable(&case, &request("first")).await.unwrap();
    case.store
        .remove_tracker_scan_source(
            &case.token,
            &case.owner,
            &case.conversation,
            &TrackerSourceRemove {
                request_key: "remove".into(),
                expected_revision: 1,
            },
        )
        .await
        .unwrap();
    let current = status(&case).await;
    assert!(!current.enabled && !current.source_current);
    assert_eq!(current.timer_revision, Some(3));
    let recovered = case
        .store
        .tracker_automation_receipt(&case.token, &case.owner, &case.conversation, "first")
        .await
        .unwrap();
    assert!(recovered.enabled && recovered.duplicate);
    assert_eq!(
        case.count("SELECT count(*) FROM dormant_timers WHERE state='enabled'")
            .await,
        0
    );
    assert_eq!(
        case.store
            .tracker_automation_receipt("invalid-session", &case.owner, &case.conversation, "first")
            .await,
        Err(HistoryError::Unauthorized)
    );
    action_tests::assert_no_model_or_chat_work(&case).await;
    case.finish().await;
}
