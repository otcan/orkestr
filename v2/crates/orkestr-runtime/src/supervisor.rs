//! One nonblocking supervisor step at a time. Ingress does not call this path.
use crate::ports::{Admission, Blocker, Provider, Role, SessionStore};

/// Admission evidence is persisted before any runtime command. Started is only
/// recorded after an explicit provider Started event, never on command return.
pub fn start<S: SessionStore, P: Provider>(
    store: &S,
    provider: &mut P,
    scope: &str,
    role: Role,
    run_id: &str,
) -> Result<Admission, Blocker> {
    let admission = store.admit(scope, role, run_id)?;
    provider.start(&admission)?;
    Ok(admission)
}

/// The store must reject stale generations atomically even after poll returns.
/// Provider completion is merely proposed evidence, never verified task success.
pub fn step<S: SessionStore, P: Provider>(
    store: &S,
    provider: &mut P,
    admission: &Admission,
) -> Result<bool, Blocker> {
    match provider.poll(admission)? {
        Some(event) => {
            store.record(admission, event)?;
            Ok(true)
        }
        None => Ok(false),
    }
}
