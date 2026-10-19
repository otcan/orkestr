//! Real ordinary server lifecycle with synthetic Store-issued timer records.
use orkestr_v2_store_sqlite::{
    history_import::timers::{TimerImportRequest, TimerSchedule},
    Store,
};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

#[tokio::test]
async fn ordinary_binary_delivers_once_and_restart_never_rearms_an_old_enable() {
    let directory = std::env::temp_dir().join(format!("v2-timer-seed-{}", Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap();
    let database = directory.join("seed.sqlite3");
    let store = Store::open(&database).await.unwrap();
    let conversation = store
        .setup("synthetic-owner", "unused-test-hash")
        .await
        .unwrap();
    let owner = store
        .credentials("synthetic-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    let machine = "a1".repeat(32);
    store.save_session(&machine, &owner).await.unwrap();
    store
        .save_session(&format!("browser:{}", "b2".repeat(32)), &owner)
        .await
        .unwrap();
    let once = Uuid::new_v4();
    let interval = Uuid::new_v4();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    for (namespace, schedule) in [
        (
            once,
            TimerSchedule::Once {
                due_ms: now + 8_000,
            },
        ),
        (interval, TimerSchedule::Interval { every_ms: 60_000 }),
    ] {
        store
            .import_dormant_timer(
                &machine,
                &owner,
                &TimerImportRequest {
                    namespace,
                    source_namespace: "synthetic-native-timer".into(),
                    source_timer_id: namespace.to_string(),
                    source_enabled: true,
                    schedule,
                },
            )
            .await
            .unwrap();
    }
    store.close().await;
    let output = tokio::task::spawn_blocking(move || {
        std::process::Command::new("python3")
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../tests/timer_lifecycle_http.py"
            ))
            .arg(env!("CARGO_BIN_EXE_orkestr-v2-server"))
            .arg(&database)
            .arg(conversation.to_string())
            .arg(once.to_string())
            .arg(interval.to_string())
            .env_clear()
            .env("PATH", "/usr/local/bin:/usr/bin:/bin")
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .output()
            .unwrap()
    })
    .await
    .unwrap();
    std::fs::remove_dir_all(directory).unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
