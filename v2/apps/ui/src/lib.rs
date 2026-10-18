//! Client presentation only. Accepted input is not model completion.
use orkestr_v2_contracts::{ConversationSnapshot, Message, MessageInput};
use std::collections::BTreeMap;

pub const WINDOW: usize = 100;

#[derive(Clone, Default)]
pub struct Draft {
    pub text: String,
    pub revision: u64,
    pub pending: Option<Submission>,
}

#[derive(Clone)]
pub struct Submission {
    pub input: MessageInput,
    pub revision: u64,
}

impl Draft {
    pub fn edit(&mut self, text: String) {
        self.text = text;
        self.revision += 1;
    }

    pub fn prepare(&mut self, key: String) -> Result<MessageInput, &'static str> {
        if let Some(pending) = &self.pending {
            return Ok(pending.input.clone());
        }
        if self.text.trim().is_empty() || self.text.len() > 32768 {
            return Err("Message must contain 1–32768 UTF-8 bytes.");
        }
        let input = MessageInput { client_message_id: key, text: self.text.clone() };
        self.pending = Some(Submission { input: input.clone(), revision: self.revision });
        Ok(input)
    }

    pub fn accepted(&mut self) {
        if let Some(pending) = self.pending.take() {
            if pending.revision == self.revision {
                self.text.clear();
                self.revision += 1;
            }
        }
    }
}

#[derive(Clone, Default)]
pub struct Projection {
    pub messages: BTreeMap<i64, Message>,
    pub watermark: i64,
}

impl Projection {
    pub fn page(&mut self, page: ConversationSnapshot) -> Result<(), &'static str> {
        if page.last_sequence < 0 { return Err("Invalid snapshot watermark"); }
        for message in &page.messages {
            if message.sequence <= 0 || message.sequence > page.last_sequence {
                return Err("Invalid message sequence");
            }
            if let Some(old) = self.messages.get(&message.sequence) {
                if old.message_id != message.message_id || old.text != message.text {
                    return Err("Conflicting snapshot; reconnect required");
                }
            }
        }
        for message in page.messages {
            self.messages.insert(message.sequence, message);
            while self.messages.len() > WINDOW {
                self.messages.pop_first();
            }
        }
        self.watermark = self.watermark.max(page.last_sequence);
        Ok(())
    }
}
