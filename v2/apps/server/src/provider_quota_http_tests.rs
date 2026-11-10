use super::*;
use crate::conversation_resources_http::tests::{case, send};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::test]
async fn owner_binding_and_cookie_authority_are_checked_before_remote_read() {
    let mut c = case().await;
    let cookie = format!("Cookie: orkestr_v2_session={}", c.cookie);
    assert_eq!(
        send(&c.state, "GET", "/api/v2/provider-quotas", &[], "")
            .await
            .0,
        401
    );
    assert_eq!(
        send(&c.state, "GET", "/api/v2/provider-quotas", &[&c.auth()], "")
            .await
            .0,
        401
    );
    assert_eq!(
        send(&c.state, "GET", "/api/v2/provider-quotas", &[&cookie], "")
            .await
            .0,
        503
    );
    c.state.provider_quota = Some(Arc::new(Source {
        broker: Broker::new("http://127.0.0.1:9", "a".repeat(24)).unwrap(),
        owner: OwnerId(uuid::Uuid::new_v4()),
        legacy_owner: "synthetic-other".into(),
        cache: cache::Cache::default(),
    }));
    assert_eq!(
        send(&c.state, "GET", "/api/v2/provider-quotas", &[&cookie], "")
            .await
            .0,
        503
    );
    assert_eq!(
        send(
            &c.state,
            "GET",
            "/api/v2/provider-quotas?ownerUserId=foreign",
            &[&cookie],
            ""
        )
        .await
        .0,
        400
    );
    c.finish().await;
}
#[tokio::test]
async fn scoped_projection_and_revocation_during_the_read() {
    for revoke in [false, true] {
        let mut c = case().await;
        let owner = c
            .state
            .store
            .credentials("synthetic-owner")
            .await
            .unwrap()
            .unwrap()
            .0;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        c.state.provider_quota = Some(Arc::new(Source {
            broker: Broker::new(
                &format!("http://{}", listener.local_addr().unwrap()),
                "a".repeat(24),
            )
            .unwrap(),
            owner,
            legacy_owner: "legacy-owner".into(),
            cache: cache::Cache::default(),
        }));
        let store = c.state.store.clone();
        let token = format!("browser:{}", c.cookie);
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![];
            loop {
                let mut byte = [0];
                socket.read_exact(&mut byte).await.unwrap();
                request.push(byte[0]);
                if request.ends_with(b"\r\n\r\n") {
                    break;
                }
            }
            let request = String::from_utf8(request).unwrap();
            assert!(
                request.starts_with("GET /api/quota/providers?ownerUserId=legacy-owner HTTP/1.1")
            );
            assert!(request
                .to_ascii_lowercase()
                .contains("authorization: bearer aaaaaaaaaaaaaaaaaaaaaaaa"));
            if revoke {
                store.revoke_session(&token).await.unwrap();
            }
            let body = r#"{"quota":{"codex":{"fiveHourRemainingPct":42,"observedAt":"2026-01-01T00:00:00Z","account_ref":"private"},"claude":{"weeklyRemainingPct":0,"weeklyStatus":"allowed"}},"staleAfterMs":120000}"#;
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        });
        let cookie = format!("Cookie: orkestr_v2_session={}", c.cookie);
        let (status, value) =
            send(&c.state, "GET", "/api/v2/provider-quotas", &[&cookie], "").await;
        server.await.unwrap();
        assert_eq!(status, if revoke { 401 } else { 200 });
        if !revoke {
            assert_eq!(value["quota"]["codex"]["fiveHourRemainingPct"], 42.0);
            assert_eq!(value["quota"]["claude"]["weeklyRemainingPct"], 0.0);
            assert_eq!(value["quota"]["claude"]["weeklyStatus"], "allowed");
            assert_eq!(value["staleAfterMs"], 120000);
            assert!(!value.to_string().contains("private"));
            // The upstream has closed. A second request uses the validated cache,
            // while revocation must still deny that same cached response.
            assert_eq!(
                send(&c.state, "GET", "/api/v2/provider-quotas", &[&cookie], "")
                    .await
                    .0,
                200
            );
            c.state
                .store
                .revoke_session(&format!("browser:{}", c.cookie))
                .await
                .unwrap();
            assert_eq!(
                send(&c.state, "GET", "/api/v2/provider-quotas", &[&cookie], "")
                    .await
                    .0,
                401
            );
        }
        c.finish().await;
    }
}
