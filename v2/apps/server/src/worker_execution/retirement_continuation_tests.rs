//! Refusal-state tests do not construct or substitute any Runtime reap proof.
use super::*;
use orkestr_v2_application::runtime::ProviderKind;
use orkestr_v2_contracts::SessionId;

fn fixture() -> (WorkerReaps, ExecutionScope, Binding) {
    let reaps = WorkerReaps::new(
        OwnerId(uuid::Uuid::new_v4()),
        ConversationId(uuid::Uuid::new_v4()),
        "synthetic:continuation".into(),
    );
    let mut state = reaps.0.lock().unwrap();
    let binding = Binding {
        owner_id: state.owner.clone(),
        conversation_id: state.conversation.clone(),
        session_id: SessionId(uuid::Uuid::new_v4()),
        role: SessionRole::Deep,
        provider_kind: ProviderKind::Codex,
        native_session_id: Some("synthetic-original".into()),
        parent_session_id: None,
        generation: 3,
        state: SessionState::Ready,
    };
    let scope = ExecutionScope::new(
        &state.namespace,
        "incarnation",
        &state.owner.to_string(),
        &binding.session_id.to_string(),
        "parent-run",
        1,
    )
    .unwrap();
    state.incarnation = Some("incarnation".into());
    state.current_parent = Some(scope.run().into());
    state.parents.insert(
        scope.run().into(),
        Parent {
            scope: scope.clone(),
            binding_generation: 2,
            continuation_attempted: false,
        },
    );
    drop(state);
    (reaps, scope, binding)
}

#[test]
fn unresolved_or_poisoned_history_cannot_be_hidden_by_a_stopped_parent() {
    for lost in [false, true] {
        let (reaps, scope, binding) = fixture();
        let mut state = reaps.0.lock().unwrap();
        state.reserve("unproven-worker".into()).unwrap();
        state.poisoned = lost;
        assert!(state.can_continue(&scope, &binding).is_err());
        assert_eq!(state.launches.len(), 1);
        assert!(!state.frozen);
        assert!(state.continuing.is_none());
    }
}

#[test]
fn old_parent_or_attempted_handoff_cannot_spend_another_original_proof() {
    for repeated in [false, true] {
        let (reaps, scope, binding) = fixture();
        let mut state = reaps.0.lock().unwrap();
        if repeated {
            state
                .parents
                .get_mut(scope.run())
                .unwrap()
                .continuation_attempted = true;
        } else {
            state.current_parent = Some("later-parent".into());
        }
        assert!(state.can_continue(&scope, &binding).is_err());
        assert!(state.reaped_parents.is_empty());
        assert!(!state.frozen);
    }
}

#[test]
fn binding_owner_session_role_and_released_generation_stay_exact() {
    let (reaps, scope, binding) = fixture();
    for changed in 0..6 {
        let mut wrong = binding.clone();
        match changed {
            0 => wrong.owner_id = OwnerId(uuid::Uuid::new_v4()),
            1 => wrong.conversation_id = ConversationId(uuid::Uuid::new_v4()),
            2 => wrong.session_id = SessionId(uuid::Uuid::new_v4()),
            3 => wrong.generation += 1,
            4 => wrong.role = SessionRole::Worker,
            _ => wrong.state = SessionState::Busy,
        }
        assert!(reaps
            .0
            .lock()
            .unwrap()
            .can_continue(&scope, &wrong)
            .is_err());
    }
}

#[test]
fn cancellation_of_pending_core_handoff_poison_is_not_a_reset() {
    let (reaps, scope, binding) = fixture();
    {
        let mut state = reaps.0.lock().unwrap();
        state.continuing = Some(scope.run().into());
        state
            .parents
            .get_mut(scope.run())
            .unwrap()
            .continuation_attempted = true;
        assert!(state.reserve("racing-launch".into()).is_err());
    }
    // Model dropping the pending async reservation. There is deliberately no
    // original proof or successful Core result to construct in this unit test.
    drop(Continuation {
        ledger: reaps.clone(),
        run: scope.run().into(),
        binding: binding.clone(),
        completed: false,
    });
    let mut state = reaps.0.lock().unwrap();
    assert!(state.poisoned);
    assert_eq!(state.continuing.as_deref(), Some(scope.run()));
    assert!(state.can_continue(&scope, &binding).is_err());
    assert!(state.finish(&scope).is_err());
    assert!(state.launches.is_empty());
}

#[test]
fn aggregate_capacity_reserves_parent_and_refuses_without_mutation() {
    let (reaps, scope, binding) = fixture();
    let mut state = reaps.0.lock().unwrap();
    for number in 0..MAX_WITNESSES - 1 {
        state.reserve(format!("worker-{number}")).unwrap();
    }
    assert_eq!(state.proof_count(), MAX_WITNESSES);
    assert!(state.reserve("overflow-launch".into()).is_err());
    assert!(state.can_continue(&scope, &binding).is_err());
    assert_eq!(state.launches.len(), MAX_WITNESSES - 1);
    assert_eq!(state.parents.len(), 1);
    assert!(state.reaped_parents.is_empty());
    assert!(state.continuing.is_none());
    assert!(!state.parents[scope.run()].continuation_attempted);
    assert!(!state.frozen);
}
