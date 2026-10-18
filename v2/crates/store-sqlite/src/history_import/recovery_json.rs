//! Bounded JSON-to-Store boundary. Authentication remains in the sole writer.
use super::*;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Bundle {
    schema_version: u32,
    original: HistoryImportRequest,
    current_receipt: HistoryImportReceipt,
    native_delta: HistoryImportRequest,
    bundle_digest: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    restore_id: Uuid,
    bundle: Bundle,
    original_namespace: Uuid,
    delta_namespace: Uuid,
}

/// Decode the adapter wire request, independently recomputing binary fingerprints.
/// This format is distinct from the Python transfer envelope and its JSON hash.
pub fn decode_history_recovery_restore(encoded: &[u8]) -> Result<HistoryRecoveryRestoreRequest> {
    if encoded.len() > 40 * 1024 * 1024 {
        return Err(HistoryError::Invalid);
    }
    let value: Request = serde_json::from_slice(encoded).map_err(|_| HistoryError::Invalid)?;
    let request = HistoryRecoveryRestoreRequest {
        restore_id: value.restore_id,
        original_namespace: value.original_namespace,
        delta_namespace: value.delta_namespace,
        bundle: HistoryRecoveryBundle {
            schema_version: value.bundle.schema_version,
            original: value.bundle.original,
            current_receipt: value.bundle.current_receipt,
            native_delta: value.bundle.native_delta,
            bundle_digest: value.bundle.bundle_digest,
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
