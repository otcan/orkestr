//! Byte-based conversion decision after attachment notes and reply context.
pub fn needs_attachment(typed: &str, final_text: &str) -> bool {
    !typed.trim().is_empty() && final_text.len() > 32768
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_utf8_boundary_and_context_overhead() {
        let exact = "a".repeat(32768);
        assert!(!needs_attachment(&exact, &exact));
        assert!(needs_attachment(&(exact.clone() + "a"), &(exact.clone() + "a")));
        let unicode = "ü".repeat(16384);
        assert!(!needs_attachment(&unicode, &unicode));
        assert!(needs_attachment(&(unicode.clone() + "界"), &(unicode + "界")));
        assert!(needs_attachment(&exact, &(exact.clone() + "\nAttachment note")));
        assert!(!needs_attachment("  ", &" ".repeat(40000)));
        assert!(needs_attachment("invalid\0", &"a".repeat(40000)));
    }
}


#[derive(Debug, PartialEq, Eq)]
pub enum CommitState { DraftChanged, AttachmentLimit, Ready }
pub fn commit_state(draft_unchanged: bool, existing: usize, incoming: usize) -> CommitState {
    if !draft_unchanged { CommitState::DraftChanged }
    else if existing.saturating_add(incoming) > 8 { CommitState::AttachmentLimit }
    else { CommitState::Ready }
}
#[cfg(test)]
mod commit_tests {
    use super::*;
    #[test]
    fn changed_reply_does_not_consume_the_eighth_slot() {
        assert_eq!(commit_state(false, 7, 1), CommitState::DraftChanged);
        // Retried unchanged content reuses the prepared receipt, with the slot intact.
        assert_eq!(commit_state(true, 7, 1), CommitState::Ready);
        assert_eq!(commit_state(true, 8, 1), CommitState::AttachmentLimit);
        assert_eq!(commit_state(true, 8, 0), CommitState::Ready);
    }
}
