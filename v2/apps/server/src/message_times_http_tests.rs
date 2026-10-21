use super::*;
use crate::conversation_resources_http::tests::{case, send};
use crate::sidebar_v1::{export_receipts, receipts};
use orkestr_v2_application::IntakeStore;
use serde_json::json;

#[test]
fn receipts_are_only_what_v1_recorded() {
    use MessageReceiptKind as K;
    let t = |s: &str| crate::live_map::timestamp_ms(s);
    // A V2 reply exported to V1 and sent by V1's WhatsApp relay.
    let exported = json!({"role": "assistant", "connector": "whatsapp", "deliveryState": "delivered",
        "deliveredAt": "2026-01-02T15:42:10.000Z", "whatsappMessageIds": ["synthetic"],
        "remoteBackend": "rust-v2", "remoteMessageId": "evt-1",
        "remoteMirrorAck": {"outcome": "delivered", "acknowledgedAt": "2026-01-02T15:42:20.000Z"}});
    assert_eq!(
        receipts(&exported),
        vec![
            MessageReceipt {
                kind: K::HandedToV1,
                at_ms: t("2026-01-02T15:42:20.000Z")
            },
            MessageReceipt {
                kind: K::SentToWhatsapp,
                at_ms: t("2026-01-02T15:42:10.000Z")
            },
        ]
    );
    // Suppressed (NO_REPLY), in-app delivery, failures and pending sends.
    let suppressed = json!({"role": "assistant", "remoteMirrorAck": {"outcome": "suppressed", "acknowledgedAt": "2026-01-02T15:00:00Z"}});
    assert_eq!(receipts(&suppressed)[0].kind, K::SuppressedByV1);
    let in_app = json!({"role": "assistant", "deliveryState": "delivered"});
    assert_eq!(
        receipts(&in_app),
        vec![MessageReceipt {
            kind: K::DeliveredInApp,
            at_ms: None
        }],
        "no time is invented"
    );
    let pending = json!({"role": "assistant", "deliveryState": "pending_delivery"});
    assert_eq!(
        receipts(&pending),
        vec![MessageReceipt {
            kind: K::Pending,
            at_ms: None
        }]
    );
    // Inbound owner messages and unknown states carry no receipts.
    assert!(receipts(&json!({"role": "user", "deliveryState": "delivered", "deliveredAt": "2026-01-02T15:00:00Z"})).is_empty());
    assert!(receipts(&json!({"role": "assistant", "deliveryState": "mystery"})).is_empty());
    let page = json!({"messages": [exported, {"role": "assistant", "deliveryState": "delivered", "remoteMessageId": "local-only"}]});
    let map = export_receipts(&page);
    assert_eq!(map.len(), 1, "only exported V2 replies are keyed");
    assert_eq!(map["evt-1"].len(), 2);
}

#[tokio::test]
async fn times_page_lists_inputs_with_durable_times() {
    let case = case().await;
    let auth = case.auth();
    let owner = case
        .state
        .store
        .credentials("synthetic-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    case.state
        .store
        .admit(
            &owner,
            &case.conversation,
            &MessageInput {
                client_message_id: "synthetic-time".into(),
                text: "Synthetic".into(),
            },
        )
        .await
        .unwrap();
    let (status, value) = send(
        &case.state,
        "GET",
        &case.path("/message-times?after=0&limit=50"),
        &[&auth],
        "",
    )
    .await;
    assert_eq!(status, 200, "{value}");
    let page: MessageTimesPage = serde_json::from_value(value).unwrap();
    assert!(page.is_valid());
    assert_eq!(page.times.len(), 1);
    assert_eq!(page.times[0].kind, MessageTimeKind::Input);
    assert!(page.times[0].receipts.is_empty());
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    assert!((now - page.times[0].at_ms).abs() < 60_000);
    let (status, _) = send(
        &case.state,
        "GET",
        &case.path("/message-times?after=-1"),
        &[&auth],
        "",
    )
    .await;
    assert_eq!(status, 400);
    let (status, _) = send(&case.state, "GET", &case.path("/message-times"), &[], "").await;
    assert_eq!(status, 401);
    case.finish().await;
}
