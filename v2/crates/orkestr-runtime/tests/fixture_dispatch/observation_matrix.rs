//! Real adapter refusal/retry coverage using public APIs, without a substitute store.
use super::*;
use orkestr_runtime::{
    ports::InterruptControl,
    supervisor::{self, Error, PendingObservation},
};

struct CountedFake {
    inner: FakeProvider,
    polls: usize,
}
impl Provider for CountedFake {
    fn start(
        &mut self,
        a: &RunAdmission,
    ) -> std::result::Result<(), orkestr_runtime::ports::Blocker> {
        self.inner.start(a)
    }
    fn poll(
        &mut self,
        a: &RunAdmission,
    ) -> std::result::Result<Option<ProviderEvent>, orkestr_runtime::ports::Blocker> {
        self.polls += 1;
        self.inner.poll(a)
    }
    fn interrupt(
        &mut self,
        c: &InterruptControl,
    ) -> std::result::Result<(), orkestr_runtime::ports::Blocker> {
        self.inner.interrupt(c)
    }
}
async fn event_bytes(f: &Fixture) -> Vec<u8> {
    serde_json::to_vec(
        &f.b.events(&f.claim.owner_id, &f.claim.conversation_id, 0, 100)
            .await
            .unwrap(),
    )
    .unwrap()
}
fn event(p: &ProviderAdmission, sequence: u64, kind: ProviderEvent) -> ProviderEventInput {
    let mut input = failed(p);
    input.sequence = sequence;
    input.event = kind;
    input
}

#[tokio::test]
async fn closed_pool_failure_retries_same_terminal_against_reopened_adapter_without_repoll() {
    for terminal in [
        ProviderEvent::CompletedProposal { synthetic: true },
        ProviderEvent::Failed,
        ProviderEvent::Lost,
    ] {
        let f = Fixture::new().await;
        let provider = consumed(&f).await;
        let mut fake = CountedFake {
            inner: FakeProvider::fixture_only(true).unwrap(),
            polls: 0,
        };
        fake.start(&provider.run).unwrap(); // Explicit test-only consumed authority boundary.
        let mut cursor = PendingObservation::default();
        assert_eq!(
            supervisor::step(&f.handle, &mut fake, &provider, &mut cursor).await,
            Ok(true)
        );
        fake.inner.emit(&provider.run, terminal.clone()).unwrap();
        let before = event_bytes(&f).await;
        f.a.close().await; // Actual SQL pool failure, not a spy/fabricated result.
        assert_eq!(
            supervisor::step(&f.handle, &mut fake, &provider, &mut cursor).await,
            Err(Error::Store(RuntimeStoreError::Unavailable))
        );
        let pending = cursor.pending().unwrap().clone();
        assert_eq!(pending.event, terminal);
        assert_eq!(pending.sequence, 2);
        assert_eq!(fake.polls, 2);
        assert!(
            before == event_bytes(&f).await,
            "failed append changed canonical events"
        );
        let reopened = Store::open(&f.root.join("fixture.sqlite3")).await.unwrap();
        let handle = f.handle.reattach(&reopened).await.unwrap();
        assert_eq!(
            supervisor::step(&handle, &mut fake, &provider, &mut cursor).await,
            Ok(true)
        );
        assert_eq!(fake.polls, 2);
        assert!(cursor.pending().is_none());
        let duplicate = handle
            .append_provider_event(&f.claim.owner_id, &provider, &pending)
            .await
            .unwrap();
        assert!(duplicate.duplicate);
        assert_eq!(duplicate.sequence, 2);
        assert_eq!(
            duplicate.state,
            match terminal {
                ProviderEvent::CompletedProposal { .. } => RunState::AwaitingAcceptance,
                ProviderEvent::Failed => RunState::Failed,
                _ => RunState::Blocked,
            }
        );
        let events = reopened
            .events(&f.claim.owner_id, &f.claim.conversation_id, 0, 100)
            .await
            .unwrap();
        assert_eq!(events.len(), 3); // One intake plus exactly two provider events.
        assert_eq!(
            events.iter().map(|e| e.sequence()).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        reopened.close().await;
        f.close().await;
    }
}

type Mutate = fn(&mut ProviderAdmission);
#[tokio::test]
async fn forged_execution_envelopes_cannot_replay_or_append_and_leave_public_projections_unchanged()
{
    let f = Fixture::new().await;
    let p = consumed(&f).await;
    let started = event(&p, 1, ProviderEvent::Started);
    let receipt = f
        .handle
        .append_provider_event(&f.claim.owner_id, &p, &started)
        .await
        .unwrap();
    let mutations: [Mutate; 8] = [
        |p| p.run.owner_id.0 = p.run.conversation_id.0,
        |p| p.run.run_id.0 = p.run.conversation_id.0,
        |p| p.run.session_id.0 = p.run.conversation_id.0,
        |p| p.run.attempt += 1,
        |p| p.run.lease_generation += 1,
        |p| p.run.dispatch_fence += 1,
        |p| p.run.purpose = AdmissionPurpose::CancellationAcknowledgement,
        |p| p.run.role = Role::Worker,
    ];
    let before = event_bytes(&f).await;
    let attempt = f
        .handle
        .inspect_fixture_attempt(&f.claim.conversation_id, "synthetic-run")
        .await
        .unwrap();
    let scope = f
        .handle
        .inspect_fixture_scope(&f.claim.conversation_id)
        .await
        .unwrap();
    let unseen = event(&p, 2, ProviderEvent::ApprovalRequested);
    for mutate in mutations {
        let mut forged = p.clone();
        mutate(&mut forged);
        for input in [&started, &unseen] {
            assert!(f
                .handle
                .append_provider_event(&f.claim.owner_id, &forged, input)
                .await
                .is_err());
            assert!(
                before == event_bytes(&f).await,
                "refusal changed canonical events"
            );
            assert_eq!(
                f.handle
                    .inspect_fixture_attempt(&f.claim.conversation_id, "synthetic-run")
                    .await
                    .unwrap(),
                attempt
            );
            assert_eq!(
                f.handle
                    .inspect_fixture_scope(&f.claim.conversation_id)
                    .await
                    .unwrap(),
                scope
            );
        }
    }
    for committed in [true, false] {
        for lease in [true, false] {
            let mut changed = if committed {
                started.clone()
            } else {
                unseen.clone()
            };
            if lease {
                changed.lease_generation += 1;
            } else {
                changed.dispatch_fence += 1;
            }
            assert_eq!(
                f.handle
                    .append_provider_event(&f.claim.owner_id, &p, &changed)
                    .await,
                Err(if committed {
                    RuntimeStoreError::Conflict
                } else if lease {
                    RuntimeStoreError::StaleLease
                } else {
                    RuntimeStoreError::Fenced
                })
            );
            assert!(before == event_bytes(&f).await);
            assert_eq!(
                f.handle
                    .inspect_fixture_attempt(&f.claim.conversation_id, "synthetic-run")
                    .await
                    .unwrap(),
                attempt
            );
            assert_eq!(
                f.handle
                    .inspect_fixture_scope(&f.claim.conversation_id)
                    .await
                    .unwrap(),
                scope
            );
        }
    }
    let duplicate = f
        .handle
        .append_provider_event(&f.claim.owner_id, &p, &started)
        .await
        .unwrap();
    assert!(duplicate.duplicate);
    assert_eq!(duplicate.event_id, receipt.event_id);
    // Refusals neither spend sequence2 nor disturb legitimate execution identity.
    let next = f
        .handle
        .append_provider_event(&f.claim.owner_id, &p, &unseen)
        .await
        .unwrap();
    assert_eq!(next.sequence, 2);
    assert_eq!(next.scope_sequence, receipt.scope_sequence + 1);
    f.close().await;
}

#[tokio::test]
async fn terminal_evidence_cannot_be_replaced_by_completion_stop_or_started() {
    for terminal in [
        ProviderEvent::CompletedProposal { synthetic: true },
        ProviderEvent::Failed,
        ProviderEvent::Lost,
    ] {
        let f = Fixture::new().await;
        let p = consumed(&f).await;
        let initial = event_bytes(&f).await;
        for premature in [
            ProviderEvent::CompletedProposal { synthetic: true },
            ProviderEvent::ApprovalRequested,
        ] {
            assert_eq!(
                f.handle
                    .append_provider_event(&f.claim.owner_id, &p, &event(&p, 1, premature))
                    .await,
                Err(RuntimeStoreError::Conflict)
            );
            assert!(
                initial == event_bytes(&f).await,
                "premature completion changed events"
            );
        }
        f.handle
            .append_provider_event(&f.claim.owner_id, &p, &event(&p, 1, ProviderEvent::Started))
            .await
            .unwrap();
        let terminal_input = event(&p, 2, terminal);
        let receipt = f
            .handle
            .append_provider_event(&f.claim.owner_id, &p, &terminal_input)
            .await
            .unwrap();
        let before = event_bytes(&f).await;
        let attempt = f
            .handle
            .inspect_fixture_attempt(&f.claim.conversation_id, "synthetic-run")
            .await
            .unwrap();
        let scope = f
            .handle
            .inspect_fixture_scope(&f.claim.conversation_id)
            .await
            .unwrap();
        for kind in [
            ProviderEvent::Started,
            ProviderEvent::Failed,
            ProviderEvent::Lost,
            ProviderEvent::CompletedProposal { synthetic: false },
            ProviderEvent::Stopped,
        ] {
            let unsupported = kind == ProviderEvent::Stopped;
            let input = event(&p, 3, kind);
            assert_eq!(
                f.handle
                    .append_provider_event(&f.claim.owner_id, &p, &input)
                    .await,
                Err(if unsupported {
                    RuntimeStoreError::Unavailable
                } else {
                    RuntimeStoreError::Conflict
                })
            );
            assert!(before == event_bytes(&f).await);
            assert_eq!(
                f.handle
                    .inspect_fixture_attempt(&f.claim.conversation_id, "synthetic-run")
                    .await
                    .unwrap(),
                attempt
            );
            assert_eq!(
                f.handle
                    .inspect_fixture_scope(&f.claim.conversation_id)
                    .await
                    .unwrap(),
                scope
            );
        }
        let replay = f
            .handle
            .append_provider_event(&f.claim.owner_id, &p, &terminal_input)
            .await
            .unwrap();
        assert!(replay.duplicate);
        assert_eq!(replay.state, receipt.state);
        assert_eq!(replay.event_id, receipt.event_id);
        f.close().await;
    }
}
