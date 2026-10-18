//! Fixed-purpose Fast scheduling seam. No Deep claim or Worker delegation.
use super::*;
use orkestr_v2_contracts::{EventId, MessageId, SessionId};

/// Trusted supervisor-selected immutable owner input. No caller text or role.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FastAdmissionInput {
    pub source_message_id: MessageId,
    pub source_event_id: EventId,
    pub fast_binding_id: SessionId,
    pub expected_binding_generation: u64,
    pub request_key: String,
}
impl Store {
    /// Source checkpoint only: the Fast lineage migration/adapter is not yet
    /// installed. Current authentication precedes refusal; no run, claim, binding
    /// mutation or dispatch locator is issued. Never substitute Deep admission.
    pub async fn admit_fast(
        &self,
        credential: &str,
        input: &FastAdmissionInput,
    ) -> Result<RunAdmissionResult> {
        let c = self.context()?;
        if credential.len() != 64
            || !credential.bytes().all(|b| b.is_ascii_hexdigit())
            || crate::digest(credential) != c.token_hash
        {
            return Err(RuntimeStoreError::Unauthorized);
        }
        if input.source_message_id.0.is_nil()
            || input.source_event_id.0.is_nil()
            || input.fast_binding_id.0.is_nil()
            || input.expected_binding_generation == 0
            || i64::try_from(input.expected_binding_generation).is_err()
            || !valid(&input.request_key)
        {
            return Err(RuntimeStoreError::InvalidInput);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        c.validate(&mut tx).await?;
        Err(RuntimeStoreError::Unavailable)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn fast_seam_never_falls_back_to_deep_or_spends_authority() {
        let f = super::super::tests::setup().await;
        let input = FastAdmissionInput {
            source_message_id: MessageId(Uuid::new_v4()),
            source_event_id: EventId(Uuid::new_v4()),
            fast_binding_id: SessionId(Uuid::new_v4()),
            expected_binding_generation: 1,
            request_key: "fixed-presentation".into(),
        };
        let before = super::super::tests::snapshot(&f.store).await;
        assert!(matches!(
            f.handle.admit_fast(&f.token, &input).await,
            Err(RuntimeStoreError::Unavailable)
        ));
        assert!(matches!(
            f.store.admit_fast(&f.token, &input).await,
            Err(RuntimeStoreError::Unavailable)
        ));
        f.store.revoke_session(&f.token).await.unwrap();
        let after = super::super::tests::snapshot(&f.store).await;
        assert!(matches!(
            f.handle.admit_fast(&f.token, &input).await,
            Err(RuntimeStoreError::Unauthorized)
        ));
        assert_eq!(before, after);
        assert_eq!(super::super::tests::snapshot(&f.store).await, after);
    }
}
