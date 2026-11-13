//! The chat rules line for a Deep turn that came without it (ORK-804).
//!
//! The WhatsApp adapter starts every intake of a binding with an
//! `instructions_path` with its `[Chat rules v...: read <path> ...]` line
//! (`fast_rules`). An input the owner typed in the web app reaches Core
//! directly, so a Deep turn of a WhatsApp-bound conversation typed there (or a
//! timer occurrence, or accepted results) never saw the chat's rules and got
//! only the generic house note. Such a turn now starts with the line of the
//! conversation's latest earlier adapter intake, unchanged.
//!
//! Only a line the adapter wrote counts (`fast_rules::leading_line`: followed
//! by its source header, which owner text never supplies), only from this
//! conversation's own earlier inputs, and the rendered text depends on stored
//! inputs only, so a replayed dispatch renders the same turn. Core cannot
//! read every rules file (the agent can), so the line keeps the adapter's
//! version; the next WhatsApp intake brings a newer one. Fast is unchanged.
use super::*;

/// Earlier inputs scanned for an adapter line (newest first).
const SCAN: i64 = 8;

/// Whether the turn already carries a chat rules line: first, or after the
/// notes Core puts before it (the same test as the runtime's house rules).
pub(super) fn carries(text: &str) -> bool {
    const PREFIX: &str = "[Chat rules v";
    text.starts_with(PREFIX) || text.contains(&format!("\n{PREFIX}"))
}

/// The adapter's rules line of the latest input before `message` in its
/// conversation that carries one.
pub(super) async fn earlier_line(
    conn: &mut SqliteConnection,
    owner: &str,
    conversation: &str,
    message: &str,
) -> Result<Option<String>> {
    let texts: Vec<String> = sqlx::query_scalar(
        "SELECT text FROM messages WHERE owner_id=? AND conversation_id=? AND sequence<(SELECT sequence FROM messages WHERE id=? AND conversation_id=?) AND substr(text,1,13)='[Chat rules v' ORDER BY sequence DESC LIMIT ?",
    )
    .bind(owner)
    .bind(conversation)
    .bind(message)
    .bind(conversation)
    .bind(SCAN)
    .fetch_all(conn)
    .await
    .map_err(db)?;
    Ok(texts
        .iter()
        .find_map(|text| super::fast_rules::leading_line(text))
        .map(str::to_owned))
}

/// `text` with the line in front, when it carries none and still fits the
/// provider input bound with room for Core's later notes.
pub(super) fn with_line(line: Option<String>, text: String) -> String {
    match line {
        Some(line)
            if !carries(&text)
                && line.len() + 2 + text.len() <= super::fast_rules::FAST_INPUT_BUDGET =>
        {
            format!("{line}\n\n{text}")
        }
        _ => text,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LINE: &str = "[Chat rules v0123456789ab: before answering, read /synthetic/chat.md (cat it) unless you already read this version in this session, and follow it.]";

    #[test]
    fn the_line_goes_first_once_and_only_while_the_turn_fits() {
        assert_eq!(
            with_line(Some(LINE.into()), "hello".into()),
            format!("{LINE}\n\nhello")
        );
        assert_eq!(with_line(None, "hello".into()), "hello");
        // Already carried: first, or after notes Core puts before it.
        for text in [
            format!("{LINE}\n\n[WhatsApp: synthetic]\n\nhello"),
            format!("[Grouped turn: 2 owner messages]\n{LINE}\n\nhello"),
        ] {
            assert_eq!(with_line(Some(LINE.into()), text.clone()), text);
        }
        let budget = super::super::fast_rules::FAST_INPUT_BUDGET;
        let fits = "x".repeat(budget - LINE.len() - 2);
        assert_eq!(with_line(Some(LINE.into()), fits.clone()).len(), budget);
        let full = "x".repeat(budget - LINE.len() - 1);
        assert_eq!(with_line(Some(LINE.into()), full.clone()), full);
    }
}
