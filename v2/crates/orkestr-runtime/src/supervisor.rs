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

/// One retained observation per supervised run. Transient record failure never
/// polls again until this exact observation is recorded or explicitly fenced.
/// Volatile retention is not crash durability; core's durable journal is pending.
#[derive(Default)]
pub struct PendingObservation(Option<(Admission, crate::ports::ProviderEvent)>);

/// The store must reject stale generations atomically even after poll returns.
/// Provider completion is merely proposed evidence, never verified task success.
/// A stale refusal deliberately discards the fenced observation; every other
/// record error retains it. Callers must preserve `pending` across retries.
pub fn step<S: SessionStore, P: Provider>(
    store: &S,
    provider: &mut P,
    admission: &Admission,
    pending: &mut PendingObservation,
) -> Result<bool, Blocker> {
    if let Some((original, _)) = &pending.0 {
        if original != admission {
            // Never relabel an earlier observation with a newer lease/run.
            return Err(Blocker::StaleLease);
        }
    } else if let Some(event) = provider.poll(admission)? {
        pending.0 = Some((admission.clone(), event));
    }
    let Some((original, event)) = &pending.0 else {
        return Ok(false);
    };
    match store.record(original, event.clone()) {
        Ok(()) => {
            pending.0 = None;
            Ok(true)
        }
        Err(Blocker::StaleLease) => {
            pending.0 = None;
            Err(Blocker::StaleLease)
        }
        Err(error) => Err(error),
    }
}
