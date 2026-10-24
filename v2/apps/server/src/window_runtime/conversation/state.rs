//! Original task cleanup accounting survives a consumed task outcome.
use super::*;

pub(super) enum State {
    Idle,
    Starting,
    Running(WindowTask),
    Uncertain,
    /// The task ended; retain its original accounting while asynchronous reap
    /// finishes. An empty new process snapshot can never create this marker.
    Reaping(crate::owned_children::ChildSet),
    /// The durable window is unresolved, but this process holds no custody:
    /// it never ran a task for it, or its task stopped and every original
    /// child was reaped. Only audited reconciliation may close it; shutdown
    /// is clean because nothing local remains to prove.
    Released,
}
impl State {
    pub(super) async fn refresh_reaping(&mut self) {
        if let Self::Reaping(children) = self {
            if children.wait_empty(Duration::ZERO).await {
                *self = Self::Released;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn late_reap_uses_the_original_retained_child_accounting() {
        let children = crate::owned_children::ChildSet::default();
        let original = children.retain();
        let mut state = State::Reaping(children.clone());
        state.refresh_reaping().await;
        assert!(matches!(state, State::Reaping(_)));
        // An unrelated empty snapshot is not evidence about this task.
        assert!(
            crate::owned_children::ChildSet::default()
                .wait_empty(Duration::ZERO)
                .await
        );
        state.refresh_reaping().await;
        assert!(matches!(state, State::Reaping(_)));
        drop(original);
        state.refresh_reaping().await;
        assert!(matches!(state, State::Released));
    }

    #[tokio::test]
    async fn unknown_custody_never_becomes_released_without_original_accounting() {
        let mut state = State::Uncertain;
        state.refresh_reaping().await;
        assert!(matches!(state, State::Uncertain));
    }
}
