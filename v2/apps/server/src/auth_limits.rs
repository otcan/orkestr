//! Authentication attempt limits, kept per client instead of per server.
//!
//! One server-wide window of ten attempts a minute let a key renewal of a few
//! service credentials lock every other client out. Attempts now count against
//! the client they present: the username (known or not, so a refusal never
//! tells which usernames exist) or the stored service credential a token
//! belongs to. Attempts that present no known client (a token no credential
//! has, the bootstrap token) and every username attempt also count against
//! their source address, and a server-wide failure ceiling bounds the
//! password-hash work when sources are spread.
//!
//! Every admitted attempt is held as a failure until it proves otherwise, so
//! parallel guesses cannot outrun the count. Failures have a much smaller
//! budget and a longer window than attempts, which a legitimate client mostly
//! spends on successes. A refused attempt is not charged, so a client that
//! keeps retrying does not extend its own lockout.
use super::*;
use axum::extract::{ConnectInfo, FromRequestParts};
use axum::http::request::Parts;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Mutex as SyncMutex, PoisonError};

/// Attempts and failures allowed per window for one kind of key.
#[derive(Clone, Copy)]
struct Rule {
    attempts: u32,
    attempt_window: Duration,
    failures: u32,
    failure_window: Duration,
}

const MINUTE: Duration = Duration::from_secs(60);
const QUARTER_HOUR: Duration = Duration::from_secs(15 * 60);
/// A username or a stored service credential: room for a key renewal of every
/// credential an owner may hold, ten failures per quarter hour.
const CLIENT: Rule = Rule {
    attempts: 60,
    attempt_window: MINUTE,
    failures: 10,
    failure_window: QUARTER_HOUR,
};
/// One source address, shared by every client behind it.
const SOURCE: Rule = Rule {
    attempts: 300,
    attempt_window: MINUTE,
    failures: 30,
    failure_window: QUARTER_HOUR,
};
/// The whole server: failures only (about two password hashes a second).
const SERVER: Rule = Rule {
    attempts: u32::MAX,
    attempt_window: MINUTE,
    failures: 120,
    failure_window: MINUTE,
};
/// Buckets kept before idle ones are dropped, and the most ever kept. The
/// server ceiling bounds how fast new keys arrive, so the cap is not reached
/// in practice; if it is, new keys are refused rather than old ones evicted.
const PRUNE_AT: usize = 1024;
const CAPACITY: usize = 8192;

/// What an attempt is counted against.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Key {
    /// A presented username, hashed so attacker input is not kept.
    Username([u8; 16]),
    /// A stored service credential (active, revoked or expired), by id.
    ServiceCredential(String),
    /// A source address; `None` when the connection's address is unknown.
    Source(Option<IpAddr>),
    Server,
}

impl Key {
    pub(crate) fn username(username: &str) -> Self {
        let digest = Sha256::digest(username.as_bytes());
        let mut key = [0; 16];
        key.copy_from_slice(&digest[..16]);
        Self::Username(key)
    }
    pub(crate) fn source(peer: Peer) -> Self {
        Self::Source(peer.0)
    }
    fn rule(&self) -> Rule {
        match self {
            Self::Username(_) | Self::ServiceCredential(_) => CLIENT,
            Self::Source(_) => SOURCE,
            Self::Server => SERVER,
        }
    }
}

/// The address an attempt comes from. Behind a reverse proxy on the same host
/// peer is loopback, and the proxy's own entry (the last) in
/// `X-Forwarded-For` names the client; any other peer is taken as it is.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Peer(Option<IpAddr>);

impl Peer {
    fn of(peer: Option<IpAddr>, headers: &HeaderMap) -> Self {
        let forwarded = || {
            headers
                .get_all("x-forwarded-for")
                .iter()
                .next_back()?
                .to_str()
                .ok()?
                .rsplit(',')
                .next()?
                .trim()
                .parse::<IpAddr>()
                .ok()
        };
        match peer.map(|ip| ip.to_canonical()) {
            Some(ip) if ip.is_loopback() => Self(Some(forwarded().unwrap_or(ip).to_canonical())),
            other => Self(other),
        }
    }
}

impl<S: Send + Sync> FromRequestParts<S> for Peer {
    type Rejection = std::convert::Infallible;
    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Self::Rejection> {
        let peer = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|info| info.0.ip());
        Ok(Self::of(peer, &parts.headers))
    }
}

struct Window {
    started: Instant,
    used: u32,
}

impl Window {
    fn current(&mut self, now: Instant, length: Duration) -> &mut Self {
        if now.saturating_duration_since(self.started) >= length {
            self.started = now;
            self.used = 0;
        }
        self
    }
}

struct Bucket {
    attempts: Window,
    failures: Window,
}

impl Bucket {
    fn new(now: Instant) -> Self {
        Self {
            attempts: Window {
                started: now,
                used: 0,
            },
            failures: Window {
                started: now,
                used: 0,
            },
        }
    }
    fn full(&mut self, now: Instant, rule: Rule) -> bool {
        self.attempts.current(now, rule.attempt_window).used >= rule.attempts
            || self.failures.current(now, rule.failure_window).used >= rule.failures
    }
    fn idle(&self, now: Instant, rule: Rule) -> bool {
        now.saturating_duration_since(self.attempts.started) >= rule.attempt_window
            && now.saturating_duration_since(self.failures.started) >= rule.failure_window
    }
}

#[derive(Default)]
pub(crate) struct AuthLimits {
    buckets: SyncMutex<HashMap<Key, Bucket>>,
}

impl AuthLimits {
    /// Admits one attempt against every key, or refuses it with the existing
    /// `rate_limited` error when any key's budget is spent.
    pub(crate) fn begin(self: &Arc<Self>, keys: &[Key]) -> Result<Attempt, Error> {
        self.begin_at(Instant::now(), keys).ok_or_else(limited)
    }

    fn begin_at(self: &Arc<Self>, now: Instant, keys: &[Key]) -> Option<Attempt> {
        let mut buckets = self.buckets.lock().unwrap_or_else(PoisonError::into_inner);
        if buckets.len() >= PRUNE_AT {
            buckets.retain(|key, bucket| !bucket.idle(now, key.rule()));
        }
        let mut fresh = 0;
        for key in keys {
            match buckets.get_mut(key) {
                Some(bucket) => {
                    if bucket.full(now, key.rule()) {
                        return None;
                    }
                }
                None => fresh += 1,
            }
        }
        if buckets.len() + fresh > CAPACITY {
            return None;
        }
        let mut held = Vec::with_capacity(keys.len());
        for key in keys {
            let bucket = buckets
                .entry(key.clone())
                .or_insert_with(|| Bucket::new(now));
            bucket.attempts.used = bucket.attempts.used.saturating_add(1);
            bucket.failures.used = bucket.failures.used.saturating_add(1);
            held.push((key.clone(), bucket.failures.started));
        }
        Some(Attempt {
            limits: self.clone(),
            held,
        })
    }
}

/// An admitted attempt. Dropping it leaves it counted as a failure.
#[must_use = "an attempt that is dropped counts as a failure"]
pub(crate) struct Attempt {
    limits: Arc<AuthLimits>,
    held: Vec<(Key, Instant)>,
}

impl Attempt {
    /// The attempt did not fail authentication: it succeeded, or the server
    /// could not judge it (storage unavailable). Its failure is returned.
    pub(crate) fn cleared(self) {
        let mut buckets = self
            .limits
            .buckets
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        for (key, started) in &self.held {
            // A window that rolled over since admission no longer holds it.
            if let Some(bucket) = buckets.get_mut(key) {
                if bucket.failures.started == *started {
                    bucket.failures.used = bucket.failures.used.saturating_sub(1);
                }
            }
        }
    }
}

fn limited() -> Error {
    Error(
        StatusCode::TOO_MANY_REQUESTS,
        "rate_limited",
        "Authentication rate limit exceeded",
    )
}

#[cfg(test)]
#[path = "auth_limits_tests.rs"]
mod tests;
