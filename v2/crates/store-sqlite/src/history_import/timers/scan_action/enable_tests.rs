use super::*;
use crate::conversation_resources::tests_settings::Case;
use orkestr_v2_contracts::TrackerEnable;

pub(super) async fn fixture() -> (Case, TrackerScanEnable) {
    let case = Case::new().await;
    case.store
        .enable_tracker(
            &case.token,
            &case.owner,
            &case.conversation,
            &TrackerEnable {
                recipe: "job-tracker".into(),
                notify_on: vec![],
            },
        )
        .await
        .unwrap();
    case.store
        .select_tracker_scan_source(
            &case.token,
            &case.owner,
            &case.conversation,
            &TrackerSourceSelect {
                request_key: "source-choice".into(),
                expected_revision: 0,
                acknowledge_read_only_access: true,
                source: SelectedMailSource {
                    source_id: Uuid::new_v4(),
                    inbox: vec![Uuid::new_v4()],
                    sent: vec![Uuid::new_v4()],
                },
            },
        )
        .await
        .unwrap();
    let namespace = Uuid::new_v4();
    case.store
        .import_dormant_timer(
            &case.token,
            &case.owner,
            &TimerImportRequest {
                namespace,
                source_namespace: "synthetic-recipe".into(),
                source_timer_id: "tracker-check".into(),
                source_enabled: false,
                schedule: TimerSchedule::Interval { every_ms: 60_000 },
            },
        )
        .await
        .unwrap();
    let request = TrackerScanEnable {
        timer: TimerEnableRequest {
            namespace,
            expected_revision: 1,
            request_key: "enable-scan".into(),
            conversation_id: case.conversation.clone(),
        },
        expected_source_revision: 1,
        expected_recipe: "job-tracker".into(),
        classifier_id: "synthetic-rules-v1".into(),
        classifier_digest: "ab".repeat(32),
    };
    (case, request)
}

#[tokio::test]
async fn event_schedule_is_not_silently_converted_into_a_clock_scan() {
    let (case, mut request) = fixture().await;
    let namespace = Uuid::new_v4();
    case.store
        .import_dormant_timer(
            &case.token,
            &case.owner,
            &TimerImportRequest {
                namespace,
                source_namespace: "synthetic-recipe".into(),
                source_timer_id: "unsupported-event".into(),
                source_enabled: false,
                schedule: TimerSchedule::Event,
            },
        )
        .await
        .unwrap();
    request.timer.namespace = namespace;
    let before = case
        .store
        .dormant_timer_receipt(&case.token, &case.owner, namespace)
        .await
        .unwrap();
    assert_eq!(
        case.store
            .enable_tracker_scan_timer(&case.token, &case.owner, &request)
            .await,
        Err(HistoryError::Invalid)
    );
    assert_eq!(
        case.store
            .dormant_timer_receipt(&case.token, &case.owner, namespace)
            .await
            .unwrap(),
        before
    );
    assert_eq!(
        case.count("SELECT count(*) FROM tracker_scan_authorities")
            .await,
        0
    );
    case.finish().await;
}

#[tokio::test]
async fn scan_enable_is_typed_and_never_falls_back_to_model_intake() {
    let (case, request) = fixture().await;
    assert!(case
        .store
        .authorize_timer_scheduler(request.timer.namespace)
        .await
        .is_err());
    let authority = case
        .store
        .enable_tracker_scan_timer(&case.token, &case.owner, &request)
        .await
        .unwrap();
    assert!(!authority.duplicate);
    let handle = case
        .store
        .authorize_timer_supervisor(&case.token)
        .await
        .unwrap();
    let issuer = handle
        .authorize_timer_scheduler(request.timer.namespace)
        .await
        .unwrap();
    assert_eq!(
        handle
            .timer_work_kind(&issuer, request.timer.namespace)
            .await
            .unwrap(),
        TimerWorkKind::TrackerScan
    );
    assert!(handle
        .admit_authorized_timer_turn(&issuer, request.timer.namespace, true)
        .await
        .is_err());
    let timer = case
        .store
        .dormant_timer_receipt(&case.token, &case.owner, request.timer.namespace)
        .await
        .unwrap();
    // Even the old owner compatibility API cannot convert this generation.
    assert!(case
        .store
        .admit_timer_input(
            &case.token,
            &case.owner,
            &input::TimerInputRequest {
                claim: TimerClaimRequest {
                    namespace: timer.namespace,
                    generation: timer.generation,
                    due_ms: timer.next_due_ms.unwrap(),
                    request_key: "forbidden-input".into()
                },
                text: "Synthetic text that must never become a model input".into(),
            },
            timer.next_due_ms.unwrap()
        )
        .await
        .is_err());
    for table in [
        "dormant_timer_claims",
        "dormant_timer_inputs",
        "production_runs",
        "reasoning_inbox",
        "execution_window_queue",
        "timer_digests",
    ] {
        assert_eq!(
            case.count(&format!("SELECT count(*) FROM {table}")).await,
            0
        );
    }
    assert_eq!(
        case.store
            .dormant_timer_receipt(&case.token, &case.owner, timer.namespace)
            .await
            .unwrap(),
        timer
    );
    let error=sqlx::query("INSERT INTO durable_timer_authorities(owner_id,namespace,generation,authority_id,conversation_id,request_key,expected_revision,instruction,instruction_digest,stop_sequence) SELECT owner_id,namespace,generation,?,conversation_id,'forbidden-instruction',1,'synthetic',?,stop_sequence FROM tracker_scan_authorities")
        .bind(Uuid::new_v4().to_string()).bind("cd".repeat(32)).execute(&case.store.pool).await.unwrap_err();
    assert!(error.to_string().contains("timer_work_kind_conflict"));
    case.finish().await;
}

#[tokio::test]
async fn enable_replay_after_source_change_and_disable_recovers_without_rearming() {
    let (case, request) = fixture().await;
    let first = case
        .store
        .enable_tracker_scan_timer(&case.token, &case.owner, &request)
        .await
        .unwrap();
    case.store
        .select_tracker_scan_source(
            &case.token,
            &case.owner,
            &case.conversation,
            &TrackerSourceSelect {
                request_key: "new-source".into(),
                expected_revision: 1,
                acknowledge_read_only_access: true,
                source: SelectedMailSource {
                    source_id: Uuid::new_v4(),
                    inbox: vec![Uuid::new_v4()],
                    sent: vec![Uuid::new_v4()],
                },
            },
        )
        .await
        .unwrap();
    let current = case
        .store
        .dormant_timer_receipt(&case.token, &case.owner, first.namespace)
        .await
        .unwrap();
    let disabled = case
        .store
        .control_dormant_timer(
            &case.token,
            &case.owner,
            &TimerControlRequest {
                namespace: first.namespace,
                expected_revision: current.revision,
                request_key: "disable-scan".into(),
                action: TimerControl::Disable,
            },
        )
        .await
        .unwrap();
    let replay = case
        .store
        .enable_tracker_scan_timer(&case.token, &case.owner, &request)
        .await
        .unwrap();
    assert!(replay.duplicate);
    assert_eq!(replay.authority_id, first.authority_id);
    assert_eq!(replay.source_revision, 1);
    assert_eq!(
        case.store
            .dormant_timer_receipt(&case.token, &case.owner, first.namespace)
            .await
            .unwrap(),
        disabled
    );
    assert_eq!(
        case.count("SELECT count(*) FROM tracker_scan_authorities")
            .await,
        1
    );
    let mut conflicting = request.clone();
    conflicting.classifier_digest = "ef".repeat(32);
    assert_eq!(
        case.store
            .enable_tracker_scan_timer(&case.token, &case.owner, &conflicting)
            .await,
        Err(HistoryError::Conflict)
    );
    assert_eq!(
        case.store
            .enable_tracker_scan_timer("invalid-session", &case.owner, &request)
            .await,
        Err(HistoryError::Unauthorized)
    );
    case.finish().await;
}

#[tokio::test]
async fn instruction_generation_cannot_also_be_scan_authority() {
    let (case, request) = fixture().await;
    case.store
        .enable_durable_timer(
            &case.token,
            &case.owner,
            &authority::DurableTimerEnable {
                timer: request.timer.clone(),
                instruction: "Synthetic explicit ordinary timer".into(),
            },
        )
        .await
        .unwrap();
    let error=sqlx::query("INSERT INTO tracker_scan_authorities(owner_id,namespace,generation,conversation_id,authority_id,request_key,expected_revision,source_revision,source_digest,recipe_id,classifier_id,classifier_digest,stop_sequence,created_ms) SELECT a.owner_id,a.namespace,a.generation,a.conversation_id,?,'forbidden-scan',1,s.source_revision,s.source_digest,'job-tracker','synthetic-rules',?,a.stop_sequence,0 FROM durable_timer_authorities a JOIN tracker_source_selections s ON s.owner_id=a.owner_id AND s.conversation_id=a.conversation_id")
        .bind(Uuid::new_v4().to_string()).bind("ab".repeat(32)).execute(&case.store.pool).await.unwrap_err();
    assert!(error.to_string().contains("timer_work_kind_conflict"));
    assert_eq!(
        case.count("SELECT count(*) FROM tracker_scan_authorities")
            .await,
        0
    );
    case.finish().await;
}
