//! ORK-794: every conversation has its agent grant, web-created ones
//! included, and an older one without it gets it with its next input.
//! ORK-804: the local-files grant is issued beside it the same way, and a
//! stale installed file is replaced.
use super::*;
use crate::conversation_resources_http::tests::{case, send, Case};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    Json,
};
use orkestr_v2_contracts::{ConversationInput, ConversationSummary};
use sha2::{Digest, Sha256};
use std::sync::Arc;

/// Agent grants on, as on a host with `agent_timers` configured.
fn configure(case: &mut Case) -> std::path::PathBuf {
    let rules = case.root.join("rules");
    std::fs::create_dir(&rules).unwrap();
    let grants = case.root.join("grants");
    case.state.whatsapp_chats = Some(Arc::new(
        chats::synthetic("http://127.0.0.1:1", &"a".repeat(32))
            .with_rules_dir(rules.to_str().unwrap())
            .with_agent_timers(grants.to_str().unwrap()),
    ));
    grants
}

async fn owner(case: &Case) -> OwnerId {
    case.state
        .store
        .credentials("synthetic-owner")
        .await
        .unwrap()
        .unwrap()
        .0
}

async fn grant(case: &Case, conversation: &ConversationId) -> (bool, i64) {
    let owner = owner(case).await;
    let grant = case
        .state
        .store
        .agent_timer_grant(&case.bearer, &owner, conversation)
        .await
        .unwrap();
    (grant.issued, grant.generation)
}

/// The installed file is the conversation's current grant: the agent route
/// knows it (no Deep turn runs here, hence that refusal rather than 401).
async fn authenticates(case: &Case, conversation: &ConversationId, value: &str) -> bool {
    match case
        .state
        .store
        .agent_timers(value.trim(), conversation)
        .await
    {
        Err(ResourceError::Conflict("agent_timer_no_running_turn")) => true,
        Err(ResourceError::Unauthorized) => false,
        other => panic!("unexpected answer: {:?}", other.map(|_| ())),
    }
}

fn file(grants: &Path, conversation: &ConversationId) -> std::path::PathBuf {
    grants.join(format!("{conversation}.grant"))
}

fn local_file(grants: &Path, conversation: &ConversationId) -> std::path::PathBuf {
    grants.join(format!("{conversation}.local-files.grant"))
}

async fn local_grant(case: &Case, conversation: &ConversationId) -> (bool, i64) {
    let owner = owner(case).await;
    let grant = case
        .state
        .store
        .local_file_grant(&case.bearer, &owner, conversation)
        .await
        .unwrap();
    (grant.issued, grant.generation)
}

/// The installed local-files file is the conversation's current grant: the
/// agent's request lookup knows it (an unknown request, hence not found).
async fn local_authenticates(case: &Case, conversation: &ConversationId, value: &str) -> bool {
    match case
        .state
        .store
        .local_file_request(value.trim(), conversation, uuid::Uuid::new_v4())
        .await
    {
        Err(ResourceError::NotFound) => true,
        Err(ResourceError::Unauthorized) => false,
        other => panic!("unexpected answer: {:?}", other.map(|_| ())),
    }
}

fn browser(case: &Case) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert("host", "127.0.0.1:19882".parse().unwrap());
    headers.insert("origin", "http://127.0.0.1:19882".parse().unwrap());
    headers.insert(
        "cookie",
        format!("orkestr_v2_session={}", case.cookie)
            .parse()
            .unwrap(),
    );
    let csrf = Sha256::digest(format!("orkestr-v2-browser-csrf-v1:{}", case.cookie).as_bytes());
    headers.insert("x-orkestr-csrf", format!("{csrf:x}").parse().unwrap());
    headers
}

async fn message(case: &Case, key: &str) {
    let body = serde_json::json!({"client_message_id": key, "text": "Synthetic input"});
    let (status, value) = send(
        &case.state,
        "POST",
        &case.path("/messages"),
        &[&case.auth()],
        &body.to_string(),
    )
    .await;
    assert_eq!(status, 202, "{value}");
}

#[tokio::test]
async fn a_conversation_created_in_the_web_app_has_its_grant_from_the_start() {
    let mut case = case().await;
    let grants = configure(&mut case);
    let input = ConversationInput {
        client_request_id: "synthetic-web-conversation".into(),
        name: "Synthetic web conversation".into(),
    };
    let created = crate::conversations_http::create(
        State(case.state.clone()),
        browser(&case),
        Ok(Json(input.clone())),
    )
    .await
    .unwrap_or_else(|error| panic!("create refused: {}", error.2));
    assert_eq!(created.status(), StatusCode::CREATED);
    let created: ConversationSummary = serde_json::from_slice(
        &axum::body::to_bytes(created.into_body(), 8192)
            .await
            .unwrap(),
    )
    .unwrap();
    let id = created.conversation_id;
    let path = file(&grants, &id);
    assert!(chats::timer_grant_installed(&path), "installed at creation");
    let first = std::fs::read_to_string(&path).unwrap();
    assert!(authenticates(&case, &id, &first).await);
    assert_eq!(grant(&case, &id).await, (true, 1));
    // The local folder tool's own grant beside it (ORK-804), no operator step.
    let local = local_file(&grants, &id);
    assert!(
        chats::timer_grant_installed(&local),
        "installed at creation"
    );
    let local_first = std::fs::read_to_string(&local).unwrap();
    assert_ne!(local_first, first, "a separate grant");
    assert!(local_authenticates(&case, &id, &local_first).await);
    assert!(!local_authenticates(&case, &id, &first).await);
    assert_eq!(local_grant(&case, &id).await, (true, 1));
    // A replay of the same creation keeps the grant.
    let replay = crate::conversations_http::create(
        State(case.state.clone()),
        browser(&case),
        Ok(Json(input)),
    )
    .await
    .unwrap_or_else(|error| panic!("replay refused: {}", error.2));
    assert_eq!(replay.status(), StatusCode::OK);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), first);
    assert_eq!(grant(&case, &id).await, (true, 1));
    assert_eq!(std::fs::read_to_string(&local).unwrap(), local_first);
    assert_eq!(local_grant(&case, &id).await, (true, 1));
    case.finish().await;
}

#[tokio::test]
async fn a_stale_grant_file_is_replaced_with_the_next_input() {
    // ORK-804: a rotation outside the server (a Root host.exec into a
    // directory the agent cannot see) leaves the installed files well-formed
    // but stale; the agent's tools then get 401 until someone notices.
    let mut case = case().await;
    let grants = configure(&mut case);
    let id = case.conversation.clone();
    message(&case, "synthetic:stale-first").await;
    let agent = std::fs::read_to_string(file(&grants, &id)).unwrap();
    let local = std::fs::read_to_string(local_file(&grants, &id)).unwrap();
    assert!(local_authenticates(&case, &id, &local).await);
    let owner = owner(&case).await;
    for _ in 0..2 {
        case.state
            .store
            .issue_agent_timer_grant(&case.bearer, &owner, &id)
            .await
            .unwrap();
        case.state
            .store
            .issue_local_file_grant(&case.bearer, &owner, &id)
            .await
            .unwrap();
    }
    assert!(!authenticates(&case, &id, &agent).await);
    assert!(!local_authenticates(&case, &id, &local).await);
    assert!(
        chats::timer_grant_installed(&file(&grants, &id)),
        "well-formed, only stale"
    );
    assert!(chats::timer_grant_installed(&local_file(&grants, &id)));
    message(&case, "synthetic:stale-second").await;
    let agent_now = std::fs::read_to_string(file(&grants, &id)).unwrap();
    let local_now = std::fs::read_to_string(local_file(&grants, &id)).unwrap();
    assert!(authenticates(&case, &id, &agent_now).await);
    assert!(local_authenticates(&case, &id, &local_now).await);
    assert_eq!(grant(&case, &id).await, (true, 4));
    assert_eq!(local_grant(&case, &id).await, (true, 4));
    // A current file is left alone.
    message(&case, "synthetic:stale-third").await;
    assert_eq!(
        std::fs::read_to_string(file(&grants, &id)).unwrap(),
        agent_now
    );
    assert_eq!(
        std::fs::read_to_string(local_file(&grants, &id)).unwrap(),
        local_now
    );
    assert_eq!(
        (grant(&case, &id).await, local_grant(&case, &id).await),
        ((true, 4), (true, 4))
    );
    case.finish().await;
}

#[tokio::test]
async fn a_revoked_local_files_grant_stays_revoked() {
    let mut case = case().await;
    let grants = configure(&mut case);
    let id = case.conversation.clone();
    message(&case, "synthetic:local-first").await;
    let owner = owner(&case).await;
    case.state
        .store
        .revoke_local_file_grant(&case.bearer, &owner, &id)
        .await
        .unwrap();
    std::fs::remove_file(local_file(&grants, &id)).unwrap();
    message(&case, "synthetic:local-second").await;
    assert!(!local_file(&grants, &id).exists());
    assert_eq!(local_grant(&case, &id).await, (false, 1));
    assert_eq!(
        ensure_local_files(&case.state, &case.bearer, &owner, &id).await,
        Ok(Grant::Revoked)
    );
    // The agent grant is not affected.
    assert!(
        authenticates(
            &case,
            &id,
            &std::fs::read_to_string(file(&grants, &id)).unwrap()
        )
        .await
    );
    case.finish().await;
}

#[tokio::test]
async fn a_project_conversation_has_its_grant_from_the_start() {
    let mut case = case().await;
    let grants = configure(&mut case);
    let body =
        serde_json::json!({"client_request_id": "synthetic-project", "name": "Synthetic project"});
    let (status, project) = send(
        &case.state,
        "POST",
        "/api/v2/projects",
        &[&case.auth()],
        &body.to_string(),
    )
    .await;
    assert_eq!(status, 201, "{project}");
    let id: ConversationId = serde_json::from_value(project["conversation_id"].clone()).unwrap();
    let path = file(&grants, &id);
    assert!(authenticates(&case, &id, &std::fs::read_to_string(&path).unwrap()).await);
    assert_eq!(grant(&case, &id).await, (true, 1));
    let local = std::fs::read_to_string(local_file(&grants, &id)).unwrap();
    assert!(local_authenticates(&case, &id, &local).await);
    case.finish().await;
}

#[tokio::test]
async fn an_older_conversation_gets_its_grant_with_its_next_input_and_a_lost_file_comes_back() {
    let mut case = case().await;
    let grants = configure(&mut case);
    let id = case.conversation.clone();
    let path = file(&grants, &id);
    // Created before grants were issued at creation (the setup conversation).
    assert_eq!(grant(&case, &id).await, (false, 0));
    assert!(!path.exists());
    message(&case, "synthetic:first").await;
    let first = std::fs::read_to_string(&path).unwrap();
    assert!(authenticates(&case, &id, &first).await);
    assert_eq!(grant(&case, &id).await, (true, 1));
    // Further inputs leave a present grant alone.
    message(&case, "synthetic:second").await;
    assert_eq!(std::fs::read_to_string(&path).unwrap(), first);
    assert_eq!(grant(&case, &id).await, (true, 1));
    // A lost file is replaced by a new grant; the old one stops.
    std::fs::remove_file(&path).unwrap();
    message(&case, "synthetic:third").await;
    let second = std::fs::read_to_string(&path).unwrap();
    assert!(authenticates(&case, &id, &second).await);
    assert!(!authenticates(&case, &id, &first).await);
    assert_eq!(grant(&case, &id).await, (true, 2));
    // A revoked grant stays revoked (the provisioner's --revoke removes the file).
    let owner = owner(&case).await;
    case.state
        .store
        .revoke_agent_timer_grant(&case.bearer, &owner, &id)
        .await
        .unwrap();
    std::fs::remove_file(&path).unwrap();
    message(&case, "synthetic:fourth").await;
    assert!(!path.exists());
    assert_eq!(grant(&case, &id).await, (false, 2));
    assert_eq!(
        ensure(&case.state, &case.bearer, &owner, &id).await,
        Ok(Grant::Revoked)
    );
    case.finish().await;
}

#[tokio::test]
async fn concurrent_inputs_issue_one_grant() {
    let mut case = case().await;
    let grants = configure(&mut case);
    let owner = owner(&case).await;
    let id = case.conversation.clone();
    let tasks: Vec<_> = (0..8)
        .map(|_| {
            let (state, bearer, owner, id) = (
                case.state.clone(),
                case.bearer.clone(),
                owner.clone(),
                id.clone(),
            );
            tokio::spawn(async move { ensure(&state, &bearer, &owner, &id).await })
        })
        .collect();
    let mut outcomes = Vec::new();
    for task in tasks {
        outcomes.push(task.await.unwrap().unwrap());
    }
    assert_eq!(outcomes.iter().filter(|g| **g == Grant::Issued).count(), 1);
    assert_eq!(outcomes.iter().filter(|g| **g == Grant::Present).count(), 7);
    assert_eq!(grant(&case, &id).await, (true, 1));
    let value = std::fs::read_to_string(file(&grants, &id)).unwrap();
    assert!(authenticates(&case, &id, &value).await);
    case.finish().await;
}

#[tokio::test]
async fn without_agent_grants_configured_nothing_is_issued_and_inputs_still_work() {
    let case = case().await;
    let owner = owner(&case).await;
    let id = case.conversation.clone();
    assert_eq!(
        ensure(&case.state, &case.bearer, &owner, &id).await,
        Ok(Grant::Unconfigured)
    );
    message(&case, "synthetic:unconfigured").await;
    assert_eq!(grant(&case, &id).await, (false, 0));
    assert!(case.state.deep_house_rules().is_none());
    case.finish().await;
}

#[tokio::test]
async fn an_unusable_grant_directory_never_refuses_the_input() {
    use std::os::unix::fs::PermissionsExt;
    let mut case = case().await;
    let grants = configure(&mut case);
    std::fs::create_dir(&grants).unwrap();
    // Group-writable: another user could plant a grant, so none is installed.
    std::fs::set_permissions(&grants, std::fs::Permissions::from_mode(0o770)).unwrap();
    message(&case, "synthetic:open-dir").await;
    assert!(!file(&grants, &case.conversation).exists());
    let owner = owner(&case).await;
    assert_eq!(
        ensure(&case.state, &case.bearer, &owner, &case.conversation).await,
        Err(StageError("agent_timer_grant_failed"))
    );
    // Nothing is issued that cannot be installed (no rotation per input).
    assert_eq!(grant(&case, &case.conversation).await, (false, 0));
    assert_eq!(local_grant(&case, &case.conversation).await, (false, 0));
    assert_eq!(
        ensure_local_files(&case.state, &case.bearer, &owner, &case.conversation).await,
        Err(StageError("local_files_grant_failed"))
    );
    // The house rules name the agent's view of the grant directory.
    let rules = case.state.deep_house_rules().unwrap();
    assert_eq!(rules.grant_dir, grants.to_str().unwrap());
    assert_eq!(rules.reply_attach_tool, chats::DEFAULT_REPLY_ATTACH_TOOL);
    assert_eq!(
        rules.local_files_tool.as_deref(),
        Some(chats::DEFAULT_LOCAL_FILES_TOOL)
    );
    assert_eq!(rules.v2_url, "http://127.0.0.1:19822");
    case.finish().await;
}
