//! Stable creating thread for contained children and their original wait owner.
//!
//! Linux PR_SET_PDEATHSIG is tied to the thread which created the child. A
//! caller may be a transient async blocking-pool thread, so it must not fork.
use super::{sys, Error, Signal};
use std::process::{Child, Command};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    mpsc::{self, Sender, SyncSender},
    Arc,
};
use std::time::Duration;

enum Work {
    Spawn(Command, SyncSender<Result<Child, Error>>),
    Reap(Child),
}

#[derive(Clone)]
pub(super) struct Reaper(Sender<Work>);

impl Reaper {
    pub(super) fn spawn(&self, command: Command) -> Result<Child, Error> {
        // No queued raw Child: send succeeds only when the waiting caller has
        // taken ownership. Receiver abandonment returns it to this creator.
        let (reply, receiver) = mpsc::sync_channel(0);
        self.0
            .send(Work::Spawn(command, reply))
            .map_err(|_| Error::Io)?;
        receiver.recv().map_err(|_| Error::Io)?
    }

    pub(super) fn send(&self, child: Child) -> Result<(), mpsc::SendError<Child>> {
        self.0.send(Work::Reap(child)).map_err(|error| {
            let Work::Reap(child) = error.0 else {
                unreachable!("only reaping is submitted by this method")
            };
            mpsc::SendError(child)
        })
    }
}

pub(super) fn start_reaper(active: Arc<AtomicUsize>) -> Result<Reaper, Error> {
    start_reaper_retained(active, Box::new(()))
}

pub(super) fn start_reaper_retained(
    active: Arc<AtomicUsize>,
    resources: Box<dyn Send + 'static>,
) -> Result<Reaper, Error> {
    let (sender, receiver) = mpsc::channel::<Work>();
    std::thread::Builder::new()
        .name("contained-reaper".into())
        .spawn(move || {
            // Capacity/scratch and the actual creating OS thread survive every
            // checked-out Child, including WNOWAIT and retirement transfers.
            let _resources = resources;
            let mut pending = Vec::new();
            let mut disconnected = false;
            loop {
                // Nothing to reap: sleep until work arrives or every sender is
                // gone instead of waking 200 times a second while idle.
                let work = if pending.is_empty() && !disconnected {
                    receiver
                        .recv()
                        .map_err(|_| mpsc::RecvTimeoutError::Disconnected)
                } else {
                    receiver.recv_timeout(Duration::from_millis(5))
                };
                match work {
                    Ok(Work::Spawn(mut command, reply)) => {
                        let result = command.spawn().map_err(|_| Error::Io);
                        if result.is_ok() {
                            active.fetch_add(1, Ordering::AcqRel);
                        }
                        if let Err(mpsc::SendError(Ok(child))) = reply.send(result) {
                            // A cancelled handoff grants no replacement or
                            // retirement proof. Keep this exact Child to wait.
                            let _ = sys::signal_group(child.id(), Signal::Kill);
                            pending.push(child);
                        }
                    }
                    Ok(Work::Reap(child)) => pending.push(child),
                    Err(mpsc::RecvTimeoutError::Disconnected) => disconnected = true,
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                }
                let mut index = 0;
                while index < pending.len() {
                    match pending[index].try_wait() {
                        Ok(None) => index += 1,
                        Ok(Some(_)) => {
                            let mut child = pending.swap_remove(index);
                            // try_wait cached this exact status; wait cannot block.
                            let _ = child.wait();
                            active.fetch_sub(1, Ordering::AcqRel);
                        }
                        // Unknown wait retains ownership, capacity and creator.
                        Err(_) => index += 1,
                    }
                }
                if disconnected && pending.is_empty() && active.load(Ordering::Acquire) == 0 {
                    break;
                }
                if disconnected {
                    std::thread::sleep(Duration::from_millis(5));
                }
            }
        })
        .map_err(|_| Error::Io)?;
    Ok(Reaper(sender))
}

#[cfg(test)]
#[path = "reaper_tests.rs"]
mod tests;
