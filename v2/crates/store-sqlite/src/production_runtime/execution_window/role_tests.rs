//! Independent auxiliary-role boundary checks. No native/provider invocation.
use super::tests::{browser, input};
use super::*;
use crate::production_runtime::{observation_tests::input as observation, tests as fixtures};
use orkestr_v2_application::runtime::RoleBindings;
use orkestr_v2_contracts::SessionId;
use std::time::Duration;

struct Window {
    f: fixtures::Case,
    browser_credential: String,
    bound: Store,
    credential: ExecutionWindowCredential,
    status: ExecutionWindowStatus,
    roles: RoleBindings,
    old: ExecutionWindowRequest,
    source: ExecutionWindowRequest,
}

impl Window {
    async fn open() -> Self {
        let f = fixtures::setup().await;
        let browser = browser(&f).await;
        let mut roles = f
            .handle
            .ensure_role_bindings(&f.owner, &f.conversation)
            .await
            .unwrap();
        roles.deep = fixtures::ready(&f).await;
        let old = input(&f, "old-unadmitted-role-input").await;
        let source = input(&f, "explicit-window-role-input").await;
        let status = f
            .store
            .admit_execution_window_authenticated(&browser, &f.conversation, &source)
            .await
            .unwrap()
            .status;
        let credential = f
            .handle
            .issue_execution_window_credential(
                &f.token,
                status.window_id,
                1,
                "role-test-boot",
                status.expires_at_ms,
                &"a".repeat(64),
            )
            .await
            .unwrap();
        let bound = f
            .handle
            .bind_execution_window(&f.token, &credential)
            .await
            .unwrap();
        Self {
            browser_credential: browser,
            f,
            bound,
            credential,
            status,
            roles,
            old,
            source,
        }
    }

    async fn activate(&self) {
        self.bound
            .activate_execution_window(
                self.credential.credential(),
                self.status.window_id,
                1,
                "role-test-boot",
            )
            .await
            .unwrap();
    }

    async fn ready_fast(&self) -> Binding {
        let grant = self
            .bound
            .authorize_session_metadata(&self.roles.fast)
            .await
            .unwrap();
        self.bound
            .confirm_metadata_session(
                grant,
                NativeSessionConfirmation {
                    session_id: self.roles.fast.session_id.clone(),
                    expected_generation: self.roles.fast.generation,
                    native_session_id: "synthetic-window-fast".into(),
                    protocol_version: "codex-rpc-1".into(),
                    source_event_key: "window-fast-ready".into(),
                },
            )
            .await
            .unwrap()
            .binding()
            .clone()
    }

    async fn consume(&self, admission: &RunAdmissionResult) -> ConsumedProviderDispatch {
        let DispatchClaimResult::Reserved(reserved) = self
            .bound
            .claim_provider_dispatch(
                admission,
                &format!("role-dispatch:{}", admission.provider.run.run_id),
            )
            .await
            .unwrap()
        else {
            panic!("fresh reservation")
        };
        let ExecutionConsumption::Dispatch(dispatch) =
            self.bound.consume_execution(&reserved).await.unwrap()
        else {
            panic!("fresh dispatch")
        };
        *dispatch
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fast_setup_is_not_inference_and_only_admitted_input_is_selected() {
    let w = Window::open().await;
    let fast = w.ready_fast().await;
    assert!(w
        .bound
        .next_fast_source(w.credential.credential(), &w.f.conversation, 0)
        .await
        .is_err());
    w.activate().await;
    let source = w
        .bound
        .next_fast_source(w.credential.credential(), &w.f.conversation, 0)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(source.event_id, w.source.input_event_id);
    assert_ne!(source.event_id, w.old.input_event_id);
    let make = |message, event| crate::production_runtime::FastAdmissionInput {
        source_message_id: message,
        source_event_id: event,
        fast_binding_id: fast.session_id.clone(),
        expected_binding_generation: fast.generation,
        request_key: "window-fast-run".into(),
    };
    let before = fixtures::snapshot(&w.f.store).await;
    assert!(w
        .bound
        .admit_fast(
            w.credential.credential(),
            &make(w.old.input_message_id.clone(), w.old.input_event_id.clone())
        )
        .await
        .is_err());
    assert_eq!(before, fixtures::snapshot(&w.f.store).await);
    let admission = w
        .bound
        .admit_fast(
            w.credential.credential(),
            &make(source.message_id, source.event_id),
        )
        .await
        .unwrap();
    let dispatch = w.consume(&admission).await;
    assert_eq!(dispatch.provider().run.role, Role::Fast);
    assert!(dispatch.launch().is_none(), "Fast keeps its pinned launch");
    assert_eq!(
        w.bound
            .with_execution_fence(dispatch.provider(), || Ok::<_, ()>(7))
            .unwrap(),
        Ok(7)
    );
    let deep = w
        .bound
        .claim_next(
            &w.f.owner,
            &w.f.conversation,
            &w.roles.deep.session_id,
            Duration::from_secs(30),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        deep.event_id, w.source.input_event_id,
        "Fast must not claim the Deep inbox"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fast_metadata_rejects_wrong_binding_and_does_not_outlive_window() {
    let w = Window::open().await;
    for mutation in 0..4 {
        let mut forged = w.roles.fast.clone();
        match mutation {
            0 => forged.role = Role::Deep,
            1 => forged.session_id = SessionId(Uuid::new_v4()),
            2 => forged.conversation_id = ConversationId(Uuid::new_v4()),
            _ => forged.parent_session_id = Some(w.roles.deep.session_id.clone()),
        }
        let before = fixtures::snapshot(&w.f.store).await;
        assert!(w.bound.authorize_session_metadata(&forged).await.is_err());
        assert_eq!(before, fixtures::snapshot(&w.f.store).await);
    }
    let grant = w
        .bound
        .authorize_session_metadata(&w.roles.fast)
        .await
        .unwrap();
    sqlx::query("UPDATE execution_windows SET opened_at_ms=opened_at_ms-870001,work_deadline_ms=work_deadline_ms-870001,expires_at_ms=expires_at_ms-870001 WHERE id=?")
        .bind(w.status.window_id.to_string()).execute(&w.f.store.pool).await.unwrap();
    let mut called = false;
    assert!(w
        .bound
        .with_metadata_fence(&grant, || {
            called = true;
            Ok::<_, ()>(())
        })
        .is_err());
    assert!(!called);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn worker_metadata_requires_exact_live_consumed_deep_parent() {
    let w = Window::open().await;
    w.activate().await;
    let claim = w
        .bound
        .claim_next(
            &w.f.owner,
            &w.f.conversation,
            &w.roles.deep.session_id,
            Duration::from_secs(30),
        )
        .await
        .unwrap()
        .unwrap();
    let admission = w
        .bound
        .admit_run(
            &claim,
            &w.roles.deep.session_id,
            w.roles.deep.generation,
            "window-parent-run",
        )
        .await
        .unwrap();
    let dispatch = w.consume(&admission).await;
    let parent = dispatch.provider();
    w.bound
        .append_provider_event(
            &w.f.owner,
            parent,
            &observation(parent, 1, ProviderEvent::Started),
        )
        .await
        .unwrap();
    let binding = w
        .bound
        .create_worker_binding(
            &w.f.owner,
            &w.f.conversation,
            Some(&parent.binding.session_id),
            "window-worker",
        )
        .await
        .unwrap();
    assert!(w.bound.authorize_session_metadata(&binding).await.is_err());
    assert!(w
        .bound
        .authorize_worker_metadata(w.credential.credential(), &RunId(Uuid::new_v4()), &binding)
        .await
        .is_err());
    let grant = w
        .bound
        .authorize_worker_metadata(w.credential.credential(), &parent.run.run_id, &binding)
        .await
        .unwrap();
    assert_eq!(
        w.bound
            .with_metadata_fence(&grant, || Ok::<_, ()>(1))
            .unwrap(),
        Ok(1)
    );
    w.bound
        .append_provider_event(
            &w.f.owner,
            parent,
            &observation(parent, 2, ProviderEvent::Failed),
        )
        .await
        .unwrap();
    let before = fixtures::snapshot(&w.f.store).await;
    let mut called = false;
    assert!(w
        .bound
        .with_metadata_fence(&grant, || {
            called = true;
            Ok::<_, ()>(())
        })
        .is_err());
    assert!(!called);
    assert_eq!(before, fixtures::snapshot(&w.f.store).await);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fast_cleanup_uses_remaining_margin_but_never_extends_hard_deadline() {
    let w = Window::open().await;
    let fast = w.ready_fast().await;
    w.activate().await;
    let admission = w
        .bound
        .admit_fast(
            w.credential.credential(),
            &FastAdmissionInput {
                source_message_id: w.source.input_message_id.clone(),
                source_event_id: w.source.input_event_id.clone(),
                fast_binding_id: fast.session_id,
                expected_binding_generation: fast.generation,
                request_key: "cleanup-fast".into(),
            },
        )
        .await
        .unwrap();
    let dispatch = w.consume(&admission).await;
    let provider = dispatch.provider();
    w.bound
        .append_provider_event(
            &w.f.owner,
            provider,
            &observation(provider, 1, ProviderEvent::Started),
        )
        .await
        .unwrap();
    let cancel = w
        .bound
        .request_cancel(&w.f.owner, &provider.run.run_id, "stop-fast-margin")
        .await
        .unwrap();
    let mut cleanup = provider.clone();
    cleanup.run = cancel.new_fenced_admission;
    sqlx::query("UPDATE execution_windows SET opened_at_ms=opened_at_ms-870001,work_deadline_ms=work_deadline_ms-870001,expires_at_ms=expires_at_ms-870001 WHERE id=?")
        .bind(w.status.window_id.to_string()).execute(&w.f.store.pool).await.unwrap();
    assert_eq!(
        w.bound
            .with_cancellation_fence(&cleanup, || Ok::<_, ()>(1))
            .unwrap(),
        Ok(1)
    );
    sqlx::query("UPDATE execution_windows SET opened_at_ms=opened_at_ms-30000,work_deadline_ms=work_deadline_ms-30000,expires_at_ms=expires_at_ms-30000 WHERE id=?")
        .bind(w.status.window_id.to_string()).execute(&w.f.store.pool).await.unwrap();
    let mut called = false;
    assert!(w
        .bound
        .with_cancellation_fence(&cleanup, || {
            called = true;
            Ok::<_, ()>(())
        })
        .is_err());
    assert!(!called);
}

#[path = "role_resume_tests.rs"]
mod resume;

#[path = "stranded_tests.rs"]
mod stranded;

#[path = "launch_tests.rs"]
mod launch;

#[path = "role_fast_acceptance_tests.rs"]
mod fast_acceptance;

#[path = "bounded_fast_tests.rs"]
mod bounded_fast;
