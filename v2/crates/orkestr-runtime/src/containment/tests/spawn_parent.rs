//! Production Process path, real Linux parent-thread death, no provider work.
use super::*;

fn task_id() -> u32 {
    fs::read_link("/proc/thread-self")
        .unwrap()
        .file_name()
        .unwrap()
        .to_str()
        .unwrap()
        .parse()
        .unwrap()
}

fn creator(child: u32) -> Option<u32> {
    fs::read_dir("/proc/self/task").unwrap().find_map(|entry| {
        let entry = entry.ok()?;
        let children = fs::read_to_string(entry.path().join("children")).ok()?;
        children
            .split_whitespace()
            .any(|pid| pid.parse::<u32>() == Ok(child))
            .then(|| entry.file_name().to_str().unwrap().parse().unwrap())
    })
}

fn next_frame(child: &OwnedChild, scope: &ExecutionScope) -> Result<Vec<u8>, Error> {
    let until = Instant::now() + Duration::from_secs(3);
    loop {
        match child.poll_stdout(scope)? {
            Output::Frame(bytes) => return Ok(bytes),
            Output::Pending if Instant::now() < until => {
                std::thread::sleep(Duration::from_millis(5));
            }
            _ => return Err(Error::PipeClosed),
        }
    }
}

#[test]
fn transient_caller_exit_cannot_kill_broker_before_original_retirement_wait() {
    let fixture = Fixture::new();
    let scope = scope("synthetic-owner", 1);
    let (authority, _) = authority(&scope);
    let executor = fixture.executor(
        &authority,
        &scope,
        r#"import ctypes,sys
assert ctypes.CDLL(None).prctl(1,9,0,0,0)==0
print('ready',flush=True)
for line in sys.stdin.buffer:
 print('alive',flush=True)
sys.exit(73)
"#,
        TransportBounds::default(),
    );
    let thread_scope = scope.clone();
    let caller = std::thread::spawn(move || {
        let child = executor.spawn(&thread_scope).unwrap();
        let ready = next_frame(&child, &thread_scope);
        let pid = child
            .process
            .live
            .lock()
            .unwrap()
            .child
            .as_ref()
            .unwrap()
            .id();
        (child, ready, pid, task_id(), creator(pid))
    });
    let (child, ready, pid, caller_tid, creator_tid) = caller.join().unwrap();
    let active = child.shared.active.clone();
    let caller_gone = !Path::new(&format!("/proc/self/task/{caller_tid}")).exists();
    let creator_alive = creator_tid.is_some_and(|tid| {
        tid != caller_tid && Path::new(&format!("/proc/self/task/{tid}")).exists()
    });
    // A second actual exchange occurs only after the original caller has exited.
    // Old source gets SIGKILL, so it cannot satisfy this readiness-independent check.
    let usable = (|| {
        child.enqueue_metadata(&scope, &metadata())?;
        let until = Instant::now() + Duration::from_secs(3);
        while child.flush_stdin(&scope)?.pending_frames != 0 {
            if Instant::now() >= until {
                return Err(Error::Backpressure);
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        next_frame(&child, &scope)
    })();
    child.process.broker_launcher.store(true, Ordering::Release);
    let mut retiring = child.retire_broker().unwrap();
    drop(authority);
    let until = Instant::now() + Duration::from_secs(3);
    let proof = loop {
        match retiring.poll_reaped() {
            Ok(None) if Instant::now() < until => {
                std::thread::sleep(Duration::from_millis(5));
            }
            result => break result,
        }
    };
    drop(retiring); // Also quarantines if an unexpected fixture error occurred.
    let until = Instant::now() + Duration::from_secs(3);
    while active.load(Ordering::Acquire) != 0 && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(5));
    }
    // Assert only after the original child was retired or cleanup was joined.
    assert_eq!(active.load(Ordering::Acquire), 0);
    assert!(!Path::new(&format!("/proc/{pid}")).exists());
    assert_eq!(ready, Ok(b"ready".to_vec()));
    assert!(caller_gone && creator_alive);
    assert_eq!(usable, Ok(b"alive".to_vec()));
    assert_eq!(proof.unwrap().unwrap().scope(), &scope);
}
