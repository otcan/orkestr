//! Owner and grant authority regression coverage.
use super::*;
#[tokio::test]
async fn grant_cannot_override_status_or_forge_mail_provenance_or_scan() {
    let c = Case::new().await;
    enabled(&c).await;
    let seed = c
        .store
        .apply_tracker_events(
            owner(&c),
            &c.conversation,
            &batch(
                "seed",
                vec![event(
                    TrackerEventKind::Rejection,
                    "Example",
                    Some("Engineer"),
                    1000,
                )],
            ),
        )
        .await
        .unwrap();
    let grant = c
        .store
        .issue_tracker_grant(&c.token, &c.owner, &c.conversation)
        .await
        .unwrap();
    let note = TrackerEventInput {
        source: "direct".into(),
        classifier: "assistant".into(),
        ..event(TrackerEventKind::Note, "Example", Some("Engineer"), 2000)
    };
    for bad in [
        TrackerEventInput {
            classifier: "manual".into(),
            kind: TrackerEventKind::Offer,
            ..note.clone()
        },
        TrackerEventInput {
            kind: TrackerEventKind::Offer,
            ..note.clone()
        },
        TrackerEventInput {
            requires_thread: true,
            ..note.clone()
        },
        TrackerEventInput {
            thread_refs: vec!["aaaaaaaaaaaaaaaaaaaaaaaa".into()],
            ..note.clone()
        },
        TrackerEventInput {
            message_ref: Some("aaaaaaaaaaaaaaaaaaaaaaaa".into()),
            ..note.clone()
        },
        TrackerEventInput {
            company: "Missing row".into(),
            ..note.clone()
        },
    ] {
        assert_eq!(
            c.store
                .apply_tracker_events(
                    TrackerCaller::Grant(&grant.grant),
                    &c.conversation,
                    &batch("forged", vec![bad])
                )
                .await,
            Err(ResourceError::Invalid)
        );
    }
    assert_eq!(
        c.store
            .record_tracker_scan(
                TrackerCaller::Grant(&grant.grant),
                &c.conversation,
                0,
                &[],
                "{}",
                "{}"
            )
            .await,
        Err(ResourceError::Unauthorized)
    );
    let note_receipt = c
        .store
        .apply_tracker_events(
            TrackerCaller::Grant(&grant.grant),
            &c.conversation,
            &batch("note", vec![note.clone()]),
        )
        .await
        .unwrap();
    let fake_manual = TrackerEventInput {
        classifier: "manual".into(),
        ..note.clone()
    };
    assert_eq!(
        c.store
            .apply_tracker_events(
                owner(&c),
                &c.conversation,
                &batch("not-an-owner-edit", vec![fake_manual])
            )
            .await,
        Err(ResourceError::Invalid)
    );
    let row = c
        .store
        .tracker_page(owner(&c), &c.conversation)
        .await
        .unwrap()
        .rows
        .remove(0);
    assert_eq!(row.status, TrackerStatus::Rejected);
    let edited = c
        .store
        .edit_tracker_row(
            &c.token,
            &c.owner,
            &c.conversation,
            seed.changes[0].row_id.unwrap(),
            &TrackerRowEdit {
                expected_revision: row.revision,
                status: Some(TrackerStatus::Offer),
                company: Some("Renamed example".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(edited.status, TrackerStatus::Offer);
    let replay = c
        .store
        .apply_tracker_events(
            TrackerCaller::Grant(&grant.grant),
            &c.conversation,
            &batch("note", vec![note]),
        )
        .await
        .unwrap();
    assert_eq!(
        replay, note_receipt,
        "exact-key receipt survives subsequent owner rename"
    );
    c.finish().await;
}

#[tokio::test]
async fn another_owner_credential_and_claimed_owner_id_are_refused() {
    let c = Case::new().await;
    let foreign = Case::new().await;
    enabled(&c).await;
    for caller in [
        TrackerCaller::Owner {
            credential: &foreign.token,
            owner: &foreign.owner,
        },
        TrackerCaller::Owner {
            credential: &c.token,
            owner: &foreign.owner,
        },
    ] {
        assert_eq!(
            c.store
                .tracker_page(caller, &c.conversation)
                .await
                .map(|_| ()),
            Err(ResourceError::Unauthorized)
        );
        assert_eq!(
            c.store
                .apply_tracker_events(
                    caller,
                    &c.conversation,
                    &batch(
                        "foreign",
                        vec![event(TrackerEventKind::Applied, "Example", None, 1000)]
                    )
                )
                .await,
            Err(ResourceError::Unauthorized)
        );
    }
    assert_eq!(
        c.store
            .issue_tracker_grant(&c.token, &foreign.owner, &c.conversation)
            .await,
        Err(ResourceError::Unauthorized)
    );
    assert_eq!(c.count("SELECT count(*) FROM tracker_rows").await, 0);
    c.finish().await;
    foreign.finish().await;
}
