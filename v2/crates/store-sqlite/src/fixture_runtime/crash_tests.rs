//! Test-binary-only checkpoints. None of this module exists in a normal build.
use super::admission::envelope;
use super::dispatch_tests::{fixture, Fixture};
use super::*;
use orkestr_v2_application::runtime::*;
use orkestr_v2_contracts::{ConversationId, EventId, MessageId, SessionId};
use std::{
    path::Path,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

pub(super) fn checkpoint(name: &str) {
    if std::env::var("ORKESTR_FIXTURE_TEST_CHECKPOINT")
        .ok()
        .as_deref()
        != Some(name)
    {
        return;
    }
    let root = std::env::var_os("ORKESTR_FIXTURE_TEST_ROOT").expect("child fixture root");
    std::fs::write(Path::new(&root).join("checkpoint"), name).unwrap();
    loop {
        std::thread::park_timeout(Duration::from_secs(1));
    }
}
struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
async fn crash(f: &Fixture, name: &str, secret: Option<&str>) {
    let marker = f.root.join("checkpoint");
    if let Some(secret) = secret {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options
            .open(f.root.join("test-private-locator"))
            .unwrap()
            .write_all(secret.as_bytes())
            .unwrap();
    }
    let mut child = OwnedChild(
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "fixture_runtime::crash_tests::checkpoint_child",
                "--nocapture",
            ])
            .env_clear()
            .env(
                "ORKESTR_V2_HOME",
                std::env::var_os("ORKESTR_V2_HOME").unwrap(),
            )
            .env("ORKESTR_FIXTURE_TEST_ROOT", &f.root)
            .env("ORKESTR_FIXTURE_TEST_CHECKPOINT", name)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if marker.exists() {
            break;
        }
        assert!(
            child.0.try_wait().unwrap().is_none(),
            "fixture checkpoint child exited early"
        );
        assert!(
            Instant::now() < deadline,
            "bounded fixture checkpoint timeout"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(std::fs::read_to_string(&marker).unwrap(), name);
    child.0.kill().unwrap();
    child.0.wait().unwrap();
    std::fs::remove_file(marker).unwrap();
    if secret.is_some() {
        std::fs::remove_file(f.root.join("test-private-locator")).unwrap();
    }
    assert!(
        !f.root.join("fake-io").exists(),
        "unknown outcome must not invoke even FAKE I/O"
    );
}

#[tokio::test]
#[ignore = "owned subprocess checkpoint child only"]
async fn checkpoint_child() {
    let Some(root) = std::env::var_os("ORKESTR_FIXTURE_TEST_ROOT") else {
        return;
    };
    let root = Path::new(&root);
    let store = Store::open(&root.join("core.sqlite3")).await.unwrap();
    // Deliberately test-private reconstruction for process crash oracles. No public
    // constructor accepts IDs, and no production API grants attachment this way.
    let row = sqlx::query("SELECT * FROM fixture_supervisors")
        .fetch_one(&store.pool)
        .await
        .unwrap();
    let handle = FixtureSupervisorStore {
        store: store.clone(),
        owner: OwnerId(Uuid::parse_str(&row.get::<String, _>("owner_id")).unwrap()),
        namespace: row.get("namespace"),
        supervisor_key: row.get("supervisor_key"),
        context_id: Uuid::parse_str(&row.get::<String, _>("context_id")).unwrap(),
        incarnation_id: Uuid::parse_str(&row.get::<String, _>("incarnation_id")).unwrap(),
        generation: row.get("generation"),
    };
    let name = std::env::var("ORKESTR_FIXTURE_TEST_CHECKPOINT").unwrap();
    if name.starts_with("admit-") {
        let row = sqlx::query("SELECT * FROM reasoning_inbox")
            .fetch_one(&store.pool)
            .await
            .unwrap();
        let claim = InboxClaim {
            owner_id: handle.owner.clone(),
            conversation_id: ConversationId(
                Uuid::parse_str(&row.get::<String, _>("conversation_id")).unwrap(),
            ),
            message_id: MessageId(Uuid::parse_str(&row.get::<String, _>("message_id")).unwrap()),
            event_id: EventId(Uuid::parse_str(&row.get::<String, _>("event_id")).unwrap()),
            consumer_session_id: SessionId(
                Uuid::parse_str(&row.get::<String, _>("claimant_session_id")).unwrap(),
            ),
            scope_sequence: row.get("sequence"),
            claim_generation: row.get::<i64, _>("claim_generation") as u64,
            lease_deadline_ms: row.get("claim_deadline_ms"),
        };
        let generation: i64 =
            sqlx::query_scalar("SELECT generation FROM session_bindings WHERE id=?")
                .bind(claim.consumer_session_id.to_string())
                .fetch_one(&store.pool)
                .await
                .unwrap();
        handle
            .admit_run(
                &claim,
                &claim.consumer_session_id,
                generation as u64,
                "run1",
            )
            .await
            .unwrap();
    } else {
        let row = sqlx::query("SELECT * FROM fixture_runs")
            .fetch_one(&store.pool)
            .await
            .unwrap();
        let provider = envelope(&row).unwrap();
        let secret = std::fs::read_to_string(root.join("test-private-locator")).unwrap();
        if name.starts_with("reserve-") {
            handle
                .claim_provider_dispatch(
                    &RunAdmissionResult {
                        provider,
                        run_state: RunState::Starting,
                        disposition: AdmissionDisposition::FreshCandidate,
                        candidate_key: Some(secret),
                    },
                    "reserve1",
                )
                .await
                .unwrap();
        } else {
            assert_eq!(
                handle
                    .consume_provider_dispatch(&DispatchClaim {
                        provider,
                        reservation_key: secret
                    })
                    .await
                    .unwrap(),
                DispatchConsumption::DispatchNow
            );
            checkpoint("consume-after-reply-before-io");
            // A marker stands in for FAKE I/O, never a provider command.
            std::fs::write(root.join("fake-io"), b"synthetic").unwrap();
        }
    }
    panic!("configured checkpoint was not reached");
}

#[tokio::test]
async fn killed_admission_before_commit_rolls_back_and_lost_ack_never_reissues_candidate() {
    for point in ["admit-before-commit", "admit-after-commit"] {
        let f = fixture().await;
        crash(&f, point, None).await;
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM fixture_runs")
            .fetch_one(&f.b.pool)
            .await
            .unwrap();
        let replay = f.admit().await;
        if point == "admit-before-commit" {
            assert_eq!(count, 0);
            assert_eq!(replay.disposition, AdmissionDisposition::FreshCandidate);
        } else {
            assert_eq!(count, 1);
            assert_eq!(replay.disposition, AdmissionDisposition::Replay);
            assert!(replay.candidate_key.is_none());
        }
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT state FROM reasoning_inbox")
                .fetch_one(&f.b.pool)
                .await
                .unwrap(),
            "consumed"
        );
        f.cleanup().await;
    }
}

#[tokio::test]
async fn killed_reservation_lost_ack_cannot_issue_replacement_locator() {
    for point in ["reserve-before-commit", "reserve-after-commit"] {
        let f = fixture().await;
        let fresh = f.admit().await;
        crash(&f, point, fresh.candidate_key.as_deref()).await;
        let result = f
            .handle
            .claim_provider_dispatch(&fresh, "reserve1")
            .await
            .unwrap();
        if point == "reserve-before-commit" {
            assert!(matches!(result, DispatchClaimResult::Reserved(_)));
        } else {
            assert!(matches!(result, DispatchClaimResult::Replay));
        }
        f.cleanup().await;
    }
}

#[tokio::test]
async fn killed_consume_before_after_commit_and_before_fake_io_never_redispatch_unknown() {
    for point in [
        "consume-before-commit",
        "consume-after-commit",
        "consume-after-reply-before-io",
    ] {
        let f = fixture().await;
        let fresh = f.admit().await;
        let claim = match f
            .handle
            .claim_provider_dispatch(&fresh, "reserve1")
            .await
            .unwrap()
        {
            DispatchClaimResult::Reserved(c) => c,
            _ => panic!(),
        };
        crash(&f, point, Some(&claim.reservation_key)).await;
        let reopened = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
        let attached = f.handle.reattach(&reopened).await.unwrap();
        let outcome = attached.consume_provider_dispatch(&claim).await.unwrap();
        if point == "consume-before-commit" {
            assert_eq!(outcome, DispatchConsumption::DispatchNow);
        } else {
            assert_eq!(outcome, DispatchConsumption::ReconciliationRequired);
        }
        assert_eq!(
            attached.consume_provider_dispatch(&claim).await.unwrap(),
            DispatchConsumption::ReconciliationRequired
        );
        reopened.close().await;
        f.cleanup().await;
    }
}
