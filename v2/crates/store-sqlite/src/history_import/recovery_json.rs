//! Bounded JSON-to-Store boundary. Authentication remains in the sole writer.
use super::*;
use serde_json::Value;

fn fields(value: &Value, expected: &[&str]) -> Result<()> {
    let object = value.as_object().ok_or(HistoryError::Invalid)?;
    if object.len() != expected.len() || expected.iter().any(|key| !object.contains_key(*key)) {
        return Err(HistoryError::Invalid);
    }
    Ok(())
}

// Match Python canonical ensure_ascii JSON exactly. Duplicate keys, alternate
// spellings, whitespace and noncanonical numbers cannot survive this comparison.
fn canonical(value: &Value, output: &mut String) -> Result<()> {
    use std::fmt::Write;
    match value {
        Value::String(text) => {
            output.push('"');
            for ch in text.chars() {
                match ch {
                    '"' => output.push_str("\\\""),
                    '\\' => output.push_str("\\\\"),
                    '\n' => output.push_str("\\n"),
                    '\r' => output.push_str("\\r"),
                    '\t' => output.push_str("\\t"),
                    '\u{08}' => output.push_str("\\b"),
                    '\u{0c}' => output.push_str("\\f"),
                    ' '..='~' => output.push(ch),
                    _ => {
                        for unit in ch.encode_utf16(&mut [0; 2]) {
                            write!(output, "\\u{unit:04x}").map_err(|_| HistoryError::Invalid)?;
                        }
                    }
                }
            }
            output.push('"');
        }
        Value::Array(items) => {
            output.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                canonical(item, output)?;
            }
            output.push(']');
        }
        Value::Object(items) => {
            output.push('{');
            let mut keys: Vec<_> = items.keys().collect();
            keys.sort();
            for (index, key) in keys.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                canonical(&Value::String((*key).clone()), output)?;
                output.push(':');
                canonical(&items[*key], output)?;
            }
            output.push('}');
        }
        Value::Number(number) if number.is_i64() || number.is_u64() => {
            output.push_str(&number.to_string())
        }
        Value::Bool(true) => output.push_str("true"),
        Value::Bool(false) => output.push_str("false"),
        Value::Null => output.push_str("null"),
        _ => return Err(HistoryError::Invalid),
    }
    Ok(())
}

fn source(value: &Value) -> Result<HistoryImportRequest> {
    fields(
        value,
        &[
            "namespace",
            "source_digest",
            "source_conversation_id",
            "source_scope",
            "source_watermark",
            "messages",
        ],
    )?;
    let scope = &value["source_scope"];
    fields(
        scope,
        if scope["kind"] == "global" {
            &["kind"]
        } else {
            &["kind", "project_id"]
        },
    )?;
    for message in value["messages"].as_array().ok_or(HistoryError::Invalid)? {
        fields(message, &["message_id", "sequence", "actor_kind", "text"])?;
    }
    serde_json::from_value(value.clone()).map_err(|_| HistoryError::Invalid)
}

/// Decode canonical adapter JSON; independently verify Core binary fingerprints.
pub fn decode_history_recovery_restore(encoded: &[u8]) -> Result<HistoryRecoveryRestoreRequest> {
    if encoded.len() > 40 * 1024 * 1024 {
        return Err(HistoryError::Invalid);
    }
    let value: Value = serde_json::from_slice(encoded).map_err(|_| HistoryError::Invalid)?;
    let mut text = String::new();
    canonical(&value, &mut text)?;
    if text.as_bytes() != encoded {
        return Err(HistoryError::Invalid);
    }
    fields(
        &value,
        &[
            "restore_id",
            "bundle",
            "original_namespace",
            "delta_namespace",
        ],
    )?;
    let bundle = &value["bundle"];
    fields(
        bundle,
        &[
            "schema_version",
            "original",
            "current_receipt",
            "native_delta",
            "bundle_digest",
        ],
    )?;
    let request = HistoryRecoveryRestoreRequest {
        restore_id: serde_json::from_value(value["restore_id"].clone())
            .map_err(|_| HistoryError::Invalid)?,
        original_namespace: serde_json::from_value(value["original_namespace"].clone())
            .map_err(|_| HistoryError::Invalid)?,
        delta_namespace: serde_json::from_value(value["delta_namespace"].clone())
            .map_err(|_| HistoryError::Invalid)?,
        bundle: HistoryRecoveryBundle {
            schema_version: serde_json::from_value(bundle["schema_version"].clone())
                .map_err(|_| HistoryError::Invalid)?,
            original: source(&bundle["original"])?,
            current_receipt: serde_json::from_value(bundle["current_receipt"].clone())
                .map_err(|_| HistoryError::Invalid)?,
            native_delta: source(&bundle["native_delta"])?,
            bundle_digest: bundle["bundle_digest"]
                .as_str()
                .ok_or(HistoryError::Invalid)?
                .to_owned(),
        },
    };
    request.validate()?;
    Ok(request)
}

impl Store {
    /// No independent writer: validated JSON delegates to the authenticated transaction.
    pub async fn restore_history_recovery_json(
        &self,
        credential: &str,
        owner: &OwnerId,
        encoded: &[u8],
    ) -> Result<HistoryRecoveryRestoreReceipt> {
        let request = decode_history_recovery_restore(encoded)?;
        self.restore_history_recovery(credential, owner, &request)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const FIXTURE: &[u8] = include_bytes!("recovery_wire_fixture.json");

    #[test]
    fn canonical_unicode_controls_match_python_ascii_encoding() {
        let value = serde_json::json!({"text": "é😀\u{7f}\n\t\u{08}\u{0c}\\\""});
        let mut encoded = String::new();
        canonical(&value, &mut encoded).unwrap();
        assert_eq!(
            encoded,
            r#"{"text":"\u00e9\ud83d\ude00\u007f\n\t\b\f\\\""}"#
        );
    }

    #[test]
    fn python_wire_matches_core_binary_fingerprint() {
        let request = decode_history_recovery_restore(FIXTURE).unwrap();
        assert_eq!(request.original_namespace, Uuid::from_u128(8));
        assert_eq!(request.bundle.original.messages.len(), 1);
        assert_eq!(request.bundle.native_delta.messages.len(), 1);
        assert_eq!(request.bundle.current_receipt.revision, 1);
    }

    #[test]
    fn tampered_unknown_and_duplicate_fields_refuse() {
        let text = std::str::from_utf8(FIXTURE).unwrap();
        for changed in [
            text.replace("Synthetic history", "Changed history"),
            text.replacen('{', "{\"unexpected\":true,", 1),
            text.replacen(
                '{',
                "{\"restore_id\":\"00000000-0000-0000-0000-000000000007\",",
                1,
            ),
        ] {
            assert!(decode_history_recovery_restore(changed.as_bytes()).is_err());
        }
    }
    #[tokio::test]
    async fn json_adapter_uses_authenticated_store_writer_and_reopens() {
        let directory = std::env::temp_dir().join(format!("recovery-json-{}", Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("store.sqlite");
        let store = Store::open(&path).await.unwrap();
        store
            .setup("synthetic-owner", "synthetic-hash")
            .await
            .unwrap();
        let owner = store
            .credentials("synthetic-owner")
            .await
            .unwrap()
            .unwrap()
            .0;
        store.save_session("synthetic-token", &owner).await.unwrap();
        assert!(matches!(
            store
                .restore_history_recovery_json("wrong", &owner, FIXTURE)
                .await,
            Err(HistoryError::Unauthorized)
        ));
        let receipt = store
            .restore_history_recovery_json("synthetic-token", &owner, FIXTURE)
            .await
            .unwrap();
        drop(store);
        let reopened = Store::open(&path).await.unwrap();
        let replay = reopened
            .restore_history_recovery_json("synthetic-token", &owner, FIXTURE)
            .await
            .unwrap();
        assert_eq!(replay.restore_id, receipt.restore_id);
        assert_eq!(replay.bundle_digest, receipt.bundle_digest);
        assert_eq!(replay.original, receipt.original);
        assert_eq!(replay.native_delta, receipt.native_delta);
        drop(reopened);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
