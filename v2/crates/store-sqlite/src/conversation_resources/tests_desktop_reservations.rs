//! Desk reservations in Core: every recorded acquire is a step of its chat's
//! task, a reservation refuses every other grant caller inside the lease's
//! own transaction, and only the chat's own claim ever changes.
use super::tests_settings::Case;
use super::*;
use orkestr_v2_contracts::*;

const TTL: u64 = 120_000;

struct Chat {
    id: ConversationId,
    grant: String,
}
impl Chat {
    fn caller(&self) -> DesktopCaller<'_> {
        DesktopCaller::Grant(&self.grant)
    }
}

async fn chat(case: &Case, name: &str, thread: &str) -> Chat {
    let (t, o) = (&case.token, &case.owner);
    let id = case.conversation(name).await;
    let request = DesktopBindingRequest {
        expected_revision: 0,
        v1_thread_id: thread.into(),
        desktop_slugs: Vec::new(),
    };
    case.store.bind_desktops(t, o, &id, &request).await.unwrap();
    let grant = case
        .store
        .issue_desktop_grant(t, o, &id)
        .await
        .unwrap()
        .grant;
    Chat { id, grant }
}

async fn share_all(case: &Case) {
    let on = DesktopSharingRequest {
        expected_revision: 0,
        share_all_desks: true,
    };
    case.store
        .set_desktop_sharing(&case.token, &case.owner, &on)
        .await
        .unwrap();
}

fn grant(desk: &str, version: i64) -> V1LeaseGrant {
    V1LeaseGrant {
        lease_id: format!("{desk}:owner:thread:{version}"),
        fencing_token: format!("fence-{desk}-{version:04}"),
        fencing_version: version,
        expires_at: None,
    }
}

/// One tool step through the store, as the server runs it: prepare, (V1),
/// record, then release.
async fn step(case: &Case, chat: &Chat, desk: &str, version: i64) -> Result<()> {
    let prepared = case
        .store
        .prepare_desktop_acquire(chat.caller(), &chat.id, desk)
        .await?;
    let v1 = grant(desk, version);
    case.store
        .record_desktop_acquired(chat.caller(), &chat.id, &prepared, desk, &v1, TTL)
        .await?;
    let fence = case
        .store
        .desktop_fence(chat.caller(), &chat.id, desk, &v1.fencing_token)
        .await
        .unwrap();
    case.store
        .end_desktop_lease(
            chat.caller(),
            &chat.id,
            &fence,
            DesktopLeaseState::Released,
            "hold_finished",
        )
        .await
        .unwrap();
    Ok(())
}

/// A system job's step on `pa` (a sync or renewal): prepared as a system
/// step, recorded, released.
async fn system_step(case: &Case, chat: &Chat, version: i64) -> Result<()> {
    let mut prepared = case
        .store
        .prepare_desktop_acquire(chat.caller(), &chat.id, "pa")
        .await?;
    prepared.system_step = true;
    let v1 = grant("pa", version);
    case.store
        .record_desktop_acquired(chat.caller(), &chat.id, &prepared, "pa", &v1, TTL)
        .await?;
    let fence = case
        .store
        .desktop_fence(chat.caller(), &chat.id, "pa", &v1.fencing_token)
        .await?;
    case.store
        .end_desktop_lease(
            chat.caller(),
            &chat.id,
            &fence,
            DesktopLeaseState::Released,
            "done",
        )
        .await
        .map(|_| ())
}

async fn verdict(case: &Case, chat: &Chat, desk: &str) -> DesktopReservationState {
    case.store
        .desktop_reservation(chat.caller(), &chat.id, desk)
        .await
        .unwrap()
}

async fn change(
    case: &Case,
    chat: &Chat,
    desk: &str,
    r: DesktopReservationRequest,
) -> Result<DesktopReservationState> {
    case.store
        .change_desktop_reservation(chat.caller(), &chat.id, desk, &r)
        .await
}

fn request(op: DesktopReservationOp, minutes: Option<i64>) -> DesktopReservationRequest {
    DesktopReservationRequest {
        op,
        minutes,
        until_ms: None,
    }
}

/// Ends every reservation's time, as if its end had passed.
async fn expire_all(case: &Case) {
    sqlx::query("UPDATE desktop_reservations SET since_ms=1,until_ms=2")
        .execute(&case.store.pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn a_step_keeps_the_desk_for_its_chat_and_refuses_every_other_grant_inside_the_record() {
    let case = Case::new().await;
    share_all(&case).await;
    let first = chat(&case, "first-chat", "v1-first").await;
    let second = chat(&case, "second-chat", "v1-second").await;
    let before = now_ms();
    step(&case, &first, "desk-a", 1).await.unwrap();
    // The lease is released; the task keeps the desk 10 minutes past the release.
    let state = verdict(&case, &first, "desk-a").await;
    assert_eq!(state.verdict, DeskVerdict::Allowed);
    let task = state.reservation.unwrap();
    assert_eq!((task.kind, task.mine), (DesktopReservationKind::Task, true));
    assert!(task.until_ms >= before + DESK_TASK_GRACE_MS);
    assert!(
        task.until_ms <= now_ms() + DESK_TASK_GRACE_MS,
        "cut back on release"
    );
    let state = verdict(&case, &second, "desk-a").await;
    assert_eq!(state.verdict, DeskVerdict::DeskBusy);
    let holder = state.holder.unwrap();
    assert_eq!(
        (
            holder.kind,
            holder.chat.as_deref(),
            holder.mine,
            holder.conversation_id
        ),
        (
            DesktopReservationKind::Task,
            Some("first-chat"),
            false,
            None
        )
    );
    // A grant caller that never asks for the reservation (any tool) is still
    // refused where the lease is recorded, and no lease row is left.
    assert_eq!(
        step(&case, &second, "desk-a", 2).await.unwrap_err(),
        ResourceError::Conflict("desk_busy")
    );
    assert_eq!(
        case.count(
            "SELECT count(*) FROM desktop_leases WHERE desktop_slug='desk-a' AND fencing_version=2"
        )
        .await,
        0
    );
    // The first chat's next step goes on and extends its own task.
    step(&case, &first, "desk-a", 3).await.unwrap();
    step(&case, &second, "desk-b", 4).await.unwrap();
    // Expired: nothing has to end it.
    expire_all(&case).await;
    step(&case, &second, "desk-a", 5).await.unwrap();
    assert_eq!(
        verdict(&case, &first, "desk-a").await.verdict,
        DeskVerdict::DeskBusy
    );
    case.finish().await;
}

#[tokio::test]
async fn a_renewing_heartbeat_extends_the_task_with_the_lease() {
    let case = Case::new().await;
    share_all(&case).await;
    let first = chat(&case, "first-chat", "v1-first").await;
    let prepared = case
        .store
        .prepare_desktop_acquire(first.caller(), &first.id, "desk-a")
        .await
        .unwrap();
    let v1 = grant("desk-a", 1);
    case.store
        .record_desktop_acquired(first.caller(), &first.id, &prepared, "desk-a", &v1, TTL)
        .await
        .unwrap();
    let before = verdict(&case, &first, "desk-a")
        .await
        .reservation
        .unwrap()
        .until_ms;
    let fence = case
        .store
        .desktop_fence(first.caller(), &first.id, "desk-a", &v1.fencing_token)
        .await
        .unwrap();
    let hour = 3_600_000;
    case.store
        .record_desktop_heartbeat(first.caller(), &first.id, &fence, Some((None, hour)))
        .await
        .unwrap();
    let after = verdict(&case, &first, "desk-a")
        .await
        .reservation
        .unwrap()
        .until_ms;
    assert!(
        after >= before + hour as i64 - TTL as i64,
        "{before} -> {after}"
    );
    // A plain heartbeat leaves the task as it is.
    case.store
        .record_desktop_heartbeat(first.caller(), &first.id, &fence, None)
        .await
        .unwrap();
    assert_eq!(
        verdict(&case, &first, "desk-a")
            .await
            .reservation
            .unwrap()
            .until_ms,
        after
    );
    // A heartbeat never makes a task: with the task gone (the owner freed the
    // desk), the next renewing heartbeat leaves the desk unreserved.
    let (t, o) = (&case.token, &case.owner);
    assert_eq!(
        case.store
            .clear_desktop_reservations(t, o, "desk-a")
            .await
            .unwrap(),
        1
    );
    case.store
        .record_desktop_heartbeat(first.caller(), &first.id, &fence, Some((None, hour)))
        .await
        .unwrap();
    assert!(verdict(&case, &first, "desk-a").await.reservation.is_none());
    case.finish().await;
}

#[tokio::test]
async fn while_the_owner_views_a_heartbeat_extends_nothing_and_a_release_cuts_the_task_back() {
    let case = Case::new().await;
    share_all(&case).await;
    let (t, o) = (&case.token, &case.owner);
    let first = chat(&case, "first-chat", "v1-first").await;
    let prepared = case
        .store
        .prepare_desktop_acquire(first.caller(), &first.id, "desk-a")
        .await
        .unwrap();
    let v1 = grant("desk-a", 1);
    // An eight-hour lease reserves the desk at most two hours ahead.
    let eight_hours = 8 * 3_600_000;
    case.store
        .record_desktop_acquired(
            first.caller(),
            &first.id,
            &prepared,
            "desk-a",
            &v1,
            eight_hours,
        )
        .await
        .unwrap();
    let made = verdict(&case, &first, "desk-a").await.reservation.unwrap();
    assert!(
        made.until_ms <= now_ms() + DESK_LEASE_TASK_MAX_MS,
        "{made:?}"
    );
    case.store
        .record_owner_viewer(t, o, "desk-a", (Some(now_ms() + 30 * 60_000), None), None)
        .await
        .unwrap();
    let fence = case
        .store
        .desktop_fence(first.caller(), &first.id, "desk-a", &v1.fencing_token)
        .await
        .unwrap();
    case.store
        .record_desktop_heartbeat(first.caller(), &first.id, &fence, Some((None, eight_hours)))
        .await
        .unwrap();
    assert_eq!(
        verdict(&case, &first, "desk-a")
            .await
            .reservation
            .unwrap()
            .until_ms,
        made.until_ms,
        "no extension while the owner views the desk"
    );
    // The step ends: 10 minutes from now, not the lease's planned end.
    case.store
        .end_desktop_lease(
            first.caller(),
            &first.id,
            &fence,
            DesktopLeaseState::Released,
            "done",
        )
        .await
        .unwrap();
    let cut = verdict(&case, &first, "desk-a").await.reservation.unwrap();
    assert!(
        cut.until_ms <= now_ms() + DESK_TASK_GRACE_MS && cut.until_ms < made.until_ms,
        "{cut:?}"
    );
    case.finish().await;
}

#[tokio::test]
async fn a_system_step_is_refused_like_any_step_but_leaves_no_task() {
    let case = Case::new().await;
    share_all(&case).await;
    let first = chat(&case, "first-chat", "v1-first").await;
    let second = chat(&case, "second-chat", "v1-second").await;
    system_step(&case, &first, 1).await.unwrap();
    assert!(verdict(&case, &first, "pa").await.reservation.is_none());
    // A chat's real step reserves the desk; another chat's system step is refused.
    step(&case, &first, "pa", 2).await.unwrap();
    let held = verdict(&case, &first, "pa").await.reservation.unwrap();
    assert_eq!(
        system_step(&case, &second, 3).await.unwrap_err(),
        ResourceError::Conflict("desk_busy")
    );
    // The chat's own system step neither extends nor (on release) lengthens its task.
    system_step(&case, &first, 4).await.unwrap();
    assert!(
        verdict(&case, &first, "pa")
            .await
            .reservation
            .unwrap()
            .until_ms
            <= held.until_ms
    );
    case.finish().await;
}

#[tokio::test]
async fn reserve_handoff_handback_and_unreserve_change_only_the_chats_own_claim() {
    use DesktopReservationOp::*;
    let case = Case::new().await;
    let first = chat(&case, "first-chat", "v1-first").await;
    let second = chat(&case, "second-chat", "v1-second").await;
    // Without sharing, only a bound desk can be reserved.
    assert_eq!(
        change(&case, &first, "desk-a", request(Reserve, None))
            .await
            .unwrap_err(),
        ResourceError::Conflict("desktop_not_granted")
    );
    share_all(&case).await;
    assert_eq!(
        change(&case, &first, "desk-a", request(Reserve, Some(121)))
            .await
            .unwrap_err(),
        ResourceError::Invalid
    );
    let now = now_ms();
    let state = change(&case, &first, "desk-a", request(Reserve, Some(90)))
        .await
        .unwrap();
    let held = state.reservation.unwrap();
    assert_eq!((held.kind, held.mine), (DesktopReservationKind::Task, true));
    assert!(held.until_ms >= now + 90 * 60_000);
    // Another chat can neither reserve, hand over nor end it.
    for r in [
        request(Reserve, None),
        request(Handoff, None),
        request(Unreserve, None),
    ] {
        assert!(matches!(
            change(&case, &second, "desk-a", r).await.unwrap_err(),
            ResourceError::Conflict("desk_busy" | "reservation_of_another_chat")
        ));
    }
    assert_eq!(
        change(&case, &second, "desk-a", request(Handback, None))
            .await
            .unwrap_err(),
        ResourceError::Conflict("no_handoff_of_this_chat")
    );
    // A step of the holder keeps a longer reserve's end.
    step(&case, &first, "desk-a", 1).await.unwrap();
    assert_eq!(
        verdict(&case, &first, "desk-a")
            .await
            .reservation
            .unwrap()
            .until_ms,
        held.until_ms
    );
    // Handoff: nobody acts, the handing chat neither, until its handback.
    let until = now_ms() + 30 * 60_000;
    let handoff = DesktopReservationRequest {
        op: Handoff,
        minutes: None,
        until_ms: Some(until),
    };
    let state = change(&case, &first, "desk-a", handoff).await.unwrap();
    assert_eq!(state.verdict, DeskVerdict::DeskHandedToOwner);
    assert_eq!(state.reservation.as_ref().map(|r| r.until_ms), Some(until));
    assert_eq!(
        step(&case, &first, "desk-a", 2).await.unwrap_err(),
        ResourceError::Conflict("desk_handed_to_owner")
    );
    assert_eq!(
        step(&case, &second, "desk-a", 3).await.unwrap_err(),
        ResourceError::Conflict("desk_busy")
    );
    assert_eq!(
        change(&case, &first, "desk-a", request(Reserve, None))
            .await
            .unwrap_err(),
        ResourceError::Conflict("desk_handed_to_owner")
    );
    let state = change(&case, &first, "desk-a", request(Handback, None))
        .await
        .unwrap();
    assert_eq!(state.verdict, DeskVerdict::Allowed);
    assert_eq!(
        state.reservation.unwrap().kind,
        DesktopReservationKind::Task
    );
    step(&case, &first, "desk-a", 4).await.unwrap();
    assert_eq!(
        step(&case, &second, "desk-a", 5).await.unwrap_err(),
        ResourceError::Conflict("desk_busy")
    );
    // Unreserve ends it at once.
    let state = change(&case, &first, "desk-a", request(Unreserve, None))
        .await
        .unwrap();
    assert!(state.reservation.is_none());
    step(&case, &second, "desk-a", 6).await.unwrap();
    case.finish().await;
}

#[tokio::test]
async fn while_the_owner_views_a_desk_only_the_chat_holding_its_task_goes_on() {
    use DesktopReservationOp::*;
    let case = Case::new().await;
    share_all(&case).await;
    let (t, o) = (&case.token, &case.owner);
    let first = chat(&case, "first-chat", "v1-first").await;
    let second = chat(&case, "second-chat", "v1-second").await;
    step(&case, &first, "desk-a", 1).await.unwrap();
    let window = case
        .store
        .record_owner_viewer(
            t,
            o,
            "desk-a",
            (Some(now_ms() + 20 * 60_000), Some("share-1")),
            None,
        )
        .await
        .unwrap();
    assert_eq!(window.kind, DesktopReservationKind::OwnerViewer);
    // A longer window is kept when the owner opens it again.
    case.store
        .record_owner_viewer(t, o, "desk-a", (Some(now_ms() + 60_000), None), None)
        .await
        .unwrap();
    let state = verdict(&case, &second, "desk-a").await;
    assert_eq!(
        state.owner_viewer.as_ref().map(|v| v.until_ms),
        Some(window.until_ms)
    );
    step(&case, &first, "desk-a", 2).await.unwrap();
    // Without a task the desk is the owner's while the window lasts.
    case.store
        .change_desktop_reservation(
            first.caller(),
            &first.id,
            "desk-a",
            &request(Unreserve, None),
        )
        .await
        .unwrap();
    for chat in [&first, &second] {
        let state = verdict(&case, chat, "desk-a").await;
        assert_eq!(
            (state.verdict, state.holder.map(|h| h.kind)),
            (
                DeskVerdict::DeskBusy,
                Some(DesktopReservationKind::OwnerViewer)
            )
        );
        assert_eq!(
            step(&case, chat, "desk-a", 3).await.unwrap_err(),
            ResourceError::Conflict("desk_busy")
        );
        // Reserving is no way around the owner.
        assert_eq!(
            case.store
                .change_desktop_reservation(
                    chat.caller(),
                    &chat.id,
                    "desk-a",
                    &request(Reserve, None)
                )
                .await
                .unwrap_err(),
            ResourceError::Conflict("desk_busy")
        );
    }
    // Nor is a handoff: its handback would make the chat the holder while the
    // owner views the desk.
    assert_eq!(
        case.store
            .change_desktop_reservation(
                second.caller(),
                &second.id,
                "desk-a",
                &request(Handoff, Some(5)),
            )
            .await
            .unwrap_err(),
        ResourceError::Conflict("desk_busy")
    );
    assert_eq!(
        case.store
            .change_desktop_reservation(
                second.caller(),
                &second.id,
                "desk-a",
                &request(Handback, None)
            )
            .await
            .unwrap_err(),
        ResourceError::Conflict("no_handoff_of_this_chat")
    );
    // Free desk ends a chat's claim only (none here); a chat's grant cannot.
    assert_eq!(
        case.store
            .clear_desktop_reservations("wrong", o, "desk-a")
            .await
            .unwrap_err(),
        ResourceError::Unauthorized
    );
    assert_eq!(
        case.store
            .clear_desktop_reservations(t, o, "desk-a")
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        step(&case, &second, "desk-a", 4).await.unwrap_err(),
        ResourceError::Conflict("desk_busy"),
        "the owner's viewing stays"
    );
    // End viewing drops the window and names the V1 link to revoke.
    assert_eq!(
        case.store.end_owner_viewer(t, o, "desk-a").await.unwrap(),
        (true, Some("share-1".to_string()))
    );
    assert_eq!(
        case.store.end_owner_viewer(t, o, "desk-a").await.unwrap(),
        (false, None)
    );
    step(&case, &second, "desk-a", 5).await.unwrap();
    // Opened from a chat, the owner watches that chat: it goes on, others
    // do not; a desk another chat holds stays that chat's.
    expire_all(&case).await;
    let window = case
        .store
        .record_owner_viewer(t, o, "desk-a", (None, None), Some(&first.id))
        .await
        .unwrap();
    let state = verdict(&case, &first, "desk-a").await;
    assert_eq!(state.verdict, DeskVerdict::Allowed);
    assert_eq!(
        state.reservation.map(|r| (r.kind, r.until_ms)),
        Some((DesktopReservationKind::Task, window.until_ms))
    );
    assert_eq!(
        verdict(&case, &second, "desk-a").await.verdict,
        DeskVerdict::DeskBusy
    );
    step(&case, &first, "desk-a", 6).await.unwrap();
    case.store
        .record_owner_viewer(t, o, "desk-a", (None, None), Some(&second.id))
        .await
        .unwrap();
    let state = verdict(&case, &second, "desk-a").await;
    assert_eq!(
        (state.verdict, state.holder.and_then(|h| h.chat)),
        (DeskVerdict::DeskBusy, Some("first-chat".to_string()))
    );
    case.finish().await;
}

#[tokio::test]
async fn free_desks_leave_out_held_viewed_and_leased_desks_and_ids_stay_with_the_owner() {
    let case = Case::new().await;
    share_all(&case).await;
    let (t, o) = (&case.token, &case.owner);
    let first = chat(&case, "first-chat", "v1-first").await;
    let second = chat(&case, "second-chat", "v1-second").await;
    for (index, desk) in ["desk-b", "desk-c", "desk-d", "desk-e"].iter().enumerate() {
        step(&case, &second, desk, index as i64 + 1).await.unwrap();
    }
    expire_all(&case).await;
    step(&case, &first, "desk-c", 10).await.unwrap(); // the first chat's task
    case.store
        .record_owner_viewer(t, o, "desk-d", (None, None), None)
        .await
        .unwrap();
    let prepared = case
        .store
        .prepare_desktop_acquire(first.caller(), &first.id, "desk-e")
        .await
        .unwrap();
    case.store
        .record_desktop_acquired(
            first.caller(),
            &first.id,
            &prepared,
            "desk-e",
            &grant("desk-e", 11),
            TTL,
        )
        .await
        .unwrap(); // active lease of the first chat
    let (thread, free) = case
        .store
        .desktop_free_candidates(
            second.caller(),
            &second.id,
            "desk-a",
            &["desk-z".into(), "desk-b".into()],
        )
        .await
        .unwrap();
    assert_eq!(thread, "v1-second");
    assert_eq!(free, vec!["desk-z".to_string(), "desk-b".to_string()]);
    // Its own task never makes a desk unfree for the chat itself.
    let (_, free) = case
        .store
        .desktop_free_candidates(
            first.caller(),
            &first.id,
            "desk-a",
            &["desk-c".into(), "desk-d".into()],
        )
        .await
        .unwrap();
    assert_eq!(free, vec!["desk-c".to_string()]);
    // A chat sees names only; the owner sees whose it is.
    let seen = case
        .store
        .desktop_reservations(second.caller(), &second.id)
        .await
        .unwrap();
    assert_eq!(seen.reservations.len(), 3);
    assert!(seen
        .reservations
        .iter()
        .all(|r| r.conversation_id.is_none() && !r.mine));
    let owner = case.store.owner_desktop_reservations(t, o).await.unwrap();
    let task = owner.iter().find(|r| r.desk == "desk-c").unwrap();
    assert_eq!(
        (
            task.kind,
            task.conversation_id.as_ref(),
            task.chat.as_deref()
        ),
        (
            DesktopReservationKind::Task,
            Some(&first.id),
            Some("first-chat")
        )
    );
    assert!(owner.iter().any(|r| r.desk == "desk-d"
        && r.kind == DesktopReservationKind::OwnerViewer
        && r.chat.is_none()));
    assert_eq!(
        case.store
            .owner_desktop_reservations("wrong", o)
            .await
            .unwrap_err(),
        ResourceError::Unauthorized
    );
    case.finish().await;
}
