//! Spacing and logging of refused automatic reconcile attempts. Synthetic ids.
use super::*;
use orkestr_v2_contracts::{
    ConversationId, EventId, ExecutionWindowLimits, ExecutionWindowState, MessageId,
};
use uuid::Uuid;

fn window(id: u128, generation: u64) -> ExecutionWindowStatus {
    ExecutionWindowStatus {
        window_id: Uuid::from_u128(id),
        conversation_id: ConversationId(Uuid::from_u128(2)),
        generation,
        state: ExecutionWindowState::ReconciliationRequired,
        input_message_id: MessageId(Uuid::from_u128(5)),
        input_event_id: EventId(Uuid::from_u128(6)),
        predecessor_window_id: None,
        opened_at_ms: 1_000,
        work_deadline_ms: 871_000,
        expires_at_ms: 901_000,
        limits: ExecutionWindowLimits::default(),
    }
}

#[test]
fn spacing_doubles_from_one_second_to_thirty() {
    let seconds: Vec<u64> = (1..=8).map(|n| delay(n).as_secs()).collect();
    assert_eq!(seconds, [1, 2, 4, 8, 16, 30, 30, 30]);
    assert_eq!(delay(u32::MAX), RETRY_MAX);
}

#[test]
fn a_refused_window_waits_and_alerts_once_until_it_settles() {
    let backoff = ReconcileBackoff::default();
    let stuck = window(31, 7);
    let start = Instant::now();
    assert!(backoff.due(&stuck, start));
    let alert = backoff
        .refused(&stuck, "manager reconciliation refused", start)
        .expect("the first refusal alerts");
    assert_eq!(
        alert,
        format!(
            "ALERT orkestr-v2-server window_reconcile_backoff conversation={} window={} generation=7 cause=\"manager reconciliation refused\" retry_ms=1000 max_retry_ms=30000",
            stuck.conversation_id, stuck.window_id
        )
    );
    assert!(!backoff.due(&stuck, start + Duration::from_millis(999)));
    assert!(backoff.due(&stuck, start + RETRY_BASE));
    let mut now = start + RETRY_BASE;
    for attempt in 2..=10 {
        assert!(backoff.due(&stuck, now));
        assert_eq!(
            backoff.refused(&stuck, "manager reconciliation refused", now),
            None
        );
        assert_eq!(backoff.attempts(&stuck), attempt);
        assert!(!backoff.due(&stuck, now + delay(attempt) - Duration::from_millis(1)));
        now += delay(attempt);
    }
    let cleared = backoff
        .settled(&stuck, now)
        .expect("one line after the refusals");
    assert!(
        cleared.contains("window_reconcile_backoff_cleared"),
        "{cleared}"
    );
    assert!(cleared.contains("refused_attempts=10"), "{cleared}");
    assert_eq!(backoff.attempts(&stuck), 0);
    assert!(backoff.due(&stuck, now));
    // A success without earlier refusals logs nothing.
    assert_eq!(backoff.settled(&stuck, now), None);
}

#[test]
fn other_windows_and_generations_keep_their_own_spacing() {
    let backoff = ReconcileBackoff::default();
    let now = Instant::now();
    let stuck = window(31, 7);
    assert!(backoff
        .refused(&stuck, "manager reconciliation refused", now)
        .is_some());
    assert!(backoff.due(&window(32, 7), now));
    assert!(backoff.due(&window(31, 8), now));
    assert!(!backoff.due(&stuck, now));
}

#[test]
fn ten_minutes_of_status_polls_make_a_few_dozen_attempts_not_hundreds() {
    // 2026-11-10: status polls, dispatcher passes and admissions reached the
    // automatic path about every 0.75 s; each attempt was refused (798 in ten
    // minutes). With spacing, the same ten minutes make at most 25 attempts.
    let backoff = ReconcileBackoff::default();
    let stuck = window(31, 7);
    let start = Instant::now();
    let (mut attempts, mut alerts) = (0, 0);
    let mut now = start;
    while now < start + Duration::from_secs(600) {
        if backoff.due(&stuck, now) {
            attempts += 1;
            if backoff
                .refused(&stuck, "manager reconciliation refused", now)
                .is_some()
            {
                alerts += 1;
            }
        }
        now += Duration::from_millis(750);
    }
    assert!(attempts <= 25, "{attempts} attempts");
    assert_eq!(alerts, 1);
}
