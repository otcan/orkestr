//! Real isolated command regressions. Require an explicitly provisioned,
//! disposable cgroup subtree and the immutable test image; never provider auth.
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
impl Fixture {
    fn new() -> Self {
        let image = std::env::var_os("ORKESTR_TEST_COMMAND_IMAGE").expect("explicit command image");
        let cgroup = PathBuf::from(
            std::env::var_os("ORKESTR_TEST_COMMAND_CGROUP").expect("disposable delegated cgroup"),
        );
        let sandbox = WorkspaceExecSandbox::configured(&cgroup, Path::new(&image)).unwrap();
        let root =
            std::env::temp_dir().join(format!("workspace-command-test-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        Self {
            sandbox,
            root,
            cgroup,
        }
    }
    fn start(
        &self,
        command: &str,
        limits: WorkerLimits,
    ) -> (WorkspaceExecProcess, Arc<AtomicBool>) {
        let retained = Arc::new(AtomicBool::new(false));
        let process = self
            .sandbox
            .start_directory(
                command,
                File::open(&self.root).unwrap(),
                limits,
                &WorkerCancellation::default(),
                Box::new(Retained(retained.clone())),
            )
            .unwrap();
        assert!(!retained.load(Ordering::Acquire));
        (process, retained)
    }
    fn clear(&self, retained: &AtomicBool) {
        assert!(
            retained.load(Ordering::Acquire),
            "resource released only after wait"
        );
        assert!(fs::read_to_string(self.cgroup.join("cgroup.events"))
            .unwrap()
            .lines()
            .any(|l| l == "populated 0"));
        assert!(fs::read_dir(&self.cgroup).unwrap().all(|entry| !entry
            .unwrap()
            .file_type()
            .unwrap()
            .is_dir()));
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn absent_or_alias_configuration_never_falls_back_to_host_execution() {
    assert!(matches!(
        WorkspaceExecSandbox::configured(
            Path::new("/absent-synthetic-group"),
            Path::new("/absent-synthetic-image")
        ),
        Err(Error::InvalidConfig)
    ));
    assert!(matches!(
        WorkspaceExecSandbox::configured(Path::new("/"), Path::new("/")),
        Err(Error::InvalidConfig)
    ));
}

#[test]
#[ignore = "requires explicitly provisioned disposable cgroup and immutable command image"]
fn actual_workspace_commands_isolation_limits_and_all_descendant_reap() {
    let f = Fixture::new();
    let normal = WorkerLimits {
        timeout: Duration::from_secs(5),
        max_output_bytes: 128 * 1024,
    };
    let (process, retained) = f.start(
        "printf 'edited by command' > result.txt; cat result.txt",
        normal,
    );
    let output = process.wait(&WorkerCancellation::default()).unwrap();
    assert_eq!(output.exit_code, Some(0));
    assert_eq!(output.stdout, b"edited by command");
    assert_eq!(fs::read(f.root.join("result.txt")).unwrap(), output.stdout);
    f.clear(&retained);

    // A second distinct command sees the real persisted workspace mutation.
    let (process, retained) = f.start("python3 -c 'from pathlib import Path; assert Path(\"result.txt\").read_text()==\"edited by command\"; print(\"read back\")'", normal);
    assert_eq!(
        process.wait(&WorkerCancellation::default()).unwrap().stdout,
        b"read back\n"
    );
    f.clear(&retained);

    let (process, retained) = f.start("python3 -c 'import os,socket; from pathlib import Path; assert not Path(\"/account\").exists(); assert not Path(\"/root\").exists(); assert not Path(\"/home/host-owner\").exists(); assert not Path(\"/sys/fs/cgroup\").exists(); assert set(os.environ)<=set(\"HOME PATH PWD TMPDIR LANG LC_CTYPE\".split()); denied=False\ntry: socket.socket()\nexcept PermissionError: denied=True\nassert denied\nprint(\"isolated\")'", normal);
    let output = process.wait(&WorkerCancellation::default()).unwrap();
    assert_eq!(output.exit_code, Some(0));
    assert_eq!(output.stdout, b"isolated\n");
    f.clear(&retained);

    // Namespace init and the outside subreaper collect setsid/double-fork
    // descendants. Output EOF is insufficient; all job tasks and originals end.
    let (process, retained) = f.start("python3 -c 'import os,time\np=os.fork()\nif p==0:\n os.setsid()\n if os.fork()==0:\n  os.close(1);os.close(2);time.sleep(60)\n os._exit(0)\nos.waitpid(p,0)\nopen(\"forked.marker\",\"w\").write(\"ready\")'\nsleep 60", WorkerLimits { timeout: Duration::from_secs(1), ..normal });
    assert!(matches!(
        process.wait(&WorkerCancellation::default()),
        Err(Error::Timeout)
    ));
    f.clear(&retained);
    assert_eq!(fs::read(f.root.join("forked.marker")).unwrap(), b"ready");

    let (process, retained) = f.start("python3 -c 'print(\"x\"*200000)'", normal);
    assert!(matches!(
        process.wait(&WorkerCancellation::default()),
        Err(Error::OutputLimit)
    ));
    f.clear(&retained);

    let (process, retained) = f.start("sleep 60", normal);
    let cancel = WorkerCancellation::default();
    cancel.cancel();
    assert!(matches!(process.wait(&cancel), Err(Error::Cancelled)));
    f.clear(&retained);

    // Dropping a handed-out command retains exactly the same cleanup contract.
    let (process, retained) = f.start("sleep 60", normal);
    drop(process);
    f.clear(&retained);
}
