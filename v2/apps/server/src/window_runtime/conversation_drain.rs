//! The existing idle-retirement gates, with optional deploy diagnostics.
use super::{ConversationController, State};
use crate::deploy_drain::{DrainWindowDiagnostic, DrainWindowOutcome as Outcome};

impl ConversationController {
    pub(in crate::window_runtime) async fn retire_if_idle(
        &self,
        browser: &str,
    ) -> Result<bool, &'static str> {
        self.retire_idle_checked(browser, None).await
    }

    pub(in crate::window_runtime) async fn retire_for_drain(
        &self,
        browser: &str,
    ) -> (Result<bool, &'static str>, DrainWindowDiagnostic) {
        let mut diagnostic = DrainWindowDiagnostic::new(self.config.conversation_id.clone());
        let result = self
            .retire_idle_checked(browser, Some(&mut diagnostic))
            .await;
        if result.is_err() {
            diagnostic.outcome = Outcome::RetirementFailed;
        }
        (result, diagnostic)
    }

    // Preserve short-circuit order, store calls, operation lock and stop path.
    async fn retire_idle_checked(
        &self,
        browser: &str,
        mut diagnostic: Option<&mut DrainWindowDiagnostic>,
    ) -> Result<bool, &'static str> {
        let _operation = self.operation.lock().await;
        self.refresh().await?;
        let mut state = self.state.lock().await;
        let State::Running(task) = &mut *state else {
            if let Some(d) = diagnostic {
                d.outcome = Outcome::LocalTaskNotRunning;
            }
            return Ok(false);
        };
        let roles_ready = task.roles_ready_to_close();
        if let Some(d) = diagnostic.as_deref_mut() {
            d.local_roles_ready = Some(roles_ready);
            d.outcome = Outcome::LocalRolesNotReady;
        }
        if !roles_ready {
            return Ok(false);
        }
        let core_ready = self
            .store
            .execution_window_switch_ready_authenticated(browser, &self.config.conversation_id)
            .await;
        if let Some(d) = diagnostic.as_deref_mut() {
            d.core_switch_ready = core_ready.as_ref().ok().copied();
            d.outcome = if core_ready.is_err() {
                Outcome::CoreSwitchUnavailable
            } else {
                Outcome::CoreSwitchNotReady
            };
        }
        if !core_ready.unwrap_or(false) {
            return Ok(false);
        }
        let result = Self::stop_task(&self.handles, &mut state).await;
        if let Some(d) = diagnostic {
            d.outcome = match &result {
                Ok(true) => Outcome::Retired,
                Ok(false) => Outcome::CustodyReleased,
                Err(_) => Outcome::RetirementFailed,
            };
        }
        result
    }
}
