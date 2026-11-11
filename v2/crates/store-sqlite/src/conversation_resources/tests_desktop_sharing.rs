//! Owner-level desk sharing (ORK-773): off is exactly the per-chat binding,
//! on lets any bound chat reserve any desk, and one holder per desk stays.
use super::tests_settings::Case;
use super::*;
use orkestr_v2_contracts::*;

fn bind(revision: i64, thread: &str, slugs: &[String]) -> DesktopBindingRequest {
    DesktopBindingRequest {
        expected_revision: revision,
        v1_thread_id: thread.into(),
        desktop_slugs: slugs.to_vec(),
    }
}
fn grant(index: i64) -> V1LeaseGrant {
    V1LeaseGrant {
        lease_id: format!("shared-desk:owner:v1-thread:{index}"),
        fencing_token: format!("fence-shared-{index:04}"),
        fencing_version: index,
        expires_at: Some("2026-11-10T13:00:00.000Z".into()),
    }
}
fn share(revision: i64, on: bool) -> DesktopSharingRequest {
    DesktopSharingRequest {
        expected_revision: revision,
        share_all_desks: on,
    }
}

#[tokio::test]
async fn sharing_reaches_every_desk_beyond_the_binding_and_off_restores_it() {
    let case = Case::new().await;
    let (t, o, c) = (&case.token, &case.owner, &case.conversation);
    // A full binding: the per-chat list cannot name a 17th desk.
    let bound: Vec<String> = (0..DESKTOP_SLUGS_MAX)
        .map(|i| format!("desk-{i}"))
        .collect();
    case.store
        .bind_desktops(t, o, c, &bind(0, "v1-thread", &bound))
        .await
        .unwrap();
    let issued = case.store.issue_desktop_grant(t, o, c).await.unwrap();
    let worker = DesktopCaller::Grant(&issued.grant);

    // Off (the default): exactly the binding.
    let off = case.store.desktop_sharing(t, o).await.unwrap();
    assert_eq!(off, DesktopSharing::default_off());
    assert!(
        !case
            .store
            .desktop_leases(worker, c)
            .await
            .unwrap()
            .shared_with_all_chats
    );
    assert_eq!(
        case.store
            .prepare_desktop_acquire(worker, c, "desk-16")
            .await
            .unwrap_err(),
        ResourceError::Conflict("desktop_not_granted")
    );
    let own = case
        .store
        .prepare_desktop_acquire(worker, c, "desk-0")
        .await
        .unwrap();
    assert!(!own.shared, "a bound desk is authorized by the binding");

    // On: every desk, also beyond 16, through the same grant and thread.
    let on = case
        .store
        .set_desktop_sharing(t, o, &share(0, true))
        .await
        .unwrap();
    assert!(on.share_all_desks && on.revision == 1);
    assert!(
        case.store
            .desktop_leases(worker, c)
            .await
            .unwrap()
            .shared_with_all_chats
    );
    for index in 16..20 {
        let slug = format!("desk-{index}");
        let prepared = case
            .store
            .prepare_desktop_acquire(worker, c, &slug)
            .await
            .unwrap();
        assert!(prepared.shared);
        assert_eq!(prepared.v1_thread_id, "v1-thread");
        let granted = case
            .store
            .record_desktop_acquired(worker, c, &prepared, &slug, &grant(index), 600_000)
            .await
            .unwrap();
        assert_eq!(granted.lease.v1_thread_id, "v1-thread");
    }
    assert_eq!(
        case.count("SELECT count(*) FROM desktop_leases WHERE state='active'")
            .await,
        4
    );

    // One holder per desk, unchanged: the same chat must heartbeat, another
    // chat (a binding with no slugs at all) is refused, and a racing record
    // loses.
    let other = case.conversation("thread-only").await;
    case.store
        .bind_desktops(t, o, &other, &bind(0, "v1-other", &[]))
        .await
        .unwrap();
    let owner = DesktopCaller::Owner {
        credential: t,
        owner: o,
    };
    assert_eq!(
        case.store
            .prepare_desktop_acquire(worker, c, "desk-16")
            .await
            .unwrap_err(),
        ResourceError::Conflict("desktop_lease_held")
    );
    assert_eq!(
        case.store
            .prepare_desktop_acquire(owner, &other, "desk-16")
            .await
            .unwrap_err(),
        ResourceError::Conflict("desktop_leased")
    );
    let free = case
        .store
        .prepare_desktop_acquire(owner, &other, "desk-30")
        .await
        .unwrap();
    let racing = case
        .store
        .prepare_desktop_acquire(worker, c, "desk-30")
        .await
        .unwrap();
    case.store
        .record_desktop_acquired(owner, &other, &free, "desk-30", &grant(30), 600_000)
        .await
        .unwrap();
    assert_eq!(
        case.store
            .record_desktop_acquired(worker, c, &racing, "desk-30", &grant(31), 600_000)
            .await
            .unwrap_err(),
        ResourceError::Conflict("desktop_leased")
    );
    // A grant still reaches only its own conversation.
    assert_eq!(
        case.store
            .prepare_desktop_acquire(worker, &other, "desk-31")
            .await
            .unwrap_err(),
        ResourceError::Unauthorized
    );

    // Off is refused while a chat holds a desk its binding does not list.
    assert_eq!(
        case.store
            .set_desktop_sharing(t, o, &share(0, false))
            .await
            .unwrap_err(),
        ResourceError::Conflict("desktop_sharing_revision_mismatch")
    );
    assert_eq!(
        case.store
            .set_desktop_sharing(t, o, &share(1, false))
            .await
            .unwrap_err(),
        ResourceError::Conflict("desktop_shared_lease_active")
    );
    assert!(
        case.store
            .desktop_sharing(t, o)
            .await
            .unwrap()
            .share_all_desks
    );
    for (conversation, caller, index) in [
        (c, worker, 16),
        (c, worker, 17),
        (c, worker, 18),
        (&other, owner, 30),
    ] {
        let slug = format!("desk-{index}");
        let fence = case
            .store
            .desktop_fence(caller, conversation, &slug, &grant(index).fencing_token)
            .await
            .unwrap();
        case.store
            .end_desktop_lease(
                caller,
                conversation,
                &fence,
                DesktopLeaseState::Released,
                "done",
            )
            .await
            .unwrap();
    }
    // A row past its V2 expiry does not hold the switch: it ends as expired.
    sqlx::query(
        "UPDATE desktop_leases SET expires_at_ms=1 WHERE state='active' AND desktop_slug='desk-19'",
    )
    .execute(&case.store.pool)
    .await
    .unwrap();
    // A lease on one of the chat's own desks does not hold it either.
    let mine = case
        .store
        .prepare_desktop_acquire(worker, c, "desk-1")
        .await
        .unwrap();
    case.store
        .record_desktop_acquired(worker, c, &mine, "desk-1", &grant(1), 600_000)
        .await
        .unwrap();
    let off = case
        .store
        .set_desktop_sharing(t, o, &share(1, false))
        .await
        .unwrap();
    assert!(!off.share_all_desks && off.revision == 2);
    assert_eq!(
        case.count("SELECT count(*) FROM desktop_leases WHERE desktop_slug='desk-19' AND state='lost' AND end_reason='expired'")
            .await,
        1
    );
    assert_eq!(
        case.count("SELECT count(*) FROM desktop_leases WHERE state='active'")
            .await,
        1
    );

    // Off again: exactly the per-chat binding, for both chats.
    assert_eq!(
        case.store
            .prepare_desktop_acquire(worker, c, "desk-16")
            .await
            .unwrap_err(),
        ResourceError::Conflict("desktop_not_granted")
    );
    assert_eq!(
        case.store
            .prepare_desktop_acquire(owner, &other, "desk-2")
            .await
            .unwrap_err(),
        ResourceError::Conflict("desktop_not_granted")
    );
    assert!(
        !case
            .store
            .prepare_desktop_acquire(worker, c, "desk-2")
            .await
            .unwrap()
            .shared
    );
    case.finish().await;
}

#[tokio::test]
async fn an_acquire_prepared_under_sharing_is_not_recorded_after_it_is_off() {
    let case = Case::new().await;
    let (t, o, c) = (&case.token, &case.owner, &case.conversation);
    let owner = DesktopCaller::Owner {
        credential: t,
        owner: o,
    };
    case.store
        .bind_desktops(t, o, c, &bind(0, "v1-thread", &["desk-0".into()]))
        .await
        .unwrap();
    case.store
        .set_desktop_sharing(t, o, &share(0, true))
        .await
        .unwrap();
    let prepared = case
        .store
        .prepare_desktop_acquire(owner, c, "desk-5")
        .await
        .unwrap();
    // Nothing is held yet, so off succeeds while V1 is still being asked.
    case.store
        .set_desktop_sharing(t, o, &share(1, false))
        .await
        .unwrap();
    assert_eq!(
        case.store
            .record_desktop_acquired(owner, c, &prepared, "desk-5", &grant(5), 600_000)
            .await
            .unwrap_err(),
        ResourceError::Conflict("desktop_sharing_changed")
    );
    assert_eq!(case.count("SELECT count(*) FROM desktop_leases").await, 0);
    // The switch is the owner's: another credential reads and changes nothing.
    assert_eq!(
        case.store.desktop_sharing("wrong", o).await.unwrap_err(),
        ResourceError::Unauthorized
    );
    assert_eq!(
        case.store
            .set_desktop_sharing("wrong", o, &share(2, true))
            .await
            .unwrap_err(),
        ResourceError::Unauthorized
    );
    assert_eq!(
        case.store
            .set_desktop_sharing(t, o, &share(-1, true))
            .await
            .unwrap_err(),
        ResourceError::Invalid
    );
    assert!(
        !case
            .store
            .desktop_sharing(t, o)
            .await
            .unwrap()
            .share_all_desks
    );
    case.finish().await;
}
