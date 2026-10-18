//! Owned synthetic namespace tree only; no provider/account or Core eligibility.
use super::*;

fn wait(retiring: &mut RetiringBroker) -> Result<ReapedBroker, Error> {
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        if let Some(proof) = retiring.poll_reaped()? {
            return Ok(proof);
        }
        assert!(Instant::now() < deadline, "owned retirement deadline");
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn clean_eof_reaps_actual_namespace_tree_before_single_use_evidence() {
    let fixture = Fixture::new();
    let scope = scope("synthetic-owner", 1);
    let (authority, _) = authority(&scope);
    // This synthetic trusted broker uses the same fixed lifetime wrapper as
    // e460. Its native forks and creates a new session inside the PID namespace.
    let code = r#"import ctypes,os,signal,subprocess,sys,time
assert ctypes.CDLL(None).prctl(36,1,0,0,0)==0
native="import os,time; p=os.fork(); os.setsid() if p==0 else None; print('native-ready',flush=True); time.sleep(60)"
child=subprocess.Popen(['/usr/bin/bwrap','--unshare-user','--unshare-pid','--die-with-parent','--bind','/','/','--proc','/proc','--','/usr/bin/python3','-c',native],process_group=0,stdout=subprocess.PIPE)
assert child.stdout.readline().strip()==b'native-ready'
print('ready',flush=True)
sys.stdin.buffer.read()
os.killpg(child.pid,signal.SIGKILL)
deadline=time.monotonic()+2
while True:
 try: pid,status=os.waitpid(-1,os.WNOHANG)
 except ChildProcessError: break
 if pid==0:
  assert time.monotonic()<deadline
  time.sleep(.005)
sys.exit(73)
"#;
    let child = fixture
        .executor(&authority, &scope, code, TransportBounds::default())
        .spawn(&scope)
        .unwrap();
    assert_eq!(frame(&child, &scope).unwrap(), b"ready");
    // Only the trusted launcher sets this in production. Test marker does not
    // expose a public constructor or teach raw executors to issue proof.
    child.process.broker_launcher.store(true, Ordering::Release);
    let mut retiring = child.retire_broker().unwrap();
    drop(authority); // retired membership cannot force-kill the cleanup owner
    let proof = wait(&mut retiring).unwrap();
    assert_eq!(proof.scope(), &scope);
    assert!(matches!(retiring.poll_reaped(), Err(Error::Revoked)));
}

#[test]
fn raw_executor_and_normal_exit_never_issue_retirement_evidence() {
    let fixture = Fixture::new();
    let scope = scope("synthetic-owner", 1);
    let (authority, _) = authority(&scope);
    let child = fixture
        .executor(
            &authority,
            &scope,
            "import sys;sys.stdin.read();sys.exit(73)",
            TransportBounds::default(),
        )
        .spawn(&scope)
        .unwrap();
    assert!(matches!(
        child.retire_broker(),
        Err(Error::AuthorityProtocol)
    ));
    let child = fixture
        .executor(
            &authority,
            &scope,
            "import sys;print('ready',flush=True);sys.stdin.read()",
            TransportBounds::default(),
        )
        .spawn(&scope)
        .unwrap();
    assert_eq!(frame(&child, &scope).unwrap(), b"ready");
    child.process.broker_launcher.store(true, Ordering::Release);
    let mut retiring = child.retire_broker().unwrap();
    assert!(matches!(wait(&mut retiring), Err(Error::AuthorityProtocol)));
}

#[test]
fn forced_broker_death_never_issues_evidence() {
    let fixture = Fixture::new();
    let scope = scope("synthetic-owner", 1);
    let (authority, _) = authority(&scope);
    let child = fixture
        .executor(
            &authority,
            &scope,
            "import time;print('ready',flush=True);time.sleep(60)",
            TransportBounds::default(),
        )
        .spawn(&scope)
        .unwrap();
    assert_eq!(frame(&child, &scope).unwrap(), b"ready");
    child.process.broker_launcher.store(true, Ordering::Release);
    child.signal(&scope, Signal::Kill).unwrap();
    let mut retiring = child.retire_broker().unwrap();
    assert!(matches!(wait(&mut retiring), Err(Error::AuthorityProtocol)));
}
