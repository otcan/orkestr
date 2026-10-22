//! Preview fills resolve every thread, including empty threads and V1
//! errors, so steady-state sidebar requests never wait for V1.
use super::*;
use std::sync::Mutex as StdMutex;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const TOKEN: &str = "cccccccccccccccccccccccc";
const DELAY: Duration = Duration::from_millis(300);

/// Slow synthetic V1: `t-ok` has text, `t-empty` none, `t-error` fails.
async fn slow_v1(calls: Arc<StdMutex<Vec<String>>>) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let calls = calls.clone();
            tokio::spawn(async move {
                let mut raw = Vec::new();
                let mut buf = [0u8; 2048];
                while !raw.windows(4).any(|w| w == b"\r\n\r\n") {
                    let n = socket.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    raw.extend_from_slice(&buf[..n]);
                }
                let head = String::from_utf8_lossy(&raw).to_string();
                let path = head.split(' ').nth(1).unwrap_or_default().to_owned();
                calls.lock().unwrap().push(path.clone());
                tokio::time::sleep(DELAY).await;
                let (status, body) = if path.starts_with("/api/threads/t-ok/") {
                    (
                        200,
                        r#"{"messages":[{"id":"m1","role":"assistant","text":"Synthetic answer","cursor":1}]}"#,
                    )
                } else if path.starts_with("/api/threads/t-empty/") {
                    (200, r#"{"messages":[]}"#)
                } else {
                    (500, r#"{"error":"synthetic"}"#)
                };
                let reply = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(reply.as_bytes()).await;
            });
        }
    });
    format!("http://{address}")
}

fn thread(id: &str, last: &str) -> V1Thread {
    V1Thread {
        id: id.into(),
        name: id.into(),
        parent: None,
        kind: None,
        last_activity_ms: None,
        last_cursor: 1,
        last_role: Some("assistant".into()),
        last_message_id: Some(last.into()),
        working: false,
        whatsapp: true,
        delegated: false,
        delegated_to: None,
        retired: false,
        public_ref: None,
        instance_ref: None,
        chat_id: None,
        icon_title: id.into(),
        codex_thread_id: None,
        workspace: None,
    }
}

async fn settled(cache: &V1Cache) {
    for _ in 0..100 {
        if cache.lock().filling.is_none() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("preview fill did not finish");
}

#[tokio::test]
async fn empty_and_failed_previews_count_as_resolved() {
    let calls = Arc::new(StdMutex::new(Vec::new()));
    let broker = Arc::new(Broker::new(&slow_v1(calls.clone()).await, TOKEN.into()).unwrap());
    let cache = V1Cache::default();
    let threads = [
        thread("t-ok", "m1"),
        thread("t-empty", "e1"),
        thread("t-error", "x1"),
    ];
    let shown: Vec<&V1Thread> = threads.iter().collect();

    // First paint waits at most the budget for threads never read before.
    let started = Instant::now();
    let first = cache.previews(&broker, &shown).await;
    assert!(started.elapsed() < PREVIEW_WAIT + Duration::from_millis(100));
    assert!(first.is_empty(), "the slow fill is still running");
    settled(&cache).await;
    assert_eq!(calls.lock().unwrap().len(), 3);

    // Steady state: no reads and no waiting, also for the empty and the failed thread.
    for _ in 0..3 {
        let started = Instant::now();
        let page = cache.previews(&broker, &shown).await;
        assert!(
            started.elapsed() < Duration::from_millis(50),
            "{:?}",
            started.elapsed()
        );
        assert_eq!(page.len(), 1);
        assert_eq!(page["t-ok"].text, "Synthetic answer");
    }
    assert_eq!(calls.lock().unwrap().len(), 3);

    // A new message re-reads in the background; the old preview answers at once.
    let changed = [
        thread("t-ok", "m2"),
        thread("t-empty", "e1"),
        thread("t-error", "x1"),
    ];
    let shown: Vec<&V1Thread> = changed.iter().collect();
    let started = Instant::now();
    let page = cache.previews(&broker, &shown).await;
    assert!(started.elapsed() < Duration::from_millis(50));
    assert_eq!(page["t-ok"].text, "Synthetic answer");
    settled(&cache).await;
    assert_eq!(calls.lock().unwrap().len(), 4);

    // A failed read is retried after its TTL.
    cache.lock().previews.get_mut("t-error").unwrap().failed_at =
        Some(Instant::now() - PREVIEW_RETRY - Duration::from_secs(1));
    let _ = cache.previews(&broker, &shown).await;
    settled(&cache).await;
    assert_eq!(calls.lock().unwrap().len(), 5);
    assert!(calls.lock().unwrap()[4].starts_with("/api/threads/t-error/"));
}
