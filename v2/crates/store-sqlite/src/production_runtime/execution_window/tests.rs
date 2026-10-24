use super::*;
use crate::production_runtime::tests::{self as fixtures, Case};
use orkestr_v2_application::IntakeStore;
use orkestr_v2_contracts::MessageInput;
use std::time::Duration;

pub(super) async fn input(f: &Case, key: &str) -> ExecutionWindowRequest {
    let receipt = f
        .store
        .admit(
            &f.owner,
            &f.conversation,
            &MessageInput {
                client_message_id: key.into(),
                text: "synthetic window input".into(),
            },
        )
        .await
        .unwrap()
        .receipt;
    ExecutionWindowRequest {
        request_key: format!("window:{key}"),
        input_message_id: receipt.message_id,
        input_event_id: receipt.event_id,
        input_request_key: key.into(),
        expected_generation: 0,
        window_id: None,
        predecessor_window_id: None,
    }
}
pub(super) async fn browser(f: &Case) -> String {
    let token = "browser:synthetic-browser-window".to_string();
    f.store.save_session(&token, &f.owner).await.unwrap();
    token
}
#[tokio::test]
async fn receipt_replay_current_auth_changed_semantics_and_reopen() {
    let f = fixtures::setup().await;
    let browser = browser(&f).await;
    let request = input(&f, "window-source").await;
    let a = f
        .store
        .admit_execution_window_authenticated(&browser, &f.conversation, &request)
        .await
        .unwrap();
    assert_eq!(a.status.generation, 1);
    assert_eq!(a.status.expires_at_ms - a.status.opened_at_ms, 900_000);
    let reopened = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let replay = reopened
        .admit_execution_window_authenticated(&browser, &f.conversation, &request)
        .await
        .unwrap();
    assert!(replay.duplicate);
    assert_eq!(a.status, replay.status);
    let mut changed = request.clone();
    changed.input_request_key = "changed".into();
    assert!(matches!(
        reopened
            .admit_execution_window_authenticated(&browser, &f.conversation, &changed)
            .await,
        Err(RuntimeStoreError::Conflict)
    ));
    sqlx::query("DELETE FROM auth_sessions WHERE token_hash=?")
        .bind(crate::digest(&browser))
        .execute(&f.store.pool)
        .await
        .unwrap();
    assert!(matches!(
        reopened
            .admit_execution_window_authenticated(&browser, &f.conversation, &request)
            .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn opening_blocks_claim_active_selects_only_admitted_and_retiring_fences() {
    let f = fixtures::setup().await;
    let browser = browser(&f).await;
    let binding = fixtures::ready(&f).await;
    let old = input(&f, "older-unadmitted").await;
    let request = input(&f, "explicitly-admitted").await;
    let a = f
        .store
        .admit_execution_window_authenticated(&browser, &f.conversation, &request)
        .await
        .unwrap();
    let grant = f
        .handle
        .issue_execution_window_credential(
            &f.token,
            a.status.window_id,
            1,
            "synthetic-boot",
            a.status.expires_at_ms,
            &"a".repeat(64),
        )
        .await
        .unwrap();
    assert!(f
        .handle
        .issue_execution_window_credential(
            &f.token,
            a.status.window_id,
            1,
            "synthetic-boot",
            a.status.expires_at_ms,
            &"a".repeat(64)
        )
        .await
        .is_err());
    assert!(f
        .store
        .authorize_supervisor(
            grant.credential(),
            fixtures::config(ProductionTakeover::First)
        )
        .await
        .is_err());
    let bound = f
        .handle
        .bind_execution_window(&f.token, &grant)
        .await
        .unwrap();
    assert!(bound
        .claim_next(
            &f.owner,
            &f.conversation,
            &binding.session_id,
            Duration::from_secs(30)
        )
        .await
        .is_err());
    bound
        .activate_execution_window(grant.credential(), a.status.window_id, 1, "synthetic-boot")
        .await
        .unwrap();
    let claim = bound
        .claim_next(
            &f.owner,
            &f.conversation,
            &binding.session_id,
            Duration::from_secs(30),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claim.event_id, request.input_event_id);
    assert_ne!(claim.event_id, old.input_event_id);
    let mut tx = f.store.pool.begin().await.unwrap();
    assert!(bound
        .execution_window_input_in(&mut tx, &f.conversation, Some(&old.input_event_id))
        .await
        .is_err());
    drop(tx);
    let mut additional = input(&f, "next-explicit").await;
    additional.expected_generation = 1;
    additional.window_id = Some(a.status.window_id);
    let added = f
        .store
        .admit_execution_window_authenticated(&browser, &f.conversation, &additional)
        .await
        .unwrap();
    assert_eq!(added.status.expires_at_ms, a.status.expires_at_ms);
    assert_eq!(added.status.generation, 1);
    let run = bound
        .admit_run(
            &claim,
            &binding.session_id,
            binding.generation,
            "window-run",
        )
        .await
        .unwrap();
    let DispatchClaimResult::Reserved(reservation) = bound
        .claim_provider_dispatch(&run, "window-dispatch")
        .await
        .unwrap()
    else {
        panic!("fresh reservation required")
    };
    let ExecutionConsumption::Dispatch(cap) = bound.consume_execution(&reservation).await.unwrap()
    else {
        panic!("fresh consume required")
    };
    assert_eq!(
        bound
            .with_execution_fence(cap.provider(), || Ok::<_, ()>(7))
            .unwrap(),
        Ok(7)
    );
    bound
        .begin_execution_window_retirement(
            grant.credential(),
            a.status.window_id,
            1,
            "synthetic-boot",
        )
        .await
        .unwrap();
    let called = std::sync::atomic::AtomicBool::new(false);
    assert!(bound
        .with_execution_fence(cap.provider(), || {
            called.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok::<_, ()>(())
        })
        .is_err());
    assert!(!called.load(std::sync::atomic::Ordering::SeqCst));
    assert!(bound
        .claim_next(
            &f.owner,
            &f.conversation,
            &binding.session_id,
            Duration::from_secs(30)
        )
        .await
        .is_err());
    assert!(bound
        .activate_execution_window(grant.credential(), a.status.window_id, 1, "synthetic-boot")
        .await
        .is_err());
    assert!(bound
        .retire_execution_window(
            grant.credential(),
            a.status.window_id,
            1,
            "synthetic-boot",
            &RunId(Uuid::new_v4())
        )
        .await
        .is_err());
    sqlx::query("DELETE FROM auth_sessions WHERE token_hash=?")
        .bind(crate::digest(grant.credential()))
        .execute(&f.store.pool)
        .await
        .unwrap();
    assert!(bound
        .mark_execution_window_uncertain(
            grant.credential(),
            a.status.window_id,
            1,
            "synthetic-boot"
        )
        .await
        .is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn current_owner_issues_after_proven_retirement_despite_expired_old_machine() {
    let f = fixtures::setup().await;
    let browser = browser(&f).await;
    let (p, decision) = crate::production_runtime::acceptance_tests::proposal(&f).await;
    f.store
        .accept_execution_authenticated(&browser, &f.conversation, &decision)
        .await
        .unwrap();
    f.handle
        .retire_terminal_supervisor(&f.token, &p.run.run_id)
        .await
        .unwrap();
    sqlx::query("UPDATE auth_sessions SET expires_at=unixepoch()-1 WHERE token_hash=?")
        .bind(crate::digest(&f.token))
        .execute(&f.store.pool)
        .await
        .unwrap();
    let request = input(&f, "idle-owner-next").await;
    let a = f
        .store
        .admit_execution_window_authenticated(&browser, &f.conversation, &request)
        .await
        .unwrap();
    assert!(f
        .handle
        .issue_execution_window_credential(
            &f.token,
            a.status.window_id,
            1,
            "idle-boot",
            a.status.expires_at_ms,
            &"b".repeat(64)
        )
        .await
        .is_err());
    let grant = f
        .handle
        .issue_idle_execution_window_credential_authenticated(
            &browser,
            a.status.window_id,
            1,
            "idle-boot",
            a.status.expires_at_ms,
            &"b".repeat(64),
        )
        .await
        .unwrap();
    assert_eq!(grant.window_id(), a.status.window_id);
    assert!(f
        .handle
        .issue_idle_execution_window_credential_authenticated(
            &browser,
            a.status.window_id,
            1,
            "idle-boot",
            a.status.expires_at_ms,
            &"b".repeat(64)
        )
        .await
        .is_err());
}

#[tokio::test]
async fn expired_unresolved_machine_cannot_be_healed_by_current_owner() {
    let f = fixtures::setup().await;
    let browser = browser(&f).await;
    fixtures::ready(&f).await;
    let request = input(&f, "unresolved-owner-next").await;
    let a = f
        .store
        .admit_execution_window_authenticated(&browser, &f.conversation, &request)
        .await
        .unwrap();
    sqlx::query("UPDATE auth_sessions SET expires_at=unixepoch()-1 WHERE token_hash=?")
        .bind(crate::digest(&f.token))
        .execute(&f.store.pool)
        .await
        .unwrap();
    assert!(f
        .handle
        .issue_idle_execution_window_credential_authenticated(
            &browser,
            a.status.window_id,
            1,
            "idle-boot",
            a.status.expires_at_ms,
            &"b".repeat(64)
        )
        .await
        .is_err());
    let issued: i64 =
        sqlx::query_scalar("SELECT credential_issued FROM execution_windows WHERE id=?")
            .bind(a.status.window_id.to_string())
            .fetch_one(&f.store.pool)
            .await
            .unwrap();
    assert_eq!(issued, 0);
}

#[tokio::test]
async fn cold_reopen_loses_private_authority_and_only_reconciles() {
    let f = fixtures::setup().await;
    let browser = browser(&f).await;
    fixtures::ready(&f).await;
    let request = input(&f, "cold-start-source").await;
    let a = f
        .store
        .admit_execution_window_authenticated(&browser, &f.conversation, &request)
        .await
        .unwrap();
    let grant = f
        .handle
        .issue_execution_window_credential(
            &f.token,
            a.status.window_id,
            1,
            "cold-boot",
            a.status.expires_at_ms,
            &"c".repeat(64),
        )
        .await
        .unwrap();
    let bound = f
        .handle
        .bind_execution_window(&f.token, &grant)
        .await
        .unwrap();
    bound
        .activate_execution_window(grant.credential(), a.status.window_id, 1, "cold-boot")
        .await
        .unwrap();
    let path = f.root.join("core.sqlite3");
    let conversation = f.conversation.clone();
    let old_token = f.token.clone();
    drop(grant);
    drop(bound);
    drop(f);
    let fresh = Store::open(&path).await.unwrap();
    let observed = fresh
        .reconcile_execution_window_authenticated(&browser, &conversation, a.status.window_id, 1)
        .await
        .unwrap();
    assert_eq!(observed.state, ExecutionWindowState::ReconciliationRequired);
    assert!(fresh
        .authorize_supervisor(&old_token, fixtures::config(ProductionTakeover::First))
        .await
        .is_err());
    assert!(fresh
        .issue_idle_execution_window_credential_authenticated(
            &browser,
            a.status.window_id,
            1,
            "new-boot",
            a.status.expires_at_ms,
            &"d".repeat(64)
        )
        .await
        .is_err());
    let mut next = request.clone();
    next.request_key = "new-window-after-crash".into();
    next.expected_generation = 1;
    next.predecessor_window_id = Some(a.status.window_id);
    assert!(fresh
        .admit_execution_window_authenticated(&browser, &conversation, &next)
        .await
        .is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn first_window_issues_before_native_readiness_and_activates_last() {
    let f = fixtures::setup().await;
    let browser = browser(&f).await;
    let binding = f
        .handle
        .ensure_role_bindings(&f.owner, &f.conversation)
        .await
        .unwrap()
        .deep;
    let readiness: i64 = sqlx::query_scalar("SELECT count(*) FROM production_readiness")
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(readiness, 0);
    let request = input(&f, "first-window-ordering").await;
    let a = f
        .store
        .admit_execution_window_authenticated(&browser, &f.conversation, &request)
        .await
        .unwrap();
    let grant = f
        .handle
        .issue_execution_window_credential(
            &f.token,
            a.status.window_id,
            1,
            "first-boot",
            a.status.expires_at_ms,
            &"a".repeat(64),
        )
        .await
        .unwrap();
    assert!(f
        .store
        .authorize_supervisor(
            grant.credential(),
            fixtures::config(ProductionTakeover::First)
        )
        .await
        .is_err());
    let bound = f
        .handle
        .bind_execution_window(&f.token, &grant)
        .await
        .unwrap();
    assert!(bound
        .claim_next(
            &f.owner,
            &f.conversation,
            &binding.session_id,
            Duration::from_secs(30)
        )
        .await
        .is_err());
    let metadata = bound.authorize_session_metadata(&binding).await.unwrap();
    assert_eq!(
        bound
            .with_metadata_fence(&metadata, || Ok::<_, ()>("setup-only"))
            .unwrap(),
        Ok("setup-only")
    );
    let transition = bound
        .confirm_metadata_session(
            metadata,
            NativeSessionConfirmation {
                session_id: binding.session_id.clone(),
                expected_generation: binding.generation,
                native_session_id: "synthetic-first-window-native".into(),
                protocol_version: "codex-rpc-1".into(),
                source_event_key: "first-window-ready".into(),
            },
        )
        .await
        .unwrap();
    assert!(bound
        .claim_next(
            &f.owner,
            &f.conversation,
            &binding.session_id,
            Duration::from_secs(30)
        )
        .await
        .is_err());
    bound
        .activate_execution_window(grant.credential(), a.status.window_id, 1, "first-boot")
        .await
        .unwrap();
    let claim = bound
        .claim_next(
            &f.owner,
            &f.conversation,
            &transition.binding().session_id,
            Duration::from_secs(30),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claim.event_id, request.input_event_id);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn opener_extends_an_active_window_forward_up_to_its_ceiling() {
    let f = fixtures::setup().await;
    let browser = browser(&f).await;
    let _binding = fixtures::ready(&f).await;
    let request = input(&f, "long-turn").await;
    let a = f
        .store
        .admit_execution_window_authenticated(&browser, &f.conversation, &request)
        .await
        .unwrap();
    let grant = f
        .handle
        .issue_execution_window_credential(
            &f.token,
            a.status.window_id,
            1,
            "synthetic-boot",
            a.status.expires_at_ms,
            &"a".repeat(64),
        )
        .await
        .unwrap();
    let bound = f
        .handle
        .bind_execution_window(&f.token, &grant)
        .await
        .unwrap();
    let opened = a.status.opened_at_ms;
    let extend = |work: i64, cap: i64, boot: &'static str| {
        let bound = bound.clone();
        let credential = grant.credential().to_owned();
        let window = a.status.window_id;
        async move {
            bound
                .extend_execution_window(&credential, window, 1, boot, work, cap)
                .await
        }
    };
    // Not active yet: an opening window is never extended.
    assert!(extend(opened + 1_470_000, 3_600_000, "synthetic-boot")
        .await
        .is_err());
    bound
        .activate_execution_window(grant.credential(), a.status.window_id, 1, "synthetic-boot")
        .await
        .unwrap();
    let status = extend(opened + 1_470_000, 3_600_000, "synthetic-boot")
        .await
        .unwrap();
    assert_eq!(
        (status.work_deadline_ms, status.expires_at_ms),
        (opened + 1_470_000, opened + 1_500_000)
    );
    // Smaller or equal requests replay the current deadline; never shorten it.
    let status = extend(opened + 900_000, 3_600_000, "synthetic-boot")
        .await
        .unwrap();
    assert_eq!(status.work_deadline_ms, opened + 1_470_000);
    // Past this window's ceiling, a foreign boot or an invalid ceiling: refused.
    assert!(extend(opened + 3_570_001, 3_600_000, "synthetic-boot")
        .await
        .is_err());
    assert!(extend(opened + 2_000_000, 3_600_000, "other-boot")
        .await
        .is_err());
    assert!(extend(opened + 2_000_000, 14_400_001, "synthetic-boot")
        .await
        .is_err());
    // A Worker lease and admission see the extended deadline in Core.
    let current = f
        .store
        .execution_window_status_authenticated(&browser, &f.conversation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current.work_deadline_ms, opened + 1_470_000);
    bound
        .begin_execution_window_retirement(
            grant.credential(),
            a.status.window_id,
            1,
            "synthetic-boot",
        )
        .await
        .unwrap();
    assert!(extend(opened + 2_000_000, 3_600_000, "synthetic-boot")
        .await
        .is_err());
}
