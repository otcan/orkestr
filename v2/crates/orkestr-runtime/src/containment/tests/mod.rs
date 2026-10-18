//! Real owned synthetic children only. No providers, credentials or live homes.
use super::*;
use serde_json::json;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

static NEXT: AtomicU64 = AtomicU64::new(1);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "contained-synthetic-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        for dir in ["workspace", "home", "tmp"] {
            fs::create_dir(path.join(dir)).unwrap();
        }
        Self(path.canonicalize().unwrap())
    }
    fn dirs(&self) -> ChildDirectories {
        ChildDirectories::new(
            &self.0.join("workspace"),
            &self.0.join("home"),
            &self.0.join("tmp"),
        )
        .unwrap()
    }
    fn executor(
        &self,
        authority: &Authority,
        scope: &ExecutionScope,
        code: &str,
        bounds: TransportBounds,
    ) -> Executor {
        // Fixed synthetic program only; no runtime/provider binary invoked.
        authority
            .issue_executor(
                scope,
                Path::new("/usr/bin/python3"),
                &[OsString::from("-c"), OsString::from(code)],
                self.dirs(),
                bounds,
            )
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct Fence(AtomicBool);
impl DispatchFence for Fence {
    fn dispatch(
        &self,
        _: &ExecutionScope,
        action: &mut dyn FnMut() -> Result<(), Error>,
    ) -> Result<(), Error> {
        if !self.0.load(Ordering::SeqCst) {
            return Err(Error::Revoked);
        }
        action()
    }
}
fn scope(owner: &str, generation: u64) -> ExecutionScope {
    ExecutionScope::new(
        "synthetic-namespace",
        "synthetic-incarnation",
        owner,
        "synthetic-session",
        "synthetic-run",
        generation,
    )
    .unwrap()
}
fn authority(scope: &ExecutionScope) -> (Authority, Arc<Fence>) {
    let fence = Arc::new(Fence(AtomicBool::new(true)));
    (
        Authority::new(scope.clone(), fence.clone(), 4).unwrap(),
        fence,
    )
}
fn frame(child: &OwnedChild, scope: &ExecutionScope) -> Result<Vec<u8>, Error> {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match child.poll_stdout(scope)? {
            Output::Frame(bytes) => return Ok(bytes),
            Output::Pending if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(5))
            }
            _ => panic!("synthetic child did not produce a frame before timeout"),
        }
    }
}
fn exit(child: &OwnedChild, scope: &ExecutionScope) -> Exit {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if let Some(exit) = child.poll_exit(scope).unwrap() {
            return exit;
        }
        assert!(Instant::now() < deadline, "owned child failed to exit");
        std::thread::sleep(Duration::from_millis(5));
    }
}
fn metadata() -> Vec<u8> {
    serde_json::to_vec(&json!({"id":1,"method":"account/read","params":{"refreshToken":false}}))
        .unwrap()
}

struct SyntheticConsumed {
    scope: ExecutionScope,
    count: Arc<AtomicU64>,
}
impl ConsumedTurn for SyntheticConsumed {
    fn into_submission(self) -> (ExecutionScope, Vec<u8>) {
        self.count.fetch_add(1, Ordering::SeqCst);
        (self.scope, br#"{"id":7,"method":"turn/start","params":{"threadId":"synthetic-native","input":[]}}"#.to_vec())
    }
}

mod scope_cases;
mod transport_cases;
