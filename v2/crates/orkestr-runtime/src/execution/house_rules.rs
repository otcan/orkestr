//! House rules for a Deep turn that came without chat rules (ORK-794).
//!
//! Chat rules reach a conversation only through its WhatsApp binding: the
//! adapter starts each intake with a `[Chat rules v...: read <file>]` line. A
//! conversation created in the web app has no binding, so its Deep turns never
//! learned how to hand the owner a file and answered with links to host paths
//! that nobody can open. A Deep turn without that line now starts with this
//! note: no links to host paths, and this conversation's reply attachment
//! command (`v2/tools/reply_attach.py`). A turn that carries chat rules is
//! unchanged (its rules file has its own section), and so are Fast and Worker
//! turns. The note is added only while the whole turn still fits the
//! providers' 32 KiB input bound; a turn too large for it is sent without it.
use std::sync::OnceLock;

/// Largest turn input both provider brokers accept (bytes).
pub const PROVIDER_INPUT_MAX: usize = 32_768;
/// The adapter's chat rules line (`v2/compat/v1_runtime/instructions.py`).
const CHAT_RULES: &str = "[Chat rules v";

/// The installed reply attachment tool and how it reaches this server. The
/// server validates these (plain absolute paths, a loopback URL) before it
/// sets them; they go into a shell command the agent runs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeepHouseRules {
    pub reply_attach_tool: String,
    pub v2_url: String,
    /// The agent's view of the grant directory.
    pub grant_dir: String,
}

static CONFIGURED: OnceLock<DeepHouseRules> = OnceLock::new();

/// Trusted startup only; later calls are ignored. Without it Deep turns are
/// sent unchanged.
pub fn set(rules: DeepHouseRules) {
    let _ = CONFIGURED.set(rules);
}

pub(crate) fn configured() -> Option<&'static DeepHouseRules> {
    CONFIGURED.get()
}

/// The file rules of one conversation, as a bullet list. The Deep note wraps
/// them; a new chat's generated rules file carries them as a section.
pub fn files_rules(rules: &DeepHouseRules, conversation: &str) -> String {
    let DeepHouseRules {
        reply_attach_tool,
        v2_url,
        grant_dir,
    } = rules;
    format!(
        "- Never answer with a Markdown link, a sandbox: link or a path to a file on this host: the owner can open none of them, in the web app or on WhatsApp.
- To give the owner a file, put it inside your working directory and attach it yourself during this Deep turn (never through a Root request, sudo or another user: the grant works only for you):
  ORKESTR_V2_AGENT_TIMER_GRANT_DIR={grant_dir} PYTHONDONTWRITEBYTECODE=1 python3 -I -S -B {reply_attach_tool} --v2-url {v2_url} --conversation {conversation} --workspace \"$PWD\" attach \"<file>\"
  End your reply with the [orkestr-attachment ...] lines it prints, unchanged, each on its own line, and name the files in your text without their paths.
- If it refuses, tell the owner its code in one line. Do not retry in a loop and do not file a repair or Root request."
    )
}

fn note(rules: &DeepHouseRules, conversation: &str) -> String {
    format!(
        "[House rules for this Deep turn (V2 conversation {conversation}):\n{}]",
        files_rules(rules, conversation)
    )
}

/// Whether the turn already carries the adapter's chat rules line: first, or
/// after the handoff context, parallel or grouping notes Core puts before it.
fn carries_chat_rules(text: &str) -> bool {
    text.starts_with(CHAT_RULES) || text.contains(&format!("\n{CHAT_RULES}"))
}

/// The Deep turn text: with the house note when it carries no chat rules and
/// still fits the provider bound, else unchanged.
pub(crate) fn deep_text(rules: Option<&DeepHouseRules>, conversation: &str, text: &str) -> String {
    let Some(rules) = rules else {
        return text.to_owned();
    };
    if carries_chat_rules(text) {
        return text.to_owned();
    }
    let note = note(rules, conversation);
    if note.len() + 2 + text.len() > PROVIDER_INPUT_MAX {
        return text.to_owned();
    }
    format!("{note}\n\n{text}")
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONVERSATION: &str = "00000000-0000-4000-8000-00000000000a";

    fn rules() -> DeepHouseRules {
        DeepHouseRules {
            reply_attach_tool: "/opt/synthetic/reply_attach.py".into(),
            v2_url: "http://127.0.0.1:19822".into(),
            grant_dir: "/srv/synthetic/agent-grants".into(),
        }
    }

    #[test]
    fn a_turn_without_chat_rules_learns_the_attach_command_and_no_host_links() {
        let text = deep_text(Some(&rules()), CONVERSATION, "zip the report for me");
        let (note, rest) = text.split_once("\n\n").unwrap();
        assert_eq!(rest, "zip the report for me", "the input follows unchanged");
        assert!(note.starts_with("[House rules for this Deep turn (V2 conversation "));
        assert!(note.ends_with(']'));
        assert!(note.contains("Never answer with a Markdown link, a sandbox: link or a path"));
        assert!(note.contains(&format!(
            "ORKESTR_V2_AGENT_TIMER_GRANT_DIR=/srv/synthetic/agent-grants PYTHONDONTWRITEBYTECODE=1 \
python3 -I -S -B /opt/synthetic/reply_attach.py --v2-url http://127.0.0.1:19822 \
--conversation {CONVERSATION} --workspace \"$PWD\" attach \"<file>\""
        )));
        assert!(note.contains("[orkestr-attachment ...] lines it prints, unchanged"));
        assert!(note.contains("never through a Root request, sudo or another user"));
        assert!(!note.contains("--grant-file"), "never the root path");
    }

    #[test]
    fn a_turn_with_chat_rules_or_without_configuration_is_unchanged() {
        let line = "[Chat rules v0123456789ab: before answering, read /srv/rules/chat-x.md \
(cat it) unless you already read this version in this session, and follow it.]";
        for text in [
            format!("{line}\n\n[WhatsApp: synthetic]\n\nhello"),
            // Core puts handoff context or grouping notes before the line.
            format!("Historical context carried by Fast.\n\nCurrent input:\n{line}\n\nhello"),
        ] {
            assert_eq!(deep_text(Some(&rules()), CONVERSATION, &text), text);
        }
        assert_eq!(deep_text(None, CONVERSATION, "hello"), "hello");
    }

    #[test]
    fn the_note_never_pushes_a_turn_over_the_provider_bound() {
        let note = deep_text(Some(&rules()), CONVERSATION, "").len();
        let fits = "x".repeat(PROVIDER_INPUT_MAX - note);
        let noted = deep_text(Some(&rules()), CONVERSATION, &fits);
        assert_eq!(noted.len(), PROVIDER_INPUT_MAX);
        assert!(noted.ends_with(&fits));
        let full = "x".repeat(PROVIDER_INPUT_MAX - note + 1);
        assert_eq!(deep_text(Some(&rules()), CONVERSATION, &full), full);
        assert!(note < 1536, "a small fraction of the bound: {note}");
    }
}
