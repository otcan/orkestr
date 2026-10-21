mod support;
use orkestr_v2_contracts::*;
use orkestr_v2_store_sqlite::ResourceError;
use support::*;

const ONCE: RestrictedApprovalScope = RestrictedApprovalScope::Once;
const SESSION: RestrictedApprovalScope = RestrictedApprovalScope::Session;

async fn call(case: &Case, name: &str, args: serde_json::Value) -> String {
    let thread = case.thread().await;
    case.broker.handle(&thread, name, &args.to_string()).await
}

#[tokio::test]
async fn auto_allow_and_auto_deny_are_audited_with_results() {
    let case = Case::new().await;
    case.enable(case.policy()).await;
    assert_eq!(
        call(&case, "read_file", serde_json::json!({"path":"notes.txt"})).await,
        "hello notes"
    );
    assert!(call(&case, "list_dir", serde_json::json!({"path":"."}))
        .await
        .contains("notes.txt"));
    // The secret file exists but is neither listed nor readable.
    assert!(!call(&case, "list_dir", serde_json::json!({"path":"."}))
        .await
        .contains(".env"));
    let denied = [
        ("read_file", serde_json::json!({"path":".env"})),
        ("read_file", serde_json::json!({"path":"/etc/passwd"})),
        ("read_file", serde_json::json!({"path":"../../etc/shadow"})),
        ("delete_file", serde_json::json!({"path":"notes.txt"})),
        ("sudo", serde_json::json!({"command":"id"})),
        ("get_credentials", serde_json::json!({})),
        ("read_thread", serde_json::json!({"id":"x"})),
        ("run_sandboxed", serde_json::json!({"command":"sudo id"})),
        ("run_sandboxed", serde_json::json!({"command":"rm -rf ."})),
        (
            "fetch_url",
            serde_json::json!({"url":"http://169.254.169.254/latest/meta-data"}),
        ),
        ("teleport", serde_json::json!({})),
        (
            "read_file",
            serde_json::json!({"path":"notes.txt","extra":1}),
        ),
    ];
    for (name, args) in denied {
        let reply = call(&case, name, args.clone()).await;
        assert!(reply.starts_with("not allowed: "), "{name} {args}: {reply}");
    }
    assert!(case.ws.join("notes.txt").exists());
    assert!(case.fakes.sandbox_runs.lock().unwrap().is_empty());
    assert!(case.fakes.fetched.lock().unwrap().is_empty());
    let audit = case.audit().await;
    assert_eq!(audit.len(), 15);
    // Every row is settled: decision, decider and a result.
    assert!(audit
        .iter()
        .all(|r| r.outcome.is_some() && r.finished_at_ms.is_some()));
    assert!(audit[..3]
        .iter()
        .all(|r| r.decision == RestrictedDecision::Allow
            && r.decider == RestrictedDecider::Policy
            && r.outcome.as_deref() == Some("ok")));
    assert!(audit[3..]
        .iter()
        .all(|r| r.decision == RestrictedDecision::Deny
            && r.decider == RestrictedDecider::Policy
            && r.outcome.as_deref() == Some("denied")));
    // The audit never stores file contents of reads or the secret.
    let dump = serde_json::to_string(&audit).unwrap();
    assert!(!dump.contains("supersecret") && !dump.contains("hello notes"));
    case.finish();
}

#[tokio::test]
async fn web_and_sandbox_follow_the_thread_policy() {
    let case = Case::new().await;
    let mut policy = case.policy();
    policy.web_enabled = false;
    policy.sandbox_enabled = false;
    case.enable(policy.clone()).await;
    assert!(call(&case, "web_search", serde_json::json!({"query":"x"}))
        .await
        .starts_with("not allowed: web access is disabled"));
    assert!(
        call(&case, "run_sandboxed", serde_json::json!({"command":"ls"}))
            .await
            .starts_with("not allowed: the sandbox is disabled")
    );
    policy.web_enabled = true;
    policy.sandbox_enabled = true;
    let t = case
        .store
        .restricted_thread(&case.token, &case.owner, &case.conversation)
        .await
        .unwrap();
    case.store
        .update_restricted_thread(
            &case.token,
            &case.owner,
            &case.conversation,
            &RestrictedThreadUpdate {
                expected_revision: t.revision,
                enabled: true,
                policy,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        call(&case, "web_search", serde_json::json!({"query":"x"})).await,
        "results for x"
    );
    assert!(call(
        &case,
        "fetch_url",
        serde_json::json!({"url":"https://example.com/p"})
    )
    .await
    .starts_with("PAGE:"));
    assert_eq!(
        call(&case, "run_sandboxed", serde_json::json!({"command":"ls"})).await,
        "exit code 0\n--- stdout ---\nsandbox-out\n"
    );
    let spec = case.fakes.sandbox_runs.lock().unwrap()[0].clone();
    assert_eq!(spec.network, None, "no network unless granted");
    assert_eq!(spec.workspace, case.ws);
    assert!(!spec.writable);
    let draft = call(
        &case,
        "draft_message",
        serde_json::json!({"to":"ann","body":"hi"}),
    )
    .await;
    assert!(draft.contains("was not sent"));
    assert!(case.fakes.sent.lock().unwrap().is_empty());
    assert_eq!(
        std::fs::read_dir(case.ws.join("drafts")).unwrap().count(),
        1
    );
    case.finish();
}

#[tokio::test]
async fn owner_approves_one_send_and_the_next_asks_again() {
    let case = Case::new().await;
    case.enable(case.policy()).await;
    let c = std::sync::Arc::new(case);
    let task = {
        let c = c.clone();
        tokio::spawn(async move {
            call(
                &c,
                "send_message",
                serde_json::json!({"to":"ann@x.com","body":"hello ann"}),
            )
            .await
        })
    };
    let approval = c.next_pending().await;
    assert!(approval.summary.contains("ann@x.com") && approval.summary.contains("hello ann"));
    // Nothing happens before the owner taps.
    assert!(c.fakes.sent.lock().unwrap().is_empty());
    let audit = c.audit().await;
    assert_eq!(
        (audit[0].decision, audit[0].outcome.clone()),
        (RestrictedDecision::Ask, None)
    );
    c.decide(&approval.id, true, ONCE).await.unwrap();
    assert_eq!(task.await.unwrap(), "sent to ann@x.com");
    assert_eq!(c.fakes.sent.lock().unwrap().len(), 1);
    let audit = c.audit().await;
    assert_eq!(
        (
            audit[0].decision,
            audit[0].decider,
            audit[0].outcome.as_deref()
        ),
        (
            RestrictedDecision::Allow,
            RestrictedDecider::Owner,
            Some("ok")
        )
    );
    assert_eq!(audit[0].approval_id.as_deref(), Some(approval.id.as_str()));
    // Deciding twice is refused.
    assert!(matches!(
        c.decide(&approval.id, false, ONCE).await,
        Err(ResourceError::Conflict("approval_not_pending"))
    ));
    // A second send asks again; this time the owner declines.
    let task = {
        let c = c.clone();
        tokio::spawn(async move {
            call(
                &c,
                "send_message",
                serde_json::json!({"to":"ann@x.com","body":"again"}),
            )
            .await
        })
    };
    let second = c.next_pending().await;
    c.decide(&second.id, false, ONCE).await.unwrap();
    assert_eq!(task.await.unwrap(), "not allowed: the owner declined");
    assert_eq!(c.fakes.sent.lock().unwrap().len(), 1);
    let audit = c.audit().await;
    assert_eq!(
        (
            audit[1].decision,
            audit[1].decider,
            audit[1].outcome.as_deref()
        ),
        (
            RestrictedDecision::Deny,
            RestrictedDecider::Owner,
            Some("denied")
        )
    );
    std::fs::remove_dir_all(&c.root).ok();
}

#[tokio::test]
async fn session_approval_covers_that_recipient_until_the_session_resets() {
    let case = std::sync::Arc::new(Case::new().await);
    case.enable(case.policy()).await;
    let send = |to: &'static str| {
        let c = case.clone();
        tokio::spawn(async move {
            call(&c, "send_message", serde_json::json!({"to":to,"body":"b"})).await
        })
    };
    let t = send("ann@x.com");
    let a = case.next_pending().await;
    assert!(a.session_grant_label.is_some());
    case.decide(&a.id, true, SESSION).await.unwrap();
    assert_eq!(t.await.unwrap(), "sent to ann@x.com");
    // Same recipient: no prompt.
    assert_eq!(send("Ann@X.com").await.unwrap(), "sent to Ann@X.com");
    assert!(case.pending().await.is_empty());
    assert_eq!(
        case.audit().await[1].decider,
        RestrictedDecider::SessionGrant
    );
    // A different recipient still asks.
    let t = send("bob@x.com");
    let b = case.next_pending().await;
    case.decide(&b.id, false, ONCE).await.unwrap();
    assert!(t.await.unwrap().starts_with("not allowed"));
    // Resetting the session revokes the grant.
    case.store
        .reset_restricted_session(&case.token, &case.owner, &case.conversation)
        .await
        .unwrap();
    let t = send("ann@x.com");
    let again = case.next_pending().await;
    case.decide(&again.id, false, ONCE).await.unwrap();
    assert!(t.await.unwrap().starts_with("not allowed"));
    assert_eq!(case.fakes.sent.lock().unwrap().len(), 2);
    std::fs::remove_dir_all(&case.root).ok();
}

#[tokio::test]
async fn gpu_always_asks_and_is_never_session_scoped() {
    let case = std::sync::Arc::new(Case::new().await);
    case.enable(case.policy()).await;
    for round in 0..2 {
        let t = {
            let c = case.clone();
            tokio::spawn(async move {
                call(&c, "start_gpu", serde_json::json!({"reason":"big job"})).await
            })
        };
        let a = case.next_pending().await;
        assert!(
            a.summary.contains("L40S"),
            "the owner sees the cost: {}",
            a.summary
        );
        assert!(a.session_grant_label.is_none());
        assert!(
            matches!(
                case.decide(&a.id, true, SESSION).await,
                Err(ResourceError::Invalid)
            ),
            "round {round}"
        );
        case.decide(&a.id, true, ONCE).await.unwrap();
        assert_eq!(t.await.unwrap(), "gpu starting");
    }
    assert_eq!(case.fakes.gpu_starts.lock().unwrap().len(), 2);
    // Disabled in policy: denied outright, never reaches the owner.
    let mut p = case.policy();
    p.gpu_enabled = false;
    let t = case
        .store
        .restricted_thread(&case.token, &case.owner, &case.conversation)
        .await
        .unwrap();
    case.store
        .update_restricted_thread(
            &case.token,
            &case.owner,
            &case.conversation,
            &RestrictedThreadUpdate {
                expected_revision: t.revision,
                enabled: true,
                policy: p,
            },
        )
        .await
        .unwrap();
    assert!(call(&case, "start_gpu", serde_json::json!({"reason":"x"}))
        .await
        .starts_with("not allowed"));
    assert_eq!(case.fakes.gpu_starts.lock().unwrap().len(), 2);
    std::fs::remove_dir_all(&case.root).ok();
}

#[tokio::test]
async fn unanswered_requests_time_out_as_denials() {
    let mut case = Case::new().await;
    let mut broker = orkestr_v2_restricted::broker::Broker {
        store: case.store.clone(),
        config: case.broker.config.clone(),
        backends: case.broker.backends.clone(),
    };
    broker.config.approval_timeout = std::time::Duration::from_millis(80);
    case.broker = std::sync::Arc::new(broker);
    case.enable(case.policy()).await;
    assert_eq!(
        call(
            &case,
            "send_message",
            serde_json::json!({"to":"a","body":"b"})
        )
        .await,
        "not allowed: the owner did not respond in time"
    );
    let audit = case.audit().await;
    assert_eq!(
        (audit[0].decision, audit[0].decider),
        (RestrictedDecision::Deny, RestrictedDecider::Timeout)
    );
    assert!(case.fakes.sent.lock().unwrap().is_empty());
    // A late tap on an expired request is refused.
    let list = case
        .store
        .restricted_approvals(&case.token, &case.owner, &case.conversation, false)
        .await
        .unwrap()
        .approvals;
    assert!(matches!(
        case.decide(&list[0].id, true, ONCE).await,
        Err(ResourceError::Conflict("approval_not_pending"))
    ));
    case.finish();
}

#[tokio::test]
async fn only_the_owner_credential_can_decide() {
    let case = std::sync::Arc::new(Case::new().await);
    case.enable(case.policy()).await;
    let t = {
        let c = case.clone();
        tokio::spawn(async move {
            call(&c, "send_message", serde_json::json!({"to":"a","body":"b"})).await
        })
    };
    let a = case.next_pending().await;
    let decision = RestrictedApprovalDecision {
        approve: true,
        scope: ONCE,
    };
    for bad in ["", "not-a-session", &"f".repeat(64)] {
        assert!(case
            .store
            .decide_restricted_approval(bad, &case.owner, &case.conversation, &a.id, &decision)
            .await
            .is_err());
    }
    // Another conversation of the same owner cannot see or decide it.
    let other = case
        .store
        .create_conversation_authenticated(
            &case.token,
            &ConversationInput {
                client_request_id: "o".into(),
                name: "other".into(),
            },
        )
        .await
        .unwrap()
        .0
        .conversation_id;
    assert!(case
        .store
        .decide_restricted_approval(&case.token, &case.owner, &other, &a.id, &decision)
        .await
        .is_err());
    assert!(case.fakes.sent.lock().unwrap().is_empty());
    case.decide(&a.id, false, ONCE).await.unwrap();
    t.await.unwrap();
    std::fs::remove_dir_all(&case.root).ok();
}

#[tokio::test]
async fn sandbox_network_needs_a_grant_or_the_owner() {
    let case = std::sync::Arc::new(Case::new().await);
    case.enable(case.policy()).await;
    let t = {
        let c = case.clone();
        tokio::spawn(async move {
            call(
                &c,
                "run_sandboxed",
                serde_json::json!({"command":"curl example.com","network":true}),
            )
            .await
        })
    };
    let a = case.next_pending().await;
    assert!(a.summary.contains("NETWORK"));
    assert!(case.fakes.sandbox_runs.lock().unwrap().is_empty());
    case.decide(&a.id, true, ONCE).await.unwrap();
    t.await.unwrap();
    assert_eq!(
        case.fakes.sandbox_runs.lock().unwrap()[0]
            .network
            .as_deref(),
        Some("bridge")
    );
    // Without asking for network the run is offline even when the policy grants it.
    let mut p = case.policy();
    p.sandbox_network_granted = true;
    let th = case
        .store
        .restricted_thread(&case.token, &case.owner, &case.conversation)
        .await
        .unwrap();
    case.store
        .update_restricted_thread(
            &case.token,
            &case.owner,
            &case.conversation,
            &RestrictedThreadUpdate {
                expected_revision: th.revision,
                enabled: true,
                policy: p,
            },
        )
        .await
        .unwrap();
    call(&case, "run_sandboxed", serde_json::json!({"command":"ls"})).await;
    assert_eq!(case.fakes.sandbox_runs.lock().unwrap()[1].network, None);
    call(
        &case,
        "run_sandboxed",
        serde_json::json!({"command":"curl example.com","network":true,"timeout_secs":9999}),
    )
    .await;
    let spec = case.fakes.sandbox_runs.lock().unwrap()[2].clone();
    assert_eq!(spec.network.as_deref(), Some("bridge"));
    assert_eq!(
        spec.timeout.as_secs(),
        30,
        "requested timeout is capped by the policy"
    );
    std::fs::remove_dir_all(&case.root).ok();
}

#[tokio::test]
async fn writes_outside_the_workspace_ask_and_secrets_never_do() {
    let case = std::sync::Arc::new(Case::new().await);
    case.enable(case.policy()).await;
    let outside = case.root.join("elsewhere.txt");
    assert_eq!(
        call(
            &case,
            "write_file",
            serde_json::json!({"path":"inside/new.txt","content":"x"})
        )
        .await,
        "wrote 1 bytes"
    );
    assert!(case.ws.join("inside/new.txt").exists());
    assert!(call(
        &case,
        "write_file",
        serde_json::json!({"path":".env","content":"x"})
    )
    .await
    .starts_with("not allowed"));
    assert!(call(
        &case,
        "write_file",
        serde_json::json!({"path":"/etc/orkestr/x","content":"x"})
    )
    .await
    .starts_with("not allowed"));
    let t = {
        let (c, p) = (case.clone(), outside.display().to_string());
        tokio::spawn(async move {
            call(
                &c,
                "write_file",
                serde_json::json!({"path":p,"content":"ext"}),
            )
            .await
        })
    };
    let a = case.next_pending().await;
    assert!(!outside.exists(), "nothing is written before approval");
    case.decide(&a.id, true, ONCE).await.unwrap();
    assert_eq!(t.await.unwrap(), "wrote 3 bytes");
    assert_eq!(std::fs::read_to_string(&outside).unwrap(), "ext");
    std::fs::remove_dir_all(&case.root).ok();
}

#[tokio::test]
async fn symlink_planted_in_the_workspace_cannot_reach_outside() {
    let case = Case::new().await;
    case.enable(case.policy()).await;
    std::fs::write(case.root.join("outside-secret"), "TOPSECRET").unwrap();
    std::os::unix::fs::symlink(case.root.join("outside-secret"), case.ws.join("link")).unwrap();
    std::os::unix::fs::symlink(&case.root, case.ws.join("dirlink")).unwrap();
    for p in [
        "link",
        "dirlink/outside-secret",
        "dirlink/../outside-secret",
    ] {
        let r = call(&case, "read_file", serde_json::json!({"path":p})).await;
        assert!(r.starts_with("not allowed"), "{p}: {r}");
        assert!(!r.contains("TOPSECRET"));
    }
    case.finish();
}

#[tokio::test]
async fn restart_recovery_settles_open_requests() {
    let case = std::sync::Arc::new(Case::new().await);
    let thread = case.enable(case.policy()).await;
    case.say("m1", "please send").await;
    assert!(case
        .store
        .restricted_take_input(&thread)
        .await
        .unwrap()
        .is_some());
    assert!(
        case.store
            .restricted_take_input(&thread)
            .await
            .unwrap()
            .is_none(),
        "one turn at a time"
    );
    let t = {
        let c = case.clone();
        tokio::spawn(async move {
            call(&c, "send_message", serde_json::json!({"to":"a","body":"b"})).await
        })
    };
    case.next_pending().await;
    assert_eq!(case.store.restricted_recover().await.unwrap(), 1);
    assert_eq!(
        t.await.unwrap(),
        "not allowed: the owner did not respond in time"
    );
    let messages = case
        .store
        .restricted_messages_page(&case.token, &case.owner, &case.conversation, 0, 50)
        .await
        .unwrap()
        .messages;
    assert!(messages
        .iter()
        .any(|m| m.role == "notice" && m.content.as_deref().unwrap().contains("restarted")));
    // The interrupted message is not replayed.
    assert!(case
        .store
        .restricted_take_input(&thread)
        .await
        .unwrap()
        .is_none());
    std::fs::remove_dir_all(&case.root).ok();
}

#[tokio::test]
async fn gpu_start_blocked_by_the_helper_never_reaches_the_owner() {
    let case = Case::new().await;
    case.enable(case.policy()).await;
    *case.fakes.gpu_block.lock().unwrap() =
        Some("the GPU cannot be started now: daily cap reached".into());
    let reply = call(&case, "start_gpu", serde_json::json!({"reason":"x"})).await;
    assert_eq!(
        reply,
        "not allowed: the GPU cannot be started now: daily cap reached"
    );
    assert!(case.pending().await.is_empty());
    assert!(case.fakes.gpu_starts.lock().unwrap().is_empty());
    let audit = case.audit().await;
    assert_eq!(
        (
            audit[0].decision,
            audit[0].decider,
            audit[0].outcome.as_deref()
        ),
        (
            RestrictedDecision::Deny,
            RestrictedDecider::Policy,
            Some("denied")
        )
    );
    case.finish();
}
