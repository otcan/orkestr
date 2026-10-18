use super::*;

fn identity(pid: u32) -> Option<String> {
    // Only known owned descendants, never host process enumeration or command lines.
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let (_, fields) = stat.rsplit_once(") ")?;
    fields.split_whitespace().nth(19).map(str::to_owned)
}

fn descendants(pid: u32, output: &mut Vec<(u32, String)>) {
    if output.iter().any(|(seen, _)| *seen == pid) {
        return;
    }
    let Some(start) = identity(pid) else {
        return;
    };
    output.push((pid, start));
    let tasks = fs::read_dir(format!("/proc/{pid}/task")).unwrap();
    for task in tasks {
        let children =
            fs::read_to_string(task.unwrap().path().join("children")).unwrap_or_default();
        for child in children.split_whitespace() {
            descendants(child.parse().unwrap(), output);
        }
    }
}

#[test]
fn owned_drop_kills_only_its_known_tree_and_reaps_the_leader() {
    let _serial = serial();
    let sandbox = sandbox();
    let policy = linux::filter().unwrap();
    let child = sandbox
        .command(
            "import time; print('ready', flush=True); time.sleep(20)",
            WorkerLimits::default(),
            &policy,
        )
        .spawn()
        .unwrap();
    let mut owned = Owned(Some(child));
    drop(policy);
    let mut stdout = owned.0.as_mut().unwrap().stdout.take().unwrap();
    linux::nonblocking(&stdout).unwrap();
    let started = Instant::now();
    let mut bytes = Vec::new();
    let mut total = 0;
    while !bytes.ends_with(b"ready\n") {
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(
            !drain(&mut stdout, &mut bytes, &mut total, 1024).unwrap(),
            "worker exited before readiness"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    let leader = owned.id();
    let mut tree = Vec::new();
    descendants(leader, &mut tree);
    assert!(tree.len() >= 2, "actual namespace child must be observed");
    drop(owned);
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let remaining = tree
            .iter()
            .any(|(pid, start)| identity(*pid).as_ref() == Some(start));
        if !remaining {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "known owned process remains after cleanup"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(identity(leader).is_none());
}

struct TreeCleanup(Vec<fs::File>);

#[test]
fn spawn_only_handle_retains_cleanup_before_any_wait_call() {
    let _serial = serial();
    let mut process = sandbox()
        .start_python(
            "import time; print('ready', flush=True); time.sleep(20)",
            WorkerLimits::default(),
            &WorkerCancellation::default(),
        )
        .unwrap();
    let (mut bytes, mut total) = (Vec::new(), 0);
    let deadline = Instant::now() + Duration::from_secs(5);
    while !bytes.ends_with(b"ready\n") {
        assert!(Instant::now() < deadline);
        assert!(!drain(&mut process.stdout, &mut bytes, &mut total, 1024).unwrap());
        std::thread::sleep(Duration::from_millis(2));
    }
    let mut tree = Vec::new();
    descendants(process.owned.id(), &mut tree);
    assert!(tree.len() >= 2);
    let _cleanup = TreeCleanup::capture(&tree);
    drop(process);
    let deadline = Instant::now() + Duration::from_secs(3);
    while tree
        .iter()
        .any(|(pid, start)| identity(*pid).as_ref() == Some(start))
    {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(ACTIVE.load(Ordering::Acquire), 0);
}
unsafe extern "C" {
    fn syscall(number: i64, ...) -> i64;
}
impl TreeCleanup {
    fn capture(tree: &[(u32, String)]) -> Self {
        use std::os::fd::FromRawFd;
        Self(
            tree.iter()
                .map(|(pid, _)| {
                    // SAFETY: known owned tree, still alive at readiness. pidfd pins the
                    // identity for failure cleanup even if a numeric PID is later reused.
                    let fd = unsafe { syscall(434, i64::from(*pid), 0_i64) };
                    assert!(fd >= 0);
                    unsafe { fs::File::from_raw_fd(i32::try_from(fd).unwrap()) }
                })
                .collect(),
        )
    }
}
impl Drop for TreeCleanup {
    fn drop(&mut self) {
        for file in &self.0 {
            // SAFETY: owned pidfd only; no process-name or numeric-PID cleanup.
            unsafe {
                syscall(424, i64::from(file.as_raw_fd()), 9_i64, 0_i64, 0_i64);
            }
        }
    }
}

#[test]
fn supervisor_sigkill_cannot_leave_an_owned_worker_running() {
    use std::io::Write;
    let _serial = serial();
    const HELPER: &str = "ORKESTR_WORKER_SANDBOX_TEST_HELPER";
    if std::env::var_os(HELPER).is_some() {
        let policy = linux::filter().unwrap();
        let child = sandbox()
            .command(
                "import time; print('payload-ready', flush=True); time.sleep(20)",
                WorkerLimits::default(),
                &policy,
            )
            .spawn()
            .unwrap();
        let mut owned = Owned(Some(child));
        drop(policy);
        let mut stdout = owned.0.as_mut().unwrap().stdout.take().unwrap();
        linux::nonblocking(&stdout).unwrap();
        let (mut bytes, mut total) = (Vec::new(), 0);
        let deadline = Instant::now() + Duration::from_secs(5);
        while !bytes.ends_with(b"payload-ready\n") {
            assert!(Instant::now() < deadline);
            assert!(!drain(&mut stdout, &mut bytes, &mut total, 1024).unwrap());
            std::thread::sleep(Duration::from_millis(2));
        }
        println!("supervisor-ready");
        std::io::stdout().flush().unwrap();
        // Parent deliberately SIGKILLs this helper: Owned::drop cannot run.
        std::thread::sleep(Duration::from_secs(20));
        return;
    }
    let mut command = Command::new(std::env::current_exe().unwrap());
    command.env_clear().env(HELPER, "1")
        .args(["--exact", "worker_sandbox::implementation::tests::cleanup::supervisor_sigkill_cannot_leave_an_owned_worker_running", "--nocapture"])
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).process_group(0);
    let mut helper = Owned(Some(command.spawn().unwrap()));
    let mut stdout = helper.0.as_mut().unwrap().stdout.take().unwrap();
    linux::nonblocking(&stdout).unwrap();
    let (mut bytes, mut total) = (Vec::new(), 0);
    let deadline = Instant::now() + Duration::from_secs(5);
    while !bytes
        .windows(b"supervisor-ready".len())
        .any(|part| part == b"supervisor-ready")
    {
        assert!(Instant::now() < deadline);
        assert!(!drain(&mut stdout, &mut bytes, &mut total, 8192).unwrap());
        std::thread::sleep(Duration::from_millis(2));
    }
    let mut tree = Vec::new();
    descendants(helper.id(), &mut tree);
    assert!(tree.len() >= 3);
    let _cleanup = TreeCleanup::capture(&tree);
    helper.0.as_mut().unwrap().kill().unwrap();
    assert_eq!(helper.finish().unwrap().signal(), Some(9));
    let deadline = Instant::now() + Duration::from_secs(3);
    while tree
        .iter()
        .any(|(pid, start)| identity(*pid).as_ref() == Some(start))
    {
        assert!(
            Instant::now() < deadline,
            "supervisor death left a known child alive"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}
