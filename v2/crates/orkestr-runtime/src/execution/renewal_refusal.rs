//! A refused same-child lease renewal, and whether the child survived it.
use orkestr_v2_application::runtime::RuntimeStoreError;

/// Why a consuming same-child renewal did not transfer the lease.
///
/// `Retry` is returned only when Core wrote nothing (`renew_running` refused
/// with `Busy`): the child, its turn, cursor and current lease fence are
/// untouched and come back in `retained`, so the caller may try again while
/// that lease lasts. `Lost` has already quarantined the owned child.
pub enum RenewalRefusal<T> {
    Retry {
        retained: Box<T>,
        error: RuntimeStoreError,
    },
    Lost(RuntimeStoreError),
}

/// An owner that can still quarantine its child when a caller gives up.
pub trait QuarantineOwned {
    fn quarantine_owned(self);
}

impl<T> RenewalRefusal<T> {
    pub fn error(&self) -> RuntimeStoreError {
        match self {
            Self::Retry { error, .. } => *error,
            Self::Lost(error) => *error,
        }
    }
    pub fn is_retry(&self) -> bool {
        matches!(self, Self::Retry { .. })
    }
}

impl<T: QuarantineOwned> RenewalRefusal<T> {
    /// Give up, exactly as a lost renewal: a retained child is quarantined.
    pub fn into_lost(self) -> RuntimeStoreError {
        match self {
            Self::Retry { retained, error } => {
                retained.quarantine_owned();
                error
            }
            Self::Lost(error) => error,
        }
    }
}

impl<T> std::fmt::Debug for RenewalRefusal<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Retry { error, .. } => write!(f, "Retry({error:?})"),
            Self::Lost(error) => write!(f, "Lost({error:?})"),
        }
    }
}
