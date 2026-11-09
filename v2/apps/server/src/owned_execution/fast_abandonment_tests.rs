//! Actual eligibility loop against an isolated Store; no provider execution.
use super::*;
use orkestr_v2_application::IntakeStore;
use orkestr_v2_contracts::MessageInput;
use std::sync::atomic::{AtomicUsize, Ordering};

async fn execution(with_source: bool) -> (ConfiguredExecution, PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let root = std::env::temp_dir().join(format!("fast-abandonment-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
    let store = Store::open(&root.join("core.sqlite3")).await.unwrap();
    let conversation = store
        .setup("synthetic-owner", "synthetic-hash")
        .await
        .unwrap();
    let owner = store
        .credentials("synthetic-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    let token = "ab".repeat(32);
    store.save_session(&token, &owner).await.unwrap();
    let token_file = root.join("machine-token");
    std::fs::write(&token_file, token).unwrap();
    std::fs::set_permissions(&token_file, std::fs::Permissions::from_mode(0o600)).unwrap();
    let config = Config {
        schema_version: 1,
        mode: "isolated-acceptance-v1".into(),
        conversation_id: conversation.clone(),
        machine_token_file: token_file,
        launcher: PathBuf::from("/usr/bin/true"),
        launcher_sha256: "0".repeat(64),
        workspace: root.clone(),
        workspace_authority: None,
        namespace: "synthetic-fast".into(),
        supervisor_key: "synthetic-fast".into(),
        provider: config::Provider::Codex,
        role: config::ExecutionRole::Fast,
        execution_budget: Default::default(),
        worker: None,
        provider_routing: None,
    };
    let mut execution = ConfiguredExecution::from_config(&store, &root, config, false)
        .await
        .unwrap();
    let companion = window_roles::Companion::new(crate::execution_registry::ExecutionScope {
        store: execution.store.clone(),
        control: Some(execution.control.clone()),
        tasks: None,
    });
    execution.companion = Some(companion);
    // A late follow-up is real durable input, not a volatile test cursor.
    if with_source {
        execution
            .store
            .admit(
                &owner,
                &conversation,
                &MessageInput {
                    client_message_id: "synthetic-late-followup".into(),
                    text: "synthetic owner input".into(),
                },
            )
            .await
            .unwrap();
    }
    (execution, root)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_companion_cannot_take_a_late_followup() {
    let (execution, root) = execution(true).await;
    execution.companion.as_ref().unwrap().fail();
    let checks = AtomicUsize::new(0);
    let (_sender, mut shutdown) = watch::channel(false);
    let mut heartbeat = Instant::now();
    let result = execution
        .fast_source_checked(&mut shutdown, &mut heartbeat, true, || {
            checks.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .await
        .unwrap();
    assert!(
        result.is_none(),
        "an abandoned Fast must not take the follow-up that wakes it"
    );
    assert_eq!(
        checks.load(Ordering::SeqCst),
        0,
        "no live provider check after abandonment"
    );
    assert!(
        execution
            .store
            .next_fast_source(&execution.token, &execution.config.conversation_id, 0)
            .await
            .unwrap()
            .is_some(),
        "abandonment must preserve unconsumed input"
    );
    execution.store.close().await;
    drop(execution);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn live_companion_still_selects_its_late_followup() {
    let (execution, root) = execution(true).await;
    let (_sender, mut shutdown) = watch::channel(false);
    let mut heartbeat = Instant::now();
    assert!(execution
        .fast_source_checked(&mut shutdown, &mut heartbeat, true, || Ok(()))
        .await
        .unwrap()
        .is_some());
    execution.store.close().await;
    drop(execution);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn companion_failure_ends_an_existing_idle_source_wait() {
    let (execution, root) = execution(false).await;
    let companion = execution.companion.as_ref().unwrap().clone();
    let (observed, waiting) = tokio::sync::oneshot::channel();
    let fail = tokio::spawn(async move {
        waiting.await.unwrap();
        companion.fail();
    });
    let mut observed = Some(observed);
    let (_sender, mut shutdown) = watch::channel(false);
    let mut heartbeat = Instant::now();
    let result = tokio::time::timeout(
        Duration::from_secs(1),
        execution.fast_source_checked(&mut shutdown, &mut heartbeat, true, || {
            if let Some(observed) = observed.take() {
                observed.send(()).unwrap();
            }
            Ok(())
        }),
    )
    .await
    .expect("abandoned Fast must stop waiting without a new input")
    .unwrap();
    assert!(result.is_none());
    fail.await.unwrap();
    execution.store.close().await;
    drop(execution);
    std::fs::remove_dir_all(root).unwrap();
}
