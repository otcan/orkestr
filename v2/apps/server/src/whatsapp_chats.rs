//! "New WhatsApp chat" from the Rust UI, like V1's
//! `orkestr create "<name>" --wa-participant …`, wired straight to V2:
//!
//! 1. the native conversation (keyed by the owner's request id) and its
//!    provider, model and effort;
//! 2. a V1 thread (`POST /api/threads` with a fresh id) and a WhatsApp group
//!    with the owner's numbers (`POST /api/connectors/whatsapp/thread-groups`);
//! 3. an enabled adapter binding (`PUT /bindings/<route>` on the loopback
//!    adapter) that routes the V1 thread to the conversation, with the full
//!    onboarding template: Fast answers the owner only, 24 outstanding inputs,
//!    no extra participants, `owner_only_verified: false` (an operator sets it
//!    after a membership check) and, with `rules_dir`, a generated chat rules
//!    file as `instructions_path`;
//! 4. the V1 delegated binding (`PUT /api/threads/:id/binding` with
//!    `remoteBackend`, `remoteThreadId`, runtime and mirror on, legacy mirror
//!    off).
//!
//! Every stage is idempotent and recorded (migration 0058), so a retry with the
//! same request id continues where the last attempt stopped. Inbound group
//! messages start once an operator registers the new group with the scoped
//! relay (`relay_pending` → `ready`). Owner numbers, accounts and the adapter
//! token come from a private server file and never reach the browser.
use crate::desktop_broker::{Broker, BrokerError};
use orkestr_v2_contracts::valid_v1_thread_id;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::Path;

/// Environment variable naming the private configuration file.
pub const CONFIG_ENV: &str = "ORKESTR_V2_WHATSAPP_CHATS_CONFIG";
const MAX_PARTICIPANTS: usize = 16;
const RESPONSE_CAP: usize = 2 * 1024 * 1024;
/// V1 creates the group on WhatsApp before it answers (observed: over 12 s).
const GROUP_DEADLINE: std::time::Duration = std::time::Duration::from_secs(90);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FileConfig {
    /// Loopback adapter (`http://127.0.0.1:<port>`) and its bearer token.
    adapter_url: String,
    adapter_token: String,
    /// V1 `ORKESTR_REMOTE_THREAD_BACKENDS_JSON` key of that adapter.
    remote_backend: String,
    /// Owner WhatsApp ids added to every new group (`<digits>@c.us`).
    participants: Vec<String>,
    /// Adapter principals allowed to instruct the conversation.
    allowed_principals: Vec<String>,
    #[serde(default)]
    receiving_account_id: Option<String>,
    #[serde(default)]
    reply_account_id: Option<String>,
    #[serde(default)]
    reply_prefix: Option<String>,
    #[serde(default = "default_outstanding")]
    max_outstanding_inputs: u32,
    #[serde(default = "default_true")]
    attachments: bool,
    /// Adapter Fast policy of a new binding (`owner_only`, `legacy`, `disabled`).
    #[serde(default = "default_fast_reply_policy")]
    fast_reply_policy: String,
    /// Absolute directory for generated chat rules files (`chat-<conversation>.md`).
    /// Without it a new binding has no `instructions_path`.
    #[serde(default)]
    rules_dir: Option<String>,
}
fn default_outstanding() -> u32 {
    24
}
fn default_fast_reply_policy() -> String {
    "owner_only".into()
}
/// The adapter refuses an `instructions_path` with control characters or brackets.
fn rules_dir_valid(value: &str) -> bool {
    value.starts_with('/')
        && value.len() <= 900
        && !value
            .chars()
            .any(|c| c.is_control() || c == '[' || c == ']')
}
fn default_true() -> bool {
    true
}

fn whatsapp_id(value: &str) -> bool {
    value.split_once('@').is_some_and(|(user, domain)| {
        (5..=24).contains(&user.len())
            && user.bytes().all(|b| b.is_ascii_digit())
            && matches!(domain, "c.us" | "lid" | "s.whatsapp.net")
    })
}
fn short_key(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.:@".contains(&b))
}

/// Validated private configuration and the adapter client.
pub(crate) struct WhatsAppChats {
    adapter: Broker,
    remote_backend: String,
    participants: Vec<String>,
    allowed_principals: Vec<String>,
    receiving_account_id: Option<String>,
    reply_account_id: Option<String>,
    reply_prefix: Option<String>,
    max_outstanding_inputs: u32,
    attachments: bool,
    fast_reply_policy: String,
    rules_dir: Option<String>,
    /// One provisioning run at a time (V1 group creation is not concurrent-safe).
    pub(crate) lock: tokio::sync::Mutex<()>,
}

impl WhatsAppChats {
    /// A private 0600 regular file owned by the service user.
    pub(crate) fn load(path: &Path) -> Result<Self, &'static str> {
        use std::os::unix::fs::MetadataExt;
        let meta =
            std::fs::symlink_metadata(path).map_err(|_| "whatsapp chats config unreadable")?;
        let uid = std::fs::metadata("/proc/self")
            .map(|m| m.uid())
            .unwrap_or(u32::MAX);
        if !meta.file_type().is_file() || meta.mode() & 0o077 != 0 || meta.uid() != uid {
            return Err("whatsapp chats config must be a private regular file");
        }
        let raw = std::fs::read(path).map_err(|_| "whatsapp chats config unreadable")?;
        let config: FileConfig =
            serde_json::from_slice(&raw).map_err(|_| "whatsapp chats config invalid")?;
        Self::new(config)
    }

    fn new(config: FileConfig) -> Result<Self, &'static str> {
        let invalid = "whatsapp chats config invalid";
        if config.participants.is_empty()
            || config.participants.len() > MAX_PARTICIPANTS
            || !config.participants.iter().all(|p| whatsapp_id(p))
            || config.allowed_principals.is_empty()
            || !config.allowed_principals.iter().all(|p| short_key(p, 128))
            || !short_key(&config.remote_backend, 64)
            || !(1..=64).contains(&config.max_outstanding_inputs)
            || !matches!(
                config.fast_reply_policy.as_str(),
                "owner_only" | "legacy" | "disabled"
            )
            || config
                .rules_dir
                .as_deref()
                .is_some_and(|d| !rules_dir_valid(d))
            || config
                .receiving_account_id
                .iter()
                .chain(config.reply_account_id.iter())
                .any(|a| !short_key(a, 128))
            || config
                .reply_prefix
                .as_deref()
                .is_some_and(|p| p.is_empty() || p.len() > 64 || p.chars().any(char::is_control))
            || config.adapter_token.len() < 32
            || !config
                .adapter_token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric())
        {
            return Err(invalid);
        }
        Ok(Self {
            adapter: Broker::new(&config.adapter_url, config.adapter_token)?,
            remote_backend: config.remote_backend,
            participants: config.participants,
            allowed_principals: config.allowed_principals,
            receiving_account_id: config.receiving_account_id,
            reply_account_id: config.reply_account_id,
            reply_prefix: config.reply_prefix,
            max_outstanding_inputs: config.max_outstanding_inputs,
            attachments: config.attachments,
            fast_reply_policy: config.fast_reply_policy,
            rules_dir: config.rules_dir,
            lock: tokio::sync::Mutex::new(()),
        })
    }

    pub(crate) fn participant_count(&self) -> u32 {
        self.participants.len() as u32
    }
}

/// A stage that did not complete: a stable code for the owner and the log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct StageError(pub &'static str);

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
}

/// V1 `POST /api/threads` body. V1 returns an existing thread of the same
/// owner when the id *or the name* matches, so the caller must check the id.
pub(crate) fn thread_body(thread_id: &str, name: &str, workspace: Option<&str>) -> Value {
    let mut body = json!({"id": thread_id, "name": name});
    if let Some(workspace) = workspace {
        body["cwd"] = json!(workspace);
    }
    body
}

/// V1 `POST /api/connectors/whatsapp/thread-groups` body, as `orkestr create`
/// sends it, except that the legacy mirror is off from the start (the scoped
/// relay and the adapter deliver replies).
pub(crate) fn group_body(chats: &WhatsAppChats, thread_id: &str, name: &str) -> Value {
    let mut body = json!({
        "threadId": thread_id,
        "name": name,
        "participantIds": chats.participants,
        "adminParticipantIds": chats.participants,
        "promoteParticipantsAsAdmins": true,
        "generatePicture": false,
        "mirrorToWhatsApp": false,
        "forceNew": false,
    });
    if let Some(account) = &chats.reply_account_id {
        for key in [
            "replyAccountId",
            "bridgeAccountId",
            "responderAccountId",
            "outboundAccountId",
        ] {
            body[key] = json!(account);
        }
    }
    if let Some(account) = &chats.receiving_account_id {
        body["receivingAccountId"] = json!(account);
        body["senderAccountId"] = json!(account);
    }
    if let Some(prefix) = &chats.reply_prefix {
        body["replyPrefix"] = json!(prefix);
    }
    body
}

/// The generated chat rules for a new chat. The adapter puts a "read this
/// file" line on every intake, so a new chat starts with the same onboarding
/// rules as a hand-provisioned one. Operators extend it (desktop, desk-login,
/// business rules); a retry never overwrites it.
pub(crate) fn rules_text(name: &str, conversation: &str, thread_id: &str, chat_id: &str) -> String {
    let name: String = name.chars().filter(|c| !c.is_control()).collect();
    format!(
        "Chat rules: {name}\n\
\n\
Generated when this WhatsApp chat was created (\"New WhatsApp chat\").\n\
V2 conversation {conversation}, V1 thread {thread_id}, WhatsApp group {chat_id}.\n\
Existing workspace AGENTS.md and business rules stay in force; report any\n\
conflict to Root before acting.\n\
\n\
Group and replies\n\
- Only the owner instructs this chat. Fast answers the owner only; other\n\
  members are not authorized until Root lists them as participants.\n\
- Never send test or probe messages into this or any other real chat.\n\
- Never print secrets, tokens, grant files or server paths into the chat.\n\
\n\
Desktop and logins\n\
- No managed desktop is granted to this chat yet. Never create desktops,\n\
  aliases, shares or grants yourself and never use another chat's desktop or\n\
  grant. If the owner asks for a desktop, tell them Root sets it up and report\n\
  it to Root. Root then adds the managed desktop, its V1 grant, the V2\n\
  desktop binding with a grant env file, and a desktop section to this file.\n\
- Login pages: use desk-login only after Root has added it to this file for a\n\
  granted desktop. Never type, print or ask for passwords.\n\
\n\
Timers\n\
- This chat runs on V2. Do not create, pause, change or delete timers through\n\
  the V1 API or CLI; ask Root for any timer change.\n"
    )
}

/// Writes the chat's rules file once (`<rules_dir>/chat-<conversation>.md`,
/// 0640) and returns its path; `None` without a configured `rules_dir`. An
/// existing file (an earlier attempt, or an operator's edit) is kept.
pub(crate) fn write_rules(
    chats: &WhatsAppChats,
    conversation: &str,
    thread_id: &str,
    chat_id: &str,
    name: &str,
) -> Result<Option<String>, StageError> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let Some(dir) = chats.rules_dir.as_deref() else {
        return Ok(None);
    };
    let failed = StageError("chat_rules_failed");
    if !conversation
        .bytes()
        .all(|b| b.is_ascii_hexdigit() || b == b'-')
    {
        return Err(failed);
    }
    let path = Path::new(dir).join(format!("chat-{conversation}.md"));
    if path.is_file() {
        return Ok(Some(path.to_string_lossy().into_owned()));
    }
    // Create-only and atomic: write a private temp file, then hard-link it.
    let temp = Path::new(dir).join(format!(".chat-{conversation}.{}.tmp", uuid::Uuid::new_v4()));
    let written = (|| -> std::io::Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o640)
            .open(&temp)?;
        file.write_all(rules_text(name, conversation, thread_id, chat_id).as_bytes())?;
        file.sync_all()?;
        match std::fs::hard_link(&temp, &path) {
            Err(e) if e.kind() != std::io::ErrorKind::AlreadyExists => Err(e),
            _ => Ok(()),
        }
    })();
    let _ = std::fs::remove_file(&temp);
    written.map_err(|_| failed)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// The adapter binding document for a fresh group thread: the full onboarding
/// template. `owner_only_verified` stays false and `participants` empty until
/// an operator has checked the group's members.
#[allow(clippy::too_many_arguments)]
pub(crate) fn binding_document(
    chats: &WhatsAppChats,
    conversation: &str,
    thread_id: &str,
    chat_id: &str,
    account_id: &str,
    route: &str,
    excluded: Vec<String>,
    instructions_path: Option<&str>,
) -> Value {
    let mut document = json!({
        "conversation_id": conversation,
        "public_thread_id": thread_id,
        "chat_id": chat_id,
        "account_id": account_id,
        "remote_thread_id": route,
        "allowed_principals": chats.allowed_principals,
        "excluded_public_ids": excluded,
        "automatic_accept_roles": ["fast", "deep"],
        "outbound_role": "deep",
        "enabled": true,
        "revoked": false,
        "progress_updates": false,
        "attachments": chats.attachments,
        "max_outstanding_inputs": chats.max_outstanding_inputs,
        "fast_reply_policy": chats.fast_reply_policy,
        "participants": [],
        "owner_only_verified": false,
    });
    if let Some(path) = instructions_path {
        document["instructions_path"] = json!(path);
    }
    document
}

/// V1 `PUT /api/threads/:id/binding`: delegate the runtime to the adapter.
pub(crate) fn delegation_body(chats: &WhatsAppChats, route: &str) -> Value {
    json!({
        "remoteBackend": chats.remote_backend,
        "remoteThreadId": route,
        "remoteRuntimeEnabled": true,
        "remoteMirrorEnabled": true,
        "mirrorToWhatsApp": false,
    })
}

async fn call(
    client: &Broker,
    method: &str,
    path: &str,
    body: Value,
    code: &'static str,
) -> Result<Value, StageError> {
    match client.write(method, path, body, RESPONSE_CAP).await {
        Ok((200..=299, value)) => Ok(value),
        Ok((_, value)) if outcome_unknown(&value) => {
            Err(StageError("whatsapp_group_outcome_unknown"))
        }
        Ok(_) | Err(BrokerError::Leased | BrokerError::Lost | BrokerError::Denied) => {
            Err(StageError(code))
        }
        Err(BrokerError::Unavailable) => Err(StageError(code)),
    }
}

/// V1's group provisioning reports an unknown external outcome: the group may
/// exist. V1 keeps the operation and reconciles it on the next attempt; it
/// needs an operator review before anything else is created.
pub(crate) fn outcome_unknown(value: &Value) -> bool {
    ["provisioning", "groupCreateFailure", "failure"]
        .iter()
        .any(|key| {
            value.get(*key).is_some_and(|p| {
                text(p, "externalOutcome").as_deref() == Some("outcome_unknown")
                    || text(p, "state").as_deref() == Some("outcome_unknown")
            })
        })
}

/// Stage 2: the V1 thread under the provision's own id.
pub(crate) async fn create_thread(
    v1: &Broker,
    thread_id: &str,
    name: &str,
    workspace: Option<&str>,
) -> Result<(), StageError> {
    let value = call(
        v1,
        "POST",
        "/api/threads",
        thread_body(thread_id, name, workspace),
        "v1_thread_failed",
    )
    .await?;
    let created = value.get("thread").and_then(|t| text(t, "id"));
    if created.as_deref() != Some(thread_id) {
        // V1 matched an existing thread by name: never take it over.
        return Err(StageError("v1_thread_name_taken"));
    }
    Ok(())
}

/// The group a successful (or reused) thread-group answer bound.
pub(crate) struct Group {
    pub chat_id: String,
    pub account_id: String,
}

pub(crate) fn group_from(value: &Value) -> Option<Group> {
    let binding = value.get("binding")?;
    let chat_id = value
        .get("chat")
        .and_then(|c| text(c, "id"))
        .or_else(|| text(binding, "chatId"))
        .filter(|c| c.ends_with("@g.us") && c.len() <= 256)?;
    let account_id = [
        "responderAccountId",
        "replyAccountId",
        "outboundAccountId",
        "bridgeAccountId",
    ]
    .iter()
    .find_map(|k| text(binding, k))
    .or_else(|| text(value, "responderAccountId"))
    .filter(|a| short_key(a, 256))?;
    Some(Group {
        chat_id,
        account_id,
    })
}

/// Stage 3: the WhatsApp group with the owner's numbers, bound to the thread.
/// V1 journals the operation and reuses the group on a retry.
pub(crate) async fn create_group(
    v1: &Broker,
    chats: &WhatsAppChats,
    thread_id: &str,
    name: &str,
) -> Result<Group, StageError> {
    let value = match v1
        .write_within(
            GROUP_DEADLINE,
            "POST",
            "/api/connectors/whatsapp/thread-groups",
            group_body(chats, thread_id, name),
            RESPONSE_CAP,
        )
        .await
    {
        Ok((200..=299, value)) => value,
        Ok((_, value)) if outcome_unknown(&value) => {
            return Err(StageError("whatsapp_group_outcome_unknown"))
        }
        Ok(_) => return Err(StageError("whatsapp_group_failed")),
        // No answer: V1 may still be creating it; the retry reconciles.
        Err(_) => return Err(StageError("whatsapp_group_unconfirmed")),
    };
    group_from(&value).ok_or(StageError("whatsapp_group_unconfirmed"))
}

/// Owner inputs already in the V1 thread; the adapter never imports them.
pub(crate) async fn existing_inputs(
    v1: &Broker,
    thread_id: &str,
) -> Result<Vec<String>, StageError> {
    let path = format!("/api/threads/{thread_id}/messages?limit=200");
    let value = match v1.read(&path, RESPONSE_CAP).await {
        Ok((200, value)) => value,
        _ => return Err(StageError("v1_messages_unavailable")),
    };
    let messages = value
        .get("messages")
        .and_then(Value::as_array)
        .ok_or(StageError("v1_messages_unavailable"))?;
    if value.get("hasMoreBefore").and_then(Value::as_bool) == Some(true) {
        return Err(StageError("v1_thread_not_fresh"));
    }
    Ok(messages
        .iter()
        .filter(|m| m.get("role").and_then(Value::as_str) == Some("user"))
        .filter_map(|m| text(m, "id"))
        .collect())
}

/// Stage 4: the enabled adapter binding (create-only on the adapter).
pub(crate) async fn bind_adapter(
    chats: &WhatsAppChats,
    route: &str,
    document: Value,
) -> Result<(), StageError> {
    let value = match chats
        .adapter
        .write("PUT", &format!("/bindings/{route}"), document, RESPONSE_CAP)
        .await
    {
        Ok((200, value)) => value,
        Ok((409, _)) => return Err(StageError("adapter_binding_conflict")),
        _ => return Err(StageError("adapter_binding_failed")),
    };
    match value.get("state").and_then(Value::as_str) {
        Some("enabled") => Ok(()),
        _ => Err(StageError("adapter_binding_not_enabled")),
    }
}

/// Stage 5: V1 delegates the thread's runtime; checked by reading it back.
pub(crate) async fn delegate(
    v1: &Broker,
    chats: &WhatsAppChats,
    thread_id: &str,
    route: &str,
) -> Result<(), StageError> {
    call(
        v1,
        "PUT",
        &format!("/api/threads/{thread_id}/binding"),
        delegation_body(chats, route),
        "v1_delegation_failed",
    )
    .await?;
    let value = match v1
        .read(&format!("/api/threads/{thread_id}"), RESPONSE_CAP)
        .await
    {
        Ok((200, value)) => value,
        _ => return Err(StageError("v1_delegation_unconfirmed")),
    };
    let binding = value.get("thread").and_then(|t| t.get("binding"));
    let confirmed = binding.is_some_and(|b| {
        text(b, "remoteThreadId").as_deref() == Some(route)
            && b.get("remoteRuntimeEnabled").and_then(Value::as_bool) == Some(true)
            && b.get("mirrorToWhatsApp").and_then(Value::as_bool) == Some(false)
    });
    if confirmed {
        Ok(())
    } else {
        Err(StageError("v1_delegation_unconfirmed"))
    }
}

/// A fresh V1 thread id for a new provision.
pub(crate) fn new_thread_id() -> String {
    let id = uuid::Uuid::new_v4().to_string();
    debug_assert!(valid_v1_thread_id(&id));
    id
}

#[cfg(test)]
pub(crate) fn synthetic(adapter_url: &str, token: &str) -> WhatsAppChats {
    WhatsAppChats::new(FileConfig {
        adapter_url: adapter_url.into(),
        adapter_token: token.into(),
        remote_backend: "synthetic-v2".into(),
        participants: vec!["10000000001@c.us".into()],
        allowed_principals: vec!["synthetic-owner".into()],
        receiving_account_id: Some("synthetic-account".into()),
        reply_account_id: Some("synthetic-account".into()),
        reply_prefix: None,
        max_outstanding_inputs: 24,
        attachments: true,
        fast_reply_policy: default_fast_reply_policy(),
        rules_dir: None,
    })
    .unwrap()
}

#[cfg(test)]
impl WhatsAppChats {
    pub(crate) fn with_rules_dir(mut self, dir: &str) -> Self {
        self.rules_dir = Some(dir.into());
        self
    }
}

#[cfg(test)]
mod onboarding_tests {
    use super::*;

    fn config(policy: &str, rules_dir: Option<&str>) -> Result<WhatsAppChats, &'static str> {
        let mut raw = json!({
            "adapter_url": "http://127.0.0.1:1", "adapter_token": "a".repeat(32),
            "remote_backend": "synthetic-v2", "participants": ["10000000001@c.us"],
            "allowed_principals": ["synthetic-owner"], "fast_reply_policy": policy,
        });
        if let Some(dir) = rules_dir {
            raw["rules_dir"] = json!(dir);
        }
        WhatsAppChats::new(serde_json::from_value(raw).unwrap())
    }

    #[test]
    fn defaults_are_the_onboarding_template() {
        let raw = json!({
            "adapter_url": "http://127.0.0.1:1", "adapter_token": "a".repeat(32),
            "remote_backend": "synthetic-v2", "participants": ["10000000001@c.us"],
            "allowed_principals": ["synthetic-owner"],
        });
        let chats = WhatsAppChats::new(serde_json::from_value(raw).unwrap()).unwrap();
        let document = binding_document(&chats, "c", "t", "g@g.us", "a", "r", vec![], None);
        assert_eq!(document["fast_reply_policy"], "owner_only");
        assert_eq!(document["max_outstanding_inputs"], 24);
        assert_eq!(document["owner_only_verified"], false);
        assert_eq!(document["participants"], json!([]));
        assert!(document.get("instructions_path").is_none());
        assert!(write_rules(&chats, "c", "t", "g@g.us", "n")
            .unwrap()
            .is_none());
    }

    #[test]
    fn policy_and_rules_dir_are_validated() {
        assert!(config("legacy", Some("/srv/rules")).is_ok());
        assert!(config("everyone", None).is_err());
        assert!(config("owner_only", Some("relative/rules")).is_err());
        assert!(config("owner_only", Some("/srv/[rules]")).is_err());
    }
}
