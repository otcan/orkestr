//! One bounded controller per ordinary server; no detached timer tasks.
use crate::timer_http::TimerController;
use std::time::Duration;
use tokio::{sync::watch, task::JoinHandle};

pub struct TimerTask {
    shutdown: watch::Sender<bool>,
    task: JoinHandle<()>,
}

impl TimerTask {
    pub(crate) fn start(controller: TimerController) -> Self {
        let (shutdown, requested) = watch::channel(false);
        Self {
            shutdown,
            task: tokio::spawn(controller.run(requested)),
        }
    }

    pub async fn shutdown(mut self) -> Result<(), &'static str> {
        let _ = self.shutdown.send(true);
        // A controller pass has its own five-second deadline. Give that pass
        // time to finish, then refuse clean shutdown if it cannot be joined.
        match tokio::time::timeout(Duration::from_secs(6), &mut self.task).await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(_)) => Err("timer controller failed during shutdown"),
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
