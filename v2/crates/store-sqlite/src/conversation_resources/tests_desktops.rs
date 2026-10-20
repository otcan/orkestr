use super::tests_settings::Case;
use super::*;
use orkestr_v2_contracts::*;

fn bind(revision: i64, thread: &str, slugs: &[&str]) -> DesktopBindingRequest {
    DesktopBindingRequest {
        expected_revision: revision,
        v1_thread_id: thread.into(),
        desktop_slugs: slugs.iter().map(|s| s.to_string()).collect(),
    }
}
fn grant(token: &str, version: i64) -> V1LeaseGrant {
    V1LeaseGrant {
        lease_id: format!("sales-nav:owner:v1-thread:{version}"),
        fencing_token: token.into(),
        fencing_version: version,
        expires_at: Some("2026-10-20T13:00:00.000Z".into()),
    }
}
const TOKEN_A: &str = "fence-aaaa-aaaa-0001";
const TOKEN_B: &str = "fence-aaaa-aaaa-0002";

#[tokio::test]
async fn binding_grant_and_fenced_lease_lifecycle() {
    let case = Case::new().await;
    let (t, o, c) = (&case.token, &case.owner, &case.conversation);
    let owner = DesktopCaller::Owner {
        credential: t,
        owner: o,
    };
    // No binding: nothing can be acquired and no grant can be issued.
    assert_eq!(
        case.store
            .prepare_desktop_acquire(owner, c, "sales-nav")
            .await
            .unwrap_err(),
        ResourceError::Conflict("desktop_binding_required")
    );
    assert_eq!(
        case.store.issue_desktop_grant(t, o, c).await.unwrap_err(),
        ResourceError::Conflict("desktop_binding_required")
    );
    let binding = case
        .store
        .bind_desktops(t, o, c, &bind(0, "v1-thread", &["sales-nav", "gmail"]))
        .await
        .unwrap();
    assert_eq!((binding.revision, binding.grant_issued), (1, false));
    let issued = case.store.issue_desktop_grant(t, o, c).await.unwrap();
    assert_eq!(issued.grant.len(), 64);
    assert!(issued.binding.grant_issued);
    let worker = DesktopCaller::Grant(&issued.grant);

    assert_eq!(
        case.store
            .prepare_desktop_acquire(worker, c, "linkedin")
            .await
            .unwrap_err(),
        ResourceError::Conflict("desktop_not_granted")
    );
    let prepared = case
        .store
        .prepare_desktop_acquire(worker, c, "sales-nav")
        .await
        .unwrap();
    assert_eq!(prepared.v1_thread_id, "v1-thread");
    let granted = case
        .store
        .record_desktop_acquired(
            worker,
            c,
            &prepared,
            "sales-nav",
            &grant(TOKEN_A, 7),
            600_000,
        )
        .await
        .unwrap();
    assert_eq!(granted.fencing_token, TOKEN_A);
    assert_eq!(
        (granted.lease.state, granted.lease.fencing_version),
        (DesktopLeaseState::Active, 7)
    );
    // Raw token is never stored.
    assert_eq!(
        case.count(&format!(
            "SELECT count(*) FROM desktop_leases WHERE token_hash='{TOKEN_A}'"
        ))
        .await,
        0
    );
    // Second acquire by the same conversation must heartbeat instead.
    assert_eq!(
        case.store
            .prepare_desktop_acquire(worker, c, "sales-nav")
            .await
            .unwrap_err(),
        ResourceError::Conflict("desktop_lease_held")
    );
    // Wrong token is fenced; right token heartbeats and extends.
    assert_eq!(
        case.store
            .desktop_fence(worker, c, "sales-nav", TOKEN_B)
            .await
            .unwrap_err(),
        ResourceError::Conflict("desktop_fence_rejected")
    );
    let fence = case
        .store
        .desktop_fence(worker, c, "sales-nav", TOKEN_A)
        .await
        .unwrap();
    assert_eq!(
        (fence.v1_thread_id.as_str(), fence.fencing_version),
        ("v1-thread", 7)
    );
    let beat = case
        .store
        .record_desktop_heartbeat(
            worker,
            c,
            &fence,
            Some((Some("2026-10-20T14:00:00.000Z".into()), 600_000)),
        )
        .await
        .unwrap();
    assert_eq!(beat.expires_at.as_deref(), Some("2026-10-20T14:00:00.000Z"));
    // Binding cannot drop a leased slug or move threads while leased.
    assert_eq!(
        case.store
            .bind_desktops(t, o, c, &bind(1, "v1-thread", &["gmail"]))
            .await
            .unwrap_err(),
        ResourceError::Conflict("desktop_lease_active")
    );
    assert_eq!(
        case.store
            .bind_desktops(t, o, c, &bind(1, "v1-other", &["sales-nav"]))
            .await
            .unwrap_err(),
        ResourceError::Conflict("desktop_lease_active")
    );
    let released = case
        .store
        .end_desktop_lease(worker, c, &fence, DesktopLeaseState::Released, "done")
        .await
        .unwrap();
    assert_eq!(released.state, DesktopLeaseState::Released);
    // An ended lease cannot be heartbeat or released again with the old fence.
    assert_eq!(
        case.store
            .record_desktop_heartbeat(worker, c, &fence, None)
            .await
            .unwrap_err(),
        ResourceError::Conflict("desktop_fence_rejected")
    );
    assert_eq!(
        case.store
            .desktop_fence(worker, c, "sales-nav", TOKEN_A)
            .await
            .unwrap_err(),
        ResourceError::NotFound
    );
    // Rotating the grant invalidates the old one; revoking removes it.
    let rotated = case.store.issue_desktop_grant(t, o, c).await.unwrap();
    assert_eq!(rotated.binding.grant_generation, 2);
    assert_eq!(
        case.store.desktop_leases(worker, c).await.unwrap_err(),
        ResourceError::Unauthorized
    );
    let list = case
        .store
        .desktop_leases(DesktopCaller::Grant(&rotated.grant), c)
        .await
        .unwrap();
    assert_eq!(list.leases.len(), 1);
    case.store.revoke_desktop_grant(t, o, c).await.unwrap();
    assert_eq!(
        case.store
            .desktop_leases(DesktopCaller::Grant(&rotated.grant), c)
            .await
            .unwrap_err(),
        ResourceError::Unauthorized
    );
    case.finish().await;
}

#[tokio::test]
async fn conversations_cannot_share_a_thread_or_a_desktop() {
    let case = Case::new().await;
    let (t, o, c) = (&case.token, &case.owner, &case.conversation);
    let other = case.conversation("worker-desk").await;
    let owner = DesktopCaller::Owner {
        credential: t,
        owner: o,
    };
    case.store
        .bind_desktops(t, o, c, &bind(0, "v1-a", &["sales-nav"]))
        .await
        .unwrap();
    assert_eq!(
        case.store
            .bind_desktops(t, o, &other, &bind(0, "v1-a", &["sales-nav"]))
            .await
            .unwrap_err(),
        ResourceError::Conflict("v1_thread_already_bound")
    );
    case.store
        .bind_desktops(t, o, &other, &bind(0, "v1-b", &["sales-nav"]))
        .await
        .unwrap();
    let a = case
        .store
        .prepare_desktop_acquire(owner, c, "sales-nav")
        .await
        .unwrap();
    let b = case
        .store
        .prepare_desktop_acquire(owner, &other, "sales-nav")
        .await
        .unwrap();
    case.store
        .record_desktop_acquired(owner, c, &a, "sales-nav", &grant(TOKEN_A, 1), 600_000)
        .await
        .unwrap();
    // A racing record for the same slug in another conversation is refused.
    assert_eq!(
        case.store
            .record_desktop_acquired(owner, &other, &b, "sales-nav", &grant(TOKEN_B, 2), 600_000)
            .await
            .unwrap_err(),
        ResourceError::Conflict("desktop_leased")
    );
    assert_eq!(
        case.store
            .prepare_desktop_acquire(owner, &other, "sales-nav")
            .await
            .unwrap_err(),
        ResourceError::Conflict("desktop_leased")
    );
    // A grant of one conversation cannot touch another conversation.
    let issued = case.store.issue_desktop_grant(t, o, &other).await.unwrap();
    assert_eq!(
        case.store
            .desktop_fence(DesktopCaller::Grant(&issued.grant), c, "sales-nav", TOKEN_A)
            .await
            .unwrap_err(),
        ResourceError::Unauthorized
    );
    // Once the V2-observed expiry passes, the slug can be prepared again.
    sqlx::query("UPDATE desktop_leases SET expires_at_ms=1 WHERE state='active'")
        .execute(&case.store.pool)
        .await
        .unwrap();
    case.store
        .prepare_desktop_acquire(owner, &other, "sales-nav")
        .await
        .unwrap();
    assert_eq!(
        case.count(
            "SELECT count(*) FROM desktop_leases WHERE state='lost' AND end_reason='expired'"
        )
        .await,
        1
    );
    // Ended rows are immutable.
    assert!(
        sqlx::query("UPDATE desktop_leases SET state='active',ended_at_ms=NULL")
            .execute(&case.store.pool)
            .await
            .is_err()
    );
    case.finish().await;
}
