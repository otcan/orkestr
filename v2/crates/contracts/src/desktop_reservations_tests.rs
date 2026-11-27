use super::*;
use DesktopReservationKind::{OwnerHandoff, OwnerViewer, Task};

const NOW: i64 = 1_795_722_060_000; // 2026-11-26T19:41:00Z
const MIN: i64 = 60_000;

fn view(kind: DesktopReservationKind, mine: bool, until_ms: i64) -> DesktopReservationView {
    DesktopReservationView {
        desk: "desk-b".into(),
        kind,
        chat: match (kind, mine) {
            (OwnerViewer, _) => None,
            (_, true) => Some("this-chat".into()),
            (_, false) => Some("other-chat".into()),
        },
        mine,
        conversation_id: None,
        since_ms: NOW - MIN,
        until_ms,
    }
}
fn request(
    op: DesktopReservationOp,
    minutes: Option<i64>,
    until_ms: Option<i64>,
) -> DesktopReservationRequest {
    DesktopReservationRequest {
        op,
        minutes,
        until_ms,
    }
}

#[test]
fn only_the_task_holder_acts_while_the_owner_watches_and_a_handoff_stops_everyone() {
    let later = NOW + 10 * MIN;
    let (own_task, other_task) = (view(Task, true, later), view(Task, false, later));
    let (own_handoff, other_handoff) = (
        view(OwnerHandoff, true, later),
        view(OwnerHandoff, false, later),
    );
    let viewer = view(OwnerViewer, false, later);
    let verdict = |claim: Option<&DesktopReservationView>,
                   viewer: Option<&DesktopReservationView>| {
        let (verdict, holder) = desk_verdict(claim, viewer);
        (verdict, holder.map(|h| (h.kind, h.mine)))
    };
    assert_eq!(verdict(None, None), (DeskVerdict::Allowed, None));
    assert_eq!(verdict(Some(&own_task), None), (DeskVerdict::Allowed, None));
    assert_eq!(
        verdict(Some(&other_task), None),
        (DeskVerdict::DeskBusy, Some((Task, false)))
    );
    assert_eq!(
        verdict(Some(&own_handoff), None),
        (DeskVerdict::DeskHandedToOwner, Some((OwnerHandoff, true)))
    );
    assert_eq!(
        verdict(Some(&other_handoff), None),
        (DeskVerdict::DeskBusy, Some((OwnerHandoff, false)))
    );
    // The owner viewing: the chat holding the task goes on, nobody else does.
    assert_eq!(
        verdict(None, Some(&viewer)),
        (DeskVerdict::DeskBusy, Some((OwnerViewer, false)))
    );
    assert_eq!(
        verdict(Some(&own_task), Some(&viewer)),
        (DeskVerdict::Allowed, None)
    );
    assert_eq!(
        verdict(Some(&other_task), Some(&viewer)),
        (DeskVerdict::DeskBusy, Some((Task, false)))
    );
    assert_eq!(
        verdict(Some(&own_handoff), Some(&viewer)),
        (DeskVerdict::DeskHandedToOwner, Some((OwnerHandoff, true)))
    );
}

#[test]
fn reserve_handoff_handback_and_unreserve_change_only_the_chats_own_claim() {
    use DesktopReservationOp::*;
    let change =
        |r: DesktopReservationRequest, claim: Option<DesktopReservationView>, viewer: bool| {
            let viewer = viewer.then(|| view(OwnerViewer, false, NOW + 30 * MIN));
            reservation_change(&r, claim.as_ref(), viewer.as_ref(), NOW)
        };
    let write = |kind, since_ms, until_ms| {
        Ok(ClaimChange::Write {
            kind,
            since_ms,
            until_ms,
        })
    };
    // reserve: default 30 minutes; a longer own end is kept; another chat or a handoff refuses.
    assert_eq!(
        change(request(Reserve, None, None), None, false),
        write(Task, NOW, NOW + 30 * MIN)
    );
    assert_eq!(
        change(
            request(Reserve, Some(120), None),
            Some(view(Task, true, NOW + 5 * MIN)),
            false
        ),
        write(Task, NOW - MIN, NOW + 120 * MIN)
    );
    assert_eq!(
        change(
            request(Reserve, Some(1), None),
            Some(view(Task, true, NOW + 50 * MIN)),
            false
        ),
        write(Task, NOW - MIN, NOW + 50 * MIN)
    );
    assert_eq!(
        change(
            request(Reserve, None, None),
            Some(view(Task, false, NOW + MIN)),
            false
        ),
        Err("desk_busy")
    );
    assert_eq!(
        change(
            request(Reserve, None, None),
            Some(view(OwnerHandoff, true, NOW + MIN)),
            false
        ),
        Err("desk_handed_to_owner")
    );
    // While the owner views a desk, reserving it is no way around the viewer.
    assert_eq!(
        change(request(Reserve, None, None), None, true),
        Err("desk_busy")
    );
    assert_eq!(
        change(
            request(Reserve, Some(20), None),
            Some(view(Task, true, NOW + MIN)),
            true
        ),
        write(Task, NOW - MIN, NOW + 20 * MIN)
    );
    // handoff: a link's end (capped), or minutes; the own task becomes the handoff.
    assert_eq!(
        change(
            request(Handoff, None, Some(NOW + 30 * MIN)),
            Some(view(Task, true, NOW + MIN)),
            true
        ),
        write(OwnerHandoff, NOW, NOW + 30 * MIN)
    );
    assert_eq!(
        change(request(Handoff, None, Some(NOW + 600 * MIN)), None, false),
        write(OwnerHandoff, NOW, NOW + DESK_HANDOFF_MAX_MS)
    );
    assert_eq!(
        change(request(Handoff, None, None), None, false),
        write(OwnerHandoff, NOW, NOW + 30 * MIN)
    );
    assert_eq!(
        change(request(Handoff, None, Some(NOW - 1)), None, false),
        Err("reservation_until_invalid")
    );
    assert_eq!(
        change(
            request(Handoff, None, None),
            Some(view(Task, false, NOW + MIN)),
            false
        ),
        Err("desk_busy")
    );
    // handback: only the chat's own handoff, which becomes its task for the grace.
    assert_eq!(
        change(
            request(Handback, None, None),
            Some(view(OwnerHandoff, true, NOW + MIN)),
            true
        ),
        write(Task, NOW, NOW + DESK_TASK_GRACE_MS)
    );
    for claim in [
        None,
        Some(view(Task, true, NOW + MIN)),
        Some(view(OwnerHandoff, false, NOW + MIN)),
    ] {
        assert_eq!(
            change(request(Handback, None, None), claim, false),
            Err("no_handoff_of_this_chat")
        );
    }
    // unreserve: nothing to do, the own claim, never another chat's.
    assert_eq!(
        change(request(Unreserve, None, None), None, false),
        Ok(ClaimChange::Keep)
    );
    assert_eq!(
        change(
            request(Unreserve, None, None),
            Some(view(Task, true, NOW + MIN)),
            false
        ),
        Ok(ClaimChange::Remove)
    );
    assert_eq!(
        change(
            request(Unreserve, None, None),
            Some(view(OwnerHandoff, false, NOW + MIN)),
            false
        ),
        Err("reservation_of_another_chat")
    );
}

#[test]
fn requests_are_bounded() {
    use DesktopReservationOp::*;
    assert!(request(Reserve, None, None).is_valid());
    assert!(request(Reserve, Some(120), None).is_valid());
    assert!(!request(Reserve, Some(121), None).is_valid());
    assert!(!request(Reserve, Some(0), None).is_valid());
    assert!(!request(Reserve, None, Some(NOW)).is_valid());
    assert!(request(Handoff, None, Some(NOW)).is_valid());
    assert!(request(Handoff, Some(45), None).is_valid());
    assert!(!request(Handoff, Some(45), Some(NOW)).is_valid());
    assert!(!request(Handoff, None, Some(0)).is_valid());
    assert!(!request(Handoff, Some(i64::MAX), None).is_valid());
    assert!(request(Handback, None, None).is_valid());
    assert!(!request(Handback, Some(1), None).is_valid());
    assert!(!request(Unreserve, None, Some(NOW)).is_valid());
    let parsed: DesktopReservationRequest =
        serde_json::from_str(r#"{"op":"handoff","until_ms":1}"#).unwrap();
    assert_eq!(parsed.op, Handoff);
    assert!(serde_json::from_str::<DesktopReservationRequest>(r#"{"op":"steal"}"#).is_err());
    assert!(
        serde_json::from_str::<DesktopReservationRequest>(r#"{"op":"reserve","force":true}"#)
            .is_err()
    );
}

#[test]
fn every_step_extends_the_chats_task_past_its_lease_and_never_touches_other_claims() {
    let lease_end = NOW + 2 * MIN;
    assert_eq!(
        touched_task(None, NOW, lease_end),
        Some((NOW, lease_end + DESK_TASK_GRACE_MS))
    );
    // A longer own reserve keeps its end.
    assert_eq!(
        touched_task(Some(&view(Task, true, NOW + 90 * MIN)), NOW, lease_end),
        Some((NOW - MIN, NOW + 90 * MIN))
    );
    assert_eq!(
        touched_task(Some(&view(Task, true, NOW + MIN)), NOW, lease_end),
        Some((NOW - MIN, lease_end + DESK_TASK_GRACE_MS))
    );
    assert_eq!(
        touched_task(Some(&view(Task, false, NOW + MIN)), NOW, lease_end),
        None
    );
    assert_eq!(
        touched_task(Some(&view(OwnerHandoff, true, NOW + MIN)), NOW, lease_end),
        None
    );
}

#[test]
fn refusals_name_the_holder_and_the_free_desks() {
    assert_eq!(desk_time(0), "1970-01-01T00:00:00Z");
    assert_eq!(desk_time(NOW), "2026-11-26T19:41:00Z");
    assert_eq!(desk_time(1_709_251_199_000), "2024-02-29T23:59:59Z");
    let free = vec!["desk-c".to_string()];
    let task = desk_refusal_hint(DeskVerdict::DeskBusy, &view(Task, false, NOW), &free);
    assert!(
        task.contains("other-chat") && task.contains("2026-11-26T19:41:00Z"),
        "{task}"
    );
    assert!(
        task.contains("nothing was done") && task.ends_with("Free now: desk-c."),
        "{task}"
    );
    let handoff = desk_refusal_hint(DeskVerdict::DeskBusy, &view(OwnerHandoff, false, NOW), &[]);
    assert!(
        handoff.contains("owner is using desk-b")
            && handoff.ends_with("No other desk is free right now.")
    );
    let viewer = desk_refusal_hint(DeskVerdict::DeskBusy, &view(OwnerViewer, false, NOW), &[]);
    assert!(viewer.contains("owner is viewing desk-b"), "{viewer}");
    let own = desk_refusal_hint(
        DeskVerdict::DeskHandedToOwner,
        &view(OwnerHandoff, true, NOW),
        &[],
    );
    assert!(
        own.contains("You handed desk-b") && own.contains("handback") && !own.contains("Free now")
    );
    // A chat's view never carries a conversation id.
    let text = serde_json::to_string(&view(Task, false, NOW)).unwrap();
    assert!(!text.contains("conversation_id"), "{text}");
    assert_eq!(
        DesktopReservationKind::parse("owner_viewer"),
        Some(OwnerViewer)
    );
    assert_eq!(DesktopReservationKind::parse(Task.as_str()), Some(Task));
    assert_eq!(DesktopReservationKind::parse("lease"), None);
}
