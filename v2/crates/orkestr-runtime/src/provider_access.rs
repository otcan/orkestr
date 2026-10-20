//! Instance-wide provider sandbox selection. Restricted read-only is the
//! default; only the operator's private startup configuration can switch the
//! whole process to host full access (V1-equivalent, equivalent to host root).
use std::sync::atomic::{AtomicBool, Ordering};

static HOST_FULL_ACCESS: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderAccess {
    /// Codex `read-only` sandbox inside the isolated provider namespace.
    ReadOnly,
    /// Codex `danger-full-access` running directly on the host.
    HostFullAccess,
}

impl ProviderAccess {
    /// Value Runtime sends as `thread/start` / `thread/resume` `sandbox`.
    pub fn request(self) -> &'static str {
        match self {
            Self::ReadOnly => "read-only",
            Self::HostFullAccess => "danger-full-access",
        }
    }
    /// Value the provider must echo as `result.sandbox.type`.
    pub fn reply(self) -> &'static str {
        match self {
            Self::ReadOnly => "readOnly",
            Self::HostFullAccess => "dangerFullAccess",
        }
    }
}

/// Trusted startup only, before any provider session exists. One-way.
pub fn enable_host_full_access() {
    HOST_FULL_ACCESS.store(true, Ordering::Release);
}

pub fn current() -> ProviderAccess {
    if HOST_FULL_ACCESS.load(Ordering::Acquire) {
        ProviderAccess::HostFullAccess
    } else {
        ProviderAccess::ReadOnly
    }
}
