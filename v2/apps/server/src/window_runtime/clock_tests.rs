use super::*;
use orkestr_v2_contracts::{ConversationId, EventId, MessageId};
use uuid::Uuid;

fn opening() -> ExecutionWindowStatus {
    ExecutionWindowStatus {
        window_id: Uuid::new_v4(),
        conversation_id: ConversationId(Uuid::new_v4()),
        generation: 1,
        state: ExecutionWindowState::Opening,
        input_message_id: MessageId(Uuid::new_v4()),
        input_event_id: EventId(Uuid::new_v4()),
        predecessor_window_id: None,
        opened_at_ms: 1_000_000,
        work_deadline_ms: 1_870_000,
        expires_at_ms: 1_900_000,
        limits: ExecutionWindowLimits::default(),
    }
}

#[test]
fn setup_time_consumes_original_budget_and_cannot_restart_cleanup_clock() {
    let now = Instant::now();
    let clock = Clock::opening(&opening(), 1_005_000, now).unwrap();
    assert!(!clock.work_due(now + Duration::from_secs(864)));
    assert!(clock.work_due(now + Duration::from_secs(865)));
    assert_eq!(
        clock.cleanup_deadline().into_std(),
        now + Duration::from_secs(895)
    );
}

#[test]
fn active_expired_extended_or_changed_limits_refuse_reconstruction() {
    let original = opening();
    let now = Instant::now();
    assert!(Clock::opening(&original, original.work_deadline_ms, now).is_err());
    assert!(Clock::opening(&original, original.opened_at_ms - 1, now).is_err());
    let mut active = original.clone();
    active.state = ExecutionWindowState::Active;
    assert!(Clock::opening(&active, active.opened_at_ms, now).is_err());
    let mut extended = original.clone();
    extended.expires_at_ms += 1;
    assert!(Clock::opening(&extended, extended.opened_at_ms, now).is_err());
    let mut limits = original;
    limits.limits.cleanup_ms += 1;
    assert!(Clock::opening(&limits, limits.opened_at_ms, now).is_err());
}

#[test]
fn extension_moves_both_deadlines_later_only() {
    let now = Instant::now();
    let clock = Clock::opening(&opening(), 1_005_000, now).unwrap();
    clock.extend_to(2_470_000).unwrap(); // +10 minutes
    assert!(!clock.work_due(now + Duration::from_secs(1464)));
    assert!(clock.work_due(now + Duration::from_secs(1465)));
    assert_eq!(
        clock.cleanup_deadline().into_std(),
        now + Duration::from_secs(1495)
    );
    clock.extend_to(2_000_000).unwrap(); // earlier: ignored
    assert_eq!(clock.work_deadline_ms(), 2_470_000);
    assert_eq!(clock.opened_at_ms(), 1_000_000);
}
