use super::*;

#[test]
fn canonical_byte_count_matches_ascii_escaping_for_unicode_and_controls() {
    let mut snapshot = ConversationSnapshot {
        conversation_id: ConversationId(Uuid::nil()),
        scope: Scope::Global,
        messages: vec![Message {
            message_id: MessageId(Uuid::nil()),
            sequence: 1,
            actor_kind: "owner".into(),
            text: String::new(),
            reply_to: None,
            origin: None,
        }],
        last_sequence: 1,
        next_cursor: None,
    };
    // Expected encoded text lengths from JSON's ensure_ascii=True convention.
    for (text, length) in [
        ("\u{7f}", 6),
        ("ä", 6),
        ("🦀", 12),
        ("\u{2028}", 6),
        ("\u{8}", 2),
        ("\0", 6),
        ("\"\\/", 5),
    ] {
        snapshot.messages[0].text = text.into();
        let actual = canonical_size(&snapshot, MAX_EXPORT_BYTES).unwrap();
        snapshot.messages[0].text = "a".repeat(length);
        assert_eq!(actual, canonical_size(&snapshot, MAX_EXPORT_BYTES).unwrap());
        assert!(matches!(
            canonical_size(&snapshot, actual - 1),
            Err(Error::LimitExceeded)
        ));
    }
}

#[tokio::test]
async fn lifetime_row_and_serialized_byte_bounds_fail_closed() {
    let case = Case::new().await;
    case.admit("input:1", &format!("x{}", "\u{0001}".repeat(200)))
        .await;
    case.admit("input:2", "synthetic second").await;
    let limits = ConversationExportLimits::default();
    assert!(matches!(
        case.begin(ConversationExportLimits {
            lifetime: Duration::ZERO,
            ..limits
        })
        .await,
        Err(Error::Invalid)
    ));
    assert!(matches!(
        case.begin(ConversationExportLimits {
            max_rows: MAX_EXPORT_ROWS + 1,
            ..limits
        })
        .await,
        Err(Error::Invalid)
    ));
    assert!(matches!(
        case.begin(ConversationExportLimits {
            max_bytes: MAX_EXPORT_BYTES + 1,
            ..limits
        })
        .await,
        Err(Error::Invalid)
    ));
    assert!(matches!(
        case.begin(ConversationExportLimits {
            max_rows: 1,
            ..limits
        })
        .await,
        Err(Error::LimitExceeded)
    ));
    // Raw text fits; JSON escaping makes the published snapshot exceed the bound.
    assert!(matches!(
        case.begin(ConversationExportLimits {
            max_bytes: 1000,
            ..limits
        })
        .await,
        Err(Error::LimitExceeded)
    ));
    let mut export = case
        .begin(ConversationExportLimits {
            lifetime: Duration::from_secs(1),
            ..limits
        })
        .await
        .unwrap();
    let cut = export.receipt().cut_id;
    tokio::time::sleep(Duration::from_millis(1100)).await;
    assert!(matches!(
        export.page(&case.token, &case.owner, cut, 0, 100).await,
        Err(Error::Expired)
    ));
    assert!(export.snapshot.is_none());
    case.finish().await;
}

#[tokio::test]
async fn cumulative_page_bytes_include_repeated_envelopes() {
    let case = Case::new().await;
    case.admit("input:1", "first synthetic input").await;
    case.admit("input:2", "second synthetic input").await;
    let snapshot = case
        .store
        .snapshot(&case.owner, &case.conversation, 0, 100)
        .await
        .unwrap();
    let max_bytes = canonical_size(&snapshot, MAX_EXPORT_BYTES).unwrap();
    let mut export = case
        .begin(ConversationExportLimits {
            max_bytes,
            ..Default::default()
        })
        .await
        .unwrap();
    let cut = export.receipt().cut_id;
    let first = export
        .page(&case.token, &case.owner, cut, 0, 1)
        .await
        .unwrap();
    assert!(matches!(
        export
            .page(&case.token, &case.owner, cut, first.next_cursor.unwrap(), 1)
            .await,
        Err(Error::LimitExceeded)
    ));
    assert!(export.snapshot.is_none());
    case.finish().await;
}

#[tokio::test]
async fn page_count_is_bounded_independently_of_row_limit() {
    let case = Case::new().await;
    for i in 0..=MAX_EXPORT_PAGES {
        case.admit(&format!("input:{i}"), "synthetic").await;
    }
    let mut export = case
        .begin(ConversationExportLimits::default())
        .await
        .unwrap();
    let cut = export.receipt().cut_id;
    let mut after = 0;
    for _ in 0..MAX_EXPORT_PAGES {
        after = export
            .page(&case.token, &case.owner, cut, after, 1)
            .await
            .unwrap()
            .next_cursor
            .unwrap();
    }
    assert!(matches!(
        export.page(&case.token, &case.owner, cut, after, 1).await,
        Err(Error::LimitExceeded)
    ));
    assert!(export.snapshot.is_none());
    case.finish().await;
}
