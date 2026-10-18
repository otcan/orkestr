use super::*;
use std::os::fd::AsRawFd;
use std::sync::atomic::AtomicU64;

static FIXTURE: AtomicU64 = AtomicU64::new(0);
static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn serial() -> std::sync::MutexGuard<'static, ()> {
    TEST_LOCK.lock().unwrap()
}

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").expect("isolated test home"));
        let path = root.join(format!(
            "sandbox-{}-{}",
            std::process::id(),
            FIXTURE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn sandbox() -> WorkerSandbox {
    // These are actual OS acceptance tests. Missing host support must fail, not skip.
    WorkerSandbox::opt_in_python_offline().expect("fixed supported sandbox profile")
}

fn successful(output: WorkerOutput) -> Vec<u8> {
    assert_eq!(
        output.exit_code,
        Some(0),
        "sandbox stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.signal, None);
    assert!(output.stderr.is_empty());
    output.stdout
}

#[test]
fn actual_worker_has_no_host_files_credentials_fds_processes_or_network() {
    let _serial = serial();
    let fixture = Fixture::new();
    let credential = fixture.0.join("synthetic-credentials");
    fs::create_dir(&credential).unwrap();
    let sentinel = credential.join("auth.json");
    fs::write(&sentinel, b"synthetic sentinel only; never an actual token").unwrap();
    let inherited = fs::File::open(&sentinel).unwrap();
    unsafe extern "C" {
        fn fcntl(fd: i32, command: i32, ...) -> i32;
    }
    // Deliberately inheritable synthetic FD: the launcher must close it at exec.
    assert_eq!(unsafe { fcntl(inherited.as_raw_fd(), 2, 0) }, 0);
    let host_path = serde_json::to_string(&sentinel.to_str().unwrap()).unwrap();
    let code = format!(
        r#"
import ctypes, errno, json, os, pathlib, resource, socket
sentinel = {host_path}
parent = {parent}
def blocked(action):
    try:
        action()
        return False
    except OSError as error:
        return error.errno in (errno.EPERM, errno.EACCES, errno.ENOENT, errno.EROFS)
def read(path):
    return pathlib.Path(path).read_bytes()
os.symlink(sentinel, '/work/alias')
checks = {{
    'host_file': blocked(lambda: read(sentinel)),
    'symlink_alias': blocked(lambda: read('/work/alias')),
    'parent_proc_root': blocked(lambda: read('/proc/%d/root%s' % (parent, sentinel))),
    'own_proc_root': blocked(lambda: read('/proc/self/root' + sentinel)),
    'host_parent_invisible': not pathlib.Path('/proc/%d' % parent).exists(),
    'root_readonly': blocked(lambda: pathlib.Path('/write-denied').write_text('x')),
    'runtime_readonly': blocked(lambda: pathlib.Path('/usr/bin/write-denied').write_text('x')),
    'device_directory_readonly': blocked(lambda: pathlib.Path('/dev/write-denied').write_text('x')),
    'inet_socket': blocked(lambda: socket.socket(socket.AF_INET)),
    'unix_socket': blocked(lambda: socket.socket(socket.AF_UNIX)),
    'memfd': blocked(lambda: os.memfd_create('untrusted')),
    'environment': set(os.environ) <= {{'HOME', 'PATH', 'PWD', 'TMPDIR', 'LANG', 'LC_CTYPE'}},
    'home': os.environ.get('HOME') == '/home/worker' and os.environ.get('PWD') == '/work',
}}
links = []
for entry in pathlib.Path('/proc/self/fd').iterdir():
    try:
        links.append(os.readlink(entry))
    except FileNotFoundError:
        pass
checks['inherited_fd_closed'] = all(link == '/dev/null' or link.startswith('pipe:[') for link in links)
status = dict(line.split(':', 1) for line in read('/proc/self/status').decode().splitlines() if ':' in line)
checks['no_new_privileges'] = status['NoNewPrivs'].strip() == '1'
checks['no_capabilities'] = int(status['CapEff'].strip(), 16) == 0
checks['seccomp'] = status['Seccomp'].strip() == '2'
checks['private_proc'] = len([p for p in pathlib.Path('/proc').iterdir() if p.name.isdigit()]) <= 3
try:
    child = os.fork()
except PermissionError:
    checks['fork'] = True
else:
    if child == 0:
        os._exit(99)
    os.waitpid(child, 0)
    checks['fork'] = False
libc = ctypes.CDLL(None, use_errno=True)
checks['unshare'] = libc.unshare(0x00020000) == -1 and ctypes.get_errno() == errno.EPERM
checks['clone3'] = libc.syscall(435, 0, 0) == -1 and ctypes.get_errno() == errno.EPERM
checks['resource_limits'] = all(resource.getrlimit(key) == (value, value) for key, value in (
    (resource.RLIMIT_AS, 256 * 1024 * 1024), (resource.RLIMIT_NOFILE, 128),
    (resource.RLIMIT_FSIZE, 8 * 1024 * 1024), (resource.RLIMIT_CORE, 0)))
checks['scratch_sizes'] = all(os.statvfs(path).f_blocks * os.statvfs(path).f_frsize == size * 1024 * 1024
    for path, size in (('/work', 32), ('/tmp', 16), ('/home/worker', 8), ('/dev/shm', 16)))
for directory in ('/work', '/tmp', '/home/worker'):
    path = pathlib.Path(directory) / 'synthetic-output'
    path.write_text('scratch')
    checks['writable_' + directory] = path.read_text() == 'scratch'
print(json.dumps(checks, sort_keys=True))
"#,
        parent = std::process::id()
    );
    let bytes = successful(
        sandbox()
            .run_python(
                &code,
                WorkerLimits::default(),
                &WorkerCancellation::default(),
            )
            .unwrap(),
    );
    let checks: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let entries = checks.as_object().unwrap();
    assert_eq!(entries.len(), 26);
    for (name, value) in entries {
        assert_eq!(value, true, "boundary check: {name}");
    }
    assert_eq!(
        fs::read(&sentinel).unwrap(),
        b"synthetic sentinel only; never an actual token"
    );
}

#[test]
fn workers_have_fresh_scratch_and_return_nonzero_without_fallback() {
    let _serial = serial();
    let sandbox = sandbox();
    let cancel = WorkerCancellation::default();
    successful(
        sandbox
            .run_python(
                "open('/work/previous', 'w').write('synthetic')",
                WorkerLimits::default(),
                &cancel,
            )
            .unwrap(),
    );
    let output = sandbox
        .run_python(
            "import os; assert not os.path.exists('/work/previous'); raise SystemExit(7)",
            WorkerLimits::default(),
            &cancel,
        )
        .unwrap();
    assert_eq!(output.exit_code, Some(7));
    assert_eq!(output.signal, None);
}

#[test]
fn source_limits_cancellation_and_concurrency_refuse_before_spawn() {
    let _serial = serial();
    let sandbox = sandbox();
    let defaults = WorkerLimits::default();
    let cancel = WorkerCancellation::default();
    for code in ["", "x\0", &"x".repeat(MAX_SOURCE + 1)] {
        assert!(matches!(
            sandbox.run_python(code, defaults, &cancel),
            Err(Error::InvalidInput)
        ));
    }
    for limits in [
        WorkerLimits {
            timeout: Duration::ZERO,
            ..defaults
        },
        WorkerLimits {
            timeout: Duration::from_secs(31),
            ..defaults
        },
        WorkerLimits {
            max_output_bytes: 0,
            ..defaults
        },
        WorkerLimits {
            max_output_bytes: 128 * 1024 + 1,
            ..defaults
        },
    ] {
        assert!(matches!(
            sandbox.run_python("pass", limits, &cancel),
            Err(Error::InvalidInput)
        ));
    }
    let slots: Vec<_> = (0..MAX_ACTIVE).map(|_| Slot::acquire().unwrap()).collect();
    assert!(matches!(
        sandbox.run_python("pass", defaults, &cancel),
        Err(Error::Busy)
    ));
    drop(slots);
    cancel.cancel();
    assert!(matches!(
        sandbox.run_python("pass", defaults, &cancel),
        Err(Error::Cancelled)
    ));
    assert_eq!(ACTIVE.load(Ordering::Acquire), 0);
}

#[test]
fn immutable_policy_and_fixed_command_cannot_be_request_overridden() {
    let _serial = serial();
    let sandbox = sandbox();
    let mut policy = linux::filter().unwrap();
    assert!(linux::policy_is_sealed(&mut policy));
    let command = sandbox.command("pass", WorkerLimits::default(), &policy);
    assert_eq!(command.get_program(), "/usr/bin/bwrap");
    assert!(command.get_envs().next().is_none());
    let args: Vec<_> = command
        .get_args()
        .map(|arg| arg.to_str().unwrap())
        .collect();
    for arg in [
        "--unshare-pid",
        "--unshare-net",
        "--unshare-user",
        "--clearenv",
        "--seccomp",
        "--disable-userns",
    ] {
        assert!(args.contains(&arg));
    }
    assert!(!args.contains(&"--bind"));
    assert!(!args.contains(&"--share-net"));
    let fixture = Fixture::new();
    assert!(matches!(
        trusted(&fixture.0, true),
        Err(Error::InvalidConfig)
    ));
}

#[test]
fn output_deadline_and_active_cancellation_are_bounded() {
    let _serial = serial();
    let sandbox = sandbox();
    let cancel = WorkerCancellation::default();
    assert!(matches!(
        sandbox.run_python(
            "import os; os.write(1, b'x' * 8192)",
            WorkerLimits {
                max_output_bytes: 4096,
                ..WorkerLimits::default()
            },
            &cancel
        ),
        Err(Error::OutputLimit)
    ));
    let started = Instant::now();
    assert!(matches!(
        sandbox.run_python(
            "while True: pass",
            WorkerLimits {
                timeout: Duration::from_millis(200),
                ..WorkerLimits::default()
            },
            &cancel
        ),
        Err(Error::Timeout)
    ));
    assert!(started.elapsed() < Duration::from_secs(3));
    let signal = cancel.clone();
    let canceller = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(150));
        signal.cancel();
    });
    let started = Instant::now();
    let result = sandbox.run_python("while True: pass", WorkerLimits::default(), &cancel);
    canceller.join().unwrap();
    assert!(matches!(result, Err(Error::Cancelled)));
    assert!(started.elapsed() < Duration::from_secs(3));
    assert_eq!(ACTIVE.load(Ordering::Acquire), 0);
}

#[path = "cleanup_tests.rs"]
mod cleanup;
