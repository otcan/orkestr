//! Same-process liveness renewal; neither object grants a provider start.
use super::*;

/// Private, non-Clone continuation locator captured before dispatch is moved into
/// transport. It cannot be constructed from JSON or an arbitrary admission.
pub struct RunRenewalAuthority {
    provider: ProviderAdmission,
    namespace: String,
    incarnation: String,
}

/// One committed old -> new lease transition. No input text, reservation or
/// dispatch capability is issued. Lost replies require reconciliation, not retry
/// of provider I/O. Transport must quiesce pending events/writes before renewal.
pub struct RunLeaseTransition {
    previous: ProviderAdmission,
    current: ProviderAdmission,
}
impl RunLeaseTransition {
    pub fn previous(&self) -> &ProviderAdmission {
        &self.previous
    }
    pub fn current(&self) -> &ProviderAdmission {
        &self.current
    }
}
impl Store {
    /// Capture while the consumed capability is still owned by trusted setup.
    /// Starting is allowed here; actual renewal requires durable Running.
    pub async fn authorize_running_renewal(
        &self,
        dispatch: &ConsumedProviderDispatch,
    ) -> Result<RunRenewalAuthority> {
        let context = self.context()?;
        if dispatch.namespace() != context.namespace
            || dispatch.incarnation_id() != context.incarnation
        {
            return Err(RuntimeStoreError::Fenced);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
        let row = self
            .production_authorized_run(&mut tx, dispatch.provider())
            .await?;
        if dispatch.provider().run.purpose != AdmissionPurpose::Execution
            || row.get::<&str, _>("dispatch_state") != "delivery_unknown"
            || !matches!(row.get::<&str, _>("state"), "starting" | "running")
        {
            return Err(RuntimeStoreError::Fenced);
        }
        tx.commit().await.map_err(db)?;
        Ok(RunRenewalAuthority {
            provider: dispatch.provider().clone(),
            namespace: context.namespace.clone(),
            incarnation: context.incarnation.clone(),
        })
    }

    /// Authenticate the original machine session in the write transaction.
    /// Does not heartbeat the supervisor, revive expiry or authorize new input.
    /// Caller serializes this with its same owned process's writes/events/Stop.
    pub async fn renew_running(
        &self,
        authority: &mut RunRenewalAuthority,
    ) -> Result<RunLeaseTransition> {
        let context = self.context()?;
        if authority.namespace != context.namespace || authority.incarnation != context.incarnation
        {
            return Err(RuntimeStoreError::Fenced);
        }
        let previous = authority.provider.clone();
        let mut current = previous.clone();
        current.run = self
            .renew_exact(&previous.run, previous.run.lease_generation, true)
            .await?;
        authority.provider = current.clone();
        Ok(RunLeaseTransition { previous, current })
    }
}

#[cfg(test)]
mod tests;
