//! ORK-795 through the actual Deep input loop against an isolated Store; no
//! provider runs. One owner turn and host results handed back to it, then an
//! owner follow-up. A handback whose source session moved on is fenced for
//! good. That used to end the loop with "execution admission refused", which
//! aborts the execution window and releases the follow-up. ORK-843: only a
//! turn that did not continue the same source turn moves it on; a later
//! result that only follows the first result's turn still runs.
//! (The second result is too large to join the first one's continuation
//! turn; a smaller one would be answered in that same turn, ORK-783.)
use super::*;
use orkestr_v2_application::runtime::{
    NativeSessionConfirmation, ProviderAdmission, ProviderEvent, ProviderEventInput, RuntimeStore,
};
use orkestr_v2_application::IntakeStore;
use orkestr_v2_contracts::{ExecutionAcceptanceRequest, InputAuthor, MessageInput};
use std::path::PathBuf;

const TOKEN: &str = "abababababababababababababababababababababababababababababababab";

async fn execution() -> (ConfiguredExecution, Store, PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let root = std::env::temp_dir().join(format!("superseded-source-{}", uuid::Uuid::new_v4()));
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
        namespace: "synthetic-deep".into(),
        supervisor_key: "synthetic-deep".into(),
        provider: config::Provider::Codex,
        role: config::ExecutionRole::Deep,
        execution_budget: Default::default(),
        worker: None,
        provider_routing: None,
    };
    let execution = ConfiguredExecution::from_config(&store, &root, config, false)
        .await
        .unwrap();
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
            native_session_id: "synthetic-native-deep".into(),
            protocol_version: "codex-rpc-1".into(),
            source_event_key: "thread-ready:1".into(),
        })
        .await
        .unwrap();
    (execution, store, root)
}

/// The run proposes an answer and the owner accepts it.
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

/// A host result handed back to `run` while it runs; `large` is too large to
/// join another result's continuation turn.
async fn hand_back(
    store: &Store,
    execution: &ConfiguredExecution,
    run: &ProviderAdmission,
    n: usize,
    large: bool,
) -> orkestr_v2_contracts::Receipt {
    store
        .admit_authenticated_attributed(
            TOKEN,
            &execution.owner,
            &execution.config.conversation_id,
            &MessageInput {
                client_message_id: format!("automatic-host-result-synthetic-{n}"),
                text: format!("Synthetic host result {n} ").repeat(if large { 1024 } else { 1 }),
            },
            None,
            Some(0),
            Some(&run.run.run_id),
            Some(InputAuthor::V1Agent),
            None,
        )
        .await
        .unwrap()
        .receipt
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
async fn a_later_handback_of_the_same_turn_runs_after_the_first_one() {
    let (execution, store, root) = execution().await;
    let (_sender, mut shutdown) = watch::channel(false);
    let mut heartbeat = Instant::now();
    owner_input(&store, &execution, "owner-turn").await;
    let turn = execution
        .next(&mut shutdown, &mut heartbeat)
        .await
        .unwrap()
        .unwrap()
        .provider()
        .clone();
    // While that turn runs, two host results are handed back to it.
    let first = hand_back(&store, &execution, &turn, 1, false).await;
    let second = hand_back(&store, &execution, &turn, 2, true).await;
    let follow_up = owner_input(&store, &execution, "owner-follow-up").await;
    accept(&execution, &store, &turn).await;

    let handback = execution
        .next(&mut shutdown, &mut heartbeat)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(handback.message_id(), &first.message_id);
    accept(&execution, &store, handback.provider()).await;

    // ORK-843: that turn only continued the source turn; the second result runs next.
    let late = execution
        .next(&mut shutdown, &mut heartbeat)
        .await
        .unwrap()
        .expect("the second result is not superseded by the first one's turn");
    assert_eq!(late.message_id(), &second.message_id);
    accept(&execution, &store, late.provider()).await;

    let next = execution
        .next(&mut shutdown, &mut heartbeat)
        .await
        .unwrap()
        .expect("the owner follow-up is the next input");
    assert_eq!(next.message_id(), &follow_up.message_id);
    execution.store.close().await;
    drop(execution);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_superseded_handback_does_not_end_the_loop_and_the_follow_up_runs() {
    let (execution, store, root) = execution().await;
    let (_sender, mut shutdown) = watch::channel(false);
    let mut heartbeat = Instant::now();
    owner_input(&store, &execution, "owner-turn").await;
    let turn = execution
        .next(&mut shutdown, &mut heartbeat)
        .await
        .unwrap()
        .unwrap()
        .provider()
        .clone();
    // While that turn runs: a host result, an owner message, a second (large)
    // host result and another owner message.
    let first = hand_back(&store, &execution, &turn, 1, false).await;
    let between = owner_input(&store, &execution, "owner-between").await;
    let second = hand_back(&store, &execution, &turn, 2, true).await;
    let follow_up = owner_input(&store, &execution, "owner-follow-up").await;
    accept(&execution, &store, &turn).await;

    // The first handback still passes its fence and becomes its own turn.
    let handback = execution
        .next(&mut shutdown, &mut heartbeat)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(handback.message_id(), &first.message_id);
    accept(&execution, &store, handback.provider()).await;
    // Then the owner's message: the source session moved on.
    let owner_turn = execution
        .next(&mut shutdown, &mut heartbeat)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(owner_turn.message_id(), &between.message_id);
    accept(&execution, &store, owner_turn.provider()).await;

    // The second can never run. The loop goes on and takes the follow-up.
    let next = execution
        .next(&mut shutdown, &mut heartbeat)
        .await
        .expect("a superseded handback must not end the execution loop")
        .expect("the owner follow-up is the next input");
    assert_eq!(next.message_id(), &follow_up.message_id);
    assert_ne!(next.message_id(), &second.message_id);
    execution.store.close().await;
    drop(execution);
    std::fs::remove_dir_all(root).unwrap();
}

/// ORK-783: the same turn with two ordinary-sized results. Both are answered
/// by one continuation turn (which may stay silent, NO_REPLY), so no second
/// result turn runs and nothing is retired unseen; the follow-up is next.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn results_of_one_turn_share_one_continuation_and_the_follow_up_runs() {
    let (execution, store, root) = execution().await;
    let owner = execution.owner.clone();
    let conversation = execution.config.conversation_id.clone();
    let (_sender, mut shutdown) = watch::channel(false);
    let mut heartbeat = Instant::now();
    let message = |key: &str, text: &str| MessageInput {
        client_message_id: key.into(),
        text: text.into(),
    };
    store
        .admit(
            &owner,
            &conversation,
            &message("owner-turn", "Synthetic owner turn"),
        )
        .await
        .unwrap();
    let turn = execution
        .next(&mut shutdown, &mut heartbeat)
        .await
        .unwrap()
        .unwrap()
        .provider()
        .clone();
    let mut results = Vec::new();
    for n in 1..=2 {
        results.push(
            store
                .admit_authenticated_attributed(
                    TOKEN,
                    &owner,
                    &conversation,
                    &message(
                        &format!("automatic-host-result-synthetic-{n}"),
                        &format!("Synthetic host result {n}"),
                    ),
                    None,
                    Some(0),
                    Some(&turn.run.run_id),
                    Some(InputAuthor::V1Agent),
                    None,
                )
                .await
                .unwrap()
                .receipt,
        );
    }
    let follow_up = store
        .admit(
            &owner,
            &conversation,
            &message("owner-follow-up", "Synthetic owner follow-up"),
        )
        .await
        .unwrap()
        .receipt;
    accept(&execution, &store, &turn).await;

    let continuation = execution
        .next(&mut shutdown, &mut heartbeat)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(continuation.message_id(), &results[0].message_id);
    assert!(continuation
        .text()
        .starts_with("[Automatic results: 2 result(s) "));
    let group = store
        .deep_run_group_authenticated(
            TOKEN,
            &owner,
            &conversation,
            &continuation.provider().run.run_id,
        )
        .await
        .unwrap();
    assert_eq!(
        group
            .iter()
            .map(|(message, _, _)| message.clone())
            .collect::<Vec<_>>(),
        vec![results[0].message_id.clone(), results[1].message_id.clone()]
    );
    accept(&execution, &store, continuation.provider()).await;

    let next = execution
        .next(&mut shutdown, &mut heartbeat)
        .await
        .unwrap()
        .expect("the owner follow-up is the next input");
    assert_eq!(next.message_id(), &follow_up.message_id);
    execution.store.close().await;
    drop(execution);
    std::fs::remove_dir_all(root).unwrap();
}
