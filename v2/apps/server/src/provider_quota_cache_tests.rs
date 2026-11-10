use super::*;
use crate::{
    desktop_broker::Broker,
    provider_quota_http::{cache, Source},
};
use orkestr_v2_contracts::OwnerId;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::oneshot,
};

fn snapshot(percent: f64) -> Snapshot {
    serde_json::from_value(serde_json::json!({
        "quota":{"codex":{"weeklyRemainingPct":percent},"claude":{}},
        "staleAfterMs":120000
    }))
    .unwrap()
}
fn new_source(address: std::net::SocketAddr) -> Arc<Source> {
    Arc::new(Source {
        broker: Broker::new(&format!("http://{address}"), "a".repeat(24)).unwrap(),
        owner: OwnerId(uuid::Uuid::new_v4()),
        legacy_owner: "synthetic-owner".into(),
        cache: cache::Cache::default(),
    })
}
fn seed(source: &Source, age: Duration) {
    source.cache.value.send_replace(Some(Cached {
        snapshot: snapshot(42.0),
        received: Instant::now() - age,
    }));
}
async fn respond(socket: &mut tokio::net::TcpStream, body: &str) {
    let mut request = Vec::new();
    loop {
        request.push(socket.read_u8().await.unwrap());
        if request.ends_with(b"\r\n\r\n") {
            break;
        }
    }
    socket
        .write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .as_bytes(),
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn warm_requests_return_during_one_blocked_refresh_and_then_update() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let source = new_source(listener.local_addr().unwrap());
    seed(&source, REFRESH_AFTER + Duration::from_secs(1));
    let (release, held) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        held.await.unwrap();
        respond(
            &mut socket,
            &serde_json::to_string(&snapshot(17.0)).unwrap(),
        )
        .await;
        assert!(
            tokio::time::timeout(Duration::from_millis(50), listener.accept())
                .await
                .is_err()
        );
    });
    let mut updates = source.cache.value.subscribe();
    let requests = (0..20)
        .map(|_| {
            let source = source.clone();
            tokio::spawn(async move { source.snapshot().await.unwrap() })
        })
        .collect::<Vec<_>>();
    // The upstream is still blocked: all these responses must finish independently.
    for request in requests {
        let value = tokio::time::timeout(Duration::from_millis(200), request)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(value.quota.codex.weekly_remaining_pct, Some(42.0));
        assert!(value.quota.codex.stale);
    }
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(1), updates.changed())
        .await
        .unwrap()
        .unwrap();
    let value = source.snapshot().await.unwrap();
    assert_eq!(value.quota.codex.weekly_remaining_pct, Some(17.0));
    assert!(!value.quota.codex.stale);
    server.await.unwrap();
}

#[tokio::test]
async fn cold_timeout_keeps_refresh_alive_and_expired_data_is_never_returned() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let source = new_source(listener.local_addr().unwrap());
    seed(&source, RETAIN_FOR);
    let (release, held) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        held.await.unwrap();
        respond(
            &mut socket,
            &serde_json::to_string(&snapshot(11.0)).unwrap(),
        )
        .await;
    });
    let mut updates = source.cache.value.subscribe();
    assert!(
        tokio::time::timeout(Duration::from_millis(450), source.snapshot())
            .await
            .unwrap()
            .is_err()
    );
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(1), updates.changed())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        source
            .snapshot()
            .await
            .unwrap()
            .quota
            .codex
            .weekly_remaining_pct,
        Some(11.0)
    );
    server.await.unwrap();
}

#[tokio::test]
async fn invalid_refresh_preserves_last_good_data_and_backs_off() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let source = new_source(listener.local_addr().unwrap());
    seed(&source, REFRESH_AFTER);
    let (finished, done) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        respond(
            &mut socket,
            &serde_json::to_string(&snapshot(101.0)).unwrap(),
        )
        .await;
        finished.send(()).unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
    });
    source.prewarm();
    done.await.unwrap();
    tokio::time::timeout(Duration::from_secs(1), async {
        while source.cache.refresh.lock().unwrap().running {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    for _ in 0..3 {
        let value = source.snapshot().await.unwrap();
        assert_eq!(value.quota.codex.weekly_remaining_pct, Some(42.0));
        assert!(value.quota.codex.stale);
    }
    server.await.unwrap();
}

#[tokio::test]
async fn fresh_cache_does_not_call_upstream_and_expiry_is_bounded() {
    let source = new_source("127.0.0.1:9".parse().unwrap());
    seed(&source, Duration::ZERO);
    assert!(!source.snapshot().await.unwrap().quota.codex.stale);
    assert!(source.cache.refresh.lock().unwrap().attempted.is_none());
    let other = new_source("127.0.0.1:9".parse().unwrap());
    assert!(other.cache.value.borrow().is_none());
}
