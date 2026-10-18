//! Private integration-harness composition. Never exported by the runtime library.
use orkestr_runtime::{
    fake::FakeProvider,
    ports::{Blocker, Provider},
    supervisor::{self, Error, PendingObservation},
};
use orkestr_v2_application::runtime::*;
use orkestr_v2_store_sqlite::fixture_runtime::FixtureSupervisorStore;

pub(super) struct FixtureSupervisor {
    pub handle: FixtureSupervisorStore,
    fake: FakeProvider,
    provider: Option<ProviderAdmission>,
    cursor: PendingObservation,
    next_sequence: u64,
    control: Option<CancelReceipt>,
    stop: Option<ProviderEventInput>,
    interrupt: Option<std::result::Result<(), Blocker>>,
    rejected: Option<ProviderEvent>,
    stopped: bool,
    starts: usize,
}
impl FixtureSupervisor {
    pub fn new(handle: FixtureSupervisorStore) -> Self {
        Self {
            handle,
            fake: FakeProvider::fixture_only(true).expect("explicit fixture"),
            provider: None,
            cursor: PendingObservation::default(),
            next_sequence: 1,
            control: None,
            stop: None,
            interrupt: None,
            rejected: None,
            stopped: false,
            starts: 0,
        }
    }
    pub fn starts(&self) -> usize {
        self.starts
    }
    pub fn provider(&self) -> &ProviderAdmission {
        self.provider.as_ref().expect("consumed fixture admission")
    }
    pub fn rejected(&self) -> Option<&ProviderEvent> {
        self.rejected.as_ref()
    }
    pub async fn start(
        &mut self,
        claim: &InboxClaim,
        binding: &Binding,
        key: &str,
    ) -> std::result::Result<(), Error> {
        self.start_inner(claim, binding, key, false).await
    }
    // Test-only lost reply; never a retry switch exposed by a product command.
    #[cfg(feature = "fixture-test-controls")]
    pub async fn start_discarding_consume_reply(
        &mut self,
        claim: &InboxClaim,
        binding: &Binding,
        key: &str,
    ) -> std::result::Result<(), Error> {
        self.start_inner(claim, binding, key, true).await
    }
    async fn start_inner(
        &mut self,
        claim: &InboxClaim,
        binding: &Binding,
        key: &str,
        discard_reply: bool,
    ) -> std::result::Result<(), Error> {
        if binding.role != Role::Deep
            || binding.session_id != claim.consumer_session_id
            || binding.owner_id != claim.owner_id
            || binding.conversation_id != claim.conversation_id
            || binding.provider_kind != ProviderKind::ExplicitFixture
            || binding.state != SessionState::Ready
        {
            return Err(Error::Store(RuntimeStoreError::InvalidInput));
        }
        let fresh = self
            .handle
            .admit_run(claim, &binding.session_id, binding.generation, key)
            .await
            .map_err(Error::Store)?;
        if fresh.provider.binding != *binding
            || fresh.provider.run.role != Role::Deep
            || fresh.provider.run.owner_id != claim.owner_id
            || fresh.provider.run.conversation_id != claim.conversation_id
            || fresh.provider.run.session_id != binding.session_id
            || fresh.provider.run.purpose != AdmissionPurpose::Execution
        {
            return Err(Error::Store(RuntimeStoreError::InvalidInput));
        }
        if fresh.disposition != AdmissionDisposition::FreshCandidate {
            return Err(Error::Provider(Blocker::DispatchUnconfirmed));
        }
        if self.provider.is_some() || fresh.run_state != RunState::Starting {
            return Err(Error::Provider(Blocker::DispatchUnconfirmed));
        }
        let DispatchClaimResult::Reserved(reservation) = self
            .handle
            .claim_provider_dispatch(&fresh, "fixture-composition")
            .await
            .map_err(Error::Store)?
        else {
            return Err(Error::Provider(Blocker::DispatchUnconfirmed));
        };
        #[cfg(feature = "fixture-test-controls")]
        if discard_reply {
            self.handle
                .fixture_consume_without_reply(&reservation)
                .await
                .map_err(Error::Store)?;
            return Err(Error::Provider(Blocker::DispatchUnconfirmed));
        }
        #[cfg(not(feature = "fixture-test-controls"))]
        if discard_reply {
            return Err(Error::Provider(Blocker::DispatchUnconfirmed));
        }
        if self
            .handle
            .consume_provider_dispatch(&reservation)
            .await
            .map_err(Error::Store)?
            != DispatchConsumption::DispatchNow
        {
            return Err(Error::Provider(Blocker::DispatchUnconfirmed));
        }
        // Retain uncertain delivery identity before FAKE I/O, including start failure.
        self.provider = Some(reservation.provider.clone());
        self.fake
            .start(&reservation.provider.run)
            .map_err(Error::Provider)?;
        self.starts += 1;
        Ok(())
    }
    pub fn emit(&mut self, event: ProviderEvent) -> std::result::Result<(), Blocker> {
        self.fake.emit(&self.provider().run.clone(), event)
    }
    pub async fn step(&mut self) -> std::result::Result<bool, Error> {
        if self.control.is_some() {
            return Err(Error::Store(RuntimeStoreError::Fenced));
        }
        let provider = self.provider().clone();
        let recorded =
            supervisor::step(&self.handle, &mut self.fake, &provider, &mut self.cursor).await?;
        if recorded {
            self.next_sequence = self
                .next_sequence
                .checked_add(1)
                .ok_or(Error::Store(RuntimeStoreError::InvalidInput))?;
        }
        Ok(recorded)
    }
    pub async fn cancel(
        &mut self,
        key: &str,
    ) -> std::result::Result<(CancelReceipt, std::result::Result<(), Blocker>), Error> {
        // Do not lose an unpersisted observation in order to switch cursors.
        if self.cursor.pending().is_some() {
            return Err(Error::Store(RuntimeStoreError::Busy));
        }
        let original = self.provider().run.clone();
        if let Some(old) = &self.control {
            let receipt = self
                .handle
                .request_cancel(&original.owner_id, &original.run_id, key)
                .await
                .map_err(Error::Store)?;
            if &receipt != old {
                return Err(Error::Store(RuntimeStoreError::Conflict));
            }
            return Ok((
                receipt,
                self.interrupt.clone().expect("original interrupt result"),
            )); // No repeated I/O.
        }
        let (receipt, interrupt) = supervisor::cancel(
            &self.handle,
            &mut self.fake,
            &original.owner_id,
            &original,
            key,
        )
        .await
        .map_err(Error::Store)?;
        self.control = Some(receipt.clone());
        self.interrupt = Some(interrupt.clone());
        Ok((receipt, interrupt))
    }
    pub async fn acknowledge_stop(&mut self) -> std::result::Result<bool, Error> {
        if self.stopped {
            return Ok(false);
        }
        if self.rejected.is_some() {
            return Err(Error::Store(RuntimeStoreError::Fenced));
        }
        let original = self.provider().clone();
        let receipt = self
            .control
            .as_ref()
            .ok_or(Error::Store(RuntimeStoreError::InvalidInput))?;
        if self.stop.is_none() {
            let Some(event) = self.fake.poll(&original.run).map_err(Error::Provider)? else {
                return Ok(false);
            };
            if event != ProviderEvent::Stopped {
                self.rejected = Some(event); // Never relabel a racing completion as Stopped.
                return Err(Error::Store(RuntimeStoreError::Fenced));
            }
            self.stop = Some(ProviderEventInput {
                run_id: original.run.run_id.clone(),
                session_id: original.run.session_id.clone(),
                lease_generation: receipt.new_fenced_admission.lease_generation,
                dispatch_fence: receipt.new_fenced_admission.dispatch_fence,
                sequence: self.next_sequence,
                event,
            });
        }
        let control = ProviderAdmission {
            run: receipt.new_fenced_admission.clone(),
            binding: original.binding,
        };
        let result = self
            .handle
            .append_provider_event(&control.run.owner_id, &control, self.stop.as_ref().unwrap())
            .await
            .map_err(Error::Store)?;
        if result.sequence != self.next_sequence || result.state != RunState::Cancelled {
            return Err(Error::Store(RuntimeStoreError::Conflict));
        }
        self.stop = None;
        self.stopped = true;
        Ok(true)
    }
}
