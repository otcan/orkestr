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
//! turns and read-only parallel Deep slots. The note is added only while the
//! whole turn still fits the providers' 32 KiB input bound; a turn too large
//! for it is sent without it.
//!
//! ORK-804: the note (and a new chat's generated files section) also names
//! this conversation's local folder command (`v2/tools/local_files.py`): run
//! it in the agent's own shell, never through Root. Since ORK-810 a write
//! applies on its own while the folder is connected (no "Allow write", no
//! ten-minute wait, no asking before many files). A Deep
//! turn of a WhatsApp-bound conversation that was typed in the web app gets
//! the chat rules line from Core (`store-sqlite` `fast_rules::earlier_line`),
//! so it reads the chat's rules like a WhatsApp-typed turn.
use std::sync::OnceLock;

/// Largest turn input both provider brokers accept (bytes).
pub const PROVIDER_INPUT_MAX: usize = 32_768;
/// The adapter's chat rules line (`v2/compat/v1_runtime/instructions.py`).
const CHAT_RULES: &str = "[Chat rules v";
/// A read-only parallel Deep slot (`parallel_deep_turns::SLOT_NOTE`): it
/// defers every action to the main turn, so it gets no attach command.
const READ_ONLY_SLOT: &str = "[Parallel read-only turn.";

/// The installed reply attachment tool and how it reaches this server. The
/// server validates these (plain absolute paths, a loopback URL) before it
/// sets them; they go into a shell command the agent runs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeepHouseRules {
    pub reply_attach_tool: String,
    pub v2_url: String,
    /// The agent's view of the grant directory.
    pub grant_dir: String,
    /// The installed local folder tool (ORK-804). Its grant,
    /// `<grant_dir>/<conversation>.local-files.grant`, sits beside the agent
    /// grant. `None` leaves the local folder bullets out.
    pub local_files_tool: Option<String>,
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
        local_files_tool,
    } = rules;
    let local_files = local_files_tool
        .as_deref()
        .map(|tool| local_files_rules(tool, v2_url, grant_dir, conversation))
        .unwrap_or_default();
    format!(
        "- Never answer with a Markdown link, a sandbox: link or a path to a file on this host: the owner can open none of them, in the web app or on WhatsApp.
- To give the owner a file, put it inside your working directory and attach it yourself during this Deep turn (never through a Root request, sudo or another user: the grant works only for you):
  ORKESTR_V2_AGENT_TIMER_GRANT_DIR={grant_dir} PYTHONDONTWRITEBYTECODE=1 python3 -I -S -B {reply_attach_tool} --v2-url {v2_url} --conversation {conversation} --workspace \"$PWD\" attach \"<file>\"
  End your reply with the [orkestr-attachment ...] lines it prints, unchanged, each on its own line, and name the files in your text without their paths.
- If it refuses, tell the owner its code in one line. Do not retry in a loop and do not file a repair or Root request.{local_files}"
    )
}

/// The local folder bullets (ORK-804, ORK-810), appended to the file rules.
/// The same text is the section `v2/tools/local_files_rules_update.py`
/// writes into existing chat rules files.
fn local_files_rules(tool: &str, v2_url: &str, grant_dir: &str, conversation: &str) -> String {
    format!(
        "
- Files on the owner's computer: only the ones he asks about, in the folder he connected for this conversation in the Orkestr web app (\"Connect folder\", Chrome or Edge). Run the local folder tool yourself in your own shell during this Deep turn, never through a Root request, host.exec, sudo or another user (its grant works only for you):
  ORKESTR_V2_LOCAL_FILES_GRANT_DIR={grant_dir} PYTHONDONTWRITEBYTECODE=1 python3 -I -S -B {tool} --v2-url {v2_url} --conversation {conversation} <list [\"<dir>\"] | read \"<path>\" | hash \"<path>\" ... | package \"<path>\" ... | write \"<path>\" --from-file <file>>
  Paths are relative to his folder. While his folder is connected a write applies on its own, with no approval step, and he sees it in his Folder activity; at most 1 MiB per file, and several writes are applied in order. Keep the command running and read its output until it ends. A write is done only when the tool printed \"Wrote\"; anything else (`expired`, `permission_denied`, ...) means nothing was written. Exit 5 means no folder is connected: ask him to open this conversation in Chrome on his computer and press \"Connect folder\"."
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
    if carries_chat_rules(text) || text.starts_with(READ_ONLY_SLOT) {
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
            local_files_tool: Some("/opt/synthetic/local_files.py".into()),
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
    fn a_turn_without_chat_rules_learns_the_local_folder_command() {
        // ORK-804: the agent found the tool by listing /usr/local/libexec and
        // ran it through Root host.exec. ORK-810: writes apply on their own.
        let text = deep_text(Some(&rules()), CONVERSATION, "update docs/plan.md");
        let (note, rest) = text.split_once("\n\n").unwrap();
        assert_eq!(rest, "update docs/plan.md");
        assert!(note.contains(&format!(
            "ORKESTR_V2_LOCAL_FILES_GRANT_DIR=/srv/synthetic/agent-grants PYTHONDONTWRITEBYTECODE=1 \
python3 -I -S -B /opt/synthetic/local_files.py --v2-url http://127.0.0.1:19822 \
--conversation {CONVERSATION} <list"
        )));
        assert!(note.contains("write \"<path>\" --from-file <file>>"));
        assert!(note.contains("Run the local folder tool yourself in your own shell"));
        assert!(note.contains("never through a Root request, host.exec, sudo or another user"));
        assert!(note.contains("a write applies on its own, with no approval step"));
        assert!(note.contains("Keep the command running and read its output until it ends"));
        assert!(note.contains("A write is done only when the tool printed \"Wrote\""));
        for gone in [
            "--timeout 600",
            "Allow write",
            "ask him before writing",
            "Each file is one Allow",
        ] {
            assert!(!note.contains(gone), "no approval wording left: {gone}");
        }
        assert!(note.ends_with("press \"Connect folder\".]"));
        assert!(
            !note.contains("--grant-file"),
            "the grant dir, never a host grant path"
        );
        // Without a configured tool the note keeps only the attachment rules.
        let plain = DeepHouseRules {
            local_files_tool: None,
            ..rules()
        };
        let text = deep_text(Some(&plain), CONVERSATION, "hello");
        assert!(text.contains("reply_attach.py"));
        assert!(!text.contains("local_files") && !text.contains("Connect folder"));
        // A new chat's generated files section carries the same bullets.
        let section = files_rules(&rules(), CONVERSATION);
        assert!(section.contains("/opt/synthetic/local_files.py --v2-url"));
        assert!(section.starts_with("- Never answer with a Markdown link"));
    }

    #[test]
    fn a_turn_with_chat_rules_or_without_configuration_is_unchanged() {
        let line = "[Chat rules v0123456789ab: before answering, read /srv/rules/chat-x.md \
(cat it) unless you already read this version in this session, and follow it.]";
        for text in [
            format!("{line}\n\n[WhatsApp: synthetic]\n\nhello"),
            // Core puts handoff context or grouping notes before the line.
            format!("Historical context carried by Fast.\n\nCurrent input:\n{line}\n\nhello"),
            // A read-only parallel slot defers actions to the main turn.
            "[Parallel read-only turn. Another Deep turn is running.]\n\nhello".to_owned(),
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
        assert!(note < 3072, "a small fraction of the bound: {note}");
    }
}
