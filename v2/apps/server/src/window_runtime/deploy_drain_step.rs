//! Deploy drain pass: existing decisions plus bounded predicate observations.
use super::Controller;
use crate::deploy_drain::DrainWindowDiagnostic;
use std::sync::atomic::Ordering;

impl Controller {
    pub(in crate::window_runtime) async fn drain_step(&self) {
        self.queue.pending.store(true, Ordering::Release);
        let Some(browser) = self.queue.credential() else {
            self.drain.observe(None, None);
            self.drain.observe_diagnostics(Vec::new());
            return;
        };
        let _opening = self.opening.lock().await;
        if self.queue.is_closed() {
            return;
        }
        self.sweep(&browser).await;
        self.reconcile_expired_locked(&browser).await;
        let mut diagnostics = Vec::new();
        for (_, entry) in self.entries_by_conversation() {
            if !entry.has_local_task().await {
                continue;
            }
            let (result, diagnostic) = entry.retire_for_drain(&browser).await;
            if let Err(reason) = result {
                eprintln!("deploy drain: idle window retirement failed: {reason}");
            }
            diagnostics.push(diagnostic);
        }
        let unresolved = self
            .store
            .unresolved_execution_windows_authenticated(&browser)
            .await
            .ok();
        // Reuse this pass's existing Core read. Never query another scope or run.
        if let Some(windows) = &unresolved {
            let now = crate::deploy_drain::now_ms();
            for w in windows {
                let index = match diagnostics.iter().position(|d| {
                    d.conversation_id == w.conversation_id
                        && (d.window_id.is_none() || d.window_id == Some(w.window_id))
                }) {
                    Some(i) => i,
                    None => {
                        diagnostics.push(DrainWindowDiagnostic::new(w.conversation_id.clone()));
                        diagnostics.len() - 1
                    }
                };
                let d = &mut diagnostics[index];
                d.window_id = Some(w.window_id);
                d.generation = Some(w.generation);
                d.age_ms = Some(now.saturating_sub(w.opened_at_ms).max(0));
            }
        }
        let queued = self
            .store
            .execution_window_queue_authenticated(&browser, None)
            .await
            .ok()
            .map(|rows| rows.len());
        self.drain.observe(
            unresolved.and_then(|windows| u32::try_from(windows.len()).ok()),
            queued,
        );
        self.drain.observe_diagnostics(diagnostics);
    }
}
