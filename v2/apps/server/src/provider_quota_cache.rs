//! A slow optional projection must not hold the WebUI request open.
use super::{Snapshot, Source};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::watch;

const REFRESH_AFTER: Duration = Duration::from_secs(30);
const RETAIN_FOR: Duration = Duration::from_secs(300);
const COLD_WAIT: Duration = Duration::from_millis(250);

#[derive(Clone)]
struct Cached {
    snapshot: Snapshot,
    received: Instant,
}
#[derive(Default)]
struct Refresh {
    running: bool,
    attempted: Option<Instant>,
}
pub(super) struct Cache {
    value: watch::Sender<Option<Cached>>,
    refresh: Mutex<Refresh>,
}
impl Default for Cache {
    fn default() -> Self {
        Self {
            value: watch::channel(None).0,
            refresh: Mutex::new(Refresh::default()),
        }
    }
}
impl Cached {
    fn usable(mut self) -> Option<Snapshot> {
        let age = self.received.elapsed();
        if age >= RETAIN_FOR {
            return None;
        }
        if age >= REFRESH_AFTER {
            self.snapshot.quota.codex.stale = true;
            self.snapshot.quota.claude.stale = true;
        }
        Some(self.snapshot)
    }
}

// Reset single-flight state even if the task is cancelled during shutdown.
struct RefreshGuard(Arc<Source>);
impl Drop for RefreshGuard {
    fn drop(&mut self) {
        self.0.cache.refresh.lock().unwrap().running = false;
    }
}
impl Source {
    pub(super) fn refresh_if_due(self: &Arc<Self>) {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let mut refresh = self.cache.refresh.lock().unwrap();
        if refresh.running
            || refresh
                .attempted
                .is_some_and(|at| at.elapsed() < REFRESH_AFTER)
        {
            return;
        }
        refresh.running = true;
        refresh.attempted = Some(Instant::now());
        let guard = RefreshGuard(self.clone());
        runtime.spawn(async move {
            let source = &guard.0;
            let started = Instant::now();
            let result = async {
                let (status, value) = source
                    .broker
                    .read(
                        &format!("/api/quota/providers?ownerUserId={}", source.legacy_owner),
                        16384,
                    )
                    .await
                    .map_err(|_| ())?;
                if status != 200 {
                    return Err(());
                }
                let snapshot: Snapshot = serde_json::from_value(value).map_err(|_| ())?;
                if !snapshot.valid() {
                    return Err(());
                }
                Ok(snapshot)
            }
            .await;
            eprintln!(
                "provider_quota_refresh elapsed_ms={} success={}",
                started.elapsed().as_millis(),
                result.is_ok()
            );
            if let Ok(snapshot) = result {
                // Cache only the validated, non-sensitive projection. No raw telemetry.
                source.cache.value.send_replace(Some(Cached {
                    snapshot,
                    received: Instant::now(),
                }));
            }
        });
    }

    pub(super) async fn snapshot(self: &Arc<Self>) -> Result<Snapshot, ()> {
        let mut updates = self.cache.value.subscribe();
        let cached = updates.borrow_and_update().clone();
        if cached
            .as_ref()
            .is_none_or(|v| v.received.elapsed() >= REFRESH_AFTER)
        {
            self.refresh_if_due();
        }
        if let Some(snapshot) = cached.and_then(Cached::usable) {
            return Ok(snapshot);
        }
        // Cold/expired data gets a short grace period; refresh continues independently
        // after a 503, so a later request can use it without restarting the read.
        tokio::time::timeout(COLD_WAIT, async {
            loop {
                updates.changed().await.map_err(|_| ())?;
                if let Some(snapshot) = updates.borrow_and_update().clone().and_then(Cached::usable)
                {
                    return Ok(snapshot);
                }
            }
        })
        .await
        .map_err(|_| ())?
    }
}

#[cfg(test)]
#[path = "provider_quota_cache_tests.rs"]
mod tests;
