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
}
