//! Native-attach holds through the actual Deep input loop against an
//! isolated Store; no provider runs. A window admitted before the hold runs
//! its own turn; afterwards the writer claims nothing and an idle wait ends
//! while held, and after release the next input runs on the same session
//! binding and native session. Only the first run after an ended attach
//! carries the internal note.
use super::*;
use crate::native_attach::fixture::Holds;
use orkestr_v2_application::runtime::{
    NativeSessionConfirmation, ProviderAdmission, ProviderEvent, ProviderEventInput, RuntimeStore,
};
use orkestr_v2_application::IntakeStore;
use orkestr_v2_contracts::{ExecutionAcceptanceRequest, MessageInput};
use std::time::Instant;

const TOKEN: &str = "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";

/// The native session the fixture's hold and ended records name.
fn native() -> uuid::Uuid {
    uuid::Uuid::from_u128(0xa71e)
}

async fn execution(holds: &Holds) -> (ConfiguredExecution, Store, PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let root = std::env::temp_dir().join(format!("native-attach-deep-{}", uuid::Uuid::new_v4()));
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
    store.save_session(TOKEN, &owner).await.unwrap();
    let token_file = root.join("machine-token");
    std::fs::write(&token_file, TOKEN).unwrap();
    std::fs::set_permissions(&token_file, std::fs::Permissions::from_mode(0o600)).unwrap();
    let config = Config {
        schema_version: 1,
        mode: "isolated-acceptance-v1".into(),
        conversation_id: conversation,
        machine_token_file: token_file,
        launcher: PathBuf::from("/usr/bin/true"),
        launcher_sha256: "0".repeat(64),
        workspace: root.clone(),
        workspace_authority: None,
        namespace: "synthetic-attach".into(),
        supervisor_key: "synthetic-attach".into(),
        provider: config::Provider::Codex,
        role: config::ExecutionRole::Deep,
        execution_budget: Default::default(),
        worker: None,
        provider_routing: None,
    };
    let mut execution = ConfiguredExecution::from_config(&store, &root, config, false)
        .await
        .unwrap();
    execution.native_attach = Some(holds.holds.clone());
    let deep = execution
        .store
        .ensure_role_bindings(&execution.owner, &execution.config.conversation_id)
        .await
        .unwrap()
        .deep;
    execution
        .store
        .confirm_native_session(NativeSessionConfirmation {
            session_id: deep.session_id,
            expected_generation: deep.generation,
            native_session_id: native().to_string(),
            protocol_version: "codex-rpc-1".into(),
            source_event_key: "thread-ready:1".into(),
        })
        .await
        .unwrap();
    (execution, store, root)
}

/// The run starts, proposes an answer and the owner accepts it.
async fn accept(execution: &ConfiguredExecution, store: &Store, run: &ProviderAdmission) {
    let conversation = &execution.config.conversation_id;
    let mut completion = None;
    for (sequence, event) in [
        (1, ProviderEvent::Started),
        (2, ProviderEvent::CompletedProposal { synthetic: false }),
    ] {
        let input = ProviderEventInput {
            run_id: run.run.run_id.clone(),
            session_id: run.run.session_id.clone(),
            sequence,
            lease_generation: run.run.lease_generation,
            dispatch_fence: run.run.dispatch_fence,
            event,
        };
        completion = Some(
            execution
                .store
                .append_provider_event(&execution.owner, run, &input)
                .await
                .unwrap()
                .event_id,
        );
    }
    let revision = store
        .execution_status(&execution.owner, conversation)
        .await
        .unwrap()
        .unwrap()
        .revision;
    store
        .accept_execution(
            &execution.owner,
            conversation,
            &ExecutionAcceptanceRequest {
                run_id: run.run.run_id.clone(),
                completion_event_id: completion.unwrap(),
                expected_revision: revision,
                request_key: format!("accept-{}", run.run.run_id),
            },
        )
        .await
        .unwrap();
}

async fn owner_input(
    store: &Store,
    execution: &ConfiguredExecution,
    key: &str,
) -> orkestr_v2_contracts::Receipt {
    store
        .admit(
            &execution.owner,
            &execution.config.conversation_id,
            &MessageInput {
                client_message_id: key.into(),
                text: format!("Synthetic owner input {key}"),
            },
        )
        .await
        .unwrap()
        .receipt
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_window_admitted_before_the_hold_runs_its_turn_then_takes_nothing_until_release() {
    let holds = Holds::new();
    let (execution, store, root) = execution(&holds).await;
    let conversation = execution.config.conversation_id.clone();
    let (_sender, mut shutdown) = watch::channel(false);
    let mut heartbeat = Instant::now();
    let before = execution
        .store
        .ensure_role_bindings(&execution.owner, &conversation)
        .await
        .unwrap()
        .deep;
    let admitted = owner_input(&store, &execution, "admitted-before-hold").await;
    // The hold appears after the window was admitted, before its bootstrap.
    // Bootstrap and the first claim are not gated: the turn the window was
    // admitted for runs, so the window can close canonically after it.
    holds.hold(&conversation);
    let first = execution
        .next(&mut shutdown, &mut heartbeat)
        .await
        .unwrap()
        .expect("the window's own input runs");
    assert_eq!(first.message_id(), &admitted.message_id);
    let first_run = first.provider().run.run_id.clone();
    accept(&execution, &store, first.provider()).await;
    // After that turn the writer takes nothing while held: its input loop
    // ends there (Codex: next_after_turn; Claude: wait_eligible_after_turn)
    // and the caller reaps the native tree and closes the window.
    let waiting = owner_input(&store, &execution, "while-held").await;
    assert!(execution
        .next_after_turn(&mut shutdown, &mut heartbeat, || Ok(()))
        .await
        .unwrap()
        .is_none());
    assert!(!execution
        .wait_eligible_after_turn(&mut shutdown, &mut heartbeat)
        .await
        .unwrap());
    let status = store
        .execution_status(&execution.owner, &conversation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status.run_id, Some(first_run), "no run while held");
    // Released: the waiting input runs on the same binding and native session.
    holds.release(&conversation);
    let turn = execution
        .next_after_turn(&mut shutdown, &mut heartbeat, || Ok(()))
        .await
        .unwrap()
        .expect("the held input runs after release");
    assert_eq!(turn.message_id(), &waiting.message_id);
    let binding = &turn.provider().binding;
    assert_eq!(binding.session_id, before.session_id);
    assert_eq!(binding.native_session_id, Some(native().to_string()));
    assert!(turn.text().contains("Synthetic owner input while-held"));
    assert!(!turn.text().starts_with("[Orkestr:"), "no attach ended");
    execution.store.close().await;
    drop(execution);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn only_the_first_deep_run_after_an_ended_attach_carries_the_note() {
    let holds = Holds::new();
    let (execution, store, root) = execution(&holds).await;
    let conversation = execution.config.conversation_id.clone();
    let (_sender, mut shutdown) = watch::channel(false);
    let mut heartbeat = Instant::now();
    owner_input(&store, &execution, "before").await;
    let earlier = execution
        .next(&mut shutdown, &mut heartbeat)
        .await
        .unwrap()
        .unwrap();
    assert!(!earlier.text().starts_with("[Orkestr:"));
    accept(&execution, &store, earlier.provider()).await;
    // The owner attached and detached after that run's evidence.
    tokio::time::sleep(Duration::from_millis(20)).await;
    let ended = crate::deploy_drain::now_ms();
    holds.ended(&conversation, native(), ended - 60_000, ended);
    tokio::time::sleep(Duration::from_millis(20)).await;
    let note = crate::native_attach::note(&holds.holds.ended(&conversation, ended).unwrap());
    owner_input(&store, &execution, "first-after").await;
    let first = execution
        .next(&mut shutdown, &mut heartbeat)
        .await
        .unwrap()
        .unwrap();
    let text = first.text();
    assert!(text.starts_with(&format!("{note}\n\n")), "{text}");
    assert!(text.contains("Synthetic owner input first-after"));
    accept(&execution, &store, first.provider()).await;
    owner_input(&store, &execution, "second-after").await;
    let second = execution
        .next(&mut shutdown, &mut heartbeat)
        .await
        .unwrap()
        .unwrap();
    assert!(
        !second.text().starts_with("[Orkestr:"),
        "only the first run"
    );
    assert!(second.text().contains("Synthetic owner input second-after"));
    accept(&execution, &store, second.provider()).await;
    // An ended attach of another native session notes nothing.
    holds.ended(&conversation, uuid::Uuid::from_u128(0xbeef), ended, ended);
    owner_input(&store, &execution, "other-native").await;
    let other = execution
        .next(&mut shutdown, &mut heartbeat)
        .await
        .unwrap()
        .unwrap();
    assert!(!other.text().starts_with("[Orkestr:"));
    execution.store.close().await;
    drop(execution);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_writers_own_cancellation_holds_no_input_while_held() {
    for held in [true, false] {
        let holds = Holds::new();
        let (execution, store, root) = execution(&holds).await;
        let conversation = execution.config.conversation_id.clone();
        let (_sender, mut shutdown) = watch::channel(false);
        let mut heartbeat = Instant::now();
        owner_input(&store, &execution, "running").await;
        let turn = execution
            .next(&mut shutdown, &mut heartbeat)
            .await
            .unwrap()
            .unwrap();
        let follow_up = owner_input(&store, &execution, "behind-the-turn").await;
        if held {
            holds.hold(&conversation);
        }
        // A window deadline (or shutdown, or budget) cancels the running turn.
        let run = turn.provider().run.run_id.clone();
        execution
            .request_cancel_for(&run, "execution-window-work-deadline")
            .await
            .unwrap();
        let page = execution
            .store
            .held_owner_inputs_authenticated(TOKEN, &conversation, 0, 10)
            .await
            .unwrap();
        let follow_up_held = page
            .held
            .iter()
            .any(|input| input.message_id == follow_up.message_id);
        assert_eq!(follow_up_held, !held, "held={held}");
        execution.store.close().await;
        drop(execution);
        std::fs::remove_dir_all(root).unwrap();
    }
}
