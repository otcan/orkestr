//! Durable FIFO intake. A browser message never supplies provider authority.
use super::*;
use orkestr_v2_application::runtime::{
    AdmissionDisposition, DispatchClaimResult, RuntimeStore, RuntimeStoreError, SessionState,
};
use orkestr_v2_store_sqlite::{ConsumedProviderDispatch, ExecutionConsumption};
use std::time::Instant;

impl ConfiguredExecution {
    /// Read-only wakeup after native retirement. A held pre-Stop input must not
    /// spend a one-use setup grant or start an idle replacement process.
    pub(super) async fn wait_eligible(
        &self,
        shutdown: &mut watch::Receiver<bool>,
        heartbeat: &mut Instant,
    ) -> Result<bool, &'static str> {
        loop {
            // An execution window accepts follow-up turns until its work
            // deadline; afterwards its owner retires it and a successor resumes.
            if *shutdown.borrow() || self.window.as_ref().is_some_and(|window| window.work_due()) {
                return Ok(false);
            }
            // The owner works in this native session from a terminal: an
            // idle window closes rather than wait to resume it.
            if self.native_attach_held() {
                return Ok(false);
            }
            self.maintain(heartbeat).await?;
            let page = self
                .store
                .held_owner_inputs_authenticated(&self.token, &self.config.conversation_id, 0, 1)
                .await
                .map_err(|_| "execution input eligibility unavailable")?;
            if !page.is_valid() || page.conversation_id != self.config.conversation_id {
                return Err("execution input eligibility invalid");
            }
            if page.eligible_input_available {
                return self.provider_input_allowed(None).await;
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(100)) => {},
                _ = shutdown.changed() => return Ok(false),
            }
        }
    }

    /// Called only after setup or committed owner acceptance. Core owns the
    /// earliest unconsumed scope sequence; active input is never claimed early.
    pub(super) async fn next(
        &self,
        shutdown: &mut watch::Receiver<bool>,
        heartbeat: &mut Instant,
    ) -> Result<Option<Box<ConsumedProviderDispatch>>, &'static str> {
        self.next_with_liveness(shutdown, heartbeat, || Ok(()))
            .await
    }

    /// A retained child must remain live before claiming the next input. This
    /// callback can only refuse admission; it supplies no provider authority.
    pub(super) async fn next_with_liveness(
        &self,
        shutdown: &mut watch::Receiver<bool>,
        heartbeat: &mut Instant,
        mut live: impl FnMut() -> Result<(), &'static str>,
    ) -> Result<Option<Box<ConsumedProviderDispatch>>, &'static str> {
        let conversation = &self.config.conversation_id;
        let binding = self
            .store
            .ensure_role_bindings(&self.owner, conversation)
            .await
            .map_err(|_| "execution ready binding unavailable")?
            .deep;
        if binding.state != SessionState::Ready {
            return Err("execution binding is not ready for another run");
        }
        'input: loop {
            let claim = loop {
                if *shutdown.borrow()
                    || self.window.as_ref().is_some_and(|window| window.work_due())
                {
                    return Ok(None);
                }
                self.maintain(heartbeat).await?;
                live()?;
                // The owner works in this native session from a terminal:
                // claim nothing. The caller reaps this native tree and the
                // window closes as after its last input; the next input
                // queues until the hold is released and then resumes here.
                if self.native_attach_held() || !self.provider_input_allowed(None).await? {
                    return Ok(None);
                }
                match self
                    .store
                    .claim_next(
                        &self.owner,
                        conversation,
                        &binding.session_id,
                        Duration::from_secs(60),
                    )
                    .await
                {
                    Ok(Some(claim)) => break claim,
                    // Busy means the writer was not acquired or an earlier
                    // unconsumed claim still owns the FIFO head. Neither case
                    // authorizes a provider turn. Wait under the same window and
                    // supervisor checks instead of stranding an idle window.
                    Ok(None) | Err(RuntimeStoreError::Busy) => {}
                    // Core fences a claim once the window's work deadline has
                    // passed on its clock. The local deadline maps the same
                    // instant and can trail it by a moment: at that edge this
                    // is the window's ordinary end, not a refusal.
                    Err(RuntimeStoreError::Fenced)
                        if self.window.as_ref().is_some_and(|window| {
                            work_deadline_reached(window.work_deadline(), Instant::now())
                        }) =>
                    {
                        eprintln!("owned execution inbox closed at the window work deadline");
                        return Ok(None);
                    }
                    Err(error) => {
                        eprintln!("owned execution inbox claim refused: {error:?}");
                        return Err("execution inbox claim refused");
                    }
                }
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(100)) => {},
                    _ = shutdown.changed() => return Ok(None),
                }
            };
            self.current().await?;
            // The admitted run's lease is capped at the supervisor deadline:
            // admit only on a heartbeat Core accepted just now.
            if !self.accepted_heartbeat(shutdown, heartbeat).await? {
                return Ok(None);
            }
            // The FIFO head can change between the prospective read and claim
            // (parallel slots). Re-evaluate the actual lease before any admission.
            if let Some(proof) = self.provider_input_refusal(&claim.message_id).await? {
                self.store
                    .release_provider_policy_claim(&claim, &proof)
                    .await
                    .map_err(|_| "provider policy claim release refused")?;
                return Ok(None);
            }
            let key = format!("http:{}", claim.message_id);
            let admitted = match self
                .store
                .admit_run(&claim, &binding.session_id, binding.generation, &key)
                .await
            {
                Ok(admitted) => admitted,
                Err(RuntimeStoreError::Fenced) => {
                    // ORK-795: a source continuation (an automatic host result)
                    // whose source run was superseded can never run. Core
                    // retires exactly that input; the window keeps every other
                    // input and claims the next one.
                    if self.retire_superseded(&claim).await? {
                        continue 'input;
                    }
                    return Err("execution admission refused");
                }
                Err(_) => return Err("execution admission refused"),
            };
            if admitted.disposition != AdmissionDisposition::FreshCandidate {
                return Err("execution admission requires reconciliation");
            }
            let DispatchClaimResult::Reserved(reservation) = self
                .store
                .claim_provider_dispatch(&admitted, &key)
                .await
                .map_err(|_| "execution reservation refused")?
            else {
                return Err("execution reservation requires reconciliation");
            };
            self.current().await?;
            // Core authenticates inside consumption and every transport fence. This
            // preliminary current-session check is never the authority for a write.
            let ExecutionConsumption::Dispatch(mut capability) = self
                .store
                .consume_execution(&reservation)
                .await
                .map_err(|_| "execution consumption refused")?
            else {
                return Err("execution delivery is uncertain; automatic replay refused");
            };
            self.note_native_attach(&mut capability).await;
            return Ok(Some(capability));
        }
    }

    /// `true` only when Core retired this exact claim because its source fence
    /// no longer holds. Anything else keeps the original admission refusal.
    async fn retire_superseded(
        &self,
        claim: &orkestr_v2_application::runtime::InboxClaim,
    ) -> Result<bool, &'static str> {
        let retired = self
            .store
            .retire_superseded_source_claim(claim)
            .await
            .map_err(|_| "execution admission refused")?;
        if retired {
            // Identifiers only, never message text.
            eprintln!(
                "owned execution retired a superseded source continuation: message={}",
                claim.message_id
            );
        }
        Ok(retired)
    }
}

pub(super) fn heartbeat_due(previous: Instant, now: Instant) -> bool {
    now.saturating_duration_since(previous) >= Duration::from_secs(10)
}

/// How far the local work deadline may trail Core's view of the same instant.
const WORK_DEADLINE_SKEW: Duration = Duration::from_secs(2);

/// Whether the window's work deadline has been reached, allowing for the
/// local clock trailing Core's by up to `WORK_DEADLINE_SKEW`.
fn work_deadline_reached(deadline: Instant, now: Instant) -> bool {
    now.checked_add(WORK_DEADLINE_SKEW)
        .is_none_or(|edge| edge >= deadline)
}

#[cfg(test)]
mod work_deadline_tests {
    use super::*;

    #[test]
    fn a_claim_fenced_at_the_work_deadline_edge_ends_the_window() {
        let now = Instant::now();
        // Core already saw the deadline; locally it is a moment ahead.
        assert!(work_deadline_reached(now + Duration::from_millis(500), now));
        assert!(work_deadline_reached(now + WORK_DEADLINE_SKEW, now));
        assert!(work_deadline_reached(now, now));
        // Well before the deadline a fenced claim stays a refusal.
        assert!(!work_deadline_reached(
            now + WORK_DEADLINE_SKEW + Duration::from_millis(1),
            now
        ));
        assert!(!work_deadline_reached(now + Duration::from_secs(300), now));
    }
}

#[cfg(all(test, unix))]
#[path = "superseded_source_tests.rs"]
mod superseded_source_tests;

#[cfg(test)]
mod metadata_heartbeat_tests {
    use super::*;

    #[test]
    fn metadata_heartbeat_keeps_original_cadence_past_work_and_cleanup_deadlines() {
        let start = Instant::now();
        let mut heartbeat = start + Duration::from_secs(870);
        // No work/cleanup deadline resets or disables the metadata lease cadence.
        for seconds in 871..=1000 {
            let now = start + Duration::from_secs(seconds);
            let due = heartbeat_due(heartbeat, now);
            assert_eq!(due, seconds % 10 == 0);
            if due {
                heartbeat = now;
            }
        }
    }
}
