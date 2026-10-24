//! Bounded, replay-stable model metadata, separate from canonical provider events.
use orkestr_v2_application::runtime::{ProviderAdmission, RuntimeStoreError};
use orkestr_v2_contracts::{ExecutionModelObservation, ExecutionModelSource, ExecutionModels};
use orkestr_v2_store_sqlite::Store;
use std::collections::VecDeque;

#[derive(Default)]
pub(super) struct ModelEvidence {
    latest: ExecutionModels,
    issued: u8,
    pending: VecDeque<(u8, ExecutionModelObservation)>,
}

impl ModelEvidence {
    pub(super) fn observe(
        &mut self,
        value: ExecutionModelObservation,
    ) -> Result<(), crate::ports::Blocker> {
        if !value.is_valid() {
            return Err(crate::ports::Blocker::Protocol);
        }
        let last = match value.source {
            ExecutionModelSource::Resolved => &mut self.latest.resolved_model,
            ExecutionModelSource::Answer => &mut self.latest.actual_model,
            ExecutionModelSource::Refused => &mut self.latest.refused_model,
        };
        if last.as_ref() == Some(&value.model) {
            return Ok(());
        }
        if self.issued >= 64 {
            return Err(crate::ports::Blocker::Protocol);
        }
        self.issued += 1;
        *last = Some(value.model.clone());
        self.pending.push_back((self.issued, value));
        Ok(())
    }

    pub(super) fn pending(&self) -> bool {
        !self.pending.is_empty()
    }

    pub(super) async fn flush(
        &mut self,
        store: &Store,
        admission: &ProviderAdmission,
    ) -> Result<bool, RuntimeStoreError> {
        let Some((sequence, value)) = self.pending.front() else {
            return Ok(false);
        };
        store
            .observe_provider_model(admission, value, &format!("native-model:{sequence}"))
            .await?;
        self.pending.pop_front();
        Ok(true)
    }
}
