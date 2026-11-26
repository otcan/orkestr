//! A proof's short handoff restarts once its operation holds Core's writer.
//!
//! Core has one SQLite writer. An operation of a chat with a Root-attested
//! project runs the complete Root check first, then queues for
//! `BEGIN IMMEDIATE`, then validates the durable rows. The 100 ms handoff
//! (`HANDOFF`) used to start at the end of the Root check, so time spent
//! queueing for the writer counted against it. When several windows were
//! busy, that wait alone reached 0.4-0.7 s. The proof then expired before the
//! first durable check (`workspace_handoff_expired`), and one refused
//! observation, lease renewal or managed run fence paused the whole window
//! for reconciliation. Chats without a project have no handoff and were
//! never affected.
//!
//! ORK-770 fixed this for setup fences only (setup_attestation.rs). The same
//! rule now holds for every operation that takes the writer through
//! `Store::begin_writer`: once the writer is held, the handoff restarts, so
//! queueing no longer counts. Nothing else changes:
//!
//! - Only once per operation, and never for a proof whose expiry an earlier
//!   check already reported, or whose single effect was already used.
//! - Never for a proof lent to an inner operation (a borrowed proof): its
//!   handoff also covers the outer operation's Root exchange, as before
//!   (`writer_wait_cannot_spend_an_expired_physical_handoff`).
//! - Only while the Root evidence is at most `SETUP_ATTESTATION` old, the
//!   same tolerance setup fences already accept. Older evidence keeps its
//!   original deadline and fences exactly as before.
//! - Only after the same local checks a setup fence uses: the retained
//!   descriptors and the directory stamps are unchanged. A change made while
//!   queueing keeps the original deadline, and the next check names it.
//! - No Root call is made and no pool connection is taken under the writer.
use super::setup_attestation::SETUP_ATTESTATION;
use super::*;

impl WorkspaceCheck {
    /// The handoff deadline in force: restarted under the writer, if it was.
    pub(super) fn handoff_deadline(&self) -> Option<Instant> {
        self.deadline
            .map(|deadline| self.rearmed.get().copied().unwrap_or(deadline))
    }

    /// Called right after `BEGIN IMMEDIATE` succeeded for this proof's Store.
    pub(in crate::production_runtime) fn rearm_under_writer(&self) {
        let now = Instant::now();
        if self.deadline.is_none()
            || self.rearmed.get().is_some()
            || self.lent.load(Ordering::SeqCst)
            || !self.alive.load(Ordering::SeqCst)
            || self.effect.load(Ordering::SeqCst)
            || self.handoff_expired.load(Ordering::SeqCst)
            || now >= self.evidence_at + SETUP_ATTESTATION
        {
            return;
        }
        let Some(installation) = &self.installation else {
            return;
        };
        if installation.check_retained().is_err() {
            return;
        }
        match installation.retained_stamp() {
            Ok(current) if Some(current) == self.retained => {}
            _ => return,
        }
        let _ = self.rearmed.set(now + HANDOFF);
    }
}
