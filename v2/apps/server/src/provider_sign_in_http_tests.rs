use super::*;
use crate::conversation_resources_http::tests::{case, send, Case};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex as StdMutex};

const ORIGIN_HEADER: &str = "Origin: http://127.0.0.1:19882";
const SECRET: &str = "synthetic-access-token-must-not-leak";

#[derive(Default)]
struct FakePort {
    replies: StdMutex<Vec<Value>>,
    commands: StdMutex<Vec<SignInCommand>>,
}
impl Port for FakePort {
    fn call(&self, command: SignInCommand) -> PortReply {
        self.commands.lock().unwrap().push(command);
        let reply = self.replies.lock().unwrap().remove(0);
        Box::pin(async move { Ok(reply) })
    }
}

fn status(result: &str) -> Value {
    json!({"result":result,"providers":[
        {"provider":"codex","available":true,"signed_in":true,"method":"chatgpt","account":null,"subscription":null,
         "checked_at_ms":1,"login":{"state":"waiting","link":"https://auth.openai.com/codex/device","code":"ABCD-EFGH1","expires_in_s":899}},
        {"provider":"claude","available":false,"reason":"not_configured"}
    ]})
}

struct Owner {
    case: Case,
    cookie: String,
    csrf: String,
}
async fn owner() -> Owner {
    let case = case().await;
    let cookie = format!("Cookie: orkestr_v2_session={}", case.cookie);
    let csrf = format!(
        "x-orkestr-csrf: {:x}",
        Sha256::digest(format!("orkestr-v2-browser-csrf-v1:{}", case.cookie).as_bytes())
    );
    Owner { case, cookie, csrf }
}
impl Owner {
    fn with_port(mut self, replies: Vec<Value>) -> (Self, Arc<FakePort>) {
        let port = Arc::new(FakePort {
            replies: StdMutex::new(replies),
            commands: StdMutex::new(Vec::new()),
        });
        self.case.state.provider_sign_in = Some(port.clone());
        (self, port)
    }
    fn browser(&self) -> Vec<&str> {
        vec![&self.cookie, ORIGIN_HEADER, &self.csrf]
    }
    async fn get(&self) -> (u16, Value) {
        send(
            &self.case.state,
            "GET",
            "/api/v2/provider-sign-in",
            &[&self.cookie],
            "",
        )
        .await
    }
    async fn post(&self, path: &str, body: &str) -> (u16, Value) {
        send(&self.case.state, "POST", path, &self.browser(), body).await
    }
}

#[tokio::test]
async fn only_the_owner_browser_session_reaches_any_route() {
    let (owner, port) = owner().await.with_port(vec![]);
    let bearer = owner.case.auth();
    for (method, path, body) in [
        ("GET", "/api/v2/provider-sign-in", ""),
        ("POST", "/api/v2/provider-sign-in/codex/start", ""),
        (
            "POST",
            "/api/v2/provider-sign-in/claude/code",
            r#"{"code":"synthetic-code"}"#,
        ),
        ("POST", "/api/v2/provider-sign-in/codex/cancel", ""),
        (
            "POST",
            "/api/v2/provider-sign-in/codex/sign-out",
            r#"{"confirm":true}"#,
        ),
    ] {
        // No credential at all, then a Bearer service or chat credential.
        assert_eq!(
            send(&owner.case.state, method, path, &[], body).await.0,
            401,
            "{path}"
        );
        let with_bearer = send(
            &owner.case.state,
            method,
            path,
            &[&bearer, ORIGIN_HEADER],
            body,
        )
        .await;
        assert_eq!(with_bearer.0, 401, "{path} refuses a Bearer credential");
        // A browser session must not be combined with a Bearer credential either.
        let mixed = send(
            &owner.case.state,
            method,
            path,
            &[&owner.cookie, ORIGIN_HEADER, &owner.csrf, &bearer],
            body,
        )
        .await;
        assert!(
            matches!(mixed.0, 401 | 403),
            "{path} refuses a mixed credential"
        );
    }
    assert!(
        port.commands.lock().unwrap().is_empty(),
        "no control request without authority"
    );
    owner.case.finish().await;
}

#[tokio::test]
async fn writes_need_same_origin_and_csrf() {
    let (owner, port) = owner().await.with_port(vec![]);
    let state = &owner.case.state;
    for path in [
        "/api/v2/provider-sign-in/codex/start",
        "/api/v2/provider-sign-in/codex/cancel",
        "/api/v2/provider-sign-in/codex/sign-out",
    ] {
        let missing = send(state, "POST", path, &[&owner.cookie, ORIGIN_HEADER], "").await;
        assert_eq!(missing.0, 403, "{path} without CSRF");
        let foreign = send(
            state,
            "POST",
            path,
            &[&owner.cookie, "Origin: https://evil.example", &owner.csrf],
            "",
        )
        .await;
        assert_eq!(foreign.0, 403, "{path} foreign origin");
    }
    assert!(port.commands.lock().unwrap().is_empty());
    owner.case.finish().await;
}

#[tokio::test]
async fn overview_keeps_only_the_link_and_code() {
    let (owner, port) = owner().await.with_port(vec![status("status")]);
    let (code, body) = owner.get().await;
    assert_eq!(code, 200);
    assert_eq!(*port.commands.lock().unwrap(), vec![SignInCommand::Status]);
    assert_eq!(
        body["providers"][0]["login"]["link"],
        "https://auth.openai.com/codex/device"
    );
    assert_eq!(body["providers"][0]["login"]["code"], "ABCD-EFGH1");
    assert_eq!(body["providers"][1]["available"], false);
    assert_eq!(body["providers"][1]["reason"], "not_configured");
    owner.case.finish().await;
}

#[tokio::test]
async fn a_foreign_link_or_stray_field_never_reaches_the_browser() {
    let mut foreign = status("status");
    foreign["providers"][0]["login"]["link"] = json!("https://evil.example/codex/device");
    let mut smuggled = status("status");
    smuggled["providers"][0]["access_token"] = json!(SECRET);
    let mut account = status("status");
    account["providers"][0]["account"] = json!(format!("token {SECRET}\n"));
    let (owner, _port) = owner().await.with_port(vec![foreign, smuggled, account]);
    for _ in 0..3 {
        let (code, body) = owner.get().await;
        assert_eq!(code, 503);
        let text = body.to_string();
        assert!(!text.contains(SECRET) && !text.contains("evil.example"));
    }
    owner.case.finish().await;
}

#[tokio::test]
async fn start_conflict_rate_limit_and_unknown_provider_are_distinct() {
    let (owner, port) = owner().await.with_port(vec![
        status("started"),
        status("in_progress"),
        status("rate_limited"),
        status("unavailable"),
    ]);
    let path = "/api/v2/provider-sign-in/codex/start";
    assert_eq!(owner.post(path, "").await.0, 202);
    let (code, body) = owner.post(path, "").await;
    assert_eq!(
        (code, body["code"].as_str()),
        (409, Some("provider_sign_in_in_progress"))
    );
    let (code, body) = owner.post(path, "").await;
    assert_eq!(
        (code, body["code"].as_str()),
        (429, Some("provider_sign_in_rate_limited"))
    );
    assert_eq!(owner.post(path, "").await.0, 503);
    assert_eq!(
        owner
            .post("/api/v2/provider-sign-in/openai/start", "")
            .await
            .0,
        404
    );
    assert_eq!(port.commands.lock().unwrap().len(), 4);
    owner.case.finish().await;
}

#[tokio::test]
async fn sign_out_needs_an_explicit_confirmation() {
    let (owner, port) = owner().await.with_port(vec![status("started")]);
    let path = "/api/v2/provider-sign-in/codex/sign-out";
    for body in ["", "{}", r#"{"confirm":false}"#, r#"{"confirm":"yes"}"#] {
        let (code, reply) = owner.post(path, body).await;
        assert_eq!(code, 400, "{body}");
        assert_eq!(reply["code"], "provider_sign_out_confirmation_required");
    }
    assert!(
        port.commands.lock().unwrap().is_empty(),
        "an unconfirmed sign-out reaches nothing"
    );
    assert_eq!(owner.post(path, r#"{"confirm":true}"#).await.0, 202);
    assert_eq!(
        *port.commands.lock().unwrap(),
        vec![SignInCommand::SignOut(SignInProvider::Codex)]
    );
    owner.case.finish().await;
}

#[tokio::test]
async fn pasted_codes_are_shaped_before_they_reach_the_cli() {
    let (owner, port) = owner()
        .await
        .with_port(vec![status("accepted"), status("refused")]);
    let path = "/api/v2/provider-sign-in/claude/code";
    let (code, reply) = owner.post(path, r#"{"code":"short"}"#).await;
    assert_eq!(
        (code, reply["code"].as_str()),
        (400, Some("provider_sign_in_code_refused"))
    );
    assert_eq!(owner.post(path, "{not json").await.0, 400);
    assert!(port.commands.lock().unwrap().is_empty());
    assert_eq!(
        owner
            .post(path, r#"{"code":" synthetic-browser-code "}"#)
            .await
            .0,
        202
    );
    assert_eq!(
        port.commands.lock().unwrap().last(),
        Some(&SignInCommand::Code(
            SignInProvider::Claude,
            "synthetic-browser-code".into()
        ))
    );
    let (code, reply) = owner
        .post(path, r#"{"code":"synthetic-browser-code"}"#)
        .await;
    assert_eq!(
        (code, reply["code"].as_str()),
        (400, Some("provider_sign_in_code_refused"))
    );
    owner.case.finish().await;
}

#[tokio::test]
async fn an_install_without_a_manager_says_so_without_failing() {
    let owner = owner().await;
    let (code, body) = owner.get().await;
    assert_eq!(code, 200);
    assert_eq!(body["providers"][0]["available"], false);
    assert_eq!(body["providers"][0]["reason"], "unsupported");
    assert_eq!(
        owner
            .post("/api/v2/provider-sign-in/codex/start", "")
            .await
            .0,
        503
    );
    owner.case.finish().await;
}

#[test]
fn every_reply_is_no_store() {
    let response = no_store(StatusCode::OK, SignInOverview::unavailable());
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
}
