//! Exact-run, test-only expiry at the post-takeover workspace boundary.
use super::*;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::Instant,
};

#[derive(Clone)]
pub(in crate::production_runtime) enum Fault {
    Expire,
    EffectThenExpire,
    DriftThenExpire(PathBuf),
}
struct Injection {
    conversation: String,
    clock: Instant,
    fault: Fault,
    remaining: usize,
    hits: usize,
}
fn controls() -> &'static Mutex<HashMap<String, Injection>> {
    static CONTROLS: OnceLock<Mutex<HashMap<String, Injection>>> = OnceLock::new();
    CONTROLS.get_or_init(Mutex::default)
}
pub(in crate::production_runtime) struct Armed(String);
impl Armed {
    pub(in crate::production_runtime) fn hits(&self) -> usize {
        controls().lock().unwrap().get(&self.0).unwrap().hits
    }
}
impl Drop for Armed {
    fn drop(&mut self) {
        controls().lock().unwrap().remove(&self.0);
    }
}
pub(in crate::production_runtime) fn arm(
    run: &RunId,
    conversation: &ConversationId,
    fault: Fault,
    remaining: usize,
) -> Armed {
    let key = run.to_string();
    assert!(controls()
        .lock()
        .unwrap()
        .insert(
            key.clone(),
            Injection {
                conversation: conversation.to_string(),
                clock: Instant::now(),
                fault,
                remaining,
                hits: 0
            }
        )
        .is_none());
    Armed(key)
}
pub(super) fn checkpoint(run: &RunId, proof: &WorkspacePreflight) {
    let fault = {
        let mut controls = controls().lock().unwrap();
        let Some(control) = controls.get_mut(&run.to_string()) else {
            return;
        };
        if control.remaining == 0 {
            return;
        }
        control.remaining -= 1;
        control.hits += 1;
        control.fault.clone()
    };
    match fault {
        Fault::Expire => {}
        Fault::EffectThenExpire => proof.workspace_effect_once().unwrap(),
        Fault::DriftThenExpire(path) => {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o777)).unwrap();
        }
    }
    proof.expire_terminal_handoff_for_test();
}

// Only exact-run fixtures use a fixed handoff clock before their explicit
// phase injection. The real five-second operation budget is never overridden.
pub(in crate::production_runtime) fn handoff_clock(
    conversation: &ConversationId,
) -> Option<Instant> {
    controls()
        .lock()
        .unwrap()
        .values()
        .find(|control| control.conversation == conversation.to_string())
        .map(|control| control.clock)
}
