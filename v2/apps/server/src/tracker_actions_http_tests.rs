use super::*;
use crate::conversation_resources_http::tests::{case, send, Case};
use crate::timer_http::durable::DurableTimerController;
use orkestr_v2_mail_reader::profile::{DiscoveryEnv, Os};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

async fn enabled() -> Case {
    let mut case = case().await;
    let owner = case
        .state
        .store
        .credentials("synthetic-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    case.state
        .store
        .enable_tracker(
            &case.bearer,
            &owner,
            &case.conversation,
            &TrackerEnable {
                recipe: "job-tracker".into(),
                notify_on: default_notify_on(),
            },
        )
        .await
        .unwrap();
    Arc::get_mut(&mut case.state.tracker_mail)
        .unwrap()
        .discovery_env = DiscoveryEnv {
        os: Os::Linux,
        home: Some(case.root.clone()),
        appdata: None,
    };
    case
}
fn mail_fixture(case: &Case) -> (std::path::PathBuf, Vec<u8>) {
    let base = case.root.join(".thunderbird");
    let account = base.join("profile/Mail/account.example");
    std::fs::create_dir_all(&account).unwrap();
    std::fs::write(
        base.join("profiles.ini"),
        "[Profile0]\nName=Synthetic Mail\nIsRelative=1\nPath=profile\nDefault=1\n",
    )
    .unwrap();
    std::fs::write(account.join("Inbox"), "").unwrap();
    let sent = account.join("Sent");
    let message = b"From - Sat Oct 24 12:00:00 2026\nFrom: Applicant <person@applicant.example>\nTo: Hiring Team <jobs@company.example>\nMessage-ID: <application-one@applicant.example>\nSubject: Your application to Backend Engineer at Example Works\n\nI would like to apply for the Backend Engineer position at Example Works. My CV is attached.\n";
    // A normal application can carry a CV larger than 512 KiB. Attachments
    // are not classification text; the bounded reader must still see the mail.
    let mut messages = message.to_vec();
    let headers_end = messages.windows(2).position(|w| w == b"\n\n").unwrap();
    messages.truncate(headers_end + 1);
    messages.extend_from_slice(b"MIME-Version: 1.0\nContent-Type: multipart/mixed; boundary=synthetic-cv\n\n--synthetic-cv\nContent-Type: text/plain\n\nI would like to apply for the Backend Engineer position at Example Works. My CV is attached.\n--synthetic-cv\nContent-Type: application/pdf\nContent-Disposition: attachment; filename=synthetic-cv.pdf\nContent-Transfer-Encoding: base64\n\n");
    for _ in 0..10_000 {
        messages.extend_from_slice(
            b"QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB\n",
        );
    }
    messages.extend_from_slice(b"--synthetic-cv--\n");
    for index in 0..70 {
        messages.extend_from_slice(format!("From - Sat Oct 24 12:00:00 2026\nFrom: Applicant <person@applicant.example>\nTo: Friend <friend@personal.example>\nMessage-ID: <greeting-{index}@applicant.example>\nSubject: Hello\n\nSee you soon.\n").as_bytes());
    }
    std::fs::write(&sent, &messages).unwrap();
    let file = std::fs::File::open(&sent).unwrap();
    file.set_times(
        std::fs::FileTimes::new()
            .set_modified(std::time::SystemTime::now() - Duration::from_secs(60)),
    )
    .unwrap();
    (sent, messages)
}
async fn choose(case: &Case) -> Value {
    let auth = case.auth();
    let (code, discovery) = send(
        &case.state,
        "POST",
        &case.path("/tracker/mail-sources"),
        &[&auth],
        "{}",
    )
    .await;
    assert_eq!(code, 200, "{discovery}");
    assert_eq!(discovery["sources"].as_array().unwrap().len(), 1);
    let source = &discovery["sources"][0];
    assert_eq!(source["ready"], true);
    assert!(!discovery
        .to_string()
        .contains(&case.root.to_string_lossy().to_string()));
    let request = json!({"request_key":"choose-mail","expected_revision":0,
        "source":{"source_id":source["id"],"inbox":[source["inbox"][0]["id"]],"sent":[source["sent"][0]["id"]]},
        "acknowledge_read_only_access":true});
    let (code, result) = send(
        &case.state,
        "PUT",
        &case.path("/tracker/mail-source"),
        &[&auth],
        &request.to_string(),
    )
    .await;
    assert_eq!(code, 200, "{result}");
    assert_eq!(result["source_revision"], 1);
    request
}
fn check_body(case: &Case, key: &str) -> String {
    json!({"request_key":key,"expected_source_revision":1,"expected_recipe":"job-tracker", "expected_classifier_id":case.state.tracker_mail.rules.version, "expected_classifier_digest":case.state.tracker_mail.digest})
        .to_string()
}

#[tokio::test]
async fn synthetic_guided_source_check_and_restarted_reader_commit_news_then_silent_result() {
    let case = enabled().await;
    let (sent, original) = mail_fixture(&case);
    let selection = choose(&case).await;
    let auth = case.auth();
    let owner = case
        .state
        .store
        .credentials("synthetic-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    let bound = case
        .state
        .store
        .authorize_timer_supervisor(&case.bearer)
        .await
        .unwrap();
    case.state
        .timers
        .ready
        .store(true, std::sync::atomic::Ordering::Release);
    let (code, first) = send(
        &case.state,
        "POST",
        &case.path("/tracker/check"),
        &[&auth],
        &check_body(&case, "first-check"),
    )
    .await;
    assert_eq!(code, 200, "{first}");
    let (code, status) = send(
        &case.state,
        "GET",
        &case.path("/tracker/mail-status"),
        &[&auth],
        "",
    )
    .await;
    assert_eq!(code, 200);
    assert_eq!(status["checks"][0]["request_key"], "first-check");
    assert!(!status
        .to_string()
        .contains(&case.root.to_string_lossy().to_string()));
    let mut controller = DurableTimerController::new(bound.clone())
        .with_tracker_mail(case.state.tracker_mail.clone());
    tokio::time::sleep(Duration::from_millis(5)).await;
    let tick = controller.tick().await.unwrap();
    assert_eq!(tick.tracker_actions, 1, "{tick:?}");
    assert_eq!(tick.admitted + tick.triggered, 0);
    let (code, reports) = send(
        &case.state,
        "GET",
        &case.path("/tracker/scan-reports"),
        &[&auth],
        "",
    )
    .await;
    assert_eq!(code, 200);
    assert_eq!(reports.as_array().unwrap().len(), 1);
    assert_eq!(reports[0]["news"], true, "{reports}");
    assert_eq!(reports[0]["more_mail"], true);
    assert_eq!(reports[0]["read_warnings"]["skipped_large"], 0);
    assert!(reports[0]["digest_id"].is_string());
    let (code, table) = send(&case.state, "GET", &case.path("/tracker"), &[&auth], "").await;
    assert_eq!(code, 200);
    assert_eq!(table["rows"].as_array().unwrap().len(), 1);
    assert_eq!(table["rows"][0]["status"], "applied");
    // A fresh server composition uses persisted opaque backing/cursor. No
    // second discovery or plaintext path/grant is required after restart.
    case.state.shutdown_tracker_reads().await.unwrap();
    let restarted_store = Store::open(&case.root.join("core.sqlite3")).await.unwrap();
    let restarted = AppState::new(
        restarted_store,
        "e".repeat(64),
        "http://127.0.0.1:19882".into(),
    )
    .unwrap();
    restarted
        .timers
        .ready
        .store(true, std::sync::atomic::Ordering::Release);
    let (code, second) = send(
        &restarted,
        "POST",
        &case.path("/tracker/check"),
        &[&auth],
        &check_body(&case, "second-check"),
    )
    .await;
    assert_eq!(code, 200, "{second}");
    let mut controller =
        DurableTimerController::new(bound).with_tracker_mail(restarted.tracker_mail.clone());
    tokio::time::sleep(Duration::from_millis(5)).await;
    assert_eq!(controller.tick().await.unwrap().tracker_actions, 1);
    let (_, reports) = send(
        &restarted,
        "GET",
        &case.path("/tracker/scan-reports"),
        &[&auth],
        "",
    )
    .await;
    assert_eq!(reports.as_array().unwrap().len(), 2);
    assert_eq!(reports[0]["news"], false);
    assert_eq!(reports[0]["more_mail"], false);
    assert!(reports[0]["digest_id"].is_null());
    assert!(restarted
        .store
        .conversation_timer_inputs(&case.bearer, &owner, &case.conversation, 0, 100)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(std::fs::read(&sent).unwrap(), original);
    let (code, replay) = send(
        &restarted,
        "PUT",
        &case.path("/tracker/mail-source"),
        &[&auth],
        &selection.to_string(),
    )
    .await;
    assert_eq!(code, 200);
    assert_eq!(replay["duplicate"], true);
    restarted.shutdown_tracker_reads().await.unwrap();
    restarted.store.close().await;
    case.finish().await;
}

#[tokio::test]
async fn stop_before_interrupted_check_response_never_requires_a_ready_scheduler() {
    let case = enabled().await;
    let auth = case.auth();
    let path = case.path("/tracker/checks/delayed-check");
    let (code, stop) = send(&case.state, "DELETE", &path, &[&auth], "").await;
    assert_eq!(code, 200);
    assert_eq!(stop["cancelled"], true);
    let (code, late) = send(
        &case.state,
        "POST",
        &case.path("/tracker/check"),
        &[&auth],
        &check_body(&case, "delayed-check"),
    )
    .await;
    assert_eq!(code, 200, "{late}");
    assert_eq!(late["cancelled"], true);
    assert!(late["authority"].is_null());
    let (code, receipt) = send(&case.state, "GET", &path, &[&auth], "").await;
    assert_eq!(code, 200);
    assert_eq!(receipt["cancelled"], true);
    case.state.shutdown_tracker_reads().await.unwrap();
    case.finish().await;
}

#[tokio::test]
async fn every_mail_mutation_rejects_grants_and_requires_browser_origin_and_csrf() {
    let case = enabled().await;
    let cookie = format!("Cookie: orkestr_v2_session={}", case.cookie);
    let csrf = format!(
        "x-orkestr-csrf: {:x}",
        Sha256::digest(format!("orkestr-v2-browser-csrf-v1:{}", case.cookie).as_bytes())
    );
    let owner = case
        .state
        .store
        .credentials("synthetic-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    let issued = case
        .state
        .store
        .issue_tracker_grant(&case.bearer, &owner, &case.conversation)
        .await
        .unwrap();
    let grant = format!("x-orkestr-tracker-grant: {}", issued.grant);
    for (method, suffix) in [
        ("POST", "/tracker/mail-sources"),
        ("PUT", "/tracker/mail-source"),
        ("DELETE", "/tracker/mail-source"),
        ("POST", "/tracker/check"),
        ("DELETE", "/tracker/checks/key"),
        ("POST", "/tracker/automation"),
        ("DELETE", "/tracker/automation"),
    ] {
        for headers in [
            vec![cookie.as_str()],
            vec![cookie.as_str(), "Origin: http://127.0.0.1:19882"],
            vec![cookie.as_str(), csrf.as_str()],
            vec![
                cookie.as_str(),
                csrf.as_str(),
                "Origin: http://wrong.example",
            ],
        ] {
            let (code, _) = send(&case.state, method, &case.path(suffix), &headers, "{}").await;
            assert_eq!(code, 403, "{method} {suffix}");
        }
        let (code, _) = send(&case.state, method, &case.path(suffix), &[&grant], "{}").await;
        assert_eq!(code, 401, "grant {method} {suffix}");
    }
    let (code, _) = send(
        &case.state,
        "DELETE",
        &case.path("/tracker/checks/browser-stop"),
        &[&cookie, "Origin: http://127.0.0.1:19882", &csrf],
        "",
    )
    .await;
    assert_eq!(code, 200);
    case.state.shutdown_tracker_reads().await.unwrap();
    case.finish().await;
}

#[tokio::test]
async fn automation_requires_ready_selected_mail_and_recovers_its_old_decision_after_disable() {
    let case = enabled().await;
    mail_fixture(&case);
    choose(&case).await;
    let auth = case.auth();
    let path = case.path("/tracker/automation");
    let mut request = json!({"request_key":"automation-on", "expected_revision":0,"expected_timer_revision":null,
        "expected_source_revision":1,"expected_recipe":"job-tracker",
        "expected_classifier_id":case.state.tracker_mail.rules.version,"expected_classifier_digest":case.state.tracker_mail.digest,
        "calendar":{"timezone":"Europe/Berlin","weekdays":[1,2,3,4,5],"start_minute":540,"end_minute":540,"every_hours":1,"minutes":[0]},
        "acknowledge_automation":true});
    let (code, _) = send(&case.state, "POST", &path, &[&auth], &request.to_string()).await;
    assert_eq!(code, 503);
    let (code, initial_stop) = send(
        &case.state,
        "DELETE",
        &path,
        &[&auth],
        &json!({"request_key":"initial-stop","expected_revision":0,"expected_timer_revision":null})
            .to_string(),
    )
    .await;
    assert_eq!(code, 200);
    assert_eq!(initial_stop["revision"], 1);
    case.state
        .timers
        .ready
        .store(true, std::sync::atomic::Ordering::Release);
    let (code, _) = send(&case.state, "POST", &path, &[&auth], &request.to_string()).await;
    assert_eq!(code, 409);
    request["request_key"] = json!("fresh-opt-in");
    request["expected_revision"] = json!(1);
    let (code, enabled) = send(&case.state, "POST", &path, &[&auth], &request.to_string()).await;
    assert_eq!(code, 200, "{enabled}");
    assert_eq!(enabled["enabled"], true);
    let (_, current) = send(&case.state, "GET", &path, &[&auth], "").await;
    assert_eq!(current["enabled"], true);
    let (code, stopped) = send(&case.state, "DELETE", &path, &[&auth],
        &json!({"request_key":"stop-recurring","expected_revision":current["revision"],"expected_timer_revision":current["timer_revision"]}).to_string()).await;
    assert_eq!(code, 200);
    assert_eq!(stopped["enabled"], false);
    // Receipt recovery needs neither a ready scheduler nor still-present folders.
    case.state
        .timers
        .ready
        .store(false, std::sync::atomic::Ordering::Release);
    let profile = case.root.join(".thunderbird/profile");
    std::fs::rename(&profile, profile.with_extension("moved")).unwrap();
    let (code, replay) = send(&case.state, "POST", &path, &[&auth], &request.to_string()).await;
    assert_eq!(code, 200, "{replay}");
    assert_eq!(replay["duplicate"], true);
    let (_, current) = send(&case.state, "GET", &path, &[&auth], "").await;
    assert_eq!(current["enabled"], false);
    assert_eq!(current["revision"], 3);
    case.state.shutdown_tracker_reads().await.unwrap();
    case.finish().await;
}
