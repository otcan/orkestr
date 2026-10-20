//! Moving a thread's timers over the mounted router: dormant import with
//! mapping, listing, explicit enable, one queued Deep turn, relay listing.
use super::tests::request;
use super::*;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU32, Ordering};

fn sql(database: &std::path::Path, statement: &str) {
    let status = std::process::Command::new("python3")
        .arg("-c")
        .arg("import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(sys.argv[2]); c.commit(); c.close()")
        .arg(database)
        .arg(statement)
        .status()
        .unwrap();
    assert!(status.success());
}

#[tokio::test]
async fn thread_timers_import_list_enable_fire_once_and_relay_listing() {
    let directory = std::env::temp_dir().join(format!("timer-move-{}", Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap();
    let database = directory.join("store.sqlite3");
    let store = Store::open(&database).await.unwrap();
    let conversation = store
        .setup("synthetic-move-owner", "synthetic-password-hash")
        .await
        .unwrap();
    let owner = store
        .credentials("synthetic-move-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    let token = "d4".repeat(32);
    store.save_session(&token, &owner).await.unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let controller = DurableOwnerController::new(store.clone());
    controller.ready.store(true, Ordering::Release);
    let mut state =
        AppState::new(store.clone(), "b".repeat(32), format!("http://{address}")).unwrap();
    state.timers = controller.clone();
    let router = crate::router(state);
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

    let weekly = Uuid::new_v4();
    let hourly = Uuid::new_v4();
    let import = |namespace: Uuid, id: &str, schedule: Value, enabled: bool| {
        json!({"namespace": namespace, "source_namespace": "synthetic-v1", "source_timer_id": id,
               "source_enabled": enabled, "schedule": schedule, "conversation_id": conversation,
               "label": format!("Synthetic {id}"), "source_thread_id": "synthetic-thread"})
    };
    let weekly_body = import(
        weekly,
        "weekly",
        json!({"kind":"zoned_clock","timezone":"Europe/Berlin","weekday":5,"minute_of_day":1205}),
        true,
    );
    let (status, detail) = request(
        address,
        "POST",
        "/api/v2/timers/import",
        &token,
        weekly_body.clone(),
    )
    .await;
    assert_eq!(status, 200, "{detail}");
    assert_eq!(detail["state"], "paused");
    assert_eq!(detail["schedule"]["kind"], "zoned_clock");
    assert_eq!(detail["next_due_ms"], Value::Null);
    // Identical replay is idempotent; a different mapping conflicts.
    let replay = request(
        address,
        "POST",
        "/api/v2/timers/import",
        &token,
        weekly_body.clone(),
    )
    .await;
    assert_eq!(replay, (200, detail.clone()));
    let mut moved = weekly_body.clone();
    moved["label"] = "Renamed".into();
    assert_eq!(
        request(address, "POST", "/api/v2/timers/import", &token, moved)
            .await
            .0,
        409
    );
    for bad in [
        json!({"kind":"zoned_clock","timezone":"Mars/Base","weekday":null,"minute_of_day":60}),
        json!({"kind":"zoned_clock","timezone":"Europe/Berlin","weekday":9,"minute_of_day":60}),
        json!({"kind":"interval","every_ms":1000}),
    ] {
        let mut body = import(Uuid::new_v4(), "bad", bad, true);
        body["source_timer_id"] = Uuid::new_v4().to_string().into();
        assert_eq!(
            request(address, "POST", "/api/v2/timers/import", &token, body)
                .await
                .0,
            400
        );
    }
    let mut extra = weekly_body.clone();
    extra["enabled"] = true.into();
    assert_eq!(
        request(address, "POST", "/api/v2/timers/import", &token, extra)
            .await
            .0,
        400
    );
    let (status, _) = request(
        address,
        "POST",
        "/api/v2/timers/import",
        &token,
        import(
            hourly,
            "hourly",
            json!({"kind":"interval","every_ms":3_600_000}),
            true,
        ),
    )
    .await;
    assert_eq!(status, 200);

    let listing_path = format!("/api/v2/conversations/{conversation}/timers");
    let (status, listing) = request(address, "GET", &listing_path, &token, Value::Null).await;
    assert_eq!(status, 200);
    assert_eq!(listing["conversation_id"], json!(conversation));
    let timers = listing["timers"].as_array().unwrap();
    assert_eq!(timers.len(), 2);
    assert_eq!(timers[0]["label"], "Synthetic weekly");
    assert_eq!(timers[0]["source_timer_id"], "weekly");
    assert_eq!(timers[0]["source_enabled"], true);
    assert_eq!(timers[0]["state"], "paused");

    // Explicit owner enable; the mapped conversation is the only valid target.
    let enable = json!({"expected_revision":1,"request_key":"synthetic-enable-hourly",
                        "conversation_id": conversation, "text":"Synthetic hourly work"});
    let (status, enabled) = request(
        address,
        "POST",
        &format!("/api/v2/timers/{hourly}/enable"),
        &token,
        enable,
    )
    .await;
    assert_eq!(status, 200, "{enabled}");
    assert_eq!(enabled["state"], "enabled");
    assert_eq!(enabled["controller_armed"], true);

    // Simulate downtime: many missed hours, then one scheduler pass.
    sql(
        &database,
        &format!("UPDATE dormant_timers SET next_due_ms=next_due_ms-50*3600000 WHERE namespace='{hourly}'"),
    );
    let bound = store
        .authorize_supervisor(
            &token,
            orkestr_v2_application::runtime::ProductionSupervisorConfig {
                provider: orkestr_v2_application::runtime::ProviderKind::Codex,
                namespace: "synthetic-move-scheduler".into(),
                supervisor_key: "synthetic".into(),
                takeover: orkestr_v2_application::runtime::ProductionTakeover::First,
            },
        )
        .await
        .unwrap();
    let woken = std::sync::Arc::new(AtomicU32::new(0));
    let counter = woken.clone();
    let mut scheduler = durable::DurableTimerController::new(bound).with_window_dispatch(
        std::sync::Arc::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        }),
    );
    let first = scheduler.tick().await.unwrap();
    assert_eq!((first.scanned, first.admitted), (1, 1));
    assert_eq!(
        scheduler.tick().await.unwrap(),
        durable::DurableTick::default()
    );
    assert_eq!(woken.load(Ordering::SeqCst), 1);

    let inputs_path = format!("/api/v2/conversations/{conversation}/timer-inputs");
    let (status, inputs) = request(address, "GET", &inputs_path, &token, Value::Null).await;
    assert_eq!(status, 200);
    let rows = inputs["inputs"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["namespace"], json!(hourly));
    assert_eq!(rows[0]["label"], "Synthetic hourly");
    assert_eq!(rows[0]["source_timer_id"], "hourly");
    assert_eq!(rows[0]["window"], "queued");
    assert_eq!(rows[0]["held"], false);
    assert!(rows[0]["request_key"]
        .as_str()
        .unwrap()
        .starts_with("timer:"));
    let after = rows[0]["sequence"].as_i64().unwrap();
    let (_, later) = request(
        address,
        "GET",
        &format!("{inputs_path}?after_sequence={after}&limit=10"),
        &token,
        Value::Null,
    )
    .await;
    assert!(later["inputs"].as_array().unwrap().is_empty());
    assert_eq!(
        request(
            address,
            "GET",
            &format!("{inputs_path}?limit=0"),
            &token,
            Value::Null
        )
        .await
        .0,
        400
    );
    assert_eq!(
        request(
            address,
            "GET",
            &format!("{inputs_path}?cursor=1"),
            &token,
            Value::Null
        )
        .await
        .0,
        400
    );
    // Handing the timer back: disable holds the occurrence that never ran.
    let (status, disabled) = request(
        address,
        "POST",
        &format!("/api/v2/timers/{hourly}/control"),
        &token,
        json!({"expected_revision": 2, "request_key": "synthetic-handback", "action": "disable"}),
    )
    .await;
    assert_eq!(status, 200, "{disabled}");
    assert_eq!(disabled["state"], "disabled");
    let (_, inputs) = request(address, "GET", &inputs_path, &token, Value::Null).await;
    assert_eq!(inputs["inputs"][0]["held"], true);
    // Unauthenticated callers learn nothing.
    assert_eq!(
        request(address, "GET", &listing_path, &"e5".repeat(32), Value::Null)
            .await
            .0,
        401
    );
    server.abort();
    store.close().await;
    std::fs::remove_dir_all(directory).unwrap();
}
