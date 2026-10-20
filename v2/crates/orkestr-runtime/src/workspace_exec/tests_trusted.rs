//! Real trusted-profile regressions. Require an explicitly provisioned,
//! disposable cgroup subtree and a root-owned image holding the layout-capable
//! supervisor. Never real credentials: the credential fixtures are synthetic.
use super::profile::{Mount, MountKind, Resources, TrustedProfile};
use super::*;
use std::sync::atomic::AtomicBool;

struct Retained(Arc<AtomicBool>);
impl Drop for Retained {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

struct Fixture {
    sandbox: WorkspaceExecSandbox,
    root: PathBuf,
    cgroup: PathBuf,
}

fn variable(name: &str) -> PathBuf {
    PathBuf::from(std::env::var_os(name).expect("explicit trusted fixture"))
}

impl Fixture {
    fn new(configure: impl FnOnce(&mut TrustedProfile, &Path)) -> Self {
        let image = variable("ORKESTR_TEST_TRUSTED_IMAGE");
        let cgroup = variable("ORKESTR_TEST_COMMAND_CGROUP");
        let scratch = variable("ORKESTR_TEST_TRUSTED_SCRATCH");
        let root = scratch.join(format!("trusted-{}", uuid_like()));
        fs::create_dir_all(root.join("workspace")).unwrap();
        let mut profile = TrustedProfile {
            network: false,
            host_root: true,
            workspace_target: "/srv/trusted-project".into(),
            home: "/home/worker".into(),
            path: vec!["/usr/local/bin".into(), "/usr/bin".into()],
            mounts: vec![],
            environment: vec![("BUILD_MODE".into(), "synthetic".into())],
            credential_env_files: vec![],
            resources: Resources {
                pids: 256,
                ..Resources::RESTRICTED
            },
            sync_timeout: Duration::from_secs(10),
            sync_output: 4096,
            job_timeout: Duration::from_secs(20),
            job_output: 64 * 1024,
            max_jobs: 1,
        };
        configure(&mut profile, &root);
        let sandbox = WorkspaceExecSandbox::configured_trusted(&cgroup, &image, profile).unwrap();
        Self {
            sandbox,
            root,
            cgroup,
        }
    }
    fn start(&self, command: &str, kind: CommandKind) -> (WorkspaceExecProcess, Arc<AtomicBool>) {
        let retained = Arc::new(AtomicBool::new(false));
        let limits = self.sandbox.limits(kind).unwrap();
        let process = self
            .sandbox
            .start_directory(
                command,
                File::open(self.root.join("workspace")).unwrap(),
                limits,
                &WorkerCancellation::default(),
                Box::new(Retained(retained.clone())),
                kind,
            )
            .unwrap();
        (process, retained)
    }
    fn clear(&self, retained: &AtomicBool) {
        assert!(retained.load(Ordering::Acquire));
        assert!(fs::read_to_string(self.cgroup.join("cgroup.events"))
            .unwrap()
            .lines()
            .any(|l| l == "populated 0"));
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn uuid_like() -> String {
    format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    )
}

#[test]
#[ignore = "requires provisioned disposable cgroup and layout-capable supervisor image"]
fn trusted_host_root_without_network_or_credentials_by_default() {
    let f = Fixture::new(|_, _| {});
    let check = r#"set -e
test -x /usr/bin/python3; test -f /etc/passwd; test ! -e /etc/shadow; test ! -e /root/.ssh
test "$PWD" = /srv/trusted-project; test "$HOME" = /home/worker; test "$BUILD_MODE" = synthetic
env | cut -d= -f1 | sort | tr '\n' ' '
echo edited > result.txt
python3 -c 'import socket
try: socket.socket(); print("socket-open")
except PermissionError: print("socket-denied")'
if touch /usr/forbidden 2>/dev/null || touch /new-root-file 2>/dev/null; then echo writable-root; fi
"#;
    let (process, retained) = f.start(check, CommandKind::Command);
    let output = process
        .wait_truncated(&WorkerCancellation::default())
        .unwrap();
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert_eq!(output.exit_code, Some(0), "{stdout}");
    assert!(stdout.contains("socket-denied") && !stdout.contains("writable-root"));
    assert!(
        stdout.starts_with("BUILD_MODE HOME LANG PATH PWD TMPDIR "),
        "{stdout}"
    );
    assert_eq!(
        fs::read(f.root.join("workspace/result.txt")).unwrap(),
        b"edited\n"
    );
    f.clear(&retained);
}

#[test]
#[ignore = "requires provisioned disposable cgroup and layout-capable supervisor image"]
fn trusted_network_cache_and_explicit_credentials_only() {
    let f = Fixture::new(|profile, root| {
        fs::create_dir(root.join("cache")).unwrap();
        fs::create_dir(root.join("skill")).unwrap();
        fs::write(root.join("skill/SKILL.md"), b"synthetic skill").unwrap();
        fs::write(root.join("unlisted"), b"must stay absent").unwrap();
        fs::write(root.join("token.env"), b"SYNTHETIC_TOKEN=fixture-value\n").unwrap();
        profile.network = true;
        profile.mounts = vec![
            Mount {
                kind: MountKind::Cache,
                path: root.join("cache"),
            },
            Mount {
                kind: MountKind::Skill,
                path: root.join("skill"),
            },
        ];
        profile.credential_env_files = vec![root.join("token.env")];
    });
    let root = f.root.display().to_string();
    let check = format!(
        r#"set -e
test "$SYNTHETIC_TOKEN" = fixture-value
! tr '\0' ' ' < /proc/1/cmdline | grep -q fixture-value
echo cached > {root}/cache/value
cat {root}/skill/SKILL.md; echo
if echo x > {root}/skill/new 2>/dev/null; then echo skill-writable; fi
test ! -e {root}/unlisted; test ! -e {root}/token.env
python3 -c 'import socket; socket.socket(); print("socket-open")'
"#
    );
    let (process, retained) = f.start(&check, CommandKind::Command);
    let output = process
        .wait_truncated(&WorkerCancellation::default())
        .unwrap();
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert_eq!(
        output.exit_code,
        Some(0),
        "{stdout}{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(stdout.contains("synthetic skill") && stdout.contains("socket-open"));
    assert!(!stdout.contains("skill-writable"));
    assert_eq!(fs::read(f.root.join("cache/value")).unwrap(), b"cached\n");
    f.clear(&retained);
}

#[test]
#[ignore = "requires provisioned disposable cgroup and layout-capable supervisor image"]
fn trusted_output_truncates_and_jobs_stream_until_reaped_timeout() {
    let f = Fixture::new(|profile, _| profile.job_timeout = Duration::from_secs(2));
    let (process, retained) = f.start(
        "python3 -c 'print(\"a\"*100000); print(\"tail-marker\")'",
        CommandKind::Command,
    );
    let output = process
        .wait_truncated(&WorkerCancellation::default())
        .unwrap();
    let text = String::from_utf8(output.stdout).unwrap();
    assert!(text.contains("bytes omitted") && text.ends_with("tail-marker\n"));
    assert!(text.len() < 4096);
    f.clear(&retained);

    let (job, retained) = f.start(
        "for i in 1 2 3; do echo line-$i; done; (setsid sleep 60 &); sleep 60",
        CommandKind::Job,
    );
    // A second concurrent job exceeds max_jobs.
    assert!(matches!(
        f.sandbox.start_directory(
            "true",
            File::open(f.root.join("workspace")).unwrap(),
            f.sandbox.limits(CommandKind::Job).unwrap(),
            &WorkerCancellation::default(),
            Box::new(()),
            CommandKind::Job,
        ),
        Err(Error::Busy)
    ));
    let mut seen = Vec::new();
    let result = job.wait_streaming(&WorkerCancellation::default(), &mut |_, bytes| {
        seen.extend_from_slice(bytes)
    });
    assert!(matches!(result, Err(Error::Timeout)));
    assert_eq!(seen, b"line-1\nline-2\nline-3\n");
    f.clear(&retained);
}
