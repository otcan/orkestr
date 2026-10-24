use super::*;
use crate::conversation_resources_http::tests::{case, send};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Raw response bytes (the CSV export is not JSON).
async fn raw(state: &AppState, path: &str, headers: &[&str]) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let app = crate::router(state.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
    });
    let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
    let mut request = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:19882\r\nConnection: close\r\nAccept-Encoding: identity\r\n");
    for header in headers {
        request.push_str(header);
        request.push_str("\r\n");
    }
    request.push_str("\r\n");
    socket.write_all(request.as_bytes()).await.unwrap();
    let mut response = Vec::new();
    socket.read_to_end(&mut response).await.unwrap();
    let _ = stop.send(());
    server.await.unwrap();
    String::from_utf8(response).unwrap()
}

fn applied(company: &str, role: &str, at: i64, reference: &str) -> serde_json::Value {
    json!({"kind":"applied","company":company,"role":role,"source":"linkedin","occurred_ms":at,
           "message_ref":reference,"classifier":"rule:linkedin.applied","confidence":98,
           "link":"https://www.linkedin.com/comm/jobs/view/4012345678/?trk=x"})
}

#[tokio::test]
async fn tracker_routes_enable_record_edit_export_and_grant() {
    let case = case().await;
    let auth = case.auth();
    let (status, value) = send(&case.state, "GET", &case.path("/tracker"), &[&auth], "").await;
    assert_eq!(
        (status, value["code"].as_str()),
        (409, Some("tracker_not_enabled"))
    );
    let (status, value) = send(
        &case.state,
        "PUT",
        &case.path("/tracker"),
        &[&auth],
        &json!({"recipe":"job-tracker"}).to_string(),
    )
    .await;
    assert_eq!(status, 200, "{value}");
    assert_eq!(value["recipe"], "job-tracker");
    let batch = json!({"request_key":"scan-1","events":[
        applied("Acme Robotics GmbH", "Backend Engineer (Rust)", 1_792_486_800_000, "0123456789abcdef01234567"),
        {"kind":"interview_invite","company":"Acme Robotics","role":null,"source":"direct","occurred_ms":1_792_573_200_000i64,
         "classifier":"assistant","confidence":90}
    ]});
    let (status, set) = send(
        &case.state,
        "POST",
        &case.path("/tracker/events"),
        &[&auth],
        &batch.to_string(),
    )
    .await;
    assert_eq!(status, 200, "{set}");
    assert_eq!(set["changes"][0]["kind"], "created");
    assert_eq!(set["changes"][1]["kind"], "status_changed");
    assert_eq!(set["changes"][1]["notify"], true);
    let (_, replay) = send(
        &case.state,
        "POST",
        &case.path("/tracker/events"),
        &[&auth],
        &batch.to_string(),
    )
    .await;
    assert_eq!(replay, set);
    for bad in [
        json!({"request_key":"x","events":[{"kind":"applied"}]}),
        json!({"request_key":"x","events":[applied("A", "B", 1, "short")]}),
        json!({"request_key":"x","events":[], "extra": 1}),
    ] {
        let (status, _) = send(
            &case.state,
            "POST",
            &case.path("/tracker/events"),
            &[&auth],
            &bad.to_string(),
        )
        .await;
        assert_eq!(status, 400, "{bad}");
    }
    let (_, page) = send(&case.state, "GET", &case.path("/tracker"), &[&auth], "").await;
    let row = page["rows"][0].clone();
    assert_eq!(row["status"], "interview");
    let row_path = case.path(&format!("/tracker/rows/{}", row["id"].as_str().unwrap()));
    let (status, timeline) = send(
        &case.state,
        "GET",
        &format!("{row_path}/events"),
        &[&auth],
        "",
    )
    .await;
    assert_eq!(
        (status, timeline["events"].as_array().unwrap().len()),
        (200, 2)
    );
    let edit = json!({"expected_revision": row["revision"], "notes": "=cmd|'/C calc'!A0", "next_step": "Send availability"});
    let (status, edited) = send(&case.state, "POST", &row_path, &[&auth], &edit.to_string()).await;
    assert_eq!(
        (status, edited["next_step"].as_str()),
        (200, Some("Send availability"))
    );
    let (status, _) = send(&case.state, "POST", &row_path, &[&auth], &edit.to_string()).await;
    assert_eq!(status, 409);
    // CSV: BOM, header, the row, and the formula neutralised.
    let csv = raw(
        &case.state,
        &case.path("/tracker/export.csv?delimiter=semicolon"),
        &[&auth],
    )
    .await;
    assert!(csv.starts_with("HTTP/1.1 200"), "{csv}");
    assert!(csv.contains("content-type: text/csv; charset=utf-8"));
    assert!(csv.contains("\u{feff}company;role;status;"));
    assert!(
        csv.contains("Acme Robotics GmbH;Backend Engineer (Rust);interview;linkedin;2026-10-20;")
    );
    assert!(csv.contains(";'=cmd|'/C calc'!A0;"));
    let (status, _) = send(
        &case.state,
        "GET",
        &case.path("/tracker/export.csv?delimiter=tab"),
        &[&auth],
        "",
    )
    .await;
    assert_eq!(status, 400);
    // Grant: machine-only, scoped to this tracker's reads and events.
    let (status, issued) = send(
        &case.state,
        "POST",
        &case.path("/tracker/grant"),
        &[&auth],
        "",
    )
    .await;
    assert_eq!(status, 201);
    let grant = format!(
        "{TRACKER_GRANT_HEADER}: {}",
        issued["grant"].as_str().unwrap()
    );
    let (status, page) = send(&case.state, "GET", &case.path("/tracker"), &[&grant], "").await;
    assert_eq!((status, page["grant_issued"].as_bool()), (200, Some(true)));
    let note = json!({"request_key":"assistant-1","events":[{"kind":"note","company":"Acme Robotics GmbH","source":"direct",
        "occurred_ms":1_792_600_000_000_i64,"classifier":"assistant","confidence":80,"next_step":"Prepare for the interview on Thursday"}]});
    let (status, _) = send(
        &case.state,
        "POST",
        &case.path("/tracker/events"),
        &[&grant],
        &note.to_string(),
    )
    .await;
    assert_eq!(status, 200);
    // The grant cannot edit, merge, rotate, or be combined with other credentials.
    let (status, _) = send(
        &case.state,
        "POST",
        &case.path("/tracker/grant"),
        &[&grant],
        "",
    )
    .await;
    assert_eq!(status, 401);
    let (status, _) = send(
        &case.state,
        "GET",
        &case.path("/tracker"),
        &[&grant, &auth],
        "",
    )
    .await;
    assert_eq!(status, 401);
    let other = format!("/api/v2/conversations/{}/tracker", Uuid::new_v4());
    let (status, _) = send(&case.state, "GET", &other, &[&grant], "").await;
    assert_eq!(status, 401);
    let (status, _) = send(
        &case.state,
        "DELETE",
        &case.path("/tracker/grant"),
        &[&auth],
        "",
    )
    .await;
    assert_eq!(status, 204);
    let (status, _) = send(&case.state, "GET", &case.path("/tracker"), &[&grant], "").await;
    assert_eq!(status, 401);
    case.finish().await;
}
