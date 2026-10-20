//! Real Core lifecycle fixture; native evidence is modeled, never provider proof.
use super::*;
use crate::window_runtime::handles::{Generation, Handles};
use crate::{control_registry::ControlRegistry, execution_registry::ExecutionScope};
use orkestr_v2_application::{runtime::*, IntakeStore};
use orkestr_v2_store_sqlite::ExecutionConsumption;
use std::time::Duration;

pub(crate) const COOKIE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
pub(crate) const AUTHORITY: &str = "synthetic.example:19880";
pub(crate) fn state(store: Store) -> AppState {
    AppState::new(
        store,
        "synthetic-bootstrap-not-a-deployed-secret".into(),
        format!("http://{AUTHORITY}"),
    )
    .unwrap()
}

pub(crate) struct Temporary(pub std::path::PathBuf);
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
pub(crate) struct Case {
    pub root: Temporary,
    pub state: AppState,
    pub owner: OwnerId,
    pub conversation: ConversationId,
    pub expected: HeldOwnerInputPage,
}

fn event(p: &ProviderAdmission, sequence: u64, event: ProviderEvent) -> ProviderEventInput {
    ProviderEventInput {
        run_id: p.run.run_id.clone(),
        session_id: p.run.session_id.clone(),
        sequence,
        lease_generation: p.run.lease_generation,
        dispatch_fence: p.run.dispatch_fence,
        event,
    }
}

pub(crate) async fn retired() -> Case {
    let root = Temporary(std::env::temp_dir().join(format!("held-owner-http-{}", Uuid::new_v4())));
    std::fs::create_dir(&root.0).unwrap();
    let store = Store::open(&root.0.join("core.sqlite3")).await.unwrap();
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
    let browser = format!("browser:{COOKIE}");
    store.save_session(&browser, &owner).await.unwrap();
    let machine = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    store.save_session(machine, &owner).await.unwrap();
    let supervisor = store
        .authorize_supervisor(
            machine,
            ProductionSupervisorConfig {
                provider: ProviderKind::Codex,
                namespace: "synthetic-held-fixture".into(),
                supervisor_key: "synthetic-supervisor".into(),
                takeover: ProductionTakeover::First,
            },
        )
        .await
        .unwrap();
    let binding = supervisor
        .ensure_role_bindings(&owner, &conversation)
        .await
        .unwrap()
        .deep;
    let binding = supervisor
        .confirm_native_session(NativeSessionConfirmation {
            session_id: binding.session_id,
            expected_generation: binding.generation,
            native_session_id: "synthetic-held-native".into(),
            protocol_version: "synthetic-1".into(),
            source_event_key: "synthetic-ready".into(),
        })
        .await
        .unwrap();
    let first = store
        .admit(
            &owner,
            &conversation,
            &MessageInput {
                client_message_id: "first-window-input".into(),
                text: "synthetic first input".into(),
            },
        )
        .await
        .unwrap()
        .receipt;
    let window = store
        .admit_execution_window_authenticated(
            &browser,
            &conversation,
            &ExecutionWindowRequest {
                request_key: "first-window".into(),
                input_message_id: first.message_id,
                input_event_id: first.event_id,
                input_request_key: "first-window-input".into(),
                expected_generation: 0,
                window_id: None,
                predecessor_window_id: None,
            },
        )
        .await
        .unwrap()
        .status;
    let cap = supervisor
        .issue_execution_window_credential(
            machine,
            window.window_id,
            window.generation,
            "synthetic-boot",
            window.expires_at_ms,
            &"e".repeat(64),
        )
        .await
        .unwrap();
    let bound = supervisor
        .bind_execution_window(machine, &cap)
        .await
        .unwrap();
    bound
        .activate_execution_window(
            cap.credential(),
            window.window_id,
            window.generation,
            "synthetic-boot",
        )
        .await
        .unwrap();
    let handles = Handles::new(owner.clone(), conversation.clone()).unwrap();
    let generation = Generation {
        window: window.window_id,
        number: window.generation,
    };
    handles
        .install(
            generation,
            ExecutionScope {
                store: bound.clone(),
                control: Some(ControlRegistry::new(owner.clone(), conversation.clone())),
                tasks: None,
            },
        )
        .unwrap();
    let mut state = state(store);
    state.window_handles = Some(handles.clone());
    assert!(state
        .execution_scope(&owner, &conversation)
        .await
        .unwrap_or_else(|_| panic!("scope read refused"))
        .is_some());
    let claim = bound
        .claim_next(
            &owner,
            &conversation,
            &binding.session_id,
            Duration::from_secs(30),
        )
        .await
        .unwrap()
        .unwrap();
    let run = bound
        .admit_run(
            &claim,
            &binding.session_id,
            binding.generation,
            "held-window-run",
        )
        .await
        .unwrap();
    let DispatchClaimResult::Reserved(reservation) = bound
        .claim_provider_dispatch(&run, "held-window-dispatch")
        .await
        .unwrap()
    else {
        panic!("dispatch reservation refused")
    };
    let ExecutionConsumption::Dispatch(dispatch) =
        bound.consume_execution(&reservation).await.unwrap()
    else {
        panic!("dispatch consumption refused")
    };
    let p = dispatch.provider();
    bound
        .append_provider_event(&owner, p, &event(p, 1, ProviderEvent::Started))
        .await
        .unwrap();
    let old = state
        .store
        .admit(
            &owner,
            &conversation,
            &MessageInput {
                client_message_id: "pre-stop-held".into(),
                text: "synthetic old queued input".into(),
            },
        )
        .await
        .unwrap()
        .receipt;
    let cancel = bound
        .request_cancel(&owner, &p.run.run_id, "stop-window")
        .await
        .unwrap();
    let mut stopped = p.clone();
    stopped.run = cancel.new_fenced_admission;
    bound
        .append_provider_event(
            &owner,
            &stopped,
            &event(&stopped, 2, ProviderEvent::Stopped),
        )
        .await
        .unwrap();
    let expected = bound
        .held_owner_inputs_authenticated(&browser, &conversation, 0, 50)
        .await
        .unwrap();
    assert_eq!(expected.held.len(), 1);
    assert_eq!(expected.held[0].message_id, old.message_id);
    assert_eq!(expected.held[0].source_event_id, old.event_id);
    assert_eq!(expected.held[0].scope_sequence, old.sequence);
    assert_eq!(expected.held[0].boundary_run_id, p.run.run_id);
    bound
        .begin_execution_window_retirement(
            cap.credential(),
            window.window_id,
            window.generation,
            "synthetic-boot",
        )
        .await
        .unwrap();
    // Trusted Core teardown MODELS original Runtime reap. No provider is run.
    bound
        .retire_terminal_supervisor(cap.credential(), &p.run.run_id)
        .await
        .unwrap();
    let (_, retirement) = bound
        .retire_execution_window(
            cap.credential(),
            window.window_id,
            window.generation,
            "synthetic-boot",
            &p.run.run_id,
        )
        .await
        .unwrap();
    assert_eq!(retirement.outcome(), "stopped");
    handles.remove(generation).unwrap();
    assert!(state
        .execution_scope(&owner, &conversation)
        .await
        .unwrap_or_else(|_| panic!("scope read refused"))
        .is_none());
    assert!(bound
        .held_owner_inputs_authenticated(&browser, &conversation, 0, 50)
        .await
        .is_err());
    assert_eq!(
        state
            .store
            .execution_window_status_authenticated(&browser, &conversation)
            .await
            .unwrap()
            .unwrap()
            .state,
        ExecutionWindowState::Closed
    );
    Case {
        root,
        state,
        owner,
        conversation,
        expected,
    }
}

pub(crate) fn headers(cookie: Option<&str>, host: &str) -> HeaderMap {
    let mut h = HeaderMap::new();
    h.insert("host", host.parse().unwrap());
    if let Some(cookie) = cookie {
        h.insert(
            "cookie",
            format!("orkestr_v2_session={cookie}").parse().unwrap(),
        );
    }
    h
}
pub(crate) async fn request(
    state: &AppState,
    id: &str,
    query: &str,
    headers: HeaderMap,
) -> Response {
    let uri: axum::http::Uri = format!("/api/v2/conversations/{id}/held-inputs{query}")
        .parse()
        .unwrap();
    read(
        State(state.clone()),
        headers,
        Path(id.to_owned()),
        Query::try_from_uri(&uri),
    )
    .await
    .unwrap_or_else(IntoResponse::into_response)
}
pub(crate) async fn page(state: &AppState, conversation: &ConversationId) -> HeldOwnerInputPage {
    let response = request(
        state,
        &conversation.to_string(),
        "",
        headers(Some(COOKIE), AUTHORITY),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), 16_384)
            .await
            .unwrap(),
    )
    .unwrap()
}
