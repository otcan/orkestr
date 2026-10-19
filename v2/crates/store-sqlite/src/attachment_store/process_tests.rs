//! Owned executable crash windows; no in-process discarded receipt substitute.
use super::{tests::*, *};
use crate::ProductionCheckpoint;
use std::{
    process::{Command, Stdio},
    time::{Duration, Instant},
};
const CHILD: &str = "attachment_store::process_tests::attachment_process_child";
#[tokio::test]
async fn attachment_process_child() {
    let Ok(dir) = std::env::var("ATTACHMENT_TEST_DIRECTORY") else {
        return;
    };
    let dir = std::path::PathBuf::from(dir);
    let request: AttachmentImportRequest =
        serde_json::from_slice(&std::fs::read(dir.join("request.json")).unwrap()).unwrap();
    let mut s = Store::open(&dir.join("store.sqlite3")).await.unwrap();
    let owner = &request.target_manifest.owner_id;
    let conversation = &request.target_manifest.conversation_id;
    let operation = std::env::var("ATTACHMENT_TEST_OPERATION").unwrap();
    if let Ok(stage) = std::env::var("ATTACHMENT_TEST_STAGE") {
        let stage = match stage.as_str() {
            "import-before" => ProductionCheckpoint::AttachmentImportBeforeCommit,
            "import-after" => ProductionCheckpoint::AttachmentImportAfterCommit,
            "remove-before" => ProductionCheckpoint::AttachmentRemoveBeforeCommit,
            "remove-after" => ProductionCheckpoint::AttachmentRemoveAfterCommit,
            _ => panic!("invalid stage"),
        };
        s.production_arm_history_checkpoint("synthetic-token", owner, stage, dir.join("marker"))
            .await
            .unwrap();
    }
    let json = if operation == "import" {
        serde_json::to_vec(
            &s.import_attachment_bundle_authenticated(
                "synthetic-token",
                owner,
                conversation,
                &request,
            )
            .await
            .unwrap(),
        )
        .unwrap()
    } else {
        serde_json::to_vec(
            &s.remove_attachment_authenticated(
                "synthetic-token",
                owner,
                conversation,
                request.target_manifest.manifest_id,
                request.target_manifest.references[0].reference_id,
                "remove",
            )
            .await
            .unwrap(),
        )
        .unwrap()
    };
    std::fs::write(dir.join("receipt.json"), json).unwrap();
    s.close().await;
}
fn child(dir: &std::path::Path, operation: &str, stage: Option<&str>) -> std::process::Child {
    let mut c = Command::new(std::env::current_exe().unwrap());
    c.args(["--exact", CHILD, "--nocapture"])
        .env("ATTACHMENT_TEST_DIRECTORY", dir)
        .env("ATTACHMENT_TEST_OPERATION", operation)
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    if let Some(stage) = stage {
        c.env("ATTACHMENT_TEST_STAGE", stage);
    } else {
        c.env_remove("ATTACHMENT_TEST_STAGE");
    }
    c.spawn().unwrap()
}
#[tokio::test]
async fn attachment_four_sigkill_windows_fresh_exec_replay() {
    for stage in [
        "import-before",
        "import-after",
        "remove-before",
        "remove-after",
    ] {
        let (s, o, c, d) = fixture().await;
        let request = request(&o, &c);
        let operation = if stage.starts_with("import") {
            "import"
        } else {
            "remove"
        };
        if operation == "remove" {
            s.import_attachment_bundle_authenticated("synthetic-token", &o, &c, &request)
                .await
                .unwrap();
        }
        let before = audit(&s).await;
        s.close().await;
        std::fs::write(
            d.join("request.json"),
            serde_json::to_vec(&request).unwrap(),
        )
        .unwrap();
        let mut process = child(&d, operation, Some(stage));
        let start = Instant::now();
        while !d.join("marker").exists() {
            if let Some(status) = process.try_wait().unwrap() {
                panic!("child exited before marker: {status}");
            }
            if start.elapsed() > Duration::from_secs(15) {
                process.kill().unwrap();
                process.wait().unwrap();
                panic!("marker timeout");
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let expected = format!(
            "attachment-{operation}-{}-commit",
            if stage.ends_with("before") {
                "before"
            } else {
                "after"
            }
        );
        assert_eq!(std::fs::read_to_string(d.join("marker")).unwrap(), expected);
        process.kill().unwrap();
        assert!(!process.wait().unwrap().success());
        assert!(!d.join("receipt.json").exists());
        let s = Store::open(&d.join("store.sqlite3")).await.unwrap();
        let after = audit(&s).await;
        if stage.ends_with("before") {
            assert_eq!(after, before);
        } else {
            assert_ne!(after, before);
        }
        s.close().await;
        assert!(child(&d, operation, None).wait().unwrap().success());
        let receipt = std::fs::read(d.join("receipt.json")).unwrap();
        let s = Store::open(&d.join("store.sqlite3")).await.unwrap();
        let committed = audit(&s).await;
        if stage.ends_with("after") {
            assert_eq!(committed, after);
        }
        s.close().await;
        assert!(child(&d, operation, None).wait().unwrap().success());
        assert_eq!(std::fs::read(d.join("receipt.json")).unwrap(), receipt);
        let s = Store::open(&d.join("store.sqlite3")).await.unwrap();
        assert_eq!(audit(&s).await, committed);
        s.close().await;
        std::fs::remove_dir_all(d).unwrap();
    }
}
