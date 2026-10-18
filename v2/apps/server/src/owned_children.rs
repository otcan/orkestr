//! Cleanup accounting held by Runtime until owned children have actually reaped.
//! This is not provider authority or an OS containment boundary.
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;
use tokio::sync::Notify;

#[derive(Default)]
struct State {
    retained: AtomicUsize,
    changed: Notify,
}

#[derive(Clone, Default)]
pub struct ChildSet(Arc<State>);

struct Retained(Arc<State>);
impl Drop for Retained {
    fn drop(&mut self) {
        if self.0.retained.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.0.changed.notify_waiters();
        }
    }
}

impl ChildSet {
    /// Move this guard into PreparingCodex::open_retained, together with any
    /// scratch/capacity resources. Never drop it as a substitute for child wait.
    /// Runtime retains it across setup failure and through its owned reaper.
    pub fn retain(&self) -> Box<dyn Send + 'static> {
        self.0.retained.fetch_add(1, Ordering::AcqRel);
        Box::new(Retained(self.0.clone()))
    }

    /// Call only after admission is stopped and all relevant owned handles have
    /// been dropped. Timeout preserves the outstanding count and means unknown;
    /// it never signals a child, fabricates Stopped, or authorizes replacement.
    pub async fn wait_empty(&self, duration: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + duration;
        loop {
            let changed = self.0.changed.notified();
            tokio::pin!(changed);
            // Register before checking the count, including cross-thread drops.
            changed.as_mut().enable();
            if self.0.retained.load(Ordering::Acquire) == 0 {
                return true;
            }
            if tokio::time::timeout_at(deadline, changed).await.is_err() {
                return self.0.retained.load(Ordering::Acquire) == 0;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn timeout_does_not_discard_pending_reap_evidence() {
        let children = ChildSet::default();
        let first = children.retain();
        let second = children.retain();
        drop(first);
        assert!(!children.wait_empty(Duration::from_millis(5)).await);
        let release = std::thread::spawn(move || drop(second));
        assert!(children.wait_empty(Duration::from_secs(1)).await);
        release.join().unwrap();
    }

    #[tokio::test]
    async fn all_waiters_observe_the_final_retained_resource_drop() {
        let children = ChildSet::default();
        let retained = children.retain();
        let other = children.clone();
        let waiting = tokio::spawn(async move { other.wait_empty(Duration::from_secs(1)).await });
        drop(retained);
        assert!(children.wait_empty(Duration::from_secs(1)).await);
        assert!(waiting.await.unwrap());
    }
}
