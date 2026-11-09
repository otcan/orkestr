use super::*;

fn fact(kind: MessageReceiptKind, at_ms: Option<i64>) -> MessageReceipt {
    MessageReceipt { kind, at_ms }
}

#[test]
fn confirmed_ack_survives_expiry_failure_and_pending_without_a_new_time() {
    let now = Instant::now();
    let ack = fact(MessageReceiptKind::SentToWhatsapp, Some(1234));
    let mut entry = Entry::default();
    entry.record(
        Some(HashMap::from([("event".into(), vec![ack.clone()])])),
        now,
    );
    assert_eq!(entry.view(now + FRESH)["event"], vec![ack.clone()]);
    entry.record(None, now + FRESH);
    assert_eq!(entry.view(now + FRESH)["event"], vec![ack.clone()]);
    entry.record(
        Some(HashMap::from([(
            "event".into(),
            vec![fact(MessageReceiptKind::Pending, None)],
        )])),
        now + FRESH,
    );
    let observed = entry.view(now + FRESH);
    assert!(observed["event"].contains(&ack));
    assert!(observed["event"]
        .iter()
        .any(|r| r.kind == MessageReceiptKind::Pending));
    assert_eq!(entry.view(now + FRESH + FRESH)["event"], vec![ack]);
}

#[test]
fn transient_observations_expire_and_confirmed_event_storage_is_bounded() {
    let now = Instant::now();
    let mut entry = Entry::default();
    entry.record(
        Some(HashMap::from([(
            "pending".into(),
            vec![fact(MessageReceiptKind::Pending, None)],
        )])),
        now,
    );
    assert!(!entry.view(now).is_empty());
    assert!(entry.view(now + FRESH).is_empty());
    for event in 0..CONFIRMED_EVENTS + 1 {
        entry.record(
            Some(HashMap::from([(
                event.to_string(),
                vec![fact(MessageReceiptKind::HandedToV1, None)],
            )])),
            now,
        );
    }
    assert_eq!(entry.confirmed.len(), CONFIRMED_EVENTS);
    assert_eq!(entry.confirmed_order.len(), CONFIRMED_EVENTS);
    assert!(!entry.confirmed.contains_key("0"));
}

#[test]
fn cache_keys_keep_owner_conversation_link_and_broker_identity_separate() {
    let broker = Arc::new(
        Broker::new("http://127.0.0.1:12345", "synthetic-token-for-tests".into()).unwrap(),
    );
    let key = Key {
        owner: "owner-a".into(),
        conversation: "conversation-a".into(),
        thread: "thread-a".into(),
        broker: broker.clone(),
    };
    let mut keys = HashMap::from([(key.clone(), ())]);
    for changed in [
        Key {
            owner: "owner-b".into(),
            ..key.clone()
        },
        Key {
            conversation: "conversation-b".into(),
            ..key.clone()
        },
        Key {
            thread: "thread-b".into(),
            ..key.clone()
        },
        Key {
            broker: Arc::new(
                Broker::new("http://127.0.0.1:12345", "synthetic-token-for-tests".into()).unwrap(),
            ),
            ..key.clone()
        },
    ] {
        assert!(keys.insert(changed, ()).is_none());
    }
    assert_eq!(keys.len(), 5);
    assert!(keys.contains_key(&key));
}

#[tokio::test]
async fn observer_has_bounded_keys_and_only_four_background_reads() {
    let f = crate::message_receipt_test_support::Fixture::new().await;
    for number in 0..KEYS + 4 {
        let observed = f
            .case
            .state
            .message_receipts
            .observe(
                &f.owner,
                &f.case.conversation,
                &format!("thread-{number}"),
                f.case.state.desktop_broker.clone().unwrap(),
            )
            .await;
        assert!(observed.is_empty());
    }
    let state = f.case.state.message_receipts.state.lock().await;
    assert_eq!(state.entries.len(), KEYS);
    assert_eq!(
        state
            .entries
            .values()
            .filter(|e| e.flight.is_some())
            .count(),
        IN_FLIGHT
    );
    drop(state);
    f.peer.started(IN_FLIGHT).await;
    assert_eq!(
        f.peer.calls.load(std::sync::atomic::Ordering::SeqCst),
        IN_FLIGHT
    );
    f.peer.gate.add_permits(IN_FLIGHT);
    f.case.state.message_receipts.wait_for_refresh().await;
    f.finish().await;
}
