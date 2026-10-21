//! The only thing the model can produce: a structured action request. Parsing is
//! strict (unknown fields refused) and names that map to forbidden capabilities are
//! recognised so the denial carries a precise reason instead of "unknown tool".
use serde::Deserialize;
use serde_json::Value;

pub const MAX_ARGUMENT_BYTES: usize = 256 * 1024;
pub const MAX_WRITE_BYTES: usize = 1024 * 1024;
pub const MAX_MESSAGE_BYTES: usize = 16 * 1024;
pub const MAX_COMMAND_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    ReadFile {
        path: String,
    },
    ListDir {
        path: String,
    },
    WriteFile {
        path: String,
        content: String,
    },
    WebSearch {
        query: String,
    },
    FetchUrl {
        url: String,
    },
    DraftMessage {
        to: String,
        body: String,
    },
    SendMessage {
        to: String,
        body: String,
    },
    RunSandboxed {
        command: String,
        network: bool,
        timeout_secs: Option<u32>,
    },
    StartGpu {
        reason: String,
    },
    /// A capability that is never available to this model, with the stable reason.
    Forbidden {
        name: String,
        reason: &'static str,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    Unknown(String),
    Invalid(String),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Path {
    path: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Write {
    path: String,
    content: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Query {
    query: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Url {
    url: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Message {
    to: String,
    body: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Run {
    command: String,
    #[serde(default)]
    network: bool,
    #[serde(default)]
    timeout_secs: Option<u32>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Gpu {
    reason: String,
}

const DELETES: &[&str] = &[
    "delete_file",
    "remove_file",
    "delete",
    "rm",
    "unlink",
    "delete_dir",
    "remove_dir",
    "rmdir",
    "delete_thread",
    "delete_message",
    "truncate_file",
    "move_file",
    "rename_file",
];
const HOST: &[&str] = &[
    "shell",
    "bash",
    "sh",
    "exec",
    "run_command",
    "run_shell",
    "run_host",
    "host_command",
    "sudo",
    "system",
    "terminal",
    "execute",
    "run_bash",
];
const SECRETS: &[&str] = &[
    "read_secret",
    "get_secret",
    "get_credentials",
    "read_credentials",
    "list_secrets",
    "get_env",
    "read_env",
    "env",
    "get_token",
    "read_token",
    "ssh",
    "keychain",
];
const OTHER_THREADS: &[&str] = &[
    "read_thread",
    "list_threads",
    "read_conversation",
    "list_conversations",
    "read_other_thread",
    "search_threads",
    "read_memory",
    "read_history",
];

pub fn parse(name: &str, arguments: &str) -> Result<Action, ParseError> {
    let lowered = name.trim().to_ascii_lowercase();
    for (names, reason) in [
        (DELETES, "deleting is never allowed"),
        (HOST, "host commands and sudo are never allowed"),
        (SECRETS, "credentials and secrets are never available"),
        (OTHER_THREADS, "other threads' data is never available"),
    ] {
        if names.contains(&lowered.as_str()) {
            return Ok(Action::Forbidden {
                name: lowered,
                reason,
            });
        }
    }
    if arguments.len() > MAX_ARGUMENT_BYTES {
        return Err(ParseError::Invalid("arguments too large".into()));
    }
    let known = matches!(
        lowered.as_str(),
        "read_file"
            | "list_dir"
            | "write_file"
            | "web_search"
            | "fetch_url"
            | "draft_message"
            | "send_message"
            | "run_sandboxed"
            | "start_gpu"
    );
    if !known {
        return Err(ParseError::Unknown(name.chars().take(64).collect()));
    }
    let value: Value = if arguments.trim().is_empty() {
        Value::Object(Default::default())
    } else {
        serde_json::from_str(arguments)
            .map_err(|_| ParseError::Invalid("arguments are not valid JSON".into()))?
    };
    fn args<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, ParseError> {
        serde_json::from_value(value)
            .map_err(|e| ParseError::Invalid(format!("bad arguments: {e}")))
    }
    let action = match lowered.as_str() {
        "read_file" => Action::ReadFile {
            path: args::<Path>(value)?.path,
        },
        "list_dir" => Action::ListDir {
            path: args::<Path>(value)?.path,
        },
        "write_file" => {
            let w = args::<Write>(value)?;
            Action::WriteFile {
                path: w.path,
                content: w.content,
            }
        }
        "web_search" => Action::WebSearch {
            query: args::<Query>(value)?.query,
        },
        "fetch_url" => Action::FetchUrl {
            url: args::<Url>(value)?.url,
        },
        "draft_message" => {
            let m = args::<Message>(value)?;
            Action::DraftMessage {
                to: m.to,
                body: m.body,
            }
        }
        "send_message" => {
            let m = args::<Message>(value)?;
            Action::SendMessage {
                to: m.to,
                body: m.body,
            }
        }
        "run_sandboxed" => {
            let r = args::<Run>(value)?;
            Action::RunSandboxed {
                command: r.command,
                network: r.network,
                timeout_secs: r.timeout_secs,
            }
        }
        _ => Action::StartGpu {
            reason: args::<Gpu>(value)?.reason,
        },
    };
    action.validate()?;
    Ok(action)
}

fn clean(text: &str, max: usize, what: &str, allow_newlines: bool) -> Result<(), ParseError> {
    if text.is_empty() || text.len() > max {
        return Err(ParseError::Invalid(format!("{what} is empty or too long")));
    }
    if text.contains('\0')
        || text
            .chars()
            .any(|c| c.is_control() && !(allow_newlines && matches!(c, '\n' | '\t' | '\r')))
    {
        return Err(ParseError::Invalid(format!(
            "{what} contains control characters"
        )));
    }
    Ok(())
}

impl Action {
    pub fn name(&self) -> &str {
        match self {
            Self::ReadFile { .. } => "read_file",
            Self::ListDir { .. } => "list_dir",
            Self::WriteFile { .. } => "write_file",
            Self::WebSearch { .. } => "web_search",
            Self::FetchUrl { .. } => "fetch_url",
            Self::DraftMessage { .. } => "draft_message",
            Self::SendMessage { .. } => "send_message",
            Self::RunSandboxed { .. } => "run_sandboxed",
            Self::StartGpu { .. } => "start_gpu",
            Self::Forbidden { name, .. } => name,
        }
    }
    fn validate(&self) -> Result<(), ParseError> {
        match self {
            Self::ReadFile { path } | Self::ListDir { path } => clean(
                path,
                orkestr_v2_contracts::RESTRICTED_PATH_MAX,
                "path",
                false,
            ),
            Self::WriteFile { path, content } => {
                clean(
                    path,
                    orkestr_v2_contracts::RESTRICTED_PATH_MAX,
                    "path",
                    false,
                )?;
                if content.len() > MAX_WRITE_BYTES || content.contains('\0') {
                    return Err(ParseError::Invalid("content is too large or binary".into()));
                }
                Ok(())
            }
            Self::WebSearch { query } => clean(query, 512, "query", false),
            Self::FetchUrl { url } => clean(url, 2048, "url", false),
            Self::DraftMessage { to, body } | Self::SendMessage { to, body } => {
                clean(to, 256, "recipient", false)?;
                clean(body, MAX_MESSAGE_BYTES, "message", true)
            }
            Self::RunSandboxed {
                command,
                timeout_secs,
                ..
            } => {
                clean(command, MAX_COMMAND_BYTES, "command", true)?;
                if timeout_secs.is_some_and(|t| t == 0) {
                    return Err(ParseError::Invalid("timeout_secs must be positive".into()));
                }
                Ok(())
            }
            Self::StartGpu { reason } => clean(reason, 512, "reason", true),
            Self::Forbidden { .. } => Ok(()),
        }
    }

    /// Bounded request record for the audit table. Large bodies keep a prefix and a length.
    pub fn audit_request(&self) -> String {
        fn cut(text: &str, max: usize) -> String {
            let mut end = text.len().min(max);
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            if end < text.len() {
                format!("{}… ({} bytes)", &text[..end], text.len())
            } else {
                text.to_owned()
            }
        }
        let value = match self {
            Self::ReadFile { path } | Self::ListDir { path } => {
                serde_json::json!({"path": cut(path, 1024)})
            }
            Self::WriteFile { path, content } => {
                serde_json::json!({"path": cut(path, 1024), "content": cut(content, 512)})
            }
            Self::WebSearch { query } => serde_json::json!({"query": cut(query, 512)}),
            Self::FetchUrl { url } => serde_json::json!({"url": cut(url, 1024)}),
            Self::DraftMessage { to, body } | Self::SendMessage { to, body } => {
                serde_json::json!({"to": cut(to, 256), "body": cut(body, 1024)})
            }
            Self::RunSandboxed {
                command,
                network,
                timeout_secs,
            } => {
                serde_json::json!({"command": cut(command, 2048), "network": network, "timeout_secs": timeout_secs})
            }
            Self::StartGpu { reason } => serde_json::json!({"reason": cut(reason, 512)}),
            Self::Forbidden { .. } => serde_json::json!({}),
        };
        value.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_actions_parse_strictly() {
        assert_eq!(
            parse("read_file", r#"{"path":"a.txt"}"#),
            Ok(Action::ReadFile {
                path: "a.txt".into()
            })
        );
        assert!(matches!(
            parse("read_file", r#"{"path":"a","mode":"w"}"#),
            Err(ParseError::Invalid(_))
        ));
        assert!(matches!(
            parse("read_file", "not json"),
            Err(ParseError::Invalid(_))
        ));
        assert!(matches!(
            parse("read_file", r#"{"path":"a\u0000b"}"#),
            Err(ParseError::Invalid(_))
        ));
        assert!(matches!(
            parse("fly_to_moon", "{}"),
            Err(ParseError::Unknown(_))
        ));
        assert!(matches!(
            parse("run_sandboxed", r#"{"command":"ls","timeout_secs":0}"#),
            Err(ParseError::Invalid(_))
        ));
    }
    #[test]
    fn forbidden_names_carry_a_reason_in_any_case() {
        for (name, needle) in [
            ("delete_file", "deleting"),
            ("RM", "deleting"),
            ("sudo", "host commands"),
            ("Bash", "host commands"),
            ("get_credentials", "credentials"),
            ("read_thread", "other threads"),
        ] {
            match parse(name, "{}") {
                Ok(Action::Forbidden { reason, .. }) => assert!(reason.contains(needle), "{name}"),
                other => panic!("{name}: {other:?}"),
            }
        }
    }
    #[test]
    fn audit_request_is_bounded() {
        let big = "é".repeat(100_000);
        let action = Action::WriteFile {
            path: "p".into(),
            content: big,
        };
        assert!(action.audit_request().len() < 2048);
    }
}
