use super::fixture::Holds;
use super::*;
use std::os::unix::fs::{MetadataExt, PermissionsExt};

const NOW: i64 = 1_800_000_000_000;

fn name(conversation: &ConversationId) -> String {
    format!("{}.json", conversation.0)
}

#[test]
fn a_valid_renewed_record_holds_its_conversation_only() {
    let case = Holds::new();
    let conversation = ConversationId(Uuid::new_v4());
    assert!(!case.holds.held(&conversation, NOW), "no record, no hold");
    case.write(
        &name(&conversation),
        &Holds::record(&conversation, NOW),
        0o440,
    );
    let hold = case.holds.active(&conversation, NOW).unwrap();
    assert_eq!(hold.session_id, Uuid::from_u128(0x5e55_1011));
    assert_eq!(hold.native_session_id, Uuid::from_u128(0xa71e));
    assert_eq!(hold.provider, Provider::Codex);
    assert_eq!(hold.acquired_at_ms, NOW - 1_000);
    assert_eq!(hold.expires_at_ms, NOW + 120_000);
    assert_eq!(hold.max_age_deadline_ms, NOW - 1_000 + MAX_HOLD_AGE_MS);
    // The file names the conversation; another conversation is not held.
    assert!(!case.holds.held(&ConversationId(Uuid::new_v4()), NOW));
}

#[test]
fn an_expired_or_unrenewed_record_no_longer_holds() {
    let case = Holds::new();
    let conversation = ConversationId(Uuid::new_v4());
    case.write(
        &name(&conversation),
        &Holds::record(&conversation, NOW),
        0o440,
    );
    assert!(case.holds.held(&conversation, NOW + 119_999));
    assert!(!case.holds.held(&conversation, NOW + 120_000), "expired");
    // A long stated expiry still lapses five minutes after the last renewal.
    let mut stale = Holds::record(&conversation, NOW);
    stale["expires_at_ms"] = serde_json::json!(NOW + 3_600_000);
    case.write(&name(&conversation), &stale, 0o440);
    assert!(case.holds.held(&conversation, NOW + RENEWAL_GRACE_MS - 1));
    assert!(!case.holds.held(&conversation, NOW + RENEWAL_GRACE_MS));
    assert_eq!(
        case.holds.active(&conversation, NOW).unwrap().expires_at_ms,
        NOW + RENEWAL_GRACE_MS
    );
}

#[test]
fn a_hold_acquired_more_than_eight_hours_ago_is_ignored_however_renewed() {
    let case = Holds::new();
    let conversation = ConversationId(Uuid::new_v4());
    let mut record = Holds::record(&conversation, NOW);
    record["acquired_at_ms"] = serde_json::json!(NOW - MAX_HOLD_AGE_MS + 1);
    case.write(&name(&conversation), &record, 0o440);
    assert!(case.holds.held(&conversation, NOW), "under the bound");
    // The hold's lapse never passes its age deadline, however renewed.
    let hold = case.holds.active(&conversation, NOW).unwrap();
    assert_eq!(hold.max_age_deadline_ms, NOW + 1);
    assert_eq!(hold.expires_at_ms, NOW + 1);
    record["acquired_at_ms"] = serde_json::json!(NOW - MAX_HOLD_AGE_MS);
    case.write(&name(&conversation), &record, 0o440);
    assert!(!case.holds.held(&conversation, NOW), "too old");
    assert!(!case.holds.held(&conversation, NOW + 1), "still too old");
}

#[test]
fn a_queue_backlog_of_a_held_conversation_alerts_at_most_once_a_minute() {
    let case = Holds::new();
    let conversation = ConversationId(Uuid::new_v4());
    let holds = &case.holds;
    assert!(holds
        .backlog_alert(&conversation, HELD_QUEUE_ALERT, NOW)
        .is_none());
    let line = holds
        .backlog_alert(&conversation, HELD_QUEUE_ALERT + 1, NOW)
        .unwrap();
    let prefix = "ALERT orkestr-v2-server native_attach_queue_backlog ";
    assert!(line.starts_with(prefix));
    assert!(line.contains(&format!("queued={}", HELD_QUEUE_ALERT + 1)));
    let within = holds.backlog_alert(&conversation, 40, NOW + 59_999);
    assert!(within.is_none(), "one line a minute");
    let later = holds.backlog_alert(&conversation, 40, NOW + 60_000);
    assert!(later.is_some());
}

#[test]
fn invalid_or_foreign_records_hold_nothing() {
    let case = Holds::new();
    let conversation = ConversationId(Uuid::new_v4());
    let path = name(&conversation);
    let mut cases = Vec::new();
    for (field, value) in [
        ("format", serde_json::json!("orkestr-native-attach-hold-v2")),
        ("conversation_id", serde_json::json!(Uuid::new_v4())),
        ("provider", serde_json::json!("gemini")),
        ("session_id", serde_json::json!(Uuid::nil())),
        ("native_session_id", serde_json::json!("not-a-uuid")),
        ("binding_generation", serde_json::json!(0)),
        ("holder_pid", serde_json::json!(0)),
        ("acquired_at_ms", serde_json::json!(NOW + 1)),
        ("expires_at_ms", serde_json::json!(NOW)),
    ] {
        let mut value_record = Holds::record(&conversation, NOW);
        value_record[field] = value;
        cases.push(value_record);
    }
    // A renewal far ahead of this clock would otherwise hold for too long.
    let mut ahead = Holds::record(&conversation, NOW + 10 * 60_000);
    ahead["acquired_at_ms"] = serde_json::json!(NOW - 1_000);
    cases.push(ahead);
    let mut extra = Holds::record(&conversation, NOW);
    extra["note"] = serde_json::json!("unknown field");
    cases.push(extra);
    let mut missing = Holds::record(&conversation, NOW);
    missing.as_object_mut().unwrap().remove("holder_pid");
    cases.push(missing);
    for record in cases {
        case.write(&path, &record, 0o440);
        assert!(!case.holds.held(&conversation, NOW), "{record}");
    }
    // Oversized (padding keeps it valid JSON) and empty records.
    let raw = |bytes: &[u8]| {
        let file = case.dir.join(&path);
        let _ = std::fs::remove_file(&file);
        std::fs::write(&file, bytes).unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o440)).unwrap();
    };
    let mut large = Holds::record(&conversation, NOW).to_string();
    large.insert_str(large.len() - 1, &" ".repeat(4096));
    raw(large.as_bytes());
    assert!(!case.holds.held(&conversation, NOW), "oversized");
    raw(b"".as_slice());
    assert!(!case.holds.held(&conversation, NOW), "empty");
    // The same record without padding holds.
    raw(Holds::record(&conversation, NOW).to_string().as_bytes());
    assert!(case.holds.held(&conversation, NOW));
}

#[test]
fn records_outside_root_custody_hold_nothing() {
    let case = Holds::new();
    let conversation = ConversationId(Uuid::new_v4());
    let path = case.dir.join(name(&conversation));
    let record = Holds::record(&conversation, NOW);
    // Group- or world-writable record.
    for mode in [0o460, 0o442] {
        case.write(&name(&conversation), &record, mode);
        assert!(!case.holds.held(&conversation, NOW), "mode {mode:o}");
    }
    // A record of another owner: this process binds as a different uid.
    case.write(&name(&conversation), &record, 0o440);
    let uid = std::fs::metadata(&case.dir).unwrap().uid();
    let foreign = NativeAttachHolds {
        dir: case.dir.clone(),
        owner_uid: uid.wrapping_add(1),
        warned_at_ms: AtomicI64::new(i64::MIN),
        aged_at_ms: AtomicI64::new(i64::MIN),
        backlog_at_ms: AtomicI64::new(i64::MIN),
    };
    assert!(!foreign.held(&conversation, NOW), "wrong owner");
    // A second hard link to the record.
    let link = case.root.join("second-link.json");
    std::fs::hard_link(&path, &link).unwrap();
    assert!(!case.holds.held(&conversation, NOW), "hard link");
    std::fs::remove_file(&link).unwrap();
    assert!(case.holds.held(&conversation, NOW));
    // A symlink in place of the record.
    std::fs::remove_file(&path).unwrap();
    let target = case.root.join("elsewhere.json");
    std::fs::write(&target, serde_json::to_vec(&record).unwrap()).unwrap();
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o440)).unwrap();
    std::os::unix::fs::symlink(&target, &path).unwrap();
    assert!(!case.holds.held(&conversation, NOW), "symlink");
    std::fs::remove_file(&path).unwrap();
    // A valid record under another conversation's file name.
    let other = ConversationId(Uuid::new_v4());
    case.write(&name(&other), &record, 0o440);
    assert!(!case.holds.held(&other, NOW), "name mismatch");
    assert!(!case.holds.held(&conversation, NOW));
    // A group-writable directory.
    case.write(&name(&conversation), &record, 0o440);
    assert!(case.holds.held(&conversation, NOW));
    std::fs::set_permissions(&case.dir, std::fs::Permissions::from_mode(0o770)).unwrap();
    assert!(
        !case.holds.held(&conversation, NOW),
        "group-writable directory"
    );
    std::fs::set_permissions(&case.dir, std::fs::Permissions::from_mode(0o750)).unwrap();
}

#[test]
fn binding_refuses_relative_core_home_or_unprotected_directories() {
    let case = Holds::new();
    let uid = std::fs::metadata(&case.dir).unwrap().uid();
    assert!(NativeAttachHolds::bind_owned(Path::new("relative"), Path::new("/h"), uid).is_err());
    assert!(NativeAttachHolds::bind_owned(&case.dir, &case.root, uid).is_err());
    std::fs::set_permissions(&case.dir, std::fs::Permissions::from_mode(0o777)).unwrap();
    assert!(NativeAttachHolds::bind_owned(&case.dir, Path::new("/h"), uid).is_err());
    std::fs::set_permissions(&case.dir, std::fs::Permissions::from_mode(0o750)).unwrap();
    assert!(NativeAttachHolds::bind_owned(&case.dir, Path::new("/h"), uid).is_ok());
}

#[test]
fn an_ended_record_names_the_last_attach_and_formats_its_note() {
    let case = Holds::new();
    let conversation = ConversationId(Uuid::new_v4());
    let native = Uuid::from_u128(0xa71e);
    assert!(case.holds.ended(&conversation, NOW).is_none());
    case.ended(&conversation, native, NOW - 3_600_000, NOW);
    let ended = case.holds.ended(&conversation, NOW).unwrap();
    assert_eq!(
        ended,
        Ended {
            native_session_id: native,
            started_at_ms: NOW - 3_600_000,
            ended_at_ms: NOW,
        }
    );
    // An ended record never holds, and a hold record is not an ended one.
    assert!(!case.holds.held(&conversation, NOW));
    assert_eq!(
        note(&ended),
        "[Orkestr: the owner worked directly in this native session from the terminal, 2027-01-15 07:00–2027-01-15 08:00 UTC (orkestr attach). Their messages there are earlier in this session.]"
    );
    // Ending before starting, or far in the future, is ignored.
    case.ended(&conversation, native, NOW, NOW - 1);
    assert!(case.holds.ended(&conversation, NOW).is_none());
    case.ended(&conversation, native, NOW, NOW + 10 * 60_000);
    assert!(case.holds.ended(&conversation, NOW).is_none());
}

#[test]
fn utc_minutes_follow_the_civil_calendar() {
    assert_eq!(utc_minute(0), "1970-01-01 00:00");
    assert_eq!(utc_minute(951_782_400_000), "2000-02-29 00:00");
    assert_eq!(utc_minute(1_763_700_000_000), "2025-11-21 04:40");
    assert_eq!(utc_minute(-60_000), "1969-12-31 23:59");
}
