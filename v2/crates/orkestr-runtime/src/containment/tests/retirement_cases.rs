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

// Run separately so missing executable / namespace refusal cannot disappear
// into the contained child's intentionally closed stderr. This is a required
// readiness check, never a skip or a substitute for the tree cleanup assertion.
fn namespace_readiness() {
    let probe = std::process::Command::new("/usr/bin/python3")
        .arg("-c")
        .arg(include_str!("retirement_readiness.py"))
        .env_clear()
        .output()
        .expect("launch fixed synthetic namespace readiness probe");
    assert!(
        probe.status.success(),
        "namespace retirement prerequisite failed: status={} stdout={} stderr={}",
        probe.status,
        String::from_utf8_lossy(&probe.stdout),
        String::from_utf8_lossy(&probe.stderr),
    );
}

#[test]
fn clean_eof_reaps_actual_namespace_tree_before_single_use_evidence() {
    namespace_readiness();
    let fixture = Fixture::new();
    let scope = scope("synthetic-owner", 1);
    let (authority, _) = authority(&scope);
    // This synthetic trusted broker uses the same fixed lifetime wrapper as
    // e460. Its native forks and creates a new session inside the PID namespace.
    let code = r#"import ctypes,os,signal,subprocess,sys,tempfile,time
assert ctypes.CDLL(None).prctl(36,1,0,0,0)==0
native="import os,time; p=os.fork(); os.setsid() if p==0 else None; print('native-ready',flush=True); time.sleep(60)"
startup_errors=tempfile.TemporaryFile()
child=subprocess.Popen(['/usr/bin/bwrap','--unshare-user','--unshare-pid','--die-with-parent','--bind','/','/','--proc','/proc','--','/usr/bin/python3','-c',native],process_group=0,stdout=subprocess.PIPE,stderr=startup_errors)
if child.stdout.readline().strip()!=b'native-ready':
 status=child.wait(timeout=2)
 startup_errors.seek(0)
 print('namespace startup failed: status='+str(status)+' stderr='+repr(startup_errors.read(4096)),flush=True)
 sys.exit(1)
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

fn exited_broker(
    fixture: &Fixture,
    authority: &Authority,
    scope: &ExecutionScope,
    code: &str,
) -> OwnedChild {
    let child = fixture
        .executor(authority, scope, code, TransportBounds::default())
        .spawn(scope)
        .unwrap();
    assert_eq!(frame(&child, scope).unwrap(), b"ready");
    child.process.broker_launcher.store(true, Ordering::Release);
    let deadline = Instant::now() + Duration::from_secs(4);
    while child.poll_exit(scope).unwrap().is_none() {
        assert!(Instant::now() < deadline, "synthetic broker exit deadline");
        std::thread::sleep(Duration::from_millis(5));
    }
    child
}

#[test]
fn idle_native_death_with_broker_echild_status_is_claimable_once() {
    namespace_readiness();
    let fixture = Fixture::new();
    let scope = scope("synthetic-owner", 1);
    let (authority, _) = authority(&scope);
    // The native dies on its own (SIGKILL, as by OOM); the subreaper broker
    // reaps its tree to ECHILD and exits with the native-ended status 222.
    let code = r#"import ctypes,os,signal,subprocess,sys,time
assert ctypes.CDLL(None).prctl(36,1,0,0,0)==0
child=subprocess.Popen(['/usr/bin/bwrap','--unshare-user','--unshare-pid','--die-with-parent','--bind','/','/','--proc','/proc','--','/usr/bin/python3','-c','import time;print("native-ready",flush=True);time.sleep(60)'],process_group=0,stdout=subprocess.PIPE)
assert child.stdout.readline().strip()==b'native-ready'
print('ready',flush=True)
os.killpg(child.pid,signal.SIGKILL)
deadline=time.monotonic()+2
while True:
 try: pid,status=os.waitpid(-1,os.WNOHANG)
 except ChildProcessError: break
 if pid==0:
  assert time.monotonic()<deadline
  time.sleep(.005)
sys.exit(222)
"#;
    let child = exited_broker(&fixture, &authority, &scope, code);
    let mut retiring = child.retire_ended_broker().unwrap();
    drop(authority);
    let proof = wait(&mut retiring).unwrap();
    assert_eq!(proof.scope(), &scope);
    assert!(matches!(retiring.poll_reaped(), Err(Error::Revoked)));
}

#[test]
fn ended_claim_refuses_live_unproven_or_requested_statuses() {
    let fixture = Fixture::new();
    let scope = scope("synthetic-owner", 1);
    let (authority, _) = authority(&scope);
    // Still running: nothing to claim.
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
    assert!(matches!(
        child.retire_ended_broker(),
        Err(Error::AuthorityProtocol)
    ));
    // A failure class, 0, the requested-retirement 73 and an out-of-range
    // code are never native-ended proof.
    for status in [102, 0, 73, 224] {
        let code = format!("import sys;print('ready',flush=True);sys.exit({status})");
        let child = exited_broker(&fixture, &authority, &scope, &code);
        assert!(
            matches!(child.retire_ended_broker(), Err(Error::AuthorityProtocol)),
            "{status}"
        );
    }
    // A raw executor (not the trusted launcher) cannot claim 222 either.
    let child = fixture
        .executor(
            &authority,
            &scope,
            "import sys;print('ready',flush=True);sys.exit(222)",
            TransportBounds::default(),
        )
        .spawn(&scope)
        .unwrap();
    assert_eq!(frame(&child, &scope).unwrap(), b"ready");
    let deadline = Instant::now() + Duration::from_secs(4);
    while child.poll_exit(&scope).unwrap().is_none() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(matches!(
        child.retire_ended_broker(),
        Err(Error::AuthorityProtocol)
    ));
}
