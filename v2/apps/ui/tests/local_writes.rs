//! ORK-804: a local folder write waiting for the owner is shown in every tab,
//! and every text says where it is answered.
use orkestr_v2_contracts::{ConversationId, LocalFileWriteWaiting, LocalFileWritesWaiting};
use orkestr_v2_ui::conversation_status::{RowStatus, Tone};
use orkestr_v2_ui::local_writes::{
    notice_heading, notice_lines, row_hint, row_state, valid, waiting_for, NOTICE_LINES_MAX,
};

fn waiting(n: u32, writes: u32) -> LocalFileWriteWaiting {
    LocalFileWriteWaiting {
        conversation_id: id(n),
        conversation_name: format!("Synthetic chat {n}"),
        folder_name: "Synthetic folder".into(),
        writes,
        deadline_ms: 1_000,
    }
}
fn id(n: u32) -> ConversationId {
    ConversationId(format!("00000000-0000-4000-8000-{n:012}").parse().unwrap())
}

#[test]
fn the_notice_names_the_chat_and_the_tab_where_the_write_is_answered() {
    let one = waiting(1, 1);
    assert_eq!(notice_heading(std::slice::from_ref(&one)), "Approve write");
    assert_eq!(
        notice_lines(std::slice::from_ref(&one)),
        vec!["\u{201c}Synthetic chat 1\u{201d} wants to change a file in your folder. Allow or refuse it in the browser tab where the folder \u{201c}Synthetic folder\u{201d} is connected."]
    );
    let two = waiting(2, 2);
    assert_eq!(notice_heading(std::slice::from_ref(&two)), "Approve writes");
    assert!(notice_lines(std::slice::from_ref(&two))[0].contains("wants to change 2 files"));
    let many: Vec<_> = (1..=5).map(|n| waiting(n, 1)).collect();
    let lines = notice_lines(&many);
    assert_eq!(lines.len(), NOTICE_LINES_MAX + 1);
    assert_eq!(
        lines.last().unwrap(),
        "2 more chats are waiting for a write."
    );
    assert_eq!(
        notice_lines(&many[..4]).last().unwrap(),
        "1 more chat is waiting for a write."
    );
    assert!(notice_lines(&[]).is_empty());
}

#[test]
fn the_row_state_needs_the_owner_and_says_where_to_act() {
    let one = waiting(1, 1);
    assert_eq!(row_state(&one).label, "Approve write");
    assert_eq!(row_state(&one).tone, Tone::Attention);
    assert_eq!(row_state(&waiting(1, 3)).label, "Approve 3 writes");
    assert!(row_hint(&one).ends_with(
        "in the browser tab where the folder \u{201c}Synthetic folder\u{201d} is connected."
    ));
    // The list finds the row by its conversation.
    let list = vec![waiting(1, 1), waiting(2, 2)];
    let second = list[1].conversation_id.to_string();
    assert_eq!(waiting_for(&list, &second).map(|w| w.writes), Some(2));
    assert_eq!(waiting_for(&list, &id(9).to_string()), None);
    // It is the same kind of state as the list's other attention states.
    let attention = RowStatus {
        label: row_state(&one).label,
        tone: row_state(&one).tone,
    };
    assert_eq!(attention.tone.class(), "status-attention");
}

#[test]
fn only_a_valid_reply_is_shown() {
    assert!(valid(&LocalFileWritesWaiting::default()));
    assert!(valid(&LocalFileWritesWaiting {
        conversations: vec![waiting(1, 1)]
    }));
    assert!(!valid(&LocalFileWritesWaiting {
        conversations: vec![waiting(1, 1), waiting(1, 2)]
    }));
    assert!(!valid(&LocalFileWritesWaiting {
        conversations: vec![LocalFileWriteWaiting {
            folder_name: String::new(),
            ..waiting(1, 1)
        }]
    }));
}
