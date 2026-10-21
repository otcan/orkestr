use orkestr_v2_contracts::{MessageReceipt, MessageReceiptKind};
use orkestr_v2_ui::message_time::{
    berlin_offset_minutes, full, parse, receipt_label, receipt_mark, short,
};

#[test]
fn berlin_time_follows_eu_summer_time() {
    let t = |s: &str| parse(s).unwrap();
    assert_eq!(
        full(t("2026-10-21T14:42:05Z")),
        "Wed 21 Oct 2026, 16:42:05 CEST"
    );
    // Spring forward: 01:00 UTC on the last Sunday of March.
    assert_eq!(
        full(t("2026-03-29T00:59:59Z")),
        "Sun 29 Mar 2026, 01:59:59 CET"
    );
    assert_eq!(
        full(t("2026-03-29T01:00:00Z")),
        "Sun 29 Mar 2026, 03:00:00 CEST"
    );
    // Fall back: 01:00 UTC on the last Sunday of October.
    assert_eq!(
        full(t("2026-10-25T00:59:00Z")),
        "Sun 25 Oct 2026, 02:59:00 CEST"
    );
    assert_eq!(
        full(t("2026-10-25T01:00:00Z")),
        "Sun 25 Oct 2026, 02:00:00 CET"
    );
    // Local midnight decides the day, not UTC.
    assert_eq!(
        full(t("2025-12-31T23:30:00Z")),
        "Thu 1 Jan 2026, 00:30:00 CET"
    );
    assert_eq!(berlin_offset_minutes(t("2026-07-01T12:00:00Z")), 120);
    assert_eq!(berlin_offset_minutes(t("2026-01-15T12:00:00Z")), 60);
    assert_eq!(
        parse("2026-10-21T16:42:05.250+02:00"),
        Some(t("2026-10-21T14:42:05Z") + 250)
    );
    assert_eq!(parse("not a time"), None);
}

#[test]
fn short_times_show_the_date_for_older_days() {
    let t = |s: &str| parse(s).unwrap();
    let now = t("2026-10-21T20:00:00Z");
    assert_eq!(short(t("2026-10-21T14:42:05Z"), now), "16:42");
    // 22:30 UTC is already the next Berlin day.
    assert_eq!(short(t("2026-10-20T22:30:00Z"), now), "00:30");
    assert_eq!(short(t("2026-10-20T14:42:00Z"), now), "20 Oct, 16:42");
    assert_eq!(short(t("2025-03-01T09:05:00Z"), now), "1 Mar 2025, 10:05");
}

#[test]
fn receipts_are_labelled_without_inventing_delivery() {
    let r = |kind| MessageReceipt { kind, at_ms: None };
    assert_eq!(receipt_mark(&[]), "");
    assert_eq!(receipt_mark(&[r(MessageReceiptKind::Pending)]), "");
    assert_eq!(receipt_mark(&[r(MessageReceiptKind::SentToWhatsapp)]), "✓");
    assert_eq!(receipt_mark(&[r(MessageReceiptKind::SuppressedByV1)]), "");
    assert_eq!(
        receipt_mark(&[
            r(MessageReceiptKind::HandedToV1),
            r(MessageReceiptKind::Failed)
        ]),
        "!"
    );
    assert_eq!(
        receipt_label(&r(MessageReceiptKind::SentToWhatsapp)),
        "✓ Sent to WhatsApp"
    );
    assert_eq!(
        receipt_label(&r(MessageReceiptKind::SuppressedByV1)),
        "Not sent (no reply)"
    );
}
