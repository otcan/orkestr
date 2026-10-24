//! Grant annotations are immutable events, never implicit row edits.
use super::*;
use crate::conversation_resources::now_ms;

#[tokio::test]
async fn grant_note_canonicalizes_links_and_never_mutates_a_row_or_reconsiders_mail() {
    let c = Case::new().await;
    enabled(&c).await;
    let mut seed = event(TrackerEventKind::Applied, "Example", Some("Engineer"), 1000);
    seed.link = Some("https://jobs.example/position/42".into());
    let set = c
        .store
        .apply_tracker_events(owner(&c), &c.conversation, &batch("seed", vec![seed]))
        .await
        .unwrap();
    let row_id = set.changes[0].row_id.unwrap();
    let query=format!("SELECT json_array(company,company_key,role,role_key,status,status_changed_ms,applied_ms,last_contact_ms,next_step,link,location,notes,confidence,needs_review,archived,events_count,revision,updated_ms) FROM tracker_rows WHERE id='{row_id}'");
    let before: String = sqlx::query_scalar(&query)
        .fetch_one(&c.store.pool)
        .await
        .unwrap();
    let pending = TrackerEventInput {
        requires_thread: true,
        message_ref: Some("ffffffffffffffffffffffff".into()),
        thread_refs: vec!["eeeeeeeeeeeeeeeeeeeeeeee".into()],
        ..event(TrackerEventKind::Rejection, "Unknown company", None, 1000)
    };
    let json = crate::tracker::retention::minimized(&pending).unwrap();
    sqlx::query("INSERT INTO tracker_unresolved_events(owner_id,conversation_id,message_ref,event_digest,event_json,source_revision,state,reason,recorded_ms) VALUES(?,?,?,?,?,0,'pending','missing_known_thread',?)")
        .bind(c.owner.to_string()).bind(c.conversation.to_string()).bind(pending.message_ref.as_deref()).bind(crate::digest(&json)).bind(json).bind(now_ms()).execute(&c.store.pool).await.unwrap();

    let grant = c
        .store
        .issue_tracker_grant(&c.token, &c.owner, &c.conversation)
        .await
        .unwrap();
    let note = TrackerEventInput {
        classifier: "assistant".into(),
        source: "direct".into(),
        confidence: 0,
        link: Some("https://jobs.example/position/42?utm_source=synthetic".into()),
        location: Some("Changed location".into()),
        next_step: Some("Changed step".into()),
        ..event(
            TrackerEventKind::Note,
            "Different company",
            Some("Different role"),
            i64::MAX,
        )
    };
    let now = now_ms();
    let set = c
        .store
        .apply_tracker_events(
            TrackerCaller::Grant(&grant.grant),
            &c.conversation,
            &batch("annotation", vec![note]),
        )
        .await
        .unwrap();
    assert_eq!(set.changes[0].row_id, Some(row_id));
    assert_eq!(set.changes[0].kind, TrackerChangeKind::Event);
    let after: String = sqlx::query_scalar(&query)
        .fetch_one(&c.store.pool)
        .await
        .unwrap();
    assert_eq!(
        after, before,
        "all persisted row fields remain byte-identical"
    );
    assert_eq!(
        c.count("SELECT max(attempt_order) FROM tracker_unresolved_events")
            .await,
        0,
        "grant cannot trigger pending evidence mutation"
    );
    let events = c
        .store
        .tracker_row_events(owner(&c), &c.conversation, row_id)
        .await
        .unwrap();
    let note = events
        .iter()
        .find(|e| e.kind == TrackerEventKind::Note)
        .unwrap();
    assert!(note.occurred_ms >= now && note.occurred_ms <= now_ms());
    assert!(note.evidence.as_deref().unwrap().starts_with("sha256:"));
    let page = c
        .store
        .tracker_page(owner(&c), &c.conversation)
        .await
        .unwrap();
    assert_eq!(
        page.rows[0].events_count, 2,
        "derived timeline count includes append-only notes"
    );
    c.finish().await;
}

#[tokio::test]
async fn real_same_store_second_owner_has_own_access_but_no_cross_access() {
    let c = Case::new().await;
    enabled(&c).await;
    let second = OwnerId(Uuid::new_v4());
    let other = ConversationId(Uuid::new_v4());
    // Production setup is singleton. Seed a second owner by bypassing only
    // that setup CHECK on this fixture connection; restore checks before all
    // authorization tests. FK constraints and the actual auth path stay active.
    let mut conn = c.store.pool.acquire().await.unwrap();
    sqlx::query("PRAGMA ignore_check_constraints=ON")
        .execute(&mut *conn)
        .await
        .unwrap();
    sqlx::query("INSERT INTO owners(id,username,password_hash,singleton) VALUES(?,'synthetic-second-owner','synthetic-hash',2)").bind(second.to_string()).execute(&mut *conn).await.unwrap();
    sqlx::query("PRAGMA ignore_check_constraints=OFF")
        .execute(&mut *conn)
        .await
        .unwrap();
    let check: i64 = sqlx::query_scalar("PRAGMA ignore_check_constraints")
        .fetch_one(&mut *conn)
        .await
        .unwrap();
    assert_eq!(check, 0);
    sqlx::query("INSERT INTO conversations(id,owner_id) VALUES(?,?)")
        .bind(other.to_string())
        .bind(second.to_string())
        .execute(&mut *conn)
        .await
        .unwrap();
    drop(conn);
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    c.store.save_session(&token, &second).await.unwrap();
    let caller = TrackerCaller::Owner {
        credential: &token,
        owner: &second,
    };
    c.store
        .enable_tracker(
            &token,
            &second,
            &other,
            &TrackerEnable {
                recipe: "job-tracker".into(),
                notify_on: vec![],
            },
        )
        .await
        .unwrap();
    let set = c
        .store
        .apply_tracker_events(
            caller,
            &other,
            &batch(
                "other-owner",
                vec![event(
                    TrackerEventKind::Applied,
                    "Other owner company",
                    Some("Engineer"),
                    1000,
                )],
            ),
        )
        .await
        .unwrap();
    assert_eq!(
        c.store
            .tracker_page(caller, &other)
            .await
            .unwrap()
            .rows
            .len(),
        1
    );
    assert_eq!(
        c.store
            .tracker_page(caller, &c.conversation)
            .await
            .map(|_| ()),
        Err(ResourceError::NotFound)
    );
    assert_eq!(
        c.store.tracker_page(owner(&c), &other).await.map(|_| ()),
        Err(ResourceError::NotFound)
    );
    assert_eq!(
        c.store
            .apply_tracker_events(
                caller,
                &c.conversation,
                &batch(
                    "cross-owner",
                    vec![event(TrackerEventKind::Applied, "Cross", None, 1000)]
                )
            )
            .await,
        Err(ResourceError::NotFound)
    );
    assert_eq!(
        c.store
            .issue_tracker_grant(&c.token, &c.owner, &other)
            .await,
        Err(ResourceError::NotFound)
    );
    assert_eq!(
        c.store
            .edit_tracker_row(
                &c.token,
                &c.owner,
                &c.conversation,
                set.changes[0].row_id.unwrap(),
                &TrackerRowEdit {
                    expected_revision: 1,
                    notes: Some("Cross".into()),
                    ..Default::default()
                }
            )
            .await,
        Err(ResourceError::NotFound)
    );
    assert_eq!(c.count("SELECT count(*) FROM tracker_rows").await, 1);
    c.finish().await;
}
