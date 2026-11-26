//! One fresh Root project check per metadata setup, reused by that setup's
//! repeated fences (ORK-770).
//!
//! A setup polls its broker about every 10 ms, and every poll, flush and
//! enqueue is a metadata fence. With a fresh Root check in each fence, a chat
//! with a registered project paid one Root round trip per poll (0.4-1.6 s on a
//! loaded host). Its readiness handshake then no longer fit the server's 15 s
//! readiness budget, while chats without a project were unaffected.
//!
//! The first fence of a grant (and the first after the attestation lapses)
//! takes the complete fresh Root check. Each later fence of the SAME grant
//! derives a new single-effect, per-operation proof from that evidence after
//! local checks only (`from_evidence`): same owner, conversation and Core
//! context, the original Root actor, every retained descriptor's identity and
//! authority attributes, and unchanged directory stamps. The fence transaction
//! still validates the durable project row. Any difference drops the
//! attestation and repeats the complete Root check, which decides exactly as
//! before. What a local check cannot see (a Root-side policy change, or file
//! content inside `.git`) is seen at the next fresh check: at most
//! SETUP_ATTESTATION later, and always at readiness confirmation, which keeps
//! its own fresh Root check (`confirm_metadata_session`).
//!
//! A fence's short handoff (`HANDOFF`) starts once the fence holds Core's
//! writer (`under_writer`), not before it queues for it (ORK-770, again).
//! Core has one SQLite writer. When several windows open at once, their
//! setups poll every 10 ms, and each poll is a write transaction. A fence
//! then waited over 100 ms for `BEGIN IMMEDIATE` alone, its proof expired
//! before the first durable check (`workspace_handoff_expired`), and the
//! whole setup failed as `setup_incomplete`. The proof that runs under the
//! writer is derived from the same attested evidence with the same local
//! checks, so the time spent queueing no longer counts against the handoff.
//!
//! The attestation can also lapse during that wait (a fence that began just
//! before its 5 s ran out). There is then no evidence young enough to derive
//! from, and the proof expires as before. Nothing ran under it, so the fence
//! rolls back and repeats once with a complete fresh Root check
//! (`lapsed_while_queueing`) instead of revoking the whole setup. Every
//! other operation restarts its handoff under the writer through
//! `Store::begin_writer` (writer_handoff.rs).
use super::*;
use std::sync::Mutex;

/// How long one fresh Root check serves the fences of one setup.
pub(super) const SETUP_ATTESTATION: Duration = Duration::from_secs(5);

/// Per grant: never cloned, shared or carried to another setup.
#[derive(Default)]
pub(crate) struct SetupAttestation(Mutex<Option<Attested>>);

struct Attested {
    evidence: Arc<WorkspaceCheck>,
    until: Instant,
}

impl SetupAttestation {
    fn current(&self) -> Option<Arc<WorkspaceCheck>> {
        let mut slot = self.0.lock().ok()?;
        if slot.as_ref().is_some_and(|a| Instant::now() >= a.until) {
            *slot = None;
        }
        slot.as_ref().map(|a| a.evidence.clone())
    }

    fn record(&self, fresh: &WorkspacePreflight) {
        if let (Ok(mut slot), Some(evidence)) = (self.0.lock(), fresh.evidence()) {
            *slot = Some(Attested {
                evidence,
                until: Instant::now() + SETUP_ATTESTATION,
            });
        }
    }

    fn clear(&self) {
        if let Ok(mut slot) = self.0.lock() {
            *slot = None;
        }
    }

    #[cfg(test)]
    pub(crate) fn lapse_for_test(&self) {
        if let Ok(mut slot) = self.0.lock() {
            if let Some(attested) = slot.as_mut() {
                attested.until = Instant::now();
            }
        }
    }

    /// The last moments of an attestation: its evidence is already too old to
    /// restart a handoff under the writer, and it lapses after `remaining`.
    #[cfg(test)]
    pub(crate) fn expire_soon_for_test(&self, remaining: Duration) {
        if let Ok(mut slot) = self.0.lock() {
            if let Some(attested) = slot.as_mut() {
                let mut evidence = attested.evidence.rederive();
                evidence.evidence_at = Instant::now()
                    .checked_sub(SETUP_ATTESTATION)
                    .expect("monotonic clock older than the attestation");
                attested.evidence = Arc::new(evidence);
                attested.until = Instant::now() + remaining;
            }
        }
    }
}

impl WorkspaceCheck {
    /// A new single-effect, per-operation proof carrying this proof's fresh
    /// Root evidence: its own guard, effect and handoff deadline.
    fn rederive(&self) -> Self {
        let now = Instant::now();
        Self {
            owner: self.owner.clone(),
            conversation: self.conversation.clone(),
            project: self.project.clone(),
            installation: self.installation.clone(),
            deadline: self.deadline.map(|_| now + HANDOFF),
            rearmed: Arc::new(OnceLock::new()),
            evidence_at: self.evidence_at,
            lent: AtomicBool::new(false),
            physical_deadline: now + PHYSICAL_BUDGET,
            alive: AtomicBool::new(true),
            effect: Arc::new(AtomicBool::new(false)),
            stamp_changed: AtomicBool::new(false),
            handoff_expired: Arc::new(AtomicBool::new(false)),
            #[cfg(test)]
            forced_handoff_expiry: AtomicBool::new(false),
            context: self.context.clone(),
            retained: self.retained,
        }
    }
}

impl WorkspacePreflight {
    /// The fresh Root evidence of this owned proof. A borrowed proof attests
    /// nothing new.
    fn evidence(&self) -> Option<Arc<WorkspaceCheck>> {
        self.owns.then(|| self.proof.clone())
    }

    /// One fence's proof from attested evidence, after the local checks only.
    fn from_evidence(store: &Store, evidence: &WorkspaceCheck, binding: &Binding) -> Result<Self> {
        if evidence.owner != binding.owner_id || evidence.conversation != binding.conversation_id {
            return Err(fenced("workspace_scope"));
        }
        let proof = Arc::new(evidence.rederive());
        let mut scoped = store.clone();
        scoped.workspace_check = Some(proof.clone());
        let preflight = Self {
            store: scoped,
            proof,
            owns: true,
        };
        preflight.workspace_check_current()?;
        Ok(preflight)
    }

    /// Whether this fence's proof expired only because the setup's
    /// attestation lapsed while the fence queued for Core's writer, so
    /// `under_writer` had no evidence to restart the handoff from. Nothing
    /// ran under this proof. After rolling back, the caller may repeat the
    /// fence once: it then takes the complete fresh Root check, exactly like
    /// the first fence of a setup, instead of revoking the whole setup.
    /// A local difference never repeats: it fences exactly as before.
    pub(in crate::production_runtime) fn lapsed_while_queueing(
        &self,
        validated: &Result<()>,
        attestation: &SetupAttestation,
    ) -> bool {
        let unchanged = || {
            self.proof
                .installation
                .as_ref()
                .is_some_and(|installation| {
                    installation.check_retained().is_ok()
                        && installation.retained_stamp().ok() == self.proof.retained
                })
        };
        let lapsed = matches!(validated, Err(RuntimeStoreError::Fenced))
            && self.owns
            && self.proof.alive.load(Ordering::SeqCst)
            && !self.proof.effect.load(Ordering::SeqCst)
            && self.proof.handoff_expired.load(Ordering::SeqCst)
            && attestation.current().is_none()
            && unchanged();
        if lapsed {
            attestation.clear();
            // This attempt's code is not the repeated fence's answer.
            let _ = crate::production_runtime::fence_reason::take();
        }
        lapsed
    }
}

impl Store {
    /// The workspace preflight of one fence of the setup that owns
    /// `attestation`. A Store already scoped to a proof keeps that proof's
    /// one-effect rule and never uses or records an attestation.
    pub(in crate::production_runtime) async fn check_binding_for_setup(
        &self,
        binding: &Binding,
        attestation: &SetupAttestation,
    ) -> Result<WorkspacePreflight> {
        if self.workspace_check.is_some() {
            return self.check_binding_before_writer(binding).await;
        }
        if let Some(evidence) = attestation.current() {
            match WorkspacePreflight::from_evidence(self, &evidence, binding) {
                Ok(derived) => return Ok(derived),
                Err(_) => {
                    // Not this fence's answer: the complete check below decides.
                    let _ = crate::production_runtime::fence_reason::take();
                    attestation.clear();
                }
            }
        }
        let fresh = self.check_binding_before_writer(binding).await?;
        attestation.record(&fresh);
        Ok(fresh)
    }

    /// The proof one setup fence uses once it holds Core's writer.
    ///
    /// An owned, unused proof with a handoff deadline is replaced by a new
    /// per-operation proof derived from the setup's attested evidence, after
    /// the same local checks as at the start of a fence (`from_evidence`).
    /// Its handoff therefore starts now. No Root call and no pool connection
    /// is taken here, because the caller holds the writer.
    ///
    /// Anything else keeps `checked` and decides exactly as before: a
    /// borrowed proof, a proof without a handoff (no Root-attested project),
    /// an attestation that has lapsed, or any local difference.
    pub(in crate::production_runtime) fn under_writer(
        &self,
        checked: WorkspacePreflight,
        binding: &Binding,
        attestation: &SetupAttestation,
    ) -> WorkspacePreflight {
        if self.workspace_check.is_some()
            || !checked.owns
            || checked.proof.deadline.is_none()
            || checked.proof.effect.load(Ordering::SeqCst)
        {
            return checked;
        }
        let Some(evidence) = attestation.current() else {
            return checked;
        };
        // On a local difference the original proof fences at the next check.
        // The reason recorded here (for example `workspace_stamp_changed`)
        // stays, so the fence names the change and not the lapsed handoff.
        WorkspacePreflight::from_evidence(self, &evidence, binding).unwrap_or(checked)
    }
}
