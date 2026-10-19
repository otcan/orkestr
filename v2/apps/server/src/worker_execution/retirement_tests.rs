//! Negative registry invariants only. Positive original witnesses are exercised
//! through the actual broker/native process and HTTP restart oracle.
use super::*;
use orkestr_v2_contracts::{ConversationId, OwnerId};

fn ledger() -> WorkerReaps {
    WorkerReaps::new(
        OwnerId(uuid::Uuid::new_v4()),
        ConversationId(uuid::Uuid::new_v4()),
        "synthetic:worker".into(),
    )
}
fn parent(reaps: &WorkerReaps) -> ExecutionScope {
    let mut state = reaps.0.lock().unwrap();
    let scope = ExecutionScope::new(
        &state.namespace,
        "incarnation",
        &state.owner.to_string(),
        "parent-session",
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
            binding_generation: 1,
            continuation_attempted: false,
        },
    );
    scope
}

#[test]
fn setup_only_obligation_refuses_even_without_a_bound_run() {
    let reaps = ledger();
    let parent = parent(&reaps);
    let mut state = reaps.0.lock().unwrap();
    state.reserve("setup-only".into()).unwrap();
    assert!(state.finish(&parent).is_err());
    assert!(state.reserve("after-freeze".into()).is_err());
}

#[test]
fn lost_original_handle_poison_cannot_be_erased_by_parent_continuation() {
    let reaps = ledger();
    let parent = parent(&reaps);
    let id = reaps.0.lock().unwrap().reserve("lost".into()).unwrap();
    drop(LaunchWitness {
        ledger: reaps.clone(),
        id,
        satisfied: false,
    });
    let mut state = reaps.0.lock().unwrap();
    assert!(state.poisoned);
    // New work remains possible; only final retirement is poisoned.
    state.reserve("later-turn".into()).unwrap();
    assert_eq!(state.launches.len(), 2);
    assert!(state.finish(&parent).is_err());
}

#[test]
fn original_scope_requires_parent_session_run_incarnation_and_fence() {
    for changed in 0..5 {
        let reaps = ledger();
        let original = parent(&reaps);
        let wrong = ExecutionScope::new(
            original.namespace(),
            if changed == 0 {
                "other-incarnation"
            } else {
                original.incarnation_id()
            },
            if changed == 1 {
                "other-owner"
            } else {
                original.owner()
            },
            if changed == 2 {
                "other-session"
            } else {
                original.session()
            },
            if changed == 3 {
                "other-run"
            } else {
                original.run()
            },
            if changed == 4 { 2 } else { 1 },
        )
        .unwrap();
        let mut state = reaps.0.lock().unwrap();
        assert!(state.finish(&wrong).is_err());
        assert!(
            state.finish(&original).is_err(),
            "finalization is one-use even on refusal"
        );
    }
}

#[test]
fn duplicate_session_cannot_cover_two_native_launches() {
    let reaps = ledger();
    let mut state = reaps.0.lock().unwrap();
    state.reserve("same-session".into()).unwrap();
    assert!(state.reserve("same-session".into()).is_err());
    assert_eq!(state.launches.len(), 1);
}

#[test]
fn bounded_obligations_never_evict_older_unproven_children() {
    let reaps = ledger();
    let parent = parent(&reaps);
    let mut state = reaps.0.lock().unwrap();
    for number in 0..MAX_WITNESSES - 1 {
        state.reserve(format!("session-{number}")).unwrap();
    }
    assert!(state.reserve("overflow".into()).is_err());
    assert!(state.launches.contains_key(&0));
    assert!(state.finish(&parent).is_err());
    assert_eq!(state.launches.len(), MAX_WITNESSES - 1);
    assert_eq!(state.proof_count(), MAX_WITNESSES);
}
