//! The broker's decision function: action + per-thread policy -> allow, ask the
//! owner, or deny with a reason. Pure apart from reading file metadata to resolve
//! paths. The fixed rules (credentials, sudo/host, other threads, deletes -> deny;
//! sending, writes outside the workspace, spending, GPU -> ask) cannot be loosened
//! by the per-thread policy; the policy only switches optional capabilities on.
use crate::action::Action;
use crate::netcheck;
use crate::paths::{classify, PathClass};
use orkestr_v2_contracts::RestrictedPolicy;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ask {
    pub reason: String,
    /// Key under which "allow for this session" is remembered; `None` = never session-scoped.
    pub grant_key: Option<String>,
    pub grant_label: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Allow,
    Ask(Ask),
    Deny(String),
}
impl Verdict {
    fn deny(reason: &str) -> Self {
        Self::Deny(reason.to_owned())
    }
}

const HOST_TOKENS: &[&str] = &[
    "sudo",
    "doas",
    "su",
    "nsenter",
    "docker",
    "podman",
    "kubectl",
    "ssh",
    "scp",
    "chroot",
    "mount",
    "umount",
    "insmod",
    "modprobe",
    "systemctl",
    "crontab",
    "setcap",
];
const DELETE_TOKENS: &[&str] = &["rm", "rmdir", "unlink", "shred", "-delete", "--delete"];

/// Defense in depth only: the container is the boundary, this keeps obviously
/// out-of-scope intents out of the audit-as-allowed column.
fn command_verdict(command: &str) -> Option<Verdict> {
    let lowered = command.to_ascii_lowercase();
    if lowered.contains("docker.sock")
        || lowered.contains("/proc/1/")
        || lowered.contains("/var/run/docker")
    {
        return Some(Verdict::deny("host commands and sudo are never allowed"));
    }
    let tokens: Vec<&str> = lowered
        .split(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')))
        .filter(|t| !t.is_empty())
        .collect();
    if tokens.iter().any(|t| HOST_TOKENS.contains(t)) {
        return Some(Verdict::deny("host commands and sudo are never allowed"));
    }
    if tokens.iter().any(|t| DELETE_TOKENS.contains(t)) {
        return Some(Verdict::deny("deleting is never allowed"));
    }
    None
}

pub fn decide(policy: &RestrictedPolicy, deny_roots: &[PathBuf], action: &Action) -> Verdict {
    let workspace = Path::new(&policy.workspace);
    match action {
        Action::Forbidden { reason, .. } => Verdict::deny(reason),
        Action::ReadFile { path } | Action::ListDir { path } => {
            match classify(workspace, deny_roots, path) {
                PathClass::Inside(_) => Verdict::Allow,
                PathClass::Outside(_) => {
                    Verdict::deny("reads are limited to this thread's own workspace")
                }
                PathClass::Denied(reason) => Verdict::Deny(reason),
            }
        }
        Action::WriteFile { path, .. } => match classify(workspace, deny_roots, path) {
            PathClass::Inside(_) => Verdict::Allow,
            PathClass::Outside(real) => {
                let dir = real
                    .parent()
                    .map(|p| p.display().to_string())
                    .unwrap_or_else(|| "/".into());
                Verdict::Ask(Ask {
                    reason: "writing outside the thread workspace needs the owner".into(),
                    grant_key: Some(format!("write_outside:{dir}")),
                    grant_label: Some(format!("writes under {dir}")),
                })
            }
            PathClass::Denied(reason) => Verdict::Deny(reason),
        },
        Action::WebSearch { .. } => {
            if policy.web_enabled {
                Verdict::Allow
            } else {
                Verdict::deny("web access is disabled for this thread")
            }
        }
        Action::FetchUrl { url } => {
            if !policy.web_enabled {
                return Verdict::deny("web access is disabled for this thread");
            }
            match netcheck::screen(url) {
                Err(reason) => Verdict::Deny(reason),
                Ok(target) if !netcheck::host_allowed(&target.host, &policy.fetch_hosts) => {
                    Verdict::deny("that host is not on this thread's fetch allowlist")
                }
                Ok(_) => Verdict::Allow,
            }
        }
        Action::DraftMessage { .. } => Verdict::Allow,
        Action::SendMessage { to, .. } => {
            if !policy.messaging_enabled {
                return Verdict::deny("sending messages is disabled for this thread");
            }
            Verdict::Ask(Ask {
                reason: "sending to people needs the owner".into(),
                grant_key: Some(format!("send_message:{}", to.trim().to_ascii_lowercase())),
                grant_label: Some(format!("messages to {}", to.trim())),
            })
        }
        Action::RunSandboxed {
            command, network, ..
        } => {
            if !policy.sandbox_enabled {
                return Verdict::deny("the sandbox is disabled for this thread");
            }
            if let Some(verdict) = command_verdict(command) {
                return verdict;
            }
            if *network && !policy.sandbox_network_granted {
                return Verdict::Ask(Ask {
                    reason: "network access for a sandbox run needs the owner".into(),
                    grant_key: Some("sandbox_network".into()),
                    grant_label: Some("network access in sandbox runs".into()),
                });
            }
            Verdict::Allow
        }
        Action::StartGpu { .. } => {
            if !policy.gpu_enabled {
                return Verdict::deny("starting the GPU is disabled for this thread");
            }
            // Spending: always the owner, every time. Never remembered for a session.
            Verdict::Ask(Ask {
                reason: "starting the GPU spends money and always needs the owner".into(),
                grant_key: None,
                grant_label: None,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::action::parse;

    fn setup() -> (PathBuf, RestrictedPolicy) {
        let root = std::fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("rt-policy-{}", uuid::Uuid::new_v4()));
        let ws = root.join("ws");
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::write(ws.join("a.txt"), "a").unwrap();
        let policy: RestrictedPolicy = serde_json::from_value(serde_json::json!({
            "workspace": ws.display().to_string(), "endpoint": "stub"
        }))
        .unwrap();
        (root, policy)
    }
    fn run(policy: &RestrictedPolicy, name: &str, args: &str) -> Verdict {
        match parse(name, args) {
            Ok(action) => decide(policy, &[], &action),
            Err(e) => panic!("{e:?}"),
        }
    }
    fn is_ask(v: &Verdict) -> bool {
        matches!(v, Verdict::Ask(_))
    }
    fn is_deny(v: &Verdict) -> bool {
        matches!(v, Verdict::Deny(_))
    }

    /// The policy matrix: every action x the settings that change its answer.
    #[test]
    fn matrix() {
        let (root, mut p) = setup();
        // Auto-allow.
        assert_eq!(run(&p, "read_file", r#"{"path":"a.txt"}"#), Verdict::Allow);
        assert_eq!(run(&p, "list_dir", r#"{"path":"."}"#), Verdict::Allow);
        assert_eq!(
            run(&p, "write_file", r#"{"path":"new.txt","content":"x"}"#),
            Verdict::Allow
        );
        assert_eq!(
            run(&p, "draft_message", r#"{"to":"a@b.c","body":"hi"}"#),
            Verdict::Allow
        );
        // Web: denied unless enabled, then allowed.
        assert!(is_deny(&run(&p, "web_search", r#"{"query":"x"}"#)));
        assert!(is_deny(&run(
            &p,
            "fetch_url",
            r#"{"url":"https://example.com"}"#
        )));
        p.web_enabled = true;
        assert_eq!(run(&p, "web_search", r#"{"query":"x"}"#), Verdict::Allow);
        assert_eq!(
            run(&p, "fetch_url", r#"{"url":"https://example.com"}"#),
            Verdict::Allow
        );
        assert!(is_deny(&run(
            &p,
            "fetch_url",
            r#"{"url":"http://169.254.169.254/"}"#
        )));
        p.fetch_hosts = vec!["docs.rs".into()];
        assert!(is_deny(&run(
            &p,
            "fetch_url",
            r#"{"url":"https://example.com"}"#
        )));
        assert_eq!(
            run(&p, "fetch_url", r#"{"url":"https://docs.rs/x"}"#),
            Verdict::Allow
        );
        // Ask the owner.
        assert!(is_deny(&run(
            &p,
            "send_message",
            r#"{"to":"a","body":"b"}"#
        )));
        p.messaging_enabled = true;
        assert!(is_ask(&run(&p, "send_message", r#"{"to":"a","body":"b"}"#)));
        assert!(is_ask(&run(
            &p,
            "write_file",
            r#"{"path":"../outside.txt","content":"x"}"#
        )));
        assert!(is_deny(&run(&p, "start_gpu", r#"{"reason":"r"}"#)));
        p.gpu_enabled = true;
        match run(&p, "start_gpu", r#"{"reason":"r"}"#) {
            Verdict::Ask(ask) => assert!(ask.grant_key.is_none(), "GPU is never session-scoped"),
            other => panic!("{other:?}"),
        }
        // Sandbox.
        assert!(is_deny(&run(&p, "run_sandboxed", r#"{"command":"ls"}"#)));
        p.sandbox_enabled = true;
        assert_eq!(
            run(&p, "run_sandboxed", r#"{"command":"ls"}"#),
            Verdict::Allow
        );
        assert!(is_ask(&run(
            &p,
            "run_sandboxed",
            r#"{"command":"curl x","network":true}"#
        )));
        p.sandbox_network_granted = true;
        assert_eq!(
            run(
                &p,
                "run_sandboxed",
                r#"{"command":"curl x","network":true}"#
            ),
            Verdict::Allow
        );
        // Auto-deny, whatever the policy says.
        p.web_enabled = true;
        p.sandbox_enabled = true;
        p.messaging_enabled = true;
        p.gpu_enabled = true;
        for name in [
            "delete_file",
            "rm",
            "sudo",
            "bash",
            "get_credentials",
            "read_thread",
        ] {
            assert!(is_deny(&run(&p, name, "{}")), "{name}");
        }
        for path in ["../x", "/etc/passwd"] {
            assert!(
                is_deny(&run(&p, "read_file", &format!(r#"{{"path":"{path}"}}"#))),
                "{path}"
            );
        }
        assert!(is_deny(&run(&p, "read_file", r#"{"path":".env"}"#)));
        assert!(is_deny(&run(
            &p,
            "write_file",
            r#"{"path":".env","content":"x"}"#
        )));
        assert!(is_deny(&run(
            &p,
            "write_file",
            r#"{"path":"/etc/shadow","content":"x"}"#
        )));
        assert!(is_deny(&run(
            &p,
            "write_file",
            r#"{"path":"/etc/orkestr/runpod.env","content":"x"}"#
        )));
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn sandbox_commands_that_reach_for_the_host_or_deletes_are_denied() {
        let (root, mut p) = setup();
        p.sandbox_enabled = true;
        p.sandbox_network_granted = true;
        for cmd in [
            "sudo id",
            "ls; sudo -n id",
            "docker run alpine",
            "ssh host",
            "nsenter -t 1 -m sh",
            "cat /var/run/docker.sock",
            "rm -rf .",
            "find . -delete",
            "x && rm a",
            "systemctl stop x",
        ] {
            assert!(
                is_deny(&run(
                    &p,
                    "run_sandboxed",
                    &format!(r#"{{"command":{}}}"#, serde_json::json!(cmd))
                )),
                "{cmd}"
            );
        }
        // Network request is judged after the intent check: denied stays denied.
        assert!(is_deny(&run(
            &p,
            "run_sandboxed",
            r#"{"command":"sudo curl x","network":true}"#
        )));
        for ok in [
            "python3 -c 'print(1)'",
            "ls -la",
            "grep -r term .",
            "echo farm",
        ] {
            assert_eq!(
                run(
                    &p,
                    "run_sandboxed",
                    &format!(r#"{{"command":{}}}"#, serde_json::json!(ok))
                ),
                Verdict::Allow,
                "{ok}"
            );
        }
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn grant_keys_are_specific() {
        let (root, mut p) = setup();
        p.messaging_enabled = true;
        let key = |to: &str| match run(
            &p,
            "send_message",
            &format!(r#"{{"to":"{to}","body":"b"}}"#),
        ) {
            Verdict::Ask(a) => a.grant_key.unwrap(),
            o => panic!("{o:?}"),
        };
        assert_eq!(key("Ann@X.com "), key("ann@x.com"));
        assert_ne!(key("ann@x.com"), key("bob@x.com"));
        std::fs::remove_dir_all(root).ok();
    }
}
