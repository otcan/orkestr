use super::*;
use crate::conversation_resources_http::tests::{case, send};

#[test]
fn conversation_lists_are_bounded_unique_uuids() {
    let id = Uuid::new_v4().to_string();
    assert_eq!(parse_ids(&id).ok(), Some(vec![id.clone()]));
    let many: Vec<String> = (0..50).map(|_| Uuid::new_v4().to_string()).collect();
    assert_eq!(parse_ids(&many.join(",")).map(|v| v.len()).ok(), Some(50));
    let too_many: Vec<String> = (0..51).map(|_| Uuid::new_v4().to_string()).collect();
    for bad in [
        String::new(),
        format!("{id},{id}"),
        "not-a-uuid".into(),
        Uuid::nil().to_string(),
        id.replace('-', ""),
        too_many.join(","),
    ] {
        assert!(parse_ids(&bad).is_err(), "{bad}");
    }
}

#[tokio::test]
async fn one_request_answers_like_the_single_endpoints() {
    let case = case().await;
    let cookie = format!("Cookie: orkestr_v2_session={}", case.cookie);
    let id = case.conversation.to_string();
    let other = Uuid::new_v4().to_string();
    let (status, page) = send(
        &case.state,
        "GET",
        &format!("/api/v2/conversation-status?ids={id},{other}"),
        &[&cookie],
        "",
    )
    .await;
    assert_eq!(status, 200, "{page}");
    let rows = page["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["id"], id);
    for (row, target) in rows.iter().zip([&id, &other]) {
        for (key, path) in [("execution", "execution"), ("queue", "window/queue")] {
            let (single, body) = send(
                &case.state,
                "GET",
                &format!("/api/v2/conversations/{target}/{path}"),
                &[&cookie],
                "",
            )
            .await;
            assert_eq!(row[key]["status"], single, "{key} {target}");
            if single == 200 {
                assert_eq!(row[key]["body"], body);
            } else if single != 204 {
                assert_eq!(row[key]["body"]["code"], body["code"]);
            }
        }
    }
    let (status, _) = send(
        &case.state,
        "GET",
        &format!("/api/v2/conversation-status?ids={id}"),
        &[],
        "",
    )
    .await;
    assert_eq!(status, 401);
    let (status, _) = send(
        &case.state,
        "GET",
        "/api/v2/conversation-status?ids=nope",
        &[&cookie],
        "",
    )
    .await;
    assert_eq!(status, 400);
    case.finish().await;
}
