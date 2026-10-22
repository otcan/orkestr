//! A stub OpenAI-compatible server: scripted chat-completion responses, and a record
//! of every request (headers and body) so tests can check what the model was shown.
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Default)]
pub struct Seen {
    pub requests: Vec<(String, Value)>,
}
pub struct Stub {
    pub url: String,
    pub seen: Arc<Mutex<Seen>>,
}

pub fn tool_call(id: &str, name: &str, args: Value) -> Value {
    json!({"id": id, "type": "function", "function": {"name": name, "arguments": args.to_string()}})
}
pub fn reply_calls(calls: Vec<Value>) -> Value {
    json!({"choices": [{"message": {"role": "assistant", "content": null, "tool_calls": calls}}]})
}
pub fn reply_text(text: &str) -> Value {
    json!({"choices": [{"message": {"role": "assistant", "content": text}}]})
}

/// `script` entries are served in order; afterwards a plain "done" reply.
pub async fn start(script: Vec<Value>) -> Stub {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    let seen: Arc<Mutex<Seen>> = Default::default();
    let queue = Arc::new(Mutex::new(
        script
            .into_iter()
            .collect::<std::collections::VecDeque<_>>(),
    ));
    let (s, q) = (seen.clone(), queue);
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let (s, q) = (s.clone(), q.clone());
            tokio::spawn(async move {
                let mut data = Vec::new();
                let mut buf = [0_u8; 4096];
                let (head_end, length) = loop {
                    let n = socket.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    data.extend_from_slice(&buf[..n]);
                    if let Some(pos) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&data[..pos]).to_ascii_lowercase();
                        let len = head
                            .lines()
                            .find_map(|l| l.strip_prefix("content-length:"))
                            .and_then(|v| v.trim().parse::<usize>().ok())
                            .unwrap_or(0);
                        break (pos + 4, len);
                    }
                };
                while data.len() < head_end + length {
                    let n = socket.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    data.extend_from_slice(&buf[..n]);
                }
                let head = String::from_utf8_lossy(&data[..head_end]).into_owned();
                let body: Value = serde_json::from_slice(&data[head_end..]).unwrap_or(Value::Null);
                s.lock().unwrap().requests.push((head, body));
                let reply = q
                    .lock()
                    .unwrap()
                    .pop_front()
                    .unwrap_or_else(|| reply_text("done"));
                let payload = reply.to_string();
                let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}", payload.len());
                let _ = socket.write_all(response.as_bytes()).await;
            });
        }
    });
    Stub { url, seen }
}
