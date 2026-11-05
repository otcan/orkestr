//! Actual local HTTP + real Core transactions; native observations are synthetic
//! protocol fixtures. No business provider/process/network is used.
use super::*;
use crate::conversation_resources_http::tests::{case, send};
use orkestr_v2_application::runtime::*;
use orkestr_v2_store_sqlite::{ClaudeProcessInitialization, ExecutionConsumption};

#[tokio::test]
async fn operator_policy_http_steering_preserves_input_and_inherits_short_continuation_scope() {
    let mut case = case().await;
    let auth = case.auth();
    use sha2::Digest;
    let cookie = format!("Cookie: orkestr_v2_session={}", case.cookie);
    let csrf = format!(
        "X-Orkestr-Csrf: {:x}",
        sha2::Sha256::digest(format!("orkestr-v2-browser-csrf-v1:{}", case.cookie).as_bytes())
    );
    let origin = "Origin: http://127.0.0.1:19882";
    let owner = case
        .state
        .store
        .credentials("synthetic-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    let handle = case
        .state
        .store
        .authorize_supervisor(
            &case.bearer,
            ProductionSupervisorConfig {
                provider: ProviderKind::Claude,
                namespace: "synthetic-policy-claude".into(),
                supervisor_key: "synthetic-controller".into(),
                takeover: ProductionTakeover::First,
            },
        )
        .await
        .unwrap();
    let binding = handle
        .ensure_role_bindings(&owner, &case.conversation)
        .await
        .unwrap()
        .deep;
    let grant = handle.authorize_session_metadata(&binding).await.unwrap();
    let native = Uuid::new_v4().to_string();
    let link = handle
        .initialize_claude_session(
            grant,
            ClaudeProcessInitialization {
                requested_native_session_id: native.clone(),
                protocol_version: "claude-control-v1".into(),
                source_event_key: "synthetic-initialize".into(),
            },
        )
        .await
        .unwrap();
    let binding = link.binding().clone();
    let original = serde_json::json!({"client_message_id":"synthetic-policy-original","text":"Synthetic original work","author":"v1_agent"});
    assert_eq!(
        send(
            &case.state,
            "POST",
            &case.path("/messages"),
            &[&auth],
            &original.to_string()
        )
        .await
        .0,
        202
    );
    let claim = handle
        .claim_next(
            &owner,
            &case.conversation,
            &binding.session_id,
            std::time::Duration::from_secs(60),
        )
        .await
        .unwrap()
        .unwrap();
    let admitted = handle
        .admit_run(
            &claim,
            &binding.session_id,
            binding.generation,
            "synthetic-policy-run",
        )
        .await
        .unwrap();
    let DispatchClaimResult::Reserved(reservation) = handle
        .claim_provider_dispatch(&admitted, "synthetic-policy-dispatch")
        .await
        .unwrap()
    else {
        panic!("no dispatch");
    };
    let ExecutionConsumption::Dispatch(capability) =
        handle.consume_execution(&reservation).await.unwrap()
    else {
        panic!("no capability");
    };
    let provider = capability.provider();
    handle
        .observe_claude_session(provider, &native, "synthetic-observation")
        .await
        .unwrap();
    handle
        .append_provider_event(
            &owner,
            provider,
            &ProviderEventInput {
                run_id: provider.run.run_id.clone(),
                session_id: binding.session_id.clone(),
                sequence: 1,
                lease_generation: provider.run.lease_generation,
                dispatch_fence: provider.run.dispatch_fence,
                event: ProviderEvent::Started,
            },
        )
        .await
        .unwrap();
    let status = handle
        .execution_run_status(
            &case.bearer,
            &owner,
            &case.conversation,
            &provider.run.run_id,
        )
        .await
        .unwrap()
        .unwrap();
    let policy:crate::beta_config::provider_routing::ProviderRouting=serde_json::from_value(serde_json::json!({"allow_native_handoff":true,"rules":[{"id":"synthetic-category","terms":[{"text":"cedar","weight":3}],"threshold":3,"excluded":"claude","preferred":"codex"}]})).unwrap();
    case.state.provider_policy = Some(policy.clone());
    case.state = case
        .state
        .clone()
        .with_execution_store(owner.clone(), case.conversation.clone(), handle.clone())
        .unwrap();
    let body = serde_json::json!({"control":{"run_id":provider.run.run_id,"expected_revision":status.revision,"expected_control_revision":status.control_revision,"request_key":"synthetic-policy-steer"},"text":"Synthetic cedar work"});
    let path = case.path("/steer");
    assert_eq!(
        send(&case.state, "POST", &path, &[], &body.to_string())
            .await
            .0,
        401
    );
    let (code, receipt) = send(
        &case.state,
        "POST",
        &path,
        &[&cookie, &csrf, origin],
        &body.to_string(),
    )
    .await;
    assert_eq!(code, 200, "{receipt}");
    assert_eq!(receipt["disposition"], "queued_unsupported");
    let id: orkestr_v2_contracts::MessageId =
        serde_json::from_value(receipt["message_id"].clone()).unwrap();
    let pending = case
        .state
        .store
        .prospective_provider_input(&owner, &case.conversation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(pending.0, id);
    assert_eq!(pending.1, "Synthetic cedar work");
    let (target, rules) = crate::provider_policy::select(
        &case.state.store,
        &policy,
        &owner,
        &case.conversation,
        "continue",
        orkestr_v2_contracts::ConversationProvider::Claude,
    )
    .await
    .unwrap();
    assert_eq!(target, orkestr_v2_contracts::ConversationProvider::Codex);
    assert_eq!(rules, vec!["synthetic-category"]);
    let other = case
        .state
        .store
        .create_conversation_authenticated(
            &case.bearer,
            &orkestr_v2_contracts::ConversationInput {
                client_request_id: "synthetic-policy-other".into(),
                name: "Synthetic unrelated conversation".into(),
            },
        )
        .await
        .unwrap()
        .0
        .conversation_id;
    let (other_target, other_rules) = crate::provider_policy::select(
        &case.state.store,
        &policy,
        &owner,
        &other,
        "continue",
        orkestr_v2_contracts::ConversationProvider::Claude,
    )
    .await
    .unwrap();
    assert_eq!(
        other_target,
        orkestr_v2_contracts::ConversationProvider::Claude
    );
    assert!(other_rules.is_empty());
    let requests = case
        .state
        .store
        .pending_policy_steering_authenticated(&case.bearer, &owner)
        .await
        .unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].message_id, id);
    let request = case
        .state
        .store
        .policy_steering_window_request(&case.bearer, &owner, &requests[0])
        .await
        .unwrap();
    assert_eq!(request.input_message_id, id);
    assert!(request.input_request_key.starts_with("steering:"));
    let (code, replay) = send(
        &case.state,
        "POST",
        &path,
        &[&cookie, &csrf, origin],
        &body.to_string(),
    )
    .await;
    assert_eq!(code, 200);
    assert_eq!(receipt, replay);
    let after = handle
        .execution_run_status(
            &case.bearer,
            &owner,
            &case.conversation,
            &provider.run.run_id,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(after.phase, orkestr_v2_contracts::ExecutionPhase::Running);
    case.finish().await;
}

#[tokio::test]
async fn operator_policy_http_fresh_window_routes_before_any_native_process() {
    let mut case = case().await;
    let auth = case.auth();
    use sha2::Digest;
    let cookie = format!("Cookie: orkestr_v2_session={}", case.cookie);
    let csrf = format!(
        "X-Orkestr-Csrf: {:x}",
        sha2::Sha256::digest(format!("orkestr-v2-browser-csrf-v1:{}", case.cookie).as_bytes())
    );
    let origin = "Origin: http://127.0.0.1:19882";
    let owner = case
        .state
        .store
        .credentials("synthetic-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    let config:crate::beta_config::BetaConfig=serde_json::from_value(serde_json::json!({
        "schema_version":1,"owner_id":owner,"conversation_id":case.conversation,
        "manager_socket":case.root.join("absent-manager.sock"),"launcher":"/opt/synthetic/codex-launcher",
        "launcher_sha256":"a".repeat(64),"workspace":"/srv/synthetic/workspace",
        "namespace":"synthetic-policy","supervisor_key":"synthetic-supervisor",
        "claude":{"launcher":"/opt/synthetic/claude-launcher","launcher_sha256":"b".repeat(64),"workspace":"/srv/synthetic/claude","default":true},
        "provider_routing":{"rules":[{"id":"synthetic-category","terms":[{"text":"cedar","weight":3}],"threshold":3,"excluded":"claude","preferred":"codex"}]}
    })).unwrap();
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
    case.state = case
        .state
        .clone()
        .with_beta_config(&config, &case.root, parent)
        .unwrap();
    let body = serde_json::json!({"client_message_id":"synthetic-policy-direct","text":"Synthetic cedar task","author":"v1_agent"});
    let (status, input) = send(
        &case.state,
        "POST",
        &case.path("/messages"),
        &[&auth],
        &body.to_string(),
    )
    .await;
    assert_eq!(status, 202);
    let request = serde_json::json!({"request_key":"synthetic-policy-window","input_message_id":input["message_id"],"input_event_id":input["event_id"],"input_request_key":"synthetic-policy-direct","expected_generation":0,"window_id":null,"predecessor_window_id":null});
    assert_eq!(
        send(
            &case.state,
            "POST",
            &case.path("/window"),
            &[],
            &request.to_string()
        )
        .await
        .0,
        401
    );
    let (status, _) = send(
        &case.state,
        "POST",
        &case.path("/window"),
        &[&cookie, &csrf, origin],
        &request.to_string(),
    )
    .await;
    assert_eq!(
        status, 503,
        "missing synthetic manager must prevent native launch"
    );
    let settings = case
        .state
        .store
        .conversation_settings(&case.bearer, &owner, &case.conversation)
        .await
        .unwrap();
    assert_eq!(
        settings.provider,
        orkestr_v2_contracts::ConversationProvider::Codex
    );
    assert_eq!(
        case.state
            .store
            .conversation_provider_policy_rules(&owner, &case.conversation)
            .await
            .unwrap(),
        vec!["synthetic-category"]
    );
    let pending = case
        .state
        .store
        .prospective_provider_input(&owner, &case.conversation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(pending.1, "Synthetic cedar task");
    assert!(case
        .state
        .store
        .execution_status(&owner, &case.conversation)
        .await
        .unwrap()
        .and_then(|status| status.run_id)
        .is_none());
    if let Some(controller) = &case.state.window_controller {
        let _ = controller.shutdown().await;
    }
    case.finish().await;
}
