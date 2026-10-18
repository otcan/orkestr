//! Versioned metadata only. Not an authenticated command or an execution permit.
use crate::Envelope;
use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JournalRecord {
    pub schema_version: u32,
    pub envelope: Envelope,
}

impl JournalRecord {
    pub fn new(envelope: Envelope) -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            envelope,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ConversationKind, Event};

    #[test]
    fn wire_format_is_versioned_and_strict() {
        let record = JournalRecord::new(Envelope {
            event_id: "event-1".into(),
            event: Event::ConversationCreated {
                id: "home".into(),
                kind: ConversationKind::Home,
                parent_id: None,
            },
        });
        let json = serde_json::to_value(&record).unwrap();
        assert_eq!(json["schema_version"], 1);
        assert_eq!(
            json["envelope"]["event"]["ConversationCreated"]["id"],
            "home"
        );
        assert_eq!(
            serde_json::from_value::<JournalRecord>(json.clone()).unwrap(),
            record
        );
        let mut invalid = json;
        invalid["unrecognized"] = true.into();
        assert!(serde_json::from_value::<JournalRecord>(invalid).is_err());
    }
}
