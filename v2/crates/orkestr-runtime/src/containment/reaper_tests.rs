use super::*;
use std::fs;
use std::io::Read;
use std::os::fd::AsRawFd;
use std::os::unix::{net::UnixStream, process::CommandExt};
use std::process::Stdio;
use std::time::Instant;

struct Resource(Sender<()>);
impl Drop for Resource {
    fn drop(&mut self) {
        let _ = self.0.send(());
    }
}

struct CheckedOut {
    child: Option<Child>,
    active: Arc<AtomicUsize>,
}
impl Drop for CheckedOut {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            if child.wait().is_ok() {
                self.active.fetch_sub(1, Ordering::AcqRel);
            }
        }
    }
}

fn creator(child: u32) -> u32 {
    fs::read_dir("/proc/self/task")
        .unwrap()
        .find_map(|entry| {
            let entry = entry.ok()?;
            fs::read_to_string(entry.path().join("children"))
                .ok()?
                .split_whitespace()
                .any(|pid| pid.parse::<u32>() == Ok(child))
                .then(|| entry.file_name().to_str().unwrap().parse().unwrap())
        })
        .unwrap()
}

#[test]
fn creator_survives_disconnected_senders_and_wnowait_until_exact_wait() {
    let (released, observed) = mpsc::channel();
    let active = Arc::new(AtomicUsize::new(0));
    let reaper = start_reaper_retained(active.clone(), Box::new(Resource(released))).unwrap();
    let mut command = Command::new("/bin/cat");
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .process_group(0);
    let child = reaper.spawn(command).unwrap();
    let mut owned = CheckedOut {
        child: Some(child),
        active: active.clone(),
    };
    let pid = owned.child.as_ref().unwrap().id();
    let tid = creator(pid);
    let input = owned.child.as_mut().unwrap().stdin.take().unwrap();
    drop(reaper);
    assert!(observed.recv_timeout(Duration::from_millis(30)).is_err());
    assert!(std::path::Path::new(&format!("/proc/self/task/{tid}")).exists());
    drop(input);
    let until = Instant::now() + Duration::from_secs(3);
    while sys::observe_exit(pid).unwrap().is_none() {
        assert!(Instant::now() < until);
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(observed.recv_timeout(Duration::from_millis(30)).is_err());
    assert!(std::path::Path::new(&format!("/proc/self/task/{tid}")).exists());
    assert!(std::path::Path::new(&format!("/proc/{pid}")).exists());
    assert!(owned.child.as_mut().unwrap().wait().unwrap().success());
    owned.child = None;
    active.fetch_sub(1, Ordering::AcqRel);
    observed.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!(active.load(Ordering::Acquire), 0);
    assert!(!std::path::Path::new(&format!("/proc/{pid}")).exists());
}

#[test]
fn failed_exec_releases_creator_resources_without_capacity_credit() {
    let (released, observed) = mpsc::channel();
    let active = Arc::new(AtomicUsize::new(0));
    let reaper = start_reaper_retained(active.clone(), Box::new(Resource(released))).unwrap();
    assert!(matches!(
        reaper.spawn(Command::new("/nonexistent-contained-fixture")),
        Err(Error::Io)
    ));
    assert_eq!(active.load(Ordering::Acquire), 0);
    drop(reaper);
    observed.recv_timeout(Duration::from_secs(3)).unwrap();
}

#[test]
fn abandoned_spawn_reply_kills_and_waits_same_child_before_release() {
    unsafe extern "C" {
        fn getpid() -> i32;
        fn write(fd: i32, data: *const std::ffi::c_void, count: usize) -> isize;
    }
    let (released, observed) = mpsc::channel();
    let active = Arc::new(AtomicUsize::new(0));
    let reaper = start_reaper_retained(active.clone(), Box::new(Resource(released))).unwrap();
    let (mut parent, child_report) = UnixStream::pair().unwrap();
    parent
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut command = Command::new("/bin/cat");
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .process_group(0);
    // Capture the actual child identity before exec, even if reply abandonment
    // kills it before it executes user code. Only async-signal-safe syscalls.
    unsafe {
        command.pre_exec(move || {
            let pid = getpid().to_ne_bytes();
            if write(child_report.as_raw_fd(), pid.as_ptr().cast(), pid.len()) != pid.len() as isize
            {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let (reply, receiver) = mpsc::sync_channel(0);
    drop(receiver);
    assert!(reaper.0.send(Work::Spawn(command, reply)).is_ok());
    drop(reaper);
    let mut bytes = [0; 4];
    parent.read_exact(&mut bytes).unwrap();
    let pid = i32::from_ne_bytes(bytes);
    observed.recv_timeout(Duration::from_secs(3)).unwrap();
    assert_eq!(active.load(Ordering::Acquire), 0);
    assert!(!std::path::Path::new(&format!("/proc/{pid}")).exists());
}

#[test]
fn idle_reaper_blocks_yet_reaps_returned_child_and_releases_on_disconnect() {
    let (released, observed) = mpsc::channel();
    let active = Arc::new(AtomicUsize::new(0));
    let reaper = start_reaper_retained(active.clone(), Box::new(Resource(released))).unwrap();
    let mut command = Command::new("/bin/true");
    command.stdout(Stdio::null()).process_group(0);
    let child = reaper.spawn(command).unwrap();
    let pid = child.id();
    // The idle reaper is parked in a blocking receive; returned work wakes it.
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(active.load(Ordering::Acquire), 1);
    assert!(reaper.send(child).is_ok());
    let until = Instant::now() + Duration::from_secs(3);
    while active.load(Ordering::Acquire) != 0 {
        assert!(Instant::now() < until);
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(!std::path::Path::new(&format!("/proc/{pid}")).exists());
    assert!(observed.recv_timeout(Duration::from_millis(30)).is_err());
    drop(reaper);
    observed.recv_timeout(Duration::from_secs(3)).unwrap();
}
