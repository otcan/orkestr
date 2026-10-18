//! Exact owner decision crash windows, independent exec after actual SIGKILL.
use super::observation_tests::{consumed, input};
use super::tests::setup_at;
use super::*;
#[cfg(feature = "fixture-test-controls")]
use crate::ProductionCheckpoint;
use orkestr_v2_contracts::{ConversationId, ExecutionAcceptanceRequest};
use std::{
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
struct Owned(Child);
impl Drop for Owned {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn child(root: &std::path::Path, mode: &str, stage: &str) -> Owned {
    Owned(
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "production_runtime::acceptance_process_tests::acceptance_child",
                "--nocapture",
            ])
            .env_clear()
            .env("ORKESTR_V2_HOME", root)
            .env("CORE_PRODUCTION_CHILD_ROOT", root)
            .env("CORE_PRODUCTION_CHECKPOINT", stage)
            .env("ACCEPTANCE_MODE", mode)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    )
}
#[tokio::test]
#[ignore = "owned child invoked only by actual_process_acceptance parent"]
async fn acceptance_child() {
    let root = PathBuf::from(std::env::var_os("CORE_PRODUCTION_CHILD_ROOT").unwrap());
    if std::env::var("ACCEPTANCE_MODE").unwrap() == "write" {
        let mut f = setup_at(root.clone()).await;
        let p = consumed(&f).await;
        f.handle
            .append_provider_event(&f.owner, &p, &input(&p, 1, ProviderEvent::Started))
            .await
            .unwrap();
        let done = f
            .handle
            .append_provider_event(
                &f.owner,
                &p,
                &input(&p, 2, ProviderEvent::CompletedProposal { synthetic: false }),
            )
            .await
            .unwrap();
        let request = ExecutionAcceptanceRequest {
            run_id: p.run.run_id,
            completion_event_id: done.event_id,
            expected_revision: f
                .store
                .execution_status(&f.owner, &f.conversation)
                .await
                .unwrap()
                .unwrap()
                .revision,
            request_key: "crash-accept".into(),
        };
        std::fs::write(
            root.join("request.json"),
            serde_json::to_vec(&(f.owner.clone(), f.conversation.clone(), request.clone()))
                .unwrap(),
        )
        .unwrap();
        std::fs::write(
            root.join("before.json"),
            serde_json::to_vec(&super::process_tests::rows(&root).await).unwrap(),
        )
        .unwrap();
        #[cfg(feature = "fixture-test-controls")]
        {
            let stage = if std::env::var("CORE_PRODUCTION_CHECKPOINT").unwrap()
                == "acceptance-before-commit"
            {
                ProductionCheckpoint::AcceptanceBeforeCommit
            } else {
                ProductionCheckpoint::AcceptanceAfterCommit
            };
            f.store
                .production_arm_owner_checkpoint(
                    &f.owner,
                    &f.conversation,
                    stage,
                    root.join("marker"),
                )
                .await
                .unwrap();
        }
        #[cfg(not(feature = "fixture-test-controls"))]
        let _ = &mut f;
        let _ = f
            .store
            .accept_execution(&f.owner, &f.conversation, &request)
            .await;
        panic!("checkpoint child must be killed");
    } else {
        let store = Store::open(&root.join("core.sqlite3")).await.unwrap();
        let (owner, conversation, request): (OwnerId, ConversationId, ExecutionAcceptanceRequest) =
            serde_json::from_slice(&std::fs::read(root.join("request.json")).unwrap()).unwrap();
        assert_eq!(
            store
                .credentials("synthetic-owner")
                .await
                .unwrap()
                .unwrap()
                .0,
            owner
        );
        let receipt = store
            .accept_execution(&owner, &conversation, &request)
            .await
            .unwrap();
        assert!(receipt.is_valid());
        let before = super::process_tests::rows(&root).await;
        assert_eq!(
            store
                .accept_execution(&owner, &conversation, &request)
                .await
                .unwrap(),
            receipt
        );
        let mut changed = request;
        changed.expected_revision += 1;
        assert!(matches!(
            store
                .accept_execution(&owner, &conversation, &changed)
                .await,
            Err(RuntimeStoreError::Conflict)
        ));
        assert_eq!(super::process_tests::rows(&root).await, before);
        std::fs::write(
            root.join("receipt.json"),
            serde_json::to_vec(&receipt).unwrap(),
        )
        .unwrap();
    }
}
#[tokio::test]
async fn actual_process_acceptance_commit_and_lost_reply() {
    for stage in ["acceptance-before-commit", "acceptance-after-commit"] {
        let root = PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap())
            .join(format!("owner-acceptance-crash-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let mut writer = child(&root, "write", stage);
        let deadline = Instant::now() + Duration::from_secs(20);
        while !root.join("marker").exists() {
            assert!(
                writer.0.try_wait().unwrap().is_none(),
                "child exited before {stage}"
            );
            assert!(Instant::now() < deadline, "missing checkpoint {stage}");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(std::fs::read_to_string(root.join("marker")).unwrap(), stage);
        writer.0.kill().unwrap();
        assert!(!writer.0.wait().unwrap().success());
        let original: Vec<String> =
            serde_json::from_slice(&std::fs::read(root.join("before.json")).unwrap()).unwrap();
        let killed = super::process_tests::rows(&root).await;
        if stage == "acceptance-before-commit" {
            assert_eq!(killed, original);
        } else {
            assert_ne!(killed, original);
        }
        let mut replay = child(&root, "replay", "");
        assert!(replay.0.wait().unwrap().success());
        if stage == "acceptance-after-commit" {
            assert_eq!(super::process_tests::rows(&root).await, killed);
        }
        assert!(root.join("receipt.json").exists());
    }
}
