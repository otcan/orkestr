use super::process::start_reaper_retained;
use std::process::{Command, Stdio};
use std::sync::{atomic::AtomicUsize, mpsc, Arc};
use std::time::Duration;

struct Resource(mpsc::Sender<()>);
impl Drop for Resource {
    fn drop(&mut self) {
        let _ = self.0.send(());
    }
}

#[test]
fn resources_outlive_sender_and_child_until_wait() {
    let (released, observed) = mpsc::channel();
    let active = Arc::new(AtomicUsize::new(1));
    let reaper = start_reaper_retained(active.clone(), Box::new(Resource(released))).unwrap();
    let mut child = Command::new("/bin/cat")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    let input = child.stdin.take().unwrap();
    reaper.send(child).unwrap();
    drop(reaper);
    assert!(observed.recv_timeout(Duration::from_millis(30)).is_err());
    drop(input);
    observed.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(active.load(std::sync::atomic::Ordering::Acquire), 0);
}

#[test]
fn pre_spawn_failure_releases_resources_when_owner_closes() {
    let (released, observed) = mpsc::channel();
    let reaper =
        start_reaper_retained(Arc::new(AtomicUsize::new(0)), Box::new(Resource(released))).unwrap();
    drop(reaper);
    observed.recv_timeout(Duration::from_secs(5)).unwrap();
}
