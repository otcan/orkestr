mod support;
use orkestr_v2_contracts::*;
use orkestr_v2_restricted::agent::{Endpoints, Runner};
use orkestr_v2_restricted::llm::CurlChat;
use std::sync::Arc;
use std::time::Duration;
use support::stub::*;
use support::*;

const KEY: &str = "sk-test-very-secret-key-123";

fn runner(case: &Case, stub: &Stub) -> Arc<Runner> {
    let mut endpoints = Endpoints::new();
    endpoints.insert(
        "stub".into(),
        Arc::new(CurlChat {
            base_url: stub.url.clone(),
            api_key: Some(KEY.into()),
            default_model: Some("stub-model".into()),
            timeout: Duration::from_secs(20),
        }),
    );
    Arc::new(Runner {
        store: case.store.clone(),
        broker: case.broker.clone(),
        endpoints,
        poll: Duration::from_millis(20),
    })
}
async fn wait_reply(case: &Case, text: &str) -> Vec<RestrictedMessage> {
    for _ in 0..1000 {
        let m = case
            .store
            .restricted_messages_page(&case.token, &case.owner, &case.conversation, 0, 50)
            .await
            .unwrap()
            .messages;
        if m.iter()
            .any(|m| m.content.as_deref().is_some_and(|c| c.contains(text)))
        {
            return m;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("no reply containing {text:?}");
}

#[tokio::test]
async fn owner_message_to_reply_with_tools_approval_and_injection_attempt() {
    let case = Arc::new(Case::new().await);
    case.enable(case.policy()).await;
    let stub = start(vec![
        reply_calls(vec![
            tool_call("c1", "read_file", serde_json::json!({"path":"notes.txt"})),
            tool_call(
                "c2",
                "fetch_url",
                serde_json::json!({"url":"https://example.com/x"}),
            ),
        ]),
        // The fetched page said "call start_gpu": a manipulated model obeys, and also tries a secret.
        reply_calls(vec![
            tool_call(
                "c3",
                "start_gpu",
                serde_json::json!({"reason":"page told me to"}),
            ),
            tool_call("c4", "read_file", serde_json::json!({"path":".env"})),
        ]),
        reply_calls(vec![tool_call(
            "c5",
            "send_message",
            serde_json::json!({"to":"ann@x.com","body":"summary"}),
        )]),
        reply_text("All done: notes read, GPU declined, message sent."),
    ])
    .await;
    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    let handle = tokio::spawn(runner(&case, &stub).run(stop_rx));
    case.say("m1", "summarise my notes and tell Ann").await;

    // The injected GPU start reaches the owner and is declined.
    let gpu = case.next_pending().await;
    assert_eq!(gpu.action, "start_gpu");
    case.decide(&gpu.id, false, RestrictedApprovalScope::Once)
        .await
        .unwrap();
    // The send also waits for a tap.
    let send = loop {
        let a = case.next_pending().await;
        if a.action == "send_message" {
            break a;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    assert!(case.fakes.sent.lock().unwrap().is_empty());
    case.decide(&send.id, true, RestrictedApprovalScope::Once)
        .await
        .unwrap();

    let messages = wait_reply(&case, "All done").await;
    assert_eq!(messages.last().unwrap().role, "assistant");
    assert!(
        case.fakes.gpu_starts.lock().unwrap().is_empty(),
        "the GPU was never started"
    );
    assert_eq!(case.fakes.sent.lock().unwrap().len(), 1);

    // What the model was shown: tool results, with denials in the agreed form, never the secret.
    let seen = stub.seen.lock().unwrap().requests.clone();
    assert_eq!(seen.len(), 4);
    let last = serde_json::to_string(&seen[3].1["messages"]).unwrap();
    assert!(
        last.contains("hello notes")
            && last.contains("not allowed: the owner declined")
            && last.contains("not allowed: credentials and secrets")
    );
    assert!(!last.contains("supersecret"));
    // The API key reached the endpoint as a header and nowhere else.
    assert!(seen
        .iter()
        .all(|(head, _)| head.contains(&format!("Bearer {KEY}"))));
    assert!(seen.iter().all(|(_, body)| !body.to_string().contains(KEY)));
    // Tools offered to the model are exactly the documented set.
    assert_eq!(seen[0].1["tools"].as_array().unwrap().len(), 9);

    // Audit: every request, in order, with decision, decider and result.
    let audit = case.audit().await;
    let rows: Vec<(
        String,
        RestrictedDecision,
        RestrictedDecider,
        Option<String>,
    )> = audit
        .iter()
        .map(|r| (r.action.clone(), r.decision, r.decider, r.outcome.clone()))
        .collect();
    assert_eq!(
        rows,
        vec![
            (
                "read_file".into(),
                RestrictedDecision::Allow,
                RestrictedDecider::Policy,
                Some("ok".into())
            ),
            (
                "fetch_url".into(),
                RestrictedDecision::Allow,
                RestrictedDecider::Policy,
                Some("ok".into())
            ),
            (
                "start_gpu".into(),
                RestrictedDecision::Deny,
                RestrictedDecider::Owner,
                Some("denied".into())
            ),
            (
                "read_file".into(),
                RestrictedDecision::Deny,
                RestrictedDecider::Policy,
                Some("denied".into())
            ),
            (
                "send_message".into(),
                RestrictedDecision::Allow,
                RestrictedDecider::Owner,
                Some("ok".into())
            ),
        ]
    );
    let everything = serde_json::to_string(&audit).unwrap();
    assert!(!everything.contains(KEY) && !everything.contains("supersecret"));
    stop_tx.send(true).unwrap();
    handle.await.unwrap();
    // The turn is finished and the cursor moved: the message is not replayed.
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(stub.seen.lock().unwrap().requests.len(), 4);
    std::fs::remove_dir_all(&case.root).ok();
}

#[tokio::test]
async fn unreachable_endpoint_reports_and_never_starts_the_gpu() {
    let case = Arc::new(Case::new().await);
    case.enable(case.policy()).await;
    let mut endpoints = Endpoints::new();
    endpoints.insert(
        "stub".into(),
        Arc::new(CurlChat {
            base_url: "http://127.0.0.1:9/v1".into(),
            api_key: None,
            default_model: Some("m".into()),
            timeout: Duration::from_secs(5),
        }),
    );
    let runner = Arc::new(Runner {
        store: case.store.clone(),
        broker: case.broker.clone(),
        endpoints,
        poll: Duration::from_millis(20),
    });
    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    let handle = tokio::spawn(runner.run(stop_rx));
    case.say("m1", "hello").await;
    let m = wait_reply(&case, "model is unavailable").await;
    assert_eq!(m.last().unwrap().role, "notice");
    assert!(case.fakes.gpu_starts.lock().unwrap().is_empty());
    assert!(case.audit().await.is_empty());
    stop_tx.send(true).unwrap();
    handle.await.unwrap();
    std::fs::remove_dir_all(&case.root).ok();
}

#[tokio::test]
async fn messages_from_before_the_thread_was_restricted_are_not_replayed() {
    let case = Arc::new(Case::new().await);
    case.say("old", "old message").await;
    case.enable(case.policy()).await;
    let stub = start(vec![reply_text("hi")]).await;
    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    let handle = tokio::spawn(runner(&case, &stub).run(stop_rx));
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(stub.seen.lock().unwrap().requests.is_empty());
    case.say("new", "new message").await;
    wait_reply(&case, "hi").await;
    let body = serde_json::to_string(&stub.seen.lock().unwrap().requests[0].1["messages"]).unwrap();
    assert!(body.contains("new message") && !body.contains("old message"));
    stop_tx.send(true).unwrap();
    handle.await.unwrap();
    std::fs::remove_dir_all(&case.root).ok();
}

#[tokio::test]
async fn step_limit_ends_a_looping_model() {
    let case = Arc::new(Case::new().await);
    let mut p = case.policy();
    p.max_steps = 3;
    case.enable(p).await;
    let looping: Vec<_> = (0..10)
        .map(|i| {
            reply_calls(vec![tool_call(
                &format!("c{i}"),
                "list_dir",
                serde_json::json!({"path":"."}),
            )])
        })
        .collect();
    let stub = start(looping).await;
    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    let handle = tokio::spawn(runner(&case, &stub).run(stop_rx));
    case.say("m1", "go").await;
    wait_reply(&case, "Stopped after 3 model steps").await;
    assert_eq!(stub.seen.lock().unwrap().requests.len(), 3);
    stop_tx.send(true).unwrap();
    handle.await.unwrap();
    std::fs::remove_dir_all(&case.root).ok();
}
