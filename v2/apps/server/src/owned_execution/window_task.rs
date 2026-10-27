//! Finite execution task owned by the persistent API, with observable failure.
//! Returning successfully is not retirement evidence; Core still checks the
//! original terminal retirement provenance before closing a window.
use super::*;

pub(crate) struct WindowTask {
    shutdown: watch::Sender<bool>,
    task: Option<JoinHandle<Result<(), &'static str>>>,
    children: crate::owned_children::ChildSet,
    context: Option<std::sync::Arc<crate::window_runtime::context::Context>>,
    companion: Option<std::sync::Arc<window_roles::Companion>>,
}

impl ConfiguredExecution {
    /// Trusted window controller only, AFTER Core activation. Legacy startup
    /// keeps its existing task behavior. No browser DTO can call this method.
    pub(crate) fn start_window(self) -> Result<WindowTask, &'static str> {
        if self.config.role != config::ExecutionRole::Deep {
            return Err("window execution requires a configured Deep primary");
        }
        let (shutdown, receiver) = watch::channel(false);
        let children = self.children.clone();
        let retained_context = self.window.clone();
        let context = retained_context.clone();
        let store = self.store.clone();
        let token = self.token.clone();
        let companion = self.companion.clone();
        let retained_companion = companion.clone();
        let task = tokio::spawn(async move {
            let result = self.run_window_roles(receiver).await;
            if let Err(reason) = &result {
                if let Some(companion) = &companion {
                    companion.fail();
                }
                // Only static local diagnostics; never provider text, token or paths.
                eprintln!("owned window execution paused: {reason}");
                if let Some(context) = context {
                    context.uncertain(&store, &token).await;
                }
            }
            result
        });
        Ok(WindowTask {
            shutdown,
            task: Some(task),
            children,
            context: retained_context,
            companion: retained_companion,
        })
    }
}

impl WindowTask {
    /// Startup observation only; durable canonical terminal checks and original
    /// tree proofs are independently required before switching conversations.
    pub(crate) fn roles_ready_to_close(&self) -> bool {
        self.companion
            .as_ref()
            // A slot still in setup has no Core run yet: drain must wait for it.
            .is_none_or(|companion| {
                (companion.ready_to_close() && companion.active_slots() == 0)
                    || companion.has_failed()
            })
    }
    pub(crate) fn cleanup_deadline(&self) -> tokio::time::Instant {
        self.context
            .as_ref()
            .map_or_else(tokio::time::Instant::now, |context| {
                context.cleanup_deadline()
            })
    }
    pub(crate) fn is_closed(&self) -> bool {
        self.context
            .as_ref()
            .is_some_and(|context| context.is_closed())
    }
    pub(crate) fn cleanup_accounting(&self) -> crate::owned_children::ChildSet {
        self.children.clone()
    }
    /// Request the existing issued-control shutdown path, never a new terminal.
    pub(crate) fn request_stop(&self) {
        let _ = self.shutdown.send(true);
    }

    /// Poll without waiting behind a live execution. The controller must treat
    /// an error or unexpected return as uncertain until exact Core reconciliation.
    pub(crate) async fn poll(&mut self) -> Option<Result<(), &'static str>> {
        if !self.task.as_ref()?.is_finished() {
            return None;
        }
        let task = self.task.take()?;
        Some(task.await.unwrap_or(Err("window execution task lost")))
    }

    /// The caller supplies the ORIGINAL absolute cleanup deadline. This method
    /// cannot restart a cleanup clock or extend a window after a retry.
    pub(crate) async fn stop_until(
        &mut self,
        deadline: tokio::time::Instant,
    ) -> Result<(), &'static str> {
        self.request_stop();
        let Some(task) = self.task.as_mut() else {
            return Err("window task outcome already consumed");
        };
        let outcome = tokio::time::timeout_at(deadline, task).await;
        match outcome {
            Ok(result) => {
                self.task.take();
                result.map_err(|_| "window execution task lost")??;
            }
            Err(_) => {
                if let Some(task) = self.task.take() {
                    task.abort();
                    // Retained Child cleanup continues independently. A timeout
                    // can never authorize replacement or reset its budget.
                }
                return Err("window cleanup deadline exceeded; reconciliation required");
            }
        }
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() || !self.children.wait_empty(remaining).await {
            return Err("window resources remain; reconciliation required");
        }
        Ok(())
    }
}

impl WindowTask {
    /// After a stop attempt: every original owned child is gone by the same
    /// original deadline. This is custody release, never retirement evidence.
    pub(crate) async fn custody_released(&self, deadline: tokio::time::Instant) -> bool {
        self.task.is_none()
            && self
                .children
                .wait_empty(deadline.saturating_duration_since(tokio::time::Instant::now()))
                .await
    }
}

impl Drop for WindowTask {
    fn drop(&mut self) {
        self.request_stop();
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

#[cfg(test)]
#[path = "window_task_tests.rs"]
mod tests;
