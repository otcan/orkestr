//! Public predecessor CAS after real expiry; no process-private handle recovery.
use super::process::{spawn, Owned};
use super::process_oracle::{self as oracle, Rows};
use super::*;
use orkestr_v2_contracts::{EventId, MessageId, SessionId};
use orkestr_v2_store_sqlite::ProductionDispatchState;
use serde_json::{json, Value};
use std::{
    path::Path,
    time::{Instant, SystemTime, UNIX_EPOCH},
};
const TOKEN: &str = "abababababababababababababababababababababababababababababababab";
pub(super) fn envelope(p: &ProviderAdmission) -> Value {
    json!({"run": {
        "owner":p.run.owner_id.to_string(), "conversation":p.run.conversation_id.to_string(),
        "run":p.run.run_id.to_string(), "session":p.run.session_id.to_string(), "role":p.run.role,
        "native":p.run.native_session_id, "lease_generation":p.run.lease_generation,
        "dispatch_fence":p.run.dispatch_fence, "attempt":p.run.attempt,
        "deadline":p.run.lease_deadline_ms, "purpose":format!("{:?}", p.run.purpose)
    }, "binding": {
        "owner":p.binding.owner_id.to_string(), "conversation":p.binding.conversation_id.to_string(),
        "session":p.binding.session_id.to_string(), "role":p.binding.role,
        "provider":format!("{:?}",p.binding.provider_kind), "native":p.binding.native_session_id,
        "parent":p.binding.parent_session_id.as_ref().map(ToString::to_string),
        "generation":p.binding.generation, "state":p.binding.state
    }})
}
fn input(base: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(base.join("input.json")).unwrap()).unwrap()
}
fn claim(v: &Value) -> InboxClaim {
    let id = |field: &str| Uuid::parse_str(v[field].as_str().unwrap()).unwrap();
    InboxClaim {
        owner_id: OwnerId(id("owner")),
        conversation_id: ConversationId(id("conversation")),
        message_id: MessageId(id("message")),
        event_id: EventId(id("event")),
        consumer_session_id: SessionId(id("session")),
        scope_sequence: v["sequence"].as_i64().unwrap(),
        claim_generation: v["claim_generation"].as_u64().unwrap(),
        lease_deadline_ms: v["claim_deadline"].as_i64().unwrap(),
    }
}
fn expected_envelope(input: &Value, run: &Value) -> Value {
    json!({"run": {"owner":input["owner"], "conversation":input["conversation"], "run":run["id"],
        "session":input["session"], "role":"deep", "native":"synthetic-independent-native",
        "lease_generation":1,"dispatch_fence":run["dispatch_fence"],"attempt":1,
        "deadline":run["lease_deadline_ms"],"purpose":"Execution"},
        "binding":{"owner":input["owner"],"conversation":input["conversation"],"session":input["session"],
        "role":"deep","provider":"Codex","native":"synthetic-independent-native","parent":null,
        "generation":input["binding_generation"],"state":"ready"}})
}
pub(super) async fn recover(base: &Path, stage: &str) {
    let root = PathBuf::from(std::fs::read_to_string(base.join("case-path")).unwrap());
    let v = input(base);
    let c = claim(&v);
    let killed: Rows =
        serde_json::from_slice(&std::fs::read(base.join("killed.json")).unwrap()).unwrap();
    assert!(
        killed == oracle::rows(&root).await,
        "fresh exec must see exact post-kill rows before Store::open"
    );
    let store = Store::open(&root.join("core.sqlite3")).await.unwrap();
    assert!(
        killed == oracle::rows(&root).await,
        "ordinary reopen cannot change ledger"
    );
    let predecessor = std::fs::read_to_string(base.join("predecessor")).unwrap();
    let mut cfg = config();
    cfg.takeover = ProductionTakeover::ExpiredPredecessor {
        incarnation_id: predecessor,
    };
    let h = store.authorize_supervisor(TOKEN, cfg).await.unwrap();
    let taken = oracle::rows(&root).await;
    oracle::takeover_delta(&killed, &taken);
    let replay = h
        .admit_run(
            &c,
            &c.consumer_session_id,
            v["binding_generation"].as_u64().unwrap(),
            "independent-crash:1",
        )
        .await;
    if killed["production_runs"].is_empty() {
        assert!(matches!(
            replay,
            Err(RuntimeStoreError::Expired | RuntimeStoreError::StaleLease)
        ));
        assert!(h
            .inspect_production_attempt(&c.conversation_id, "independent-crash:1")
            .await
            .unwrap()
            .is_none());
    } else {
        let replay = replay.unwrap();
        assert_eq!(
            replay.disposition,
            AdmissionDisposition::ReconciliationRequired
        );
        assert_eq!(replay.run_state, RunState::Blocked);
        assert!(
            replay.candidate_key.is_none(),
            "no replacement candidate after exec"
        );
        let original = expected_envelope(&v, &killed["production_runs"][0]);
        assert!(
            envelope(&replay.provider) == original,
            "immutable historical admission envelope"
        );
        if base.join("receipt.json").exists() {
            let delivered: Value =
                serde_json::from_slice(&std::fs::read(base.join("receipt.json")).unwrap()).unwrap();
            assert!(
                delivered == original,
                "previously delivered receipt envelope unchanged after takeover"
            );
        } else {
            assert_eq!(stage, "admit-after-commit", "only admission reply was lost");
        }
        assert!(matches!(
            h.claim_provider_dispatch(&replay, "replacement:1").await,
            Err(RuntimeStoreError::Fenced)
        ));
        let inspected = h
            .inspect_production_attempt(&c.conversation_id, "independent-crash:1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(inspected.run_id, replay.provider.run.run_id);
        assert!(inspected.blocked && inspected.inbox_acknowledged);
        assert!(!inspected.candidate_verifier_present && !inspected.reservation_verifier_present);
        let unknown = stage == "consume-after-commit";
        assert_eq!(
            inspected.dispatch,
            if unknown {
                ProductionDispatchState::DeliveryUnknown
            } else {
                ProductionDispatchState::Quarantined
            }
        );
        let scope = h
            .inspect_production_scope(&c.conversation_id)
            .await
            .unwrap();
        assert_eq!(
            (
                scope.attempts,
                scope.acknowledged,
                scope.reservations,
                scope.delivery_unknown,
                scope.quarantined
            ),
            (1, 1, 0, i64::from(unknown), i64::from(!unknown))
        );
        let mut changed = c.clone();
        changed.lease_deadline_ms += 1;
        assert!(matches!(
            h.admit_run(
                &changed,
                &c.consumer_session_id,
                v["binding_generation"].as_u64().unwrap(),
                "independent-crash:1"
            )
            .await,
            Err(RuntimeStoreError::Conflict)
        ));
        assert!(matches!(
            h.admit_run(
                &c,
                &c.consumer_session_id,
                v["binding_generation"].as_u64().unwrap(),
                "new-attempt:1"
            )
            .await,
            Err(RuntimeStoreError::Busy)
        ));
    }
    assert!(
        taken == oracle::rows(&root).await,
        "replay/refusals must change no rows or cursor"
    );
    store.revoke_session(TOKEN).await.unwrap();
    assert!(matches!(
        h.admit_run(
            &c,
            &c.consumer_session_id,
            v["binding_generation"].as_u64().unwrap(),
            "independent-crash:1"
        )
        .await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert!(matches!(
        h.inspect_production_scope(&c.conversation_id).await,
        Err(RuntimeStoreError::Unauthorized)
    ));
    assert!(
        taken == oracle::rows(&root).await,
        "auth revocation does not mutate execution ledger"
    );
    store.close().await;
}
async fn wait(child: &mut Owned) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            assert!(status.success(), "owned probe exited unsuccessfully");
            return;
        }
        assert!(Instant::now() < deadline, "owned probe timed out");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}
#[tokio::test]
async fn independent_real_expiry_new_exec_exact_commit_and_historical_replay() {
    use std::os::unix::process::ExitStatusExt;
    let suite = PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap())
        .join(Uuid::new_v4().to_string());
    std::fs::create_dir_all(&suite).unwrap();
    let started = Instant::now();
    let mut cases = Vec::new();
    let mut latest = 0;
    for stage in [
        "admit-before-ack",
        "admit-before-commit",
        "admit-after-commit",
        "reserve-before-commit",
        "reserve-after-commit",
        "consume-before-commit",
        "consume-after-commit",
    ] {
        let base = suite.join(stage);
        std::fs::create_dir(&base).unwrap();
        let mut child = spawn(&base, "prepare", stage);
        let deadline = Instant::now() + Duration::from_secs(20);
        while !base.join("marker").exists() {
            assert!(child.0.try_wait().unwrap().is_none());
            assert!(Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(std::fs::read_to_string(base.join("marker")).unwrap(), stage);
        child.0.kill().unwrap();
        assert_eq!(child.0.wait().unwrap().signal(), Some(9));
        let root = PathBuf::from(std::fs::read_to_string(base.join("case-path")).unwrap());
        let before: Rows =
            serde_json::from_slice(&std::fs::read(base.join("oracle-before.json")).unwrap())
                .unwrap();
        let killed = oracle::rows(&root).await;
        oracle::checkpoint_delta(&before, &killed, stage, &input(&base));
        latest = latest.max(
            killed["production_supervisors"][0]["lease_deadline_ms"]
                .as_i64()
                .unwrap(),
        );
        std::fs::write(
            base.join("killed.json"),
            serde_json::to_vec(&killed).unwrap(),
        )
        .unwrap();
        let mut busy = spawn(&base, "busy", stage);
        wait(&mut busy).await;
        assert!(
            killed == oracle::rows(&root).await,
            "fresh busy probe must preserve exact rows"
        );
        cases.push((base, stage));
    }
    // Actual issued deadlines only; no SQL mutation, clock setter or private handle.
    while SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis()
        <= (latest as u128 + 100)
    {
        assert!(
            started.elapsed() < Duration::from_secs(80),
            "real expiry bound exceeded"
        );
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    for (base, stage) in cases {
        let mut child = spawn(&base, "successor", stage);
        wait(&mut child).await;
    }
    std::fs::remove_dir_all(suite).unwrap();
}
