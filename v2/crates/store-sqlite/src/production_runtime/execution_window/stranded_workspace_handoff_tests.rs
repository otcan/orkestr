//! Deterministic expiry exactly after the durable takeover, before any effect.
use super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn post_takeover_expiry_rolls_back_then_rechecks_root_once() {
    lapsed_restart_with_fault(false, HandoffCase::Expire).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn second_post_takeover_expiry_is_not_retried() {
    lapsed_restart_with_fault(false, HandoffCase::ExpireTwice).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn borrowed_guard_cannot_refresh_after_takeover() {
    lapsed_restart_with_fault(false, HandoffCase::Borrowed).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn begun_effect_cannot_refresh_after_takeover() {
    lapsed_restart_with_fault(false, HandoffCase::Effect).await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn changed_policy_is_not_blessed_by_fresh_root_check() {
    lapsed_restart_with_fault(false, HandoffCase::Drift).await;
}
