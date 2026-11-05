use super::*;
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
#[test]
fn preferences_are_typed_provider_scoped_data() {
    let (provider, _) = UnixStream::pair().unwrap();
    let mut transfer = prepare(
        Configuration {
            role: "claude".into(),
        },
        &provider,
    )
    .unwrap()
    .transfer;
    transfer
        .set_preferences((Some("synthetic-model".into()), Some("low".into())))
        .unwrap();
    assert_eq!(
        transfer.preferences(),
        serde_json::json!({"model":"synthetic-model","effort":"low"})
    );
    assert!(transfer
        .set_preferences((Some("--config=/other".into()), None))
        .is_err());
    assert!(transfer
        .set_preferences((None, Some("unbounded".into())))
        .is_err());
    let mut other = prepare(
        Configuration {
            role: "deep".into(),
        },
        &provider,
    )
    .unwrap()
    .transfer;
    assert!(other
        .set_preferences((Some("synthetic-model".into()), None))
        .is_err());
    other.set_preferences((None, None)).unwrap();
}
#[test]
fn setup_fence_comes_from_bound_metadata_and_cannot_change_provider_role_or_repeat() {
    use orkestr_v2_application::runtime::{Binding, ProviderKind, Role, SessionState};
    use orkestr_v2_contracts::{ConversationId, OwnerId, SessionId};
    let id = "\"11111111-1111-4111-8111-111111111111\"";
    let mut binding = Binding {
        owner_id: serde_json::from_str::<OwnerId>(id).unwrap(),
        conversation_id: serde_json::from_str::<ConversationId>(id).unwrap(),
        session_id: serde_json::from_str::<SessionId>(id).unwrap(),
        role: Role::Worker,
        provider_kind: ProviderKind::Unconfigured,
        native_session_id: None,
        parent_session_id: None,
        generation: 7,
        state: SessionState::Starting,
    };
    let (provider, _) = UnixStream::pair().unwrap();
    let mut transfer = prepare(
        Configuration {
            role: "worker-0".into(),
        },
        &provider,
    )
    .unwrap()
    .transfer;
    assert!(transfer.setup().is_err());
    transfer.set_workspace_worker(true).unwrap();
    assert!(transfer.workspace_worker());
    binding.role = Role::Deep;
    assert!(transfer
        .attest_setup(
            &binding,
            "synthetic-core-incarnation",
            ProviderKind::Codex,
            None
        )
        .is_err());
    binding.role = Role::Worker;
    transfer
        .attest_setup(
            &binding,
            "synthetic-core-incarnation",
            ProviderKind::Codex,
            None,
        )
        .unwrap();
    assert!(transfer.set_workspace_worker(false).is_err());
    assert_eq!(transfer.setup().unwrap()["generation"], 7);
    assert_eq!(
        transfer.setup().unwrap()["session_id"],
        "11111111-1111-4111-8111-111111111111"
    );
    assert!(transfer
        .attest_setup(&binding, "invented-retry", ProviderKind::Codex, None)
        .is_err());
}

#[test]
fn managed_workspace_worker_marker_cannot_enable_other_native_roles() {
    let (provider, _) = UnixStream::pair().unwrap();
    for role in ["deep", "fast", "claude"] {
        let mut transfer = prepare(Configuration { role: role.into() }, &provider)
            .unwrap()
            .transfer;
        assert!(!transfer.workspace_worker());
        assert!(transfer.set_workspace_worker(true).is_err());
    }
}
#[test]
fn prepared_transfer_has_distinct_one_way_pipes_and_private_lifecycle_socket() {
    let (provider, _peer) = UnixStream::pair().unwrap();
    let prepared = prepare(
        Configuration {
            role: "deep".into(),
        },
        &provider,
    )
    .unwrap();
    assert_eq!(prepared.transfer.role(), "deep");
    assert_eq!(prepared.transfer.descriptors().len(), 4);
    let mut input = File::from(prepared.input);
    let mut child_input = File::from(prepared.child_input);
    input.write_all(b"input").unwrap();
    let mut bytes = [0; 5];
    child_input.read_exact(&mut bytes).unwrap();
    assert_eq!(&bytes, b"input");
    let mut output = File::from(prepared.output);
    let mut child_output = File::from(prepared.child_output);
    child_output.write_all(b"output").unwrap();
    let mut bytes = [0; 6];
    output.read_exact(&mut bytes).unwrap();
    assert_eq!(&bytes, b"output");
    let mut manager = UnixStream::from(prepared.transfer.descriptors[3].try_clone().unwrap());
    let mut lifecycle = prepared.lifecycle;
    manager.write_all(b"exit:0\n").unwrap();
    let mut bytes = [0; 7];
    lifecycle.read_exact(&mut bytes).unwrap();
    assert_eq!(&bytes, b"exit:0\n");
    let unique: std::collections::HashSet<_> = prepared
        .transfer
        .descriptors
        .iter()
        .map(AsRawFd::as_raw_fd)
        .collect();
    assert_eq!(unique.len(), 4);
}

#[test]
fn resume_attests_only_exact_ready_role_native_and_provider_with_fifth_descriptor() {
    use orkestr_v2_application::runtime::{Binding, ProviderKind, Role, SessionState};
    use orkestr_v2_contracts::{ConversationId, OwnerId, SessionId};
    let id = "\"11111111-1111-4111-8111-111111111111\"";
    let mut binding = Binding {
        owner_id: serde_json::from_str::<OwnerId>(id).unwrap(),
        conversation_id: serde_json::from_str::<ConversationId>(id).unwrap(),
        session_id: serde_json::from_str::<SessionId>(id).unwrap(),
        role: Role::Deep,
        provider_kind: ProviderKind::Codex,
        native_session_id: Some("synthetic-resumed-native".into()),
        parent_session_id: None,
        generation: 7,
        state: SessionState::Ready,
    };
    let (provider, _) = UnixStream::pair().unwrap();
    let (bootstrap, _) = UnixStream::pair().unwrap();
    let mut transfer = prepare(
        Configuration {
            role: "deep".into(),
        },
        &provider,
    )
    .unwrap()
    .transfer;
    assert!(transfer
        .attest_setup(
            &binding,
            "synthetic-incarnation",
            ProviderKind::Codex,
            Some("22222222-2222-4222-8222-222222222222")
        )
        .is_err());
    transfer.attach_resume(&bootstrap).unwrap();
    assert_eq!(transfer.mode(), "resume");
    assert_eq!(transfer.descriptors().len(), 5);
    assert!(transfer.attach_resume(&bootstrap).is_err());
    assert!(transfer
        .attest_setup(
            &binding,
            "synthetic-incarnation",
            ProviderKind::Claude,
            Some("22222222-2222-4222-8222-222222222222")
        )
        .is_err());
    binding.state = SessionState::Starting;
    assert!(transfer
        .attest_setup(
            &binding,
            "synthetic-incarnation",
            ProviderKind::Codex,
            Some("22222222-2222-4222-8222-222222222222")
        )
        .is_err());
    binding.state = SessionState::Ready;
    transfer
        .attest_setup(
            &binding,
            "synthetic-incarnation",
            ProviderKind::Codex,
            Some("22222222-2222-4222-8222-222222222222"),
        )
        .unwrap();
    assert_eq!(
        transfer.setup().unwrap()["native_session_id"],
        "synthetic-resumed-native"
    );
    assert_eq!(transfer.setup().unwrap()["generation"], 7);
    assert!(transfer
        .attest_setup(
            &binding,
            "synthetic-incarnation",
            ProviderKind::Codex,
            Some("22222222-2222-4222-8222-222222222222")
        )
        .is_err());
    let mut worker = prepare(
        Configuration {
            role: "worker-0".into(),
        },
        &provider,
    )
    .unwrap()
    .transfer;
    assert!(worker.attach_resume(&bootstrap).is_err());
}
