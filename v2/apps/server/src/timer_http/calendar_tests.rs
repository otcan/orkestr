//! Calendar timers over the mounted router: create with a plain-words summary,
//! preview, policy and pause, silent outcomes with a digest, trigger events.
use super::tests::request;
use super::*;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;

#[tokio::test]
async fn calendar_timer_lifecycle_policy_silence_digest_and_triggers() {
    let directory = std::env::temp_dir().join(format!("timer-calendar-{}", Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap();
    let store = Store::open(&directory.join("store.sqlite3")).await.unwrap();
    let conversation = store
        .setup("synthetic-calendar-owner", "synthetic-password-hash")
        .await
        .unwrap();
    let owner = store
        .credentials("synthetic-calendar-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    let token = "c7".repeat(32);
    store.save_session(&token, &owner).await.unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let controller = DurableOwnerController::new(store.clone());
    controller.ready.store(true, Ordering::Release);
    let mut state =
        AppState::new(store.clone(), "b".repeat(32), format!("http://{address}")).unwrap();
    state.timers = controller.clone();
    let server =
        tokio::spawn(async move { axum::serve(listener, crate::router(state)).await.unwrap() });
    let bound = store
        .authorize_supervisor(
            &token,
            orkestr_v2_application::runtime::ProductionSupervisorConfig {
                provider: orkestr_v2_application::runtime::ProviderKind::Codex,
                namespace: "synthetic-calendar-scheduler".into(),
                supervisor_key: "synthetic".into(),
                takeover: orkestr_v2_application::runtime::ProductionTakeover::First,
            },
        )
        .await
        .unwrap();
    let mut scheduler = durable::DurableTimerController::new(bound)
        .with_window_dispatch(std::sync::Arc::new(|| {}));

    // Preview first: invalid rules are refused with 400.
    let berlin = json!({"kind":"calendar","timezone":"Europe/Berlin","weekdays":[1,2,3,4,5],
                        "start_minute":480,"end_minute":1140,"minutes":[0]});
    let (status, preview) = request(
        address,
        "POST",
        "/api/v2/timers/calendar/preview",
        &token,
        json!({"schedule": berlin, "from_ms": 1_792_569_600_000_i64, "count": 3}),
    )
    .await;
    assert_eq!(status, 200, "{preview}");
    assert_eq!(
        preview["summary"],
        "Hourly at :00, Mon–Fri, 08:00–19:00 Europe/Berlin"
    );
    assert_eq!(preview["runs_ms"].as_array().unwrap().len(), 3);
    for bad in [
        json!({"kind":"calendar","timezone":"Mars/Base","minutes":[0],"start_minute":0,"end_minute":10}),
        json!({"kind":"calendar","timezone":"UTC","minutes":[60],"start_minute":0,"end_minute":10}),
        json!({"kind":"calendar","timezone":"UTC","minutes":[0],"start_minute":0,"end_minute":10,"extra":1}),
    ] {
        let (status, _) = request(
            address,
            "POST",
            "/api/v2/timers/calendar/preview",
            &token,
            json!({"schedule": bad}),
        )
        .await;
        assert_eq!(status, 400);
    }

    // Create + enable in one call; replay is idempotent.
    let hourly = Uuid::new_v4();
    let create = json!({"namespace": hourly, "conversation_id": conversation, "label": "Jobs triage",
        "schedule": {"kind":"calendar","timezone":"UTC","minutes":[0],"start_minute":0,"end_minute":1439},
        "policy": {"silent_mode":"unless_changed",
                   "digest":{"timezone":"Europe/Istanbul","minutes":(0..24).map(|h| h*60).collect::<Vec<_>>()}},
        "text": "Check the inbox"});
    let (status, created) = request(
        address,
        "POST",
        "/api/v2/timers/calendar",
        &token,
        create.clone(),
    )
    .await;
    assert_eq!(status, 200, "{created}");
    assert_eq!(created["state"], "enabled");
    assert_eq!(created["schedule"]["kind"], "calendar");
    assert_eq!(
        created["schedule"]["summary"],
        "Hourly at :00, every day, 00:00–23:59 UTC"
    );
    assert_eq!(created["controller_armed"], true);
    assert_eq!(
        request(address, "POST", "/api/v2/timers/calendar", &token, create).await,
        (200, created.clone())
    );

    let listing_path = format!("/api/v2/conversations/{conversation}/timers");
    let (_, listing) = request(address, "GET", &listing_path, &token, Value::Null).await;
    let timer = &listing["timers"][0];
    assert_eq!(timer["label"], "Jobs triage");
    assert_eq!(timer["policy"]["silent_mode"], "unless_changed");
    assert_eq!(timer["stats"]["silent_runs"], 0);
    assert_eq!(timer["native"], true);
    assert!(
        timer["next_due_local"].as_str().unwrap().ends_with("UTC"),
        "{timer}"
    );
    assert_eq!(preview["runs_local"].as_array().unwrap().len(), 3);
    assert!(
        preview["runs_local"][0].as_str().unwrap().ends_with("CEST"),
        "{preview}"
    );
    assert_eq!(listing["pause_until_ms"], Value::Null);

    // Three overdue slots, one run each; results are silent, low-signal, news.
    let db = directory.join("store.sqlite3");
    let mut claims = Vec::new();
    for _ in 0..3 {
        sqlite(&db, &format!("UPDATE dormant_timers SET next_due_ms=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)-5000 WHERE namespace='{hourly}'"));
        assert_eq!(scheduler.tick().await.unwrap().admitted, 1);
        let (_, inputs) = request(
            address,
            "GET",
            &format!("/api/v2/conversations/{conversation}/timer-inputs"),
            &token,
            Value::Null,
        )
        .await;
        claims.push(inputs["inputs"].as_array().unwrap().last().unwrap()["claim_id"].clone());
    }
    let outcomes = format!("/api/v2/conversations/{conversation}/timer-outcomes");
    for (claim, text, deliver, kind) in [
        (&claims[0], "NO_NEWS", false, "silent"),
        (&claims[1], "LOW_SIGNAL: promo mail", false, "digest"),
        (&claims[2], "Interview invite from ACME", true, "delivered"),
    ] {
        let (status, out) = request(
            address,
            "POST",
            &outcomes,
            &token,
            json!({"claim_id": claim, "text": text}),
        )
        .await;
        assert_eq!(status, 200, "{out}");
        assert_eq!(
            (out["deliver"].clone(), out["outcome"].clone()),
            (json!(deliver), json!(kind))
        );
    }
    assert_eq!(
        request(
            address,
            "POST",
            &outcomes,
            &token,
            json!({"claim_id": Uuid::new_v4(), "text": "x"})
        )
        .await
        .0,
        404
    );
    let (_, listing) = request(address, "GET", &listing_path, &token, Value::Null).await;
    assert_eq!(listing["timers"][0]["stats"]["last_kind"], "delivered");
    assert_eq!(listing["timers"][0]["stats"]["total_runs"], 3);

    // Digest of the two quiet runs, generated by the supervisor, then acknowledged.
    sqlite(
        &db,
        "UPDATE timer_policies SET digest_since_ms=digest_since_ms-172800000",
    );
    scheduler.check_digests_next_pass();
    assert_eq!(scheduler.tick().await.unwrap().digests, 1);
    let digests = format!("/api/v2/conversations/{conversation}/timer-digests");
    let (_, pending) = request(address, "GET", &digests, &token, Value::Null).await;
    let list = pending["digests"].as_array().unwrap();
    assert_eq!(list.len(), 1, "{pending}");
    assert_eq!(list[0]["item_count"], 2);
    assert!(list[0]["text"].as_str().unwrap().contains("promo mail"));
    let id = list[0]["id"].as_str().unwrap().to_owned();
    let (status, done) = request(
        address,
        "POST",
        &format!("{digests}/{id}/delivered"),
        &token,
        Value::Null,
    )
    .await;
    assert_eq!((status, done["delivered"].clone()), (200, json!(true)));
    let (_, pending) = request(address, "GET", &digests, &token, Value::Null).await;
    assert!(pending["digests"].as_array().unwrap().is_empty());
    let (_, recent) = request(
        address,
        "GET",
        &format!("{digests}?state=recent"),
        &token,
        Value::Null,
    )
    .await;
    assert_eq!(recent["digests"].as_array().unwrap().len(), 1);
    assert_eq!(
        request(
            address,
            "GET",
            &format!("{digests}?state=bogus"),
            &token,
            Value::Null
        )
        .await
        .0,
        400
    );

    // Pause the timer until a time, then the whole conversation; resume both.
    let until = 4_000_000_000_000_i64;
    let (status, paused) = request(
        address,
        "POST",
        &format!("/api/v2/timers/{hourly}/pause"),
        &token,
        json!({"until_ms": until}),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(paused["pause_until_ms"], until);
    let (_, detail) = request(
        address,
        "GET",
        &format!("/api/v2/timers/{hourly}"),
        &token,
        Value::Null,
    )
    .await;
    assert!(detail["next_due_ms"].as_i64().unwrap() >= until);
    let (status, conv) = request(
        address,
        "POST",
        &format!("/api/v2/conversations/{conversation}/timer-pause"),
        &token,
        json!({"until_ms": until}),
    )
    .await;
    assert_eq!(
        (status, conv["pause_until_ms"].clone()),
        (200, json!(until))
    );
    let (_, listing) = request(address, "GET", &listing_path, &token, Value::Null).await;
    assert_eq!(listing["pause_until_ms"], until);
    request(
        address,
        "POST",
        &format!("/api/v2/conversations/{conversation}/timer-pause"),
        &token,
        json!({"until_ms": null}),
    )
    .await;
    let (_, resumed) = request(
        address,
        "POST",
        &format!("/api/v2/timers/{hourly}/pause"),
        &token,
        json!({"until_ms": null}),
    )
    .await;
    assert_eq!(resumed["pause_until_ms"], Value::Null);
    // Policy edits are optimistic.
    let (_, policy) = request(
        address,
        "GET",
        &format!("/api/v2/timers/{hourly}/policy"),
        &token,
        Value::Null,
    )
    .await;
    let revision = policy["revision"].as_i64().unwrap();
    let put = |revision: i64| json!({"expected_revision": revision, "policy": {"silent_mode":"off","skip_dates":["2026-12-25"]}});
    let (status, updated) = request(
        address,
        "PUT",
        &format!("/api/v2/timers/{hourly}/policy"),
        &token,
        put(revision),
    )
    .await;
    assert_eq!(
        (status, updated["skip_dates"].clone()),
        (200, json!(["2026-12-25"]))
    );
    assert_eq!(
        request(
            address,
            "PUT",
            &format!("/api/v2/timers/{hourly}/policy"),
            &token,
            put(revision)
        )
        .await
        .0,
        409
    );

    // Schedule edit on a native timer.
    let (status, edited) = request(address, "POST", &format!("/api/v2/timers/{hourly}/schedule"), &token,
        json!({"expected_revision": 2, "schedule": {"kind":"calendar","timezone":"UTC","minutes":[30],"start_minute":0,"end_minute":1439}})).await;
    assert_eq!(status, 200, "{edited}");
    assert_eq!(edited["revision"], 3);
    assert_eq!(edited["schedule"]["minutes"], json!([30]));

    // Event-triggered timer: an inbound email starts one run.
    let events = Uuid::new_v4();
    let (status, event_timer) = request(address, "POST", "/api/v2/timers/calendar", &token, json!({
        "namespace": events, "conversation_id": conversation, "label": "Mail watcher",
        "schedule": {"kind":"event"}, "policy": {"trigger": {"sources":["email"], "min_interval_s": 0}},
        "text": "Handle the new mail"})).await;
    assert_eq!(status, 200, "{event_timer}");
    assert_eq!(event_timer["schedule"]["kind"], "event");
    let triggers = format!("/api/v2/conversations/{conversation}/timer-triggers");
    let (_, accepted) = request(
        address,
        "POST",
        &triggers,
        &token,
        json!({"source":"email","event_key":"gmail-history-77"}),
    )
    .await;
    assert_eq!(accepted["accepted"], 1);
    let (_, replay) = request(
        address,
        "POST",
        &triggers,
        &token,
        json!({"source":"email","event_key":"gmail-history-77"}),
    )
    .await;
    assert_eq!(replay["accepted"], 0);
    let (_, ignored) = request(
        address,
        "POST",
        &triggers,
        &token,
        json!({"source":"message","event_key":"wa-1"}),
    )
    .await;
    assert_eq!(ignored["accepted"], 0);
    assert_eq!(scheduler.tick().await.unwrap().triggered, 1);
    assert_eq!(scheduler.tick().await.unwrap().triggered, 0);
    assert_eq!(
        request(
            address,
            "POST",
            &triggers,
            &token,
            json!({"source":"smoke","event_key":"x"})
        )
        .await
        .0,
        400
    );
    assert_eq!(
        request(address, "GET", &listing_path, &"d9".repeat(32), Value::Null)
            .await
            .0,
        401
    );
    server.abort();
    store.close().await;
    std::fs::remove_dir_all(directory).unwrap();
}

fn sqlite(database: &std::path::Path, statement: &str) {
    let status = std::process::Command::new("python3")
        .arg("-c")
        .arg("import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(sys.argv[2]); c.commit(); c.close()")
        .arg(database)
        .arg(statement)
        .status()
        .unwrap();
    assert!(status.success());
}
