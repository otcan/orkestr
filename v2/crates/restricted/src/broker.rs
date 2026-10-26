//! The broker: every model request is parsed, decided against the thread policy,
//! audited (request, decision, decider, result) and only then executed by the broker
//! itself. The model receives text; it never holds a handle to anything.
use crate::action::{parse, Action, ParseError};
use crate::paths::{classify, PathClass};
use crate::policy::{decide, Ask, Verdict};
use crate::sandbox::{mount_identity, Sandbox, SandboxSpec};
use crate::web::{Fetcher, Searcher};
use async_trait::async_trait;
use orkestr_v2_contracts::*;
use orkestr_v2_store_sqlite::{RestrictedRunnerThread, Store};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

#[async_trait]
pub trait Sender: Send + Sync {
    async fn send(&self, to: &str, body: &str) -> Result<String, String>;
}
#[async_trait]
pub trait GpuControl: Send + Sync {
    /// Start the GPU. Only ever called after the owner approved this exact request.
    async fn start(&self, reason: &str) -> Result<String, String>;
    /// Checked before the owner is asked: `Ok(description)` (cost, caps, credit) is shown
    /// in the approval; `Err(reason)` means a start would be refused anyway.
    async fn precheck(&self) -> Result<String, String> {
        Ok(String::new())
    }
}
pub struct NoChannel;
#[async_trait]
impl Sender for NoChannel {
    async fn send(&self, _: &str, _: &str) -> Result<String, String> {
        Err("not delivered: no outbound channel is configured for restricted threads yet".into())
    }
}
#[async_trait]
impl GpuControl for NoChannel {
    async fn start(&self, _: &str) -> Result<String, String> {
        Err("no GPU controller is configured on this installation".into())
    }
}

#[derive(Clone)]
pub struct Backends {
    pub sandbox: Arc<dyn Sandbox>,
    pub fetcher: Arc<dyn Fetcher>,
    pub searcher: Arc<dyn Searcher>,
    pub sender: Arc<dyn Sender>,
    pub gpu: Arc<dyn GpuControl>,
}
#[derive(Clone)]
pub struct BrokerConfig {
    /// Extra locations that are never readable or writable (operator state, other workspaces).
    pub deny_roots: Vec<PathBuf>,
    pub approval_timeout: Duration,
    pub poll_interval: Duration,
    /// Docker network used when a sandbox run is granted network access.
    pub sandbox_network: String,
    pub result_cap: usize,
}
impl Default for BrokerConfig {
    fn default() -> Self {
        Self {
            deny_roots: vec![],
            approval_timeout: Duration::from_secs(15 * 60),
            poll_interval: Duration::from_secs(1),
            sandbox_network: "bridge".into(),
            result_cap: 16 * 1024,
        }
    }
}
pub struct Broker {
    pub store: Store,
    pub config: BrokerConfig,
    pub backends: Backends,
}

struct Done {
    ok: bool,
    text: String,
    summary: String,
}
fn cut(text: &str, max: usize) -> String {
    let mut end = text.len().min(max);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    if end < text.len() {
        format!("{}\n[truncated, {} bytes total]", &text[..end], text.len())
    } else {
        text.to_owned()
    }
}
fn fail(message: impl Into<String>) -> Done {
    let m = message.into();
    Done {
        ok: false,
        summary: m.clone(),
        text: format!("error: {m}"),
    }
}

impl Broker {
    /// Handle one model request and return the text the model sees.
    pub async fn handle(
        &self,
        thread: &RestrictedRunnerThread,
        name: &str,
        arguments: &str,
    ) -> String {
        match self.handle_inner(thread, name, arguments).await {
            Ok(text) => text,
            Err(()) => "error: the broker could not record this request, so it was not run".into(),
        }
    }

    async fn handle_inner(
        &self,
        thread: &RestrictedRunnerThread,
        name: &str,
        arguments: &str,
    ) -> Result<String, ()> {
        let (conv, sess) = (&thread.conversation_id, thread.session_id.as_str());
        let store = &self.store;
        let action = match parse(name, arguments) {
            Ok(a) => a,
            Err(error) => {
                let reason = match error {
                    ParseError::Unknown(n) => format!("unknown action '{n}'"),
                    ParseError::Invalid(m) => format!("invalid request ({m})"),
                };
                let request = serde_json::json!({"name": name.chars().take(64).collect::<String>(), "arguments_bytes": arguments.len()}).to_string();
                let id = store
                    .restricted_audit_begin(
                        conv,
                        sess,
                        "invalid",
                        &request,
                        RestrictedDecision::Deny,
                        RestrictedDecider::Policy,
                        Some(&reason),
                    )
                    .await
                    .map_err(|_| ())?;
                let text = format!("not allowed: {reason}");
                store
                    .restricted_audit_result(id, "denied", &text)
                    .await
                    .map_err(|_| ())?;
                return Ok(text);
            }
        };
        let request = action.audit_request();
        let verdict = decide(&thread.policy, &self.config.deny_roots, &action);
        let (audit, approved_by) = match verdict {
            Verdict::Deny(reason) => {
                let id = store
                    .restricted_audit_begin(
                        conv,
                        sess,
                        action.name(),
                        &request,
                        RestrictedDecision::Deny,
                        RestrictedDecider::Policy,
                        Some(&reason),
                    )
                    .await
                    .map_err(|_| ())?;
                let text = format!("not allowed: {reason}");
                store
                    .restricted_audit_result(id, "denied", &text)
                    .await
                    .map_err(|_| ())?;
                return Ok(text);
            }
            Verdict::Allow => (
                store
                    .restricted_audit_begin(
                        conv,
                        sess,
                        action.name(),
                        &request,
                        RestrictedDecision::Allow,
                        RestrictedDecider::Policy,
                        None,
                    )
                    .await
                    .map_err(|_| ())?,
                RestrictedDecider::Policy,
            ),
            Verdict::Ask(ask) => {
                if let Some(key) = &ask.grant_key {
                    if store
                        .restricted_grant_active(conv, sess, key)
                        .await
                        .map_err(|_| ())?
                    {
                        let id = store
                            .restricted_audit_begin(
                                conv,
                                sess,
                                action.name(),
                                &request,
                                RestrictedDecision::Allow,
                                RestrictedDecider::SessionGrant,
                                Some(&format!("session grant: {key}")),
                            )
                            .await
                            .map_err(|_| ())?;
                        let done = self.execute(thread, &action).await;
                        return self.finish(id, done).await;
                    }
                }
                match self.ask_owner(thread, &action, &request, &ask).await? {
                    Ok(id) => (id, RestrictedDecider::Owner),
                    Err(text) => return Ok(text),
                }
            }
        };
        let _ = approved_by;
        let done = self.execute(thread, &action).await;
        self.finish(audit, done).await
    }

    async fn finish(&self, audit: i64, done: Done) -> Result<String, ()> {
        self.store
            .restricted_audit_result(
                audit,
                if done.ok { "ok" } else { "error" },
                &cut(&done.summary, 3900),
            )
            .await
            .map_err(|_| ())?;
        Ok(cut(&done.text, self.config.result_cap))
    }

    /// Returns `Ok(Ok(audit_id))` when approved, `Ok(Err(text))` with the denial for the model.
    async fn ask_owner(
        &self,
        thread: &RestrictedRunnerThread,
        action: &Action,
        request: &str,
        ask: &Ask,
    ) -> Result<Result<i64, String>, ()> {
        let (conv, sess) = (&thread.conversation_id, thread.session_id.as_str());
        let store = &self.store;
        let audit = store
            .restricted_audit_begin(
                conv,
                sess,
                action.name(),
                request,
                RestrictedDecision::Ask,
                RestrictedDecider::Policy,
                Some(&ask.reason),
            )
            .await
            .map_err(|_| ())?;
        let mut summary = self.summary(thread, action);
        if matches!(action, Action::StartGpu { .. }) {
            match self.backends.gpu.precheck().await {
                Ok(info) if !info.is_empty() => summary = format!("{summary}\n{info}"),
                Ok(_) => {}
                Err(reason) => {
                    store
                        .restricted_audit_settle(
                            audit,
                            RestrictedDecision::Deny,
                            RestrictedDecider::Policy,
                            Some(&reason),
                            None,
                        )
                        .await
                        .map_err(|_| ())?;
                    let text = format!("not allowed: {reason}");
                    store
                        .restricted_audit_result(audit, "denied", &text)
                        .await
                        .map_err(|_| ())?;
                    return Ok(Err(text));
                }
            }
        }
        let approval = store
            .restricted_approval_create(
                conv,
                sess,
                audit,
                action.name(),
                &summary,
                ask.grant_key.as_deref(),
                self.config.approval_timeout.as_millis() as i64,
            )
            .await
            .map_err(|_| ())?;
        let status = loop {
            let status = store
                .restricted_approval_status(&approval)
                .await
                .map_err(|_| ())?;
            if status.state != RestrictedApprovalState::Pending {
                break status;
            }
            tokio::time::sleep(self.config.poll_interval).await;
        };
        match status.state {
            RestrictedApprovalState::Approved => {
                let how = match status.scope {
                    Some(RestrictedApprovalScope::Session) => "owner approved for this session",
                    _ => "owner approved once",
                };
                store
                    .restricted_audit_settle(
                        audit,
                        RestrictedDecision::Allow,
                        RestrictedDecider::Owner,
                        Some(how),
                        Some(&approval),
                    )
                    .await
                    .map_err(|_| ())?;
                Ok(Ok(audit))
            }
            state => {
                let (decider, reason) = if state == RestrictedApprovalState::Denied {
                    (RestrictedDecider::Owner, "the owner declined")
                } else {
                    (
                        RestrictedDecider::Timeout,
                        "the owner did not respond in time",
                    )
                };
                store
                    .restricted_audit_settle(
                        audit,
                        RestrictedDecision::Deny,
                        decider,
                        Some(reason),
                        Some(&approval),
                    )
                    .await
                    .map_err(|_| ())?;
                let text = format!("not allowed: {reason}");
                store
                    .restricted_audit_result(audit, "denied", &text)
                    .await
                    .map_err(|_| ())?;
                Ok(Err(text))
            }
        }
    }

    fn summary(&self, thread: &RestrictedRunnerThread, action: &Action) -> String {
        match action {
            Action::SendMessage { to, body } => {
                format!("Send a message to {to}: {}", cut(body, 1200))
            }
            Action::WriteFile { path, content } => {
                let real = match classify(
                    Path::new(&thread.policy.workspace),
                    &self.config.deny_roots,
                    path,
                ) {
                    PathClass::Outside(p) | PathClass::Inside(p) => p.display().to_string(),
                    PathClass::Denied(_) => path.clone(),
                };
                format!(
                    "Write {} bytes to {real}: {}",
                    content.len(),
                    cut(content, 300)
                )
            }
            Action::RunSandboxed { command, .. } => format!(
                "Run in the sandbox WITH NETWORK ACCESS: {}",
                cut(command, 1200)
            ),
            Action::StartGpu { reason } => {
                format!("Start the GPU (this spends money): {}", cut(reason, 600))
            }
            other => other.audit_request(),
        }
    }

    async fn execute(&self, thread: &RestrictedRunnerThread, action: &Action) -> Done {
        let policy = &thread.policy;
        let ws = Path::new(&policy.workspace);
        match action {
            Action::Forbidden { .. } => fail("not available"),
            Action::ReadFile { path } => match classify(ws, &self.config.deny_roots, path) {
                PathClass::Inside(real) => match tokio::fs::read(&real).await {
                    Ok(bytes) if bytes.len() > 1024 * 1024 => fail("file is larger than 1 MiB"),
                    Ok(bytes) => match String::from_utf8(bytes) {
                        Ok(text) => Done {
                            ok: true,
                            summary: format!("read {} bytes", text.len()),
                            text,
                        },
                        Err(_) => fail("file is not UTF-8 text"),
                    },
                    Err(e) => fail(format!("cannot read: {}", e.kind())),
                },
                _ => Done {
                    ok: false,
                    summary: "not allowed".into(),
                    text: "not allowed: reads are limited to this thread's own workspace".into(),
                },
            },
            Action::ListDir { path } => match classify(ws, &self.config.deny_roots, path) {
                PathClass::Inside(real) => match std::fs::read_dir(&real) {
                    Ok(entries) => {
                        let mut names: Vec<String> = entries
                            .filter_map(|e| e.ok())
                            .filter(|e| {
                                !e.file_name()
                                    .to_str()
                                    .is_some_and(crate::paths::is_secret_name)
                            })
                            .map(|e| {
                                let t = e.file_type().ok();
                                let suffix = match t {
                                    Some(t) if t.is_dir() => "/",
                                    Some(t) if t.is_symlink() => "@",
                                    _ => "",
                                };
                                format!("{}{suffix}", e.file_name().to_string_lossy())
                            })
                            .collect();
                        names.sort();
                        names.truncate(500);
                        Done {
                            ok: true,
                            summary: format!("{} entries", names.len()),
                            text: names.join("\n"),
                        }
                    }
                    Err(e) => fail(format!("cannot list: {}", e.kind())),
                },
                _ => Done {
                    ok: false,
                    summary: "not allowed".into(),
                    text: "not allowed: listing is limited to this thread's own workspace".into(),
                },
            },
            Action::WriteFile { path, content } => self.write(thread, path, content).await,
            Action::WebSearch { query } => match self.backends.searcher.search(query).await {
                Ok(text) => Done {
                    ok: true,
                    summary: format!("{} bytes", text.len()),
                    text,
                },
                Err(e) => fail(e),
            },
            Action::FetchUrl { url } => match self.backends.fetcher.fetch(url).await {
                Ok(text) => Done {
                    ok: true,
                    summary: format!("{} bytes", text.len()),
                    text,
                },
                Err(e) => fail(e),
            },
            Action::DraftMessage { to, body } => {
                let rel = format!(
                    "drafts/{}-{}.md",
                    crate::now_secs(),
                    &uuid::Uuid::new_v4().simple().to_string()[..8]
                );
                let content = format!("To: {to}\n\n{body}\n");
                let done = self.write(thread, &rel, &content).await;
                if done.ok {
                    Done {
                        ok: true,
                        summary: format!("draft saved as {rel}"),
                        text: format!("draft saved as {rel}; it was not sent"),
                    }
                } else {
                    done
                }
            }
            Action::SendMessage { to, body } => match self.backends.sender.send(to, body).await {
                Ok(text) => Done {
                    ok: true,
                    summary: cut(&text, 300),
                    text,
                },
                Err(e) => fail(e),
            },
            Action::RunSandboxed {
                command,
                network,
                timeout_secs,
            } => {
                let (uid, gid) = mount_identity(ws);
                let timeout = (*timeout_secs)
                    .unwrap_or(policy.sandbox_timeout_secs)
                    .min(policy.sandbox_timeout_secs);
                let spec = SandboxSpec {
                    name: format!("orkestr-rt-{}", uuid::Uuid::new_v4().simple()),
                    image: policy.sandbox_image.clone(),
                    workspace: std::fs::canonicalize(ws).unwrap_or_else(|_| ws.to_path_buf()),
                    writable: policy.sandbox_workspace_writable,
                    // Reaching here with network=true means policy or the owner allowed it.
                    network: network.then(|| self.config.sandbox_network.clone()),
                    cpus: policy.sandbox_cpus,
                    memory_mb: policy.sandbox_memory_mb,
                    timeout: Duration::from_secs(timeout as u64),
                    command: command.clone(),
                    uid,
                    gid,
                };
                let result = self.backends.sandbox.run(spec).await;
                Done {
                    ok: result.ok(),
                    summary: cut(&result.render(), 1500),
                    text: result.render(),
                }
            }
            Action::StartGpu { reason } => match self.backends.gpu.start(reason).await {
                Ok(text) => Done {
                    ok: true,
                    summary: cut(&text, 300),
                    text,
                },
                Err(e) => fail(e),
            },
        }
    }

    async fn write(&self, thread: &RestrictedRunnerThread, path: &str, content: &str) -> Done {
        let ws = Path::new(&thread.policy.workspace);
        // Re-classify at execution time: what was approved is judged again.
        let (real, inside) = match classify(ws, &self.config.deny_roots, path) {
            PathClass::Inside(p) => (p, true),
            PathClass::Outside(p) => (p, false),
            PathClass::Denied(r) => {
                return Done {
                    ok: false,
                    summary: "not allowed".into(),
                    text: format!("not allowed: {r}"),
                }
            }
        };
        if inside {
            if let Some(parent) = real.parent() {
                if std::fs::create_dir_all(parent).is_err() {
                    return fail("cannot create the directory");
                }
                // The directories just created could not have been symlinks; confirm.
                if !matches!(
                    classify(ws, &self.config.deny_roots, path),
                    PathClass::Inside(_)
                ) {
                    return Done {
                        ok: false,
                        summary: "not allowed".into(),
                        text: "not allowed: path changed".into(),
                    };
                }
            }
        }
        match tokio::fs::write(&real, content).await {
            Ok(()) => Done {
                ok: true,
                summary: format!("wrote {} bytes to {}", content.len(), real.display()),
                text: format!("wrote {} bytes", content.len()),
            },
            Err(e) => fail(format!("cannot write: {}", e.kind())),
        }
    }
}
