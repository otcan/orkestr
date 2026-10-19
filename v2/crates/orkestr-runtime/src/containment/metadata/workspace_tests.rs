//! Real Store launch authority -> owned Runtime spawn -> disposable FD5 mount.
use super::*;
use orkestr_v2_application::runtime::*;
use orkestr_v2_store_sqlite::{
    WorkspaceLaunchConsumption, WorkspaceLaunchReservationResult, WorkspaceOperatorAllowlist,
};
use std::{
    os::unix::fs::MetadataExt,
    time::{Duration, Instant},
};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn issued_workspace_launch_mounts_original_and_outer_failure_reaps() {
    for commit_failure in [false, true] {
        exercise(commit_failure).await;
    }
}
async fn exercise(commit_failure: bool) {
    let root = std::env::temp_dir().join(format!(
        "workspace-composed-{}-{commit_failure}",
        std::process::id()
    ));
    std::fs::create_dir(&root).unwrap();
    for name in ["workspace/.git", "home", "tmp", "database"] {
        std::fs::create_dir_all(root.join(name)).unwrap();
    }
    std::fs::write(root.join("workspace/sentinel"), "original").unwrap();
    let database = root.join("database/state.sqlite3");
    let store = Store::open(&database).await.unwrap();
    let conversation = store
        .setup("synthetic-owner", "synthetic-hash")
        .await
        .unwrap();
    let owner = store
        .credentials("synthetic-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    let token = "ac".repeat(32);
    store.save_session(&token, &owner).await.unwrap();
    let bound = store
        .authorize_supervisor(
            &token,
            ProductionSupervisorConfig {
                provider: ProviderKind::Codex,
                namespace: "subscription:synthetic".into(),
                supervisor_key: "workspace-test".into(),
                takeover: ProductionTakeover::First,
            },
        )
        .await
        .unwrap();
    let project = root.join("workspace");
    let allow = WorkspaceOperatorAllowlist::new(
        vec![project.clone()],
        vec![database.clone()],
        std::fs::metadata(&project).unwrap().uid(),
    )
    .unwrap();
    let workspace = bound
        .register_workspace(
            &token,
            &conversation,
            "00000000-0000-4000-8000-000000000001".parse().unwrap(),
            allow.installation(&project).unwrap(),
        )
        .await
        .unwrap();
    let binding = bound
        .ensure_role_bindings(&owner, &conversation)
        .await
        .unwrap()
        .deep;
    bound
        .bind_workspace_session(&token, &workspace, &binding)
        .await
        .unwrap();
    let metadata = bound.authorize_session_metadata(&binding).await.unwrap();
    let WorkspaceLaunchReservationResult::Reserved(reservation) = bound
        .reserve_workspace_launch(&token, &workspace, &metadata, "launch")
        .await
        .unwrap()
    else {
        panic!("fresh reservation")
    };
    let WorkspaceLaunchConsumption::Launch(mut launch) = bound
        .consume_workspace_launch(&token, reservation)
        .await
        .unwrap()
    else {
        panic!("fresh launch")
    };
    let authority = MetadataAuthority::new(bound.clone(), metadata).unwrap();
    let module = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../provider-broker")
        .canonicalize()
        .unwrap();
    let script = format!(
        r#"
import os,sys,subprocess,errno,json
sys.path.insert(0,{module})
from workspace_fd import InheritedWorkspace
workspace=InheritedWorkspace()
original={project}
os.rename(original,original+'.retired')
os.mkdir(original)
open(original+'/sentinel','w').write('replacement')
help=subprocess.check_output(['/usr/bin/bwrap','--help'],timeout=3)
args=['/usr/bin/bwrap','--unshare-all','--die-with-parent','--new-session','--clearenv','--ro-bind','/usr','/usr','--proc','/proc','--dev','/dev']
for path in ['/lib','/lib64']:
 if os.path.exists(path):args+=['--ro-bind',path,path]
args+=list(workspace.mount_arguments(help))
probe='''import os,errno,json
assert os.getcwd()=='/workspace'
assert open('sentinel').read()=='original'
try:open('mutation','w')
except OSError as e:assert e.errno==errno.EROFS
else:raise AssertionError('write permitted')
try:os.fstat(5)
except OSError as e:assert e.errno==errno.EBADF
else:raise AssertionError('fd5 leaked')
print(json.dumps({{"mounted":True}}),flush=True)
'''
args+=['/usr/bin/python3','-I','-c',probe]
result=subprocess.run(args,pass_fds=(5,),timeout=5)
sys.exit(result.returncode)
"#,
        module = serde_json::to_string(&module).unwrap(),
        project = serde_json::to_string(&project).unwrap()
    );
    let executor = authority
        .issue_executor(
            Path::new("/usr/bin/python3"),
            &["-I".into(), "-c".into(), script.into()],
            ChildDirectories::new(&project, &root.join("home"), &root.join("tmp")).unwrap(),
            TransportBounds::default(),
        )
        .unwrap();
    if commit_failure {
        let status = std::process::Command::new("/usr/bin/python3").args(["-I", "-c", "import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.executescript(\"CREATE TABLE synthetic_commit_failure(marker TEXT REFERENCES owners(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER synthetic_commit AFTER UPDATE OF callback_attempted ON workspace_launches BEGIN INSERT INTO synthetic_commit_failure VALUES('missing-owner'); END;\");c.close()"])
            .arg(&database).status().unwrap();
        assert!(status.success());
        assert!(executor.spawn_workspace(&token, &mut launch).is_err());
        assert!(
            authority.shared.state.lock().unwrap().process.is_some(),
            "original spawned ownership retained"
        );
    } else {
        let child = executor.spawn_workspace(&token, &mut launch).unwrap();
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            match child.process.live.lock().unwrap().framing.read().unwrap() {
                Output::Frame(frame) => {
                    assert_eq!(
                        serde_json::from_slice::<serde_json::Value>(&frame).unwrap(),
                        serde_json::json!({"mounted":true})
                    );
                    break;
                }
                Output::Pending => (),
                other => panic!("mount readiness: {other:?}"),
            }
            assert!(Instant::now() < deadline, "bounded mount readiness");
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        drop(child);
    }
    assert!(
        executor.spawn_workspace(&token, &mut launch).is_err(),
        "no replay"
    );
    authority.revoke().unwrap();
    drop(executor);
    let deadline = Instant::now() + Duration::from_secs(3);
    while authority.shared.active.load(Ordering::Acquire) != 0 {
        assert!(Instant::now() < deadline, "exact child reaped");
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    bound.close().await;
    store.close().await;
    std::fs::remove_dir_all(root).unwrap();
}
