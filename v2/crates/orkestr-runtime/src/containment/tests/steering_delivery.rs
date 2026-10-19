//! Actual sole-provider writer, real Core steering authority, synthetic byte reader.
use super::*;
use orkestr_v2_application::runtime::{ProviderAdmission, RuntimeStore};
use orkestr_v2_store_sqlite::Store;

struct DurableFence(Store, ProviderAdmission);
impl DispatchFence for DurableFence {
    fn dispatch(
        &self,
        _: &ExecutionScope,
        action: &mut dyn FnMut() -> Result<(), Error>,
    ) -> Result<(), Error> {
        self.0
            .with_execution_fence(&self.1, action)
            .map_err(|_| Error::Revoked)?
    }
}

async fn exercise(mode: u8) {
    let mut issued = super::steering_fixture::issued(&format!("actual-suffix-{mode}")).await;
    let original = issued.delivery.provider().clone();
    for name in ["workspace", "home", "tmp"] {
        fs::create_dir(issued.root.join(name)).unwrap();
    }
    let scope = ExecutionScope::new(
        &issued.namespace,
        &issued.incarnation,
        &original.run.owner_id.to_string(),
        &original.run.session_id.to_string(),
        &original.run.run_id.to_string(),
        original.run.dispatch_fence,
    )
    .unwrap();
    let authority = Authority::new(
        scope.clone(),
        Arc::new(DurableFence(issued.bound.clone(), original.clone())),
        1,
    )
    .unwrap();
    let dirs = ChildDirectories::new(
        &issued.root.join("workspace"),
        &issued.root.join("home"),
        &issued.root.join("tmp"),
    )
    .unwrap();
    let code = r#"import os,socket,array
s=socket.socket(fileno=3)
r,w=os.pipe()
s.sendmsg([b'provider-stdin-v1'],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array('i',[w]))])
os.close(w);s.close()
with open('native-bytes','wb',buffering=0) as audit:
 while True:
  data=os.read(r,4096)
  if not data: break
  audit.write(data)
"#;
    let process = issued
        .bound
        .with_execution_fence(&original, || {
            super::super::process::Process::spawn_config_mode(
                Path::new("/usr/bin/python3"),
                &[OsString::from("-c"), OsString::from(code)],
                &dirs,
                TransportBounds::default(),
                &authority.shared.active,
                &authority.shared.reaper,
                true,
                None,
            )
        })
        .unwrap()
        .unwrap();
    authority
        .shared
        .state
        .lock()
        .unwrap()
        .children
        .insert(1, Arc::downgrade(&process));
    let child = OwnedChild {
        shared: authority.shared.clone(),
        process,
    };
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let received = {
            let mut live = child.process.live.lock().unwrap();
            if let Some(writer) = live.handoff.as_mut().unwrap().receive().unwrap() {
                live.provider_writer = Some(writer);
                true
            } else {
                false
            }
        };
        if received {
            break;
        }
        assert!(Instant::now() < deadline, "synthetic FD handoff timeout");
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    let lineage = child.process.broker_lineage.clone();
    let mut bytes = serde_json::to_vec(&serde_json::json!({
        "id":issued.delivery.request_id().to_string(),"method":"turn/steer",
        "params":{"threadId":issued.delivery.thread_id(),
        "expectedTurnId":issued.delivery.expected_turn_id(),
        "input":[{"type":"text","text":issued.delivery.text(),"text_elements":[]}]}
    }))
    .unwrap();
    bytes.push(b'\n');
    let audit = issued.root.join("workspace/native-bytes");
    if mode == 3 {
        assert_eq!(
            child
                .write_steering_suffix(
                    &issued.bound,
                    &scope,
                    &original,
                    &lineage,
                    &mut issued.delivery,
                    &bytes[..7]
                )
                .unwrap(),
            7
        );
        let deadline = Instant::now() + Duration::from_secs(3);
        while fs::metadata(&audit).map(|m| m.len()).unwrap_or(0) != 7 {
            assert!(Instant::now() < deadline, "native prefix not observed");
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    }
    if mode == 1 {
        issued
            .bound
            .request_cancel(
                &original.run.owner_id,
                &original.run.run_id,
                "stop-before-steer",
            )
            .await
            .unwrap();
    }
    if mode >= 2 {
        issued.store.revoke_session(&issued.token).await.unwrap();
    }
    let result = child.write_steering_suffix(
        &issued.bound,
        &scope,
        &original,
        &lineage,
        &mut issued.delivery,
        if mode == 3 { &bytes[7..] } else { &bytes },
    );
    if mode == 0 {
        assert_eq!(result.unwrap(), bytes.len());
        let deadline = Instant::now() + Duration::from_secs(3);
        while fs::metadata(&audit).map(|m| m.len()).unwrap_or(0) != bytes.len() as u64 {
            assert!(Instant::now() < deadline, "native bytes not observed");
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    } else {
        assert!(result.is_err());
    }
    authority.revoke().unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    while authority.shared.active.load(Ordering::Acquire) != 0 {
        assert!(Instant::now() < deadline, "owned native reader not reaped");
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    let observed = fs::read(&audit).unwrap_or_default();
    assert_eq!(
        observed,
        if mode == 0 {
            bytes.as_slice()
        } else if mode == 3 {
            &bytes[..7]
        } else {
            &[]
        }
    );
    drop(child);
    drop(authority);
    drop(issued.delivery);
    drop(issued.bound);
    drop(issued.store);
    fs::remove_dir_all(issued.root).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn steering_fence_writes_actual_child_and_stop_withholds_first_byte() {
    exercise(0).await;
    exercise(1).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn steering_revocation_withholds_first_byte_and_stale_suffix_then_reaps() {
    exercise(2).await;
    exercise(3).await;
}
