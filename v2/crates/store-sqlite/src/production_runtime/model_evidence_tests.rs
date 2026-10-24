use super::*;
use crate::production_runtime::observation_tests::{consumed, input};
use crate::production_runtime::tests::setup;
use orkestr_v2_contracts::{
    ExecutionFailureClass, ExecutionModelObservation, ExecutionModelSource, ExecutionPhase,
};

fn model(source: ExecutionModelSource, name: &str) -> ExecutionModelObservation {
    ExecutionModelObservation {
        source,
        model: name.into(),
    }
}

#[tokio::test]
async fn model_evidence_is_replay_stable_and_does_not_advance_canonical_run_state() {
    let f = setup().await;
    let p = consumed(&f).await;
    let before = f
        .store
        .execution_status(&f.owner, &f.conversation)
        .await
        .unwrap()
        .unwrap();
    let resolved = model(ExecutionModelSource::Resolved, "selected-model");
    f.handle
        .observe_provider_model(&p, &resolved, "model:1")
        .await
        .unwrap();
    let status = f
        .store
        .execution_status(&f.owner, &f.conversation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status.phase, ExecutionPhase::Starting);
    assert_eq!(status.phase, before.phase);
    assert!(status.revision > before.revision);
    assert_eq!(
        status.models.as_ref().unwrap().resolved_model.as_deref(),
        Some("selected-model")
    );
    assert_eq!(status.models.as_ref().unwrap().actual_model, None);
    f.handle
        .observe_provider_model(&p, &resolved, "model:1")
        .await
        .unwrap();
    assert_eq!(
        f.store
            .execution_status(&f.owner, &f.conversation)
            .await
            .unwrap()
            .unwrap()
            .revision,
        status.revision
    );
    assert!(matches!(
        f.handle
            .observe_provider_model(
                &p,
                &model(ExecutionModelSource::Resolved, "changed-model"),
                "model:1"
            )
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    // Model metadata has its own sequence and cannot impersonate a Started event.
    f.handle
        .append_provider_event(&f.owner, &p, &input(&p, 1, ProviderEvent::Started))
        .await
        .unwrap();
    f.handle
        .observe_provider_model(
            &p,
            &model(ExecutionModelSource::Answer, "answer-model"),
            "model:2",
        )
        .await
        .unwrap();
    f.handle
        .append_provider_event(
            &f.owner,
            &p,
            &input(&p, 2, ProviderEvent::CompletedProposal { synthetic: false }),
        )
        .await
        .unwrap();
    let final_status = f
        .store
        .execution_status(&f.owner, &f.conversation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(final_status.phase, ExecutionPhase::AwaitingAcceptance);
    assert_eq!(
        final_status.models.unwrap().actual_model.as_deref(),
        Some("answer-model")
    );
    assert!(f
        .handle
        .observe_provider_model(&p, &resolved, "too-late")
        .await
        .is_err());
}

#[tokio::test]
async fn model_metadata_requires_the_original_issued_provider_envelope() {
    let f = setup().await;
    let p = consumed(&f).await;
    let value = model(ExecutionModelSource::Answer, "answer-model");
    assert!(f
        .store
        .observe_provider_model(&p, &value, "unbound")
        .await
        .is_err());
    let mut wrong = p.clone();
    wrong.run.dispatch_fence += 1;
    assert!(f
        .handle
        .observe_provider_model(&wrong, &value, "forged")
        .await
        .is_err());
    let status = f
        .store
        .execution_status(&f.owner, &f.conversation)
        .await
        .unwrap()
        .unwrap();
    let models = status.models.unwrap();
    assert_eq!(models.actual_model, None);
    assert_eq!(models.resolved_model, None);
    assert_eq!(models.refused_model, None);
}

#[tokio::test]
async fn provider_policy_failure_is_a_closed_class_with_exact_model_evidence() {
    let f = setup().await;
    let p = consumed(&f).await;
    f.handle
        .observe_provider_model(
            &p,
            &model(ExecutionModelSource::Resolved, "refusing-model"),
            "model:1",
        )
        .await
        .unwrap();
    f.handle
        .append_provider_event(
            &f.owner,
            &p,
            &input(
                &p,
                1,
                ProviderEvent::FailedWith(ExecutionFailureClass::Policy),
            ),
        )
        .await
        .unwrap();
    let status = f
        .store
        .execution_status(&f.owner, &f.conversation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(status.phase, ExecutionPhase::Failed);
    assert_eq!(status.failure.unwrap().class, ExecutionFailureClass::Policy);
    let models = status.models.unwrap();
    assert_eq!(models.resolved_model.as_deref(), Some("refusing-model"));
    assert_eq!(models.actual_model, None);
}
