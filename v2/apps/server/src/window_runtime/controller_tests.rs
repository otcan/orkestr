use super::*;
use uuid::Uuid;

fn config() -> BetaConfig {
    serde_json::from_value(serde_json::json!({
        "schema_version":1,"owner_id":Uuid::new_v4(),"conversation_id":Uuid::new_v4(),
        "manager_socket":"/run/synthetic/control.sock","launcher":"/opt/synthetic/launcher",
        "launcher_sha256":"a".repeat(64),"workspace":"/srv/synthetic/workspace",
        "namespace":"synthetic-native","supervisor_key":"synthetic-supervisor"
    }))
    .unwrap()
}

#[test]
fn default_context_is_preserved_and_selected_keys_are_stable_distinct_and_bounded() {
    let base = config();
    let home = selected_config(&base, &base.conversation_id).unwrap();
    assert_eq!(home.namespace, base.namespace);
    assert_eq!(home.supervisor_key, base.supervisor_key);
    let a = ConversationId(Uuid::new_v4());
    let b = ConversationId(Uuid::new_v4());
    let first = selected_config(&base, &a).unwrap();
    let same = selected_config(&base, &a).unwrap();
    let other = selected_config(&base, &b).unwrap();
    assert_eq!(first.namespace, same.namespace);
    assert_eq!(first.supervisor_key, same.supervisor_key);
    assert_ne!(first.namespace, other.namespace);
    assert_ne!(first.supervisor_key, other.supervisor_key);
    assert_eq!(first.conversation_id, a);
    assert_eq!(first.owner_id, base.owner_id);
    assert_eq!(first.manager_socket, base.manager_socket);
    assert_eq!(first.launcher, base.launcher);
    assert_eq!(first.launcher_sha256, base.launcher_sha256);
    assert_eq!(first.workspace, base.workspace);
    first.validate().unwrap();
    assert!(selected_config(&base, &ConversationId(Uuid::nil())).is_err());
    let mut long = base.clone();
    long.namespace = "n".repeat(128);
    long.supervisor_key = "s".repeat(128);
    selected_config(&long, &a).unwrap().validate().unwrap();
}

#[test]
fn workspace_profile_follows_only_its_exact_operator_selected_conversation() {
    let mut base = config();
    let selected = ConversationId(Uuid::new_v4());
    let role = |name: &str| {
        serde_json::json!({
            "launcher":format!("/opt/synthetic/{name}"),
            "launcher_sha256":"a".repeat(64), "workspace":"/srv/native-readonly"
        })
    };
    base.roles = Some(
        serde_json::from_value(serde_json::json!({
            "fast":role("fast"), "workers":[role("w0"),role("w1"),role("w2"),role("w3")]
        }))
        .unwrap(),
    );
    base.workspace_exec = Some(
        serde_json::from_value(serde_json::json!({
            "conversation_id":selected, "project_id":Uuid::new_v4(),
            "workspace":"/srv/project", "allowed_roots":["/srv/project"],
            "protected_roots":["/srv/account"], "cgroup_root":"/sys/fs/cgroup/commands",
            "toolchain_root":"/opt/command-image"
        }))
        .unwrap(),
    );
    base.validate().unwrap();
    assert!(base.workspace_profile().is_none());
    let target = selected_config(&base, &selected).unwrap();
    assert!(target.workspace_profile().is_some());
    assert!(selected_config(&base, &ConversationId(Uuid::new_v4()))
        .unwrap()
        .workspace_profile()
        .is_none());
    assert_eq!(target.owner_id, base.owner_id);
    let mut missing_roles = target;
    missing_roles.roles = None;
    assert!(missing_roles.validate().is_err());
}

#[tokio::test]
async fn revoked_or_foreign_selection_cannot_replace_the_current_controller() {
    let root = std::env::temp_dir().join(format!("controller-selection-{}", Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let store = Store::open(&root.join("core.sqlite3")).await.unwrap();
    let conversation = store.setup("owner", "synthetic-hash").await.unwrap();
    let owner = store.credentials("owner").await.unwrap().unwrap().0;
    store
        .save_session("synthetic-browser", &owner)
        .await
        .unwrap();
    let mut config = config();
    config.owner_id = owner.clone();
    config.conversation_id = conversation.clone();
    let stat = std::fs::read_to_string("/proc/self/stat").unwrap();
    let parent = stat
        .rsplit_once(')')
        .unwrap()
        .1
        .split_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let manager = ManagerClient::new(
        config.manager_socket.clone(),
        owner.clone(),
        conversation.clone(),
        parent,
    )
    .unwrap();
    let controller = Controller::new(
        config.clone(),
        root.clone(),
        store.clone(),
        Arc::new(InitialAuthority::new(&config).unwrap()),
        Handles::new(owner.clone(), conversation.clone()).unwrap(),
        manager,
    );
    let input = ExecutionWindowRequest {
        request_key: "one-intent".into(),
        input_message_id: orkestr_v2_contracts::MessageId(Uuid::new_v4()),
        input_event_id: orkestr_v2_contracts::EventId(Uuid::new_v4()),
        input_request_key: "one-input".into(),
        expected_generation: 0,
        window_id: None,
        predecessor_window_id: None,
    };
    let foreign = ConversationId(Uuid::new_v4());
    for (token, selected) in [("synthetic-browser", &foreign), ("revoked", &conversation)] {
        assert!(controller
            .process(token, &owner, selected, &input)
            .await
            .is_err());
        // Neither a foreign nor a revoked request creates or replaces a controller.
        assert!(controller.existing(&foreign).is_none());
        assert!(
            !controller
                .existing(&conversation)
                .unwrap()
                .has_local_task()
                .await
        );
        assert!(store
            .execution_window_status_authenticated("synthetic-browser", &conversation)
            .await
            .unwrap()
            .is_none());
    }
    controller.shutdown().await.unwrap();
    drop(controller);
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn historical_admission_replay_never_selects_or_closes_another_conversation() {
    use orkestr_v2_application::IntakeStore;
    use orkestr_v2_contracts::{ConversationInput, MessageInput};
    let root = std::env::temp_dir().join(format!("controller-replay-{}", Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let store = Store::open(&root.join("core.sqlite3")).await.unwrap();
    let original = store.setup("owner", "synthetic-hash").await.unwrap();
    let owner = store.credentials("owner").await.unwrap().unwrap().0;
    store
        .save_session("synthetic-browser", &owner)
        .await
        .unwrap();
    let (selected, _) = store
        .create_conversation_authenticated(
            "synthetic-browser",
            &ConversationInput {
                client_request_id: "other".into(),
                name: "Another native thread".into(),
            },
        )
        .await
        .unwrap();
    let intake = store
        .admit(
            &owner,
            &original,
            &MessageInput {
                client_message_id: "original-input".into(),
                text: "synthetic message".into(),
            },
        )
        .await
        .unwrap()
        .receipt;
    let input = ExecutionWindowRequest {
        request_key: "original-window".into(),
        input_message_id: intake.message_id,
        input_event_id: intake.event_id,
        input_request_key: "original-input".into(),
        expected_generation: 0,
        window_id: None,
        predecessor_window_id: None,
    };
    let original_receipt = store
        .admit_execution_window_authenticated("synthetic-browser", &original, &input)
        .await
        .unwrap();
    let mut config = config();
    config.owner_id = owner.clone();
    config.conversation_id = selected.conversation_id.clone();
    let stat = std::fs::read_to_string("/proc/self/stat").unwrap();
    let parent = stat
        .rsplit_once(')')
        .unwrap()
        .1
        .split_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let manager = ManagerClient::new(
        config.manager_socket.clone(),
        owner.clone(),
        selected.conversation_id.clone(),
        parent,
    )
    .unwrap();
    let controller = Controller::new(
        config.clone(),
        root.clone(),
        store.clone(),
        Arc::new(InitialAuthority::new(&config).unwrap()),
        Handles::new(owner.clone(), selected.conversation_id.clone()).unwrap(),
        manager,
    );
    let WindowOutcome::Admitted(replay) = controller
        .process("synthetic-browser", &owner, &original, &input)
        .await
        .unwrap()
    else {
        panic!("historical admission must replay, never queue")
    };
    assert!(replay.duplicate);
    assert_eq!(replay.status.window_id, original_receipt.status.window_id);
    assert!(controller.existing(&original).is_none());
    let mut conflict = input.clone();
    conflict.input_request_key = "different-source".into();
    assert!(controller
        .process("synthetic-browser", &owner, &original, &conflict)
        .await
        .is_err());
    assert!(controller.existing(&original).is_none());
    assert!(controller.snapshot(&owner, &original).is_none());
    controller.shutdown().await.unwrap();
    drop(controller);
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn conversation_workspace_replaces_only_that_conversations_deep_and_fast_directory() {
    let mut value = serde_json::json!({
        "schema_version":1,"owner_id":Uuid::new_v4(),"conversation_id":Uuid::new_v4(),
        "manager_socket":"/run/synthetic/control.sock","launcher":"/opt/synthetic/launcher",
        "launcher_sha256":"a".repeat(64),"workspace":"/srv/synthetic/workspace",
        "namespace":"synthetic-native","supervisor_key":"synthetic-supervisor",
        "host_full_access":{"environment":{"HOME":"/home/example","PATH":"/usr/bin"}}
    });
    let role = |n: usize| {
        serde_json::json!({"launcher":format!("/opt/synthetic/launcher-{n}"),
            "launcher_sha256":"b".repeat(64),"workspace":"/srv/synthetic/workspace"})
    };
    value["roles"] =
        serde_json::json!({"fast":role(0),"workers":[role(1),role(2),role(3),role(4)]});
    let mapped = ConversationId(Uuid::new_v4());
    let other = ConversationId(Uuid::new_v4());
    value["conversation_workspaces"] =
        serde_json::json!({ mapped.to_string(): "/srv/v1/workspaces/thread" });
    let mut shared_value = value.clone();
    shared_value["conversation_workspaces"] = serde_json::json!({mapped.to_string():
        {"path":"/srv/v1/workspaces/thread", "shared":true}});
    let shared_base: BetaConfig = serde_json::from_value(shared_value).unwrap();
    let shared_selected = selected_config(&shared_base, &mapped).unwrap();
    assert_eq!(
        shared_selected.workspace,
        std::path::Path::new("/srv/v1/workspaces/thread")
    );
    assert_eq!(
        shared_selected.roles.unwrap().fast.workspace,
        shared_selected.workspace
    );
    let base: BetaConfig = serde_json::from_value(value).unwrap();
    base.validate().unwrap();
    let selected = selected_config(&base, &mapped).unwrap();
    assert_eq!(
        selected.workspace,
        std::path::PathBuf::from("/srv/v1/workspaces/thread")
    );
    let roles = selected.roles.as_ref().unwrap();
    assert_eq!(
        roles.fast.workspace,
        std::path::PathBuf::from("/srv/v1/workspaces/thread")
    );
    // Workers keep the configured instance workspace.
    assert!(roles
        .workers
        .iter()
        .all(|w| w.workspace == std::path::Path::new("/srv/synthetic/workspace")));
    let unmapped = selected_config(&base, &other).unwrap();
    assert_eq!(unmapped.workspace, base.workspace);
    assert_eq!(
        unmapped.roles.as_ref().unwrap().fast.workspace,
        std::path::PathBuf::from("/srv/synthetic/workspace")
    );
}

#[test]
fn conversation_workspace_replaces_only_that_conversations_claude_directory() {
    let mut value = serde_json::json!({
        "schema_version":1,"owner_id":Uuid::new_v4(),"conversation_id":Uuid::new_v4(),
        "manager_socket":"/run/synthetic/control.sock","launcher":"/opt/synthetic/launcher",
        "launcher_sha256":"a".repeat(64),"workspace":"/srv/synthetic/workspace",
        "namespace":"synthetic-native","supervisor_key":"synthetic-supervisor",
        "host_full_access":{"environment":{"HOME":"/home/example","PATH":"/usr/bin"}},
        "claude":{"launcher":"/opt/synthetic/launcher-claude","launcher_sha256":"c".repeat(64),
            "workspace":"/srv/synthetic/claude-workspace","default":true,"fast":true}
    });
    let mapped = ConversationId(Uuid::new_v4());
    let other = ConversationId(Uuid::new_v4());
    value["conversation_workspaces"] = serde_json::json!({ mapped.to_string(): {"path":"/srv/v1/workspaces/claude-thread", "shared":true} });
    let base: BetaConfig = serde_json::from_value(value).unwrap();
    base.validate().unwrap();
    // Claude Deep and its Fast companion both take the window's Claude
    // workspace, so one replacement covers both roles.
    let selected = selected_config(&base, &mapped).unwrap();
    let claude = selected.claude.as_ref().unwrap();
    assert_eq!(
        claude.workspace,
        std::path::PathBuf::from("/srv/v1/workspaces/claude-thread")
    );
    // Launcher pin and switches are unchanged.
    assert_eq!(
        claude.launcher,
        std::path::PathBuf::from("/opt/synthetic/launcher-claude")
    );
    assert_eq!(claude.launcher_sha256, "c".repeat(64));
    assert!(claude.default && claude.fast);
    let unmapped = selected_config(&base, &other).unwrap();
    assert_eq!(
        unmapped.claude.as_ref().unwrap().workspace,
        std::path::PathBuf::from("/srv/synthetic/claude-workspace")
    );
}

#[tokio::test]
async fn deploy_drain_queues_fresh_input_durably_and_reports_drained() {
    use orkestr_v2_application::IntakeStore;
    use orkestr_v2_contracts::MessageInput;
    let root = std::env::temp_dir().join(format!("controller-drain-{}", Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let store = Store::open(&root.join("core.sqlite3")).await.unwrap();
    let conversation = store.setup("owner", "synthetic-hash").await.unwrap();
    let owner = store.credentials("owner").await.unwrap().unwrap().0;
    store
        .save_session("synthetic-browser", &owner)
        .await
        .unwrap();
    let intake = store
        .admit(
            &owner,
            &conversation,
            &MessageInput {
                client_message_id: "drained-input".into(),
                text: "synthetic message".into(),
            },
        )
        .await
        .unwrap()
        .receipt;
    let mut config = config();
    config.owner_id = owner.clone();
    config.conversation_id = conversation.clone();
    let stat = std::fs::read_to_string("/proc/self/stat").unwrap();
    let parent = stat
        .rsplit_once(')')
        .unwrap()
        .1
        .split_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let manager = ManagerClient::new(
        config.manager_socket.clone(),
        owner.clone(),
        conversation.clone(),
        parent,
    )
    .unwrap();
    let drain = Arc::new(crate::deploy_drain::DeployDrain::default());
    drain.set(true);
    let controller = Controller::new(
        config.clone(),
        root.clone(),
        store.clone(),
        Arc::new(InitialAuthority::new(&config).unwrap()),
        Handles::new(owner.clone(), conversation.clone()).unwrap(),
        manager,
    )
    .with_deploy_drain(drain.clone());
    let input = ExecutionWindowRequest {
        request_key: "drained-window".into(),
        input_message_id: intake.message_id,
        input_event_id: intake.event_id,
        input_request_key: "drained-input".into(),
        expected_generation: 0,
        window_id: None,
        predecessor_window_id: None,
    };
    // A fresh window would have room, but the drain queues it in Core.
    let WindowOutcome::Queued(queued) = controller
        .process("synthetic-browser", &owner, &conversation, &input)
        .await
        .unwrap()
    else {
        panic!("a drained controller must queue, never open")
    };
    assert_eq!(queued.request_key, "drained-window");
    assert!(store
        .execution_window_status_authenticated("synthetic-browser", &conversation)
        .await
        .unwrap()
        .is_none());
    // Replaying the same intent while draining stays queued (idempotent).
    assert!(matches!(
        controller
            .process("synthetic-browser", &owner, &conversation, &input)
            .await
            .unwrap(),
        WindowOutcome::Queued(_)
    ));
    // A drain pass admits nothing and reports Core: no window, one intent.
    controller.drain_step().await;
    let status = drain.status();
    assert!(status.drained);
    assert_eq!(status.unresolved_windows, 0);
    assert_eq!(status.queued_intents, 1);
    assert_eq!(
        store
            .execution_window_queue_authenticated("synthetic-browser", None)
            .await
            .unwrap()
            .len(),
        1
    );
    controller.shutdown().await.unwrap();
    drop(controller);
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}
