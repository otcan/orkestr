//! Author-owned actual executable crash windows, no transport or credentials.
use super::*;
use std::{
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};
const CHILD: &str =
    "production_runtime::automatic_reply::process_tests::automatic_reply_process_child";
async fn rows(s: &Store) -> Vec<String> {
    let mut tx = s.pool.begin().await.unwrap();
    let mut result = Vec::new();
    for table in [
        "automatic_reply_routes",
        "automatic_reply_permissions",
        "automatic_reply_inputs",
        "automatic_reply_sends",
        "messages",
        "events",
        "reasoning_inbox",
        "outbox",
    ] {
        let columns: Vec<String> = sqlx::query_scalar(&format!(
            "SELECT name FROM pragma_table_info('{table}') ORDER BY cid"
        ))
        .fetch_all(&mut *tx)
        .await
        .unwrap();
        let expression = columns
            .iter()
            .map(|s| format!("quote(\"{s}\")"))
            .collect::<Vec<_>>()
            .join("||'|'||");
        let values: Vec<String> = sqlx::query_scalar(&format!(
            "SELECT {expression} AS row FROM {table} ORDER BY row"
        ))
        .fetch_all(&mut *tx)
        .await
        .unwrap();
        result.push(format!("{table}:{values:?}"));
    }
    tx.commit().await.unwrap();
    result
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn automatic_reply_process_child() {
    let Ok(root) = std::env::var("AUTOMATIC_REPLY_CHILD_ROOT") else {
        return;
    };
    let root = std::path::PathBuf::from(root);
    if std::env::var("AUTOMATIC_REPLY_CHILD_MODE").unwrap() == "inspect" {
        let s = Store::open(&root.join("core.sqlite3")).await.unwrap();
        std::fs::write(
            root.join("inspection.json"),
            serde_json::to_vec(&rows(&s).await).unwrap(),
        )
        .unwrap();
        s.close().await;
        return;
    }
    let f = crate::production_runtime::tests::setup_at(root.clone()).await;
    let p = tests::enabled(&f).await;
    let id = tests::input(&f, &p).await;
    let stage = std::env::var("AUTOMATIC_REPLY_CHILD_MODE").unwrap();
    let reserve = stage.starts_with("reserve");
    let r = if reserve {
        None
    } else {
        Some(tests::reserved(&f, &p, id).await)
    };
    std::fs::write(
        root.join("before.json"),
        serde_json::to_vec(&rows(&f.store).await).unwrap(),
    )
    .unwrap();
    let mut handle = f.handle;
    handle
        .production_arm_checkpoint(
            match stage.as_str() {
                "reserve-before" => {
                    test_controls::ProductionCheckpoint::AutomaticReplyReserveBeforeCommit
                }
                "reserve-after" => {
                    test_controls::ProductionCheckpoint::AutomaticReplyReserveAfterCommit
                }
                "consume-before" => {
                    test_controls::ProductionCheckpoint::AutomaticReplyConsumeBeforeCommit
                }
                "consume-after" => {
                    test_controls::ProductionCheckpoint::AutomaticReplyConsumeAfterCommit
                }
                _ => panic!(),
            },
            root.join("marker"),
        )
        .await
        .unwrap();
    if reserve {
        let _ = handle
            .reserve_automatic_reply(&f.token, &p, id, "reply", b"exact output")
            .await
            .unwrap();
    } else {
        let _ = handle
            .consume_automatic_reply(&f.token, r.unwrap())
            .await
            .unwrap();
    }
    std::fs::write(root.join("returned"), b"unexpected before kill").unwrap();
}
fn spawn(root: &Path, mode: &str) -> std::process::Child {
    Command::new(std::env::current_exe().unwrap())
        .args(["--exact", CHILD, "--nocapture"])
        .env("AUTOMATIC_REPLY_CHILD_ROOT", root)
        .env("AUTOMATIC_REPLY_CHILD_MODE", mode)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap()
}
#[tokio::test]
async fn four_sigkill_windows_unknown_and_fresh_exec_oracle() {
    for stage in [
        "reserve-before",
        "reserve-after",
        "consume-before",
        "consume-after",
    ] {
        let root = std::path::PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap())
            .join(format!("automatic-crash-{}", Uuid::new_v4()));
        let mut child = spawn(&root, stage);
        let start = Instant::now();
        while !root.join("marker").exists() {
            if let Some(status) = child.try_wait().unwrap() {
                panic!("child exited: {status}");
            }
            if start.elapsed() > Duration::from_secs(20) {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("marker timeout");
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(
            std::fs::read_to_string(root.join("marker")).unwrap(),
            format!(
                "automatic-reply-{}-{}-commit",
                if stage.starts_with("reserve") {
                    "reserve"
                } else {
                    "consume"
                },
                if stage.ends_with("before") {
                    "before"
                } else {
                    "after"
                }
            )
        );
        child.kill().unwrap();
        assert!(!child.wait().unwrap().success());
        assert!(!root.join("returned").exists());
        assert!(spawn(&root, "inspect").wait().unwrap().success());
        let after = std::fs::read(root.join("inspection.json")).unwrap();
        let before = std::fs::read(root.join("before.json")).unwrap();
        if stage.ends_with("before") {
            assert_eq!(after, before);
        } else {
            assert_ne!(after, before);
        }
        let s = Store::open(&root.join("core.sqlite3")).await.unwrap();
        let states: Vec<(String, i64)> =
            sqlx::query_as("SELECT state,written_bytes FROM automatic_reply_sends")
                .fetch_all(&s.pool)
                .await
                .unwrap();
        let expected = match stage {
            "reserve-before" => vec![],
            "reserve-after" | "consume-before" => vec![("reserved".into(), 0)],
            _ => vec![("delivery_unknown".into(), 0)],
        };
        assert_eq!(states, expected);
        s.close().await;
        assert!(spawn(&root, "inspect").wait().unwrap().success());
        assert_eq!(after, std::fs::read(root.join("inspection.json")).unwrap());
        std::fs::remove_dir_all(root).unwrap();
    }
}
