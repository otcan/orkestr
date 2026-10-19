//! One bounded controller per ordinary server; no detached timer tasks.
use crate::timer_http::durable::DurableTimerController;
use std::time::Duration;
use tokio::{sync::watch, task::JoinHandle};

struct Ready(std::sync::Arc<std::sync::atomic::AtomicBool>);
impl Drop for Ready {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::Release);
    }
}
pub struct TimerTask {
    shutdown: watch::Sender<bool>,
    stopped: watch::Receiver<bool>,
    task: JoinHandle<Result<(), orkestr_v2_store_sqlite::history_import::HistoryError>>,
}

impl TimerTask {
    pub(crate) fn start(
        controller: DurableTimerController,
        ready: std::sync::Arc<std::sync::atomic::AtomicBool>,
    ) -> Self {
        let (shutdown, requested) = watch::channel(false);
        let (finished, stopped) = watch::channel(false);
        ready.store(true, std::sync::atomic::Ordering::Release);
        let guard = Ready(ready);
        Self {
            shutdown,
            stopped,
            task: tokio::spawn(async move {
                let _guard = guard;
                let result = controller.run(requested).await;
                let _ = finished.send(true);
                result
            }),
        }
    }

    /// Unexpected controller exit must stop the ordinary server, not silently unarm.
    pub async fn stopped(&mut self) {
        if !*self.stopped.borrow() {
            let _ = self.stopped.changed().await;
        }
    }
    pub async fn shutdown(mut self) -> Result<(), &'static str> {
        let _ = self.shutdown.send(true);
        // A controller pass has its own five-second deadline. Give that pass
        // time to finish, then refuse clean shutdown if it cannot be joined.
        match tokio::time::timeout(Duration::from_secs(6), &mut self.task).await {
            Ok(Ok(Ok(()))) => Ok(()),
            Ok(Ok(Err(_))) | Ok(Err(_)) => Err("timer controller failed during shutdown"),
            Err(_) => {
                self.task.abort();
                let _ = (&mut self.task).await;
                Err("timer controller shutdown timed out")
            }
        }
    }
}

impl Drop for TimerTask {
    fn drop(&mut self) {
        let _ = self.shutdown.send(true);
        self.task.abort();
    }
}
