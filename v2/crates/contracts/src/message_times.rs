//! When messages happened and what real transports confirmed about them.
//! Times come from durable rows (conversation events, V1 message records);
//! a receipt exists only when a transport recorded one. Nothing is inferred.
use serde::{Deserialize, Serialize};

pub const MESSAGE_TIMES_PAGE_MAX: u32 = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageReceiptKind {
    /// V1's WhatsApp relay sent the message (V1 `deliveryState: delivered`
    /// with WhatsApp message ids or a WhatsApp connector).
    SentToWhatsapp,
    /// V1 delivered the message in the app (no WhatsApp send recorded).
    DeliveredInApp,
    /// V1 acknowledged a V2 reply exported to it (`remoteMirrorAck: delivered`).
    HandedToV1,
    /// V1 acknowledged the export and sent nothing (`NO_REPLY`).
    SuppressedByV1,
    /// The sender is still waiting to deliver (`pending_delivery`, `awaiting_ack`, …).
    Pending,
    /// The transport recorded a failed delivery.
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MessageReceipt {
    pub kind: MessageReceiptKind,
    /// When the transport recorded it; `None` when it gave no time.
    pub at_ms: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageTimeKind {
    /// An owner input (`message_accepted`); `sequence` is the message sequence.
    Input,
    /// An accepted reply (`execution_accepted`); `sequence` is the acceptance sequence.
    Reply,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MessageTime {
    pub sequence: i64,
    pub kind: MessageTimeKind,
    pub at_ms: i64,
    #[serde(default)]
    pub receipts: Vec<MessageReceipt>,
}

/// `GET /api/v2/conversations/{id}/message-times?after=<sequence>&limit=<n>`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MessageTimesPage {
    pub conversation_id: crate::ConversationId,
    /// Ascending by sequence.
    pub times: Vec<MessageTime>,
    pub next_after: Option<i64>,
}
impl MessageTimesPage {
    pub fn is_valid(&self) -> bool {
        self.times.len() <= MESSAGE_TIMES_PAGE_MAX as usize
            && self.times.windows(2).all(|w| w[0].sequence < w[1].sequence)
            && self
                .times
                .iter()
                .all(|t| t.sequence > 0 && t.at_ms > 0 && t.receipts.len() <= 8)
    }
}
