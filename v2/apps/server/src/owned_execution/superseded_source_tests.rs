//! ORK-795 through the actual Deep input loop against an isolated Store; no
//! provider runs. One owner turn, two host results handed back to it, then an
//! owner follow-up. The first handback runs as its own turn, so the second is
//! fenced for good. That used to end the loop with "execution admission
//! refused", which aborts the execution window and releases the follow-up.
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_superseded_handback_does_not_end_the_loop_and_the_follow_up_runs() {
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
    // While that turn runs, two host results are handed back to it.
    let mut handbacks = Vec::new();
    for n in 1..=2 {
        handbacks.push(
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

    // The first handback still passes its fence and becomes its own turn.
    let first = execution
        .next(&mut shutdown, &mut heartbeat)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(first.message_id(), &handbacks[0].message_id);
    accept(&execution, &store, first.provider()).await;

    // The second can never run. The loop goes on and takes the follow-up.
    let next = execution
        .next(&mut shutdown, &mut heartbeat)
        .await
        .expect("a superseded handback must not end the execution loop")
        .expect("the owner follow-up is the next input");
    assert_eq!(next.message_id(), &follow_up.message_id);
    assert_ne!(next.message_id(), &handbacks[1].message_id);
    execution.store.close().await;
    drop(execution);
    std::fs::remove_dir_all(root).unwrap();
}
