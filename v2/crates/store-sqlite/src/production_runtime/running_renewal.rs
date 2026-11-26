//! Same-process liveness renewal; neither object grants a provider start.
use super::*;

/// Private, non-Clone continuation locator captured before dispatch is moved into
/// transport. It cannot be constructed from JSON or an arbitrary admission.
pub struct RunRenewalAuthority {
    provider: ProviderAdmission,
    namespace: String,
    incarnation: String,
    worker_budget: Option<i64>,
    renewed: bool,
    refusal: Option<RenewalRefusalInfo>,
}

/// How far a running renewal got. Nothing is written before `Commit`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RenewalStage {
    /// Authority, namespace and input checks.
    Scope,
    /// The Root workspace custody check that precedes the writer.
    Workspace,
    /// Acquiring the SQLite writer (`BEGIN IMMEDIATE`).
    Writer,
    /// Authentication, lease, fence and extension checks inside the writer.
    Checks,
    /// The commit itself: a failure here leaves the outcome uncertain.
    Commit,
}

impl RenewalStage {
    pub fn name(self) -> &'static str {
        match self {
            Self::Scope => "scope",
            Self::Workspace => "workspace",
            Self::Writer => "writer",
            Self::Checks => "checks",
            Self::Commit => "commit",
        }
    }
}

/// Value-free diagnostics of the last refused renewal: where it stopped and,
/// for a fence, which check refused (best effort; codes only).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RenewalRefusalInfo {
    pub stage: RenewalStage,
    pub fence: Option<&'static str>,
}

impl RunRenewalAuthority {
    pub(super) fn current_provider(&self) -> &ProviderAdmission {
        &self.provider
    }
    /// Immutable owner/host budget deadline, for trusted scheduling only.
    /// None means no extended Worker budget was issued; ordinary lease and
    /// current authority checks still apply on every operation.
    pub fn hard_deadline_ms(&self) -> Option<i64> {
        self.worker_budget
    }
    /// The run's current lease deadline (Core clock, ms), for trusted
    /// scheduling only: it decides when to renew, never whether an effect is
    /// allowed. Every renewal moves it.
    pub fn lease_deadline_ms(&self) -> i64 {
        self.provider.run.lease_deadline_ms
    }
    /// Why the last renewal was refused; None after a successful one.
    pub fn last_refusal(&self) -> Option<RenewalRefusalInfo> {
        self.refusal
    }
    /// Value-free log text for a refused renewal: the error kind, the stage
    /// it stopped at (`pump` when Core was never asked) and any fence code.
    pub fn refusal_detail(&self, error: RuntimeStoreError) -> String {
        format!(
            "{error:?} stage={} fence={}",
            self.refusal.map_or("pump", |refusal| refusal.stage.name()),
            self.refusal
                .and_then(|refusal| refusal.fence)
                .unwrap_or("-")
        )
    }
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
        #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
        let workspace = self
            .check_binding_before_writer(&dispatch.provider().binding)
            .await?;
        #[cfg(all(target_os = "linux", target_pointer_width = "64"))]
        let store = &*workspace;
        #[cfg(not(all(target_os = "linux", target_pointer_width = "64")))]
        let store = self;
        let mut tx = store.begin_writer().await?;
        let row = store
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
            worker_budget: None,
            renewed: false,
            refusal: None,
        })
    }

    /// Authenticate the original machine session in the write transaction.
    /// Does not heartbeat the supervisor, revive expiry or authorize new input.
    /// Caller serializes this with its same owned process's writes/events/Stop.
    ///
    /// `Busy` means Core wrote nothing and the authority is unchanged: the
    /// Root workspace check did not answer in time, the writer was not
    /// acquired, the supervisor deadline did not yet allow an extension, or any
    /// other transient failure before the commit. The same authority may retry
    /// while the run's current lease lasts. `Unavailable` is returned only for
    /// a failed commit, whose outcome is uncertain. Every other refusal is
    /// authority loss. `RunRenewalAuthority::last_refusal` names the stage.
    pub async fn renew_running(
        &self,
        authority: &mut RunRenewalAuthority,
    ) -> Result<RunLeaseTransition> {
        // Best effort: a code left on this thread by an unrelated fence.
        let _ = super::fence_reason::take();
        let mut stage = RenewalStage::Scope;
        let renewed = self.renew_running_tracked(authority, &mut stage).await;
        match renewed {
            Ok(transition) => {
                authority.refusal = None;
                Ok(transition)
            }
            Err(error) => {
                let fence = (error == RuntimeStoreError::Fenced)
                    .then(super::fence_reason::take)
                    .flatten();
                authority.refusal = Some(RenewalRefusalInfo { stage, fence });
                let before_write = matches!(
                    stage,
                    RenewalStage::Workspace | RenewalStage::Writer | RenewalStage::Checks
                );
                Err(match error {
                    RuntimeStoreError::Busy | RuntimeStoreError::Unavailable if before_write => {
                        RuntimeStoreError::Busy
                    }
                    other => other,
                })
            }
        }
    }

    async fn renew_running_tracked(
        &self,
        authority: &mut RunRenewalAuthority,
        stage: &mut RenewalStage,
    ) -> Result<RunLeaseTransition> {
        let context = self.context()?;
        if authority.namespace != context.namespace || authority.incarnation != context.incarnation
        {
            return Err(RuntimeStoreError::Fenced);
        }
        let previous = authority.provider.clone();
        let mut current = previous.clone();
        current.run = self
            .renew_exact_tracked(
                &previous.run,
                previous.run.lease_generation,
                true,
                authority.worker_budget,
                stage,
            )
            .await?;
        authority.provider = current.clone();
        authority.renewed = true;
        Ok(RunLeaseTransition { previous, current })
    }
}

#[cfg(test)]
mod tests;

mod worker_budget;
