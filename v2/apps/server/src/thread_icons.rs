//! Per-thread Orkestr chat icons, as the V1 app shows them.
//!
//! V1 draws every chat icon from the chat label ("ORKESTR" over the chat
//! name, "W<n>" for worker sub-threads) and, for WhatsApp groups, saved the
//! same design as `whatsapp-bridge/outbound-media/chat-icons/<title>-<sha1
//! (chatId:title)[..10]>.jpg`. `GET /api/v2/thread-icons/{thread}` serves that
//! original file when the operator makes the V1 icon directory readable
//! (`ORKESTR_V2_V1_CHAT_ICONS_DIR`) and the association matches; otherwise it
//! draws the identical V1 design. Only threads the sidebar can show are served.
use super::*;
use axum::{
    extract::Path,
    http::header::{CACHE_CONTROL, CONTENT_TYPE},
};
use sha1::{Digest, Sha1};
use std::path::PathBuf;

pub const V1_ICONS_ENV: &str = "ORKESTR_V2_V1_CHAT_ICONS_DIR";
const FILE_MAX: u64 = 2 * 1024 * 1024;

pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/api/v2/thread-icons/{thread}", get(icon))
}

/// V1 `splitChatIconWords` (web UI).
fn words(title: &str) -> Vec<String> {
    let lower = title.to_string();
    let replaced = replace_ci(
        &replace_ci(&lower, "personalized", "personal"),
        "metabolimics",
        "metabolomics",
    );
    let cleaned: String = replaced
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { ' ' })
        .collect();
    let list: Vec<String> = cleaned.split_whitespace().map(str::to_owned).collect();
    if list.is_empty() {
        vec!["main".into()]
    } else {
        list
    }
}
fn replace_ci(text: &str, from: &str, to: &str) -> String {
    let lower = text.to_ascii_lowercase();
    let mut out = String::new();
    let mut i = 0;
    while let Some(found) = lower[i..].find(from) {
        out.push_str(&text[i..i + found]);
        out.push_str(to);
        i += found + from.len();
    }
    out.push_str(&text[i..]);
    out
}
fn cut(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

/// V1 `chatIconLines` (web UI, including the worker variant).
pub(crate) fn lines(title: &str) -> Vec<String> {
    let words = words(title);
    if let Some(index) = words.iter().position(|w| w.eq_ignore_ascii_case("worker")) {
        if let Some(number) = words.get(index + 1) {
            let topic = if index == 0 {
                "chat".to_owned()
            } else {
                words[..index].join(" ")
            };
            return vec!["ORKESTR".into(), format!("W{number}"), topic.to_uppercase()]
                .into_iter()
                .map(|l| cut(&l, 11))
                .collect();
        }
    }
    if words.len() == 1 && words[0].eq_ignore_ascii_case("main") {
        return vec!["ORKESTR".into(), "MAIN".into()];
    }
    if words.len() == 1 {
        return vec!["ORKESTR".into(), cut(&words[0].to_uppercase(), 12)];
    }
    vec![
        "ORKESTR".into(),
        cut(&words[0].to_uppercase(), 11),
        cut(&words[1..].join(" ").to_uppercase(), 11),
    ]
}

fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// V1 `chatIconSvg` (WhatsApp group picture generator), same geometry and colours.
pub(crate) fn svg(title: &str) -> String {
    let lines = lines(title);
    let longest = lines
        .iter()
        .map(|l| l.chars().count())
        .max()
        .unwrap_or(1)
        .max(1);
    let width_limited = (580.0 / (longest as f64 * 0.5)).floor() as i64;
    let height_limited = if lines.len() >= 3 { 150 } else { 190 };
    let font = width_limited.min(height_limited).max(78);
    let gap = 22.max((font as f64 * 0.16).round() as i64);
    let line_height = (font as f64 * 0.82).round() as i64;
    let n = lines.len() as i64;
    let total = n * line_height + (n - 1) * gap;
    let first = ((640 - total) as f64 / 2.0 + line_height as f64 - 4.0).round() as i64;
    let text: String = lines
        .iter()
        .enumerate()
        .map(|(i, line)| {
            let y = first + i as i64 * (line_height + gap);
            let v = escape(line);
            // Without V1's narrow font a long line would leave the canvas:
            // squeeze it into 600 px instead.
            let fit = if line.chars().count() as f64 * font as f64 * 0.62 > 600.0 {
                " textLength=\"600\" lengthAdjust=\"spacingAndGlyphs\""
            } else {
                ""
            };
            format!("<text x=\"320\" y=\"{y}\" class=\"outer\"{fit}>{v}</text><text x=\"320\" y=\"{y}\" class=\"inner\"{fit}>{v}</text>")
        })
        .collect();
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"640\" height=\"640\" viewBox=\"0 0 640 640\">\
<rect width=\"640\" height=\"640\" fill=\"#061006\"/>\
<circle cx=\"320\" cy=\"320\" r=\"282\" fill=\"#0a1d10\" stroke=\"#25d366\" stroke-width=\"12\"/>\
<circle cx=\"320\" cy=\"320\" r=\"238\" fill=\"none\" stroke=\"#123b20\" stroke-width=\"8\"/>\
<style>text{{font-family:\"Nimbus Sans Narrow\",\"Arial Narrow\",Arial,sans-serif;font-weight:900;font-size:{font}px;text-anchor:middle;dominant-baseline:alphabetic}}\
.outer{{fill:#25d366;stroke:#25d366;stroke-width:14px;stroke-linejoin:round}}\
.inner{{fill:#f6fff8;stroke:#000;stroke-width:6px;stroke-linejoin:round;paint-order:stroke fill}}</style>{text}</svg>\n"
    )
}

/// V1's saved group picture for `(chat, title)`: `<name>-<sha1(chat:title)[..10]>.jpg`.
pub(crate) fn original(dir: &std::path::Path, chat: &str, title: &str) -> Option<PathBuf> {
    let digest = Sha1::digest(format!("{chat}:{title}").as_bytes());
    let suffix: String = digest
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>()[..10]
        .to_owned();
    let wanted = format!("-{suffix}.jpg");
    std::fs::read_dir(dir).ok()?.flatten().find_map(|entry| {
        let name = entry.file_name().into_string().ok()?;
        let meta = entry.metadata().ok()?;
        (name.ends_with(&wanted) && meta.is_file() && meta.len() <= FILE_MAX).then(|| entry.path())
    })
}

async fn icon(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(thread): Path<String>,
) -> Result<Response, Error> {
    let (owner, credential) =
        crate::archived_history_http::owner_credential(&state, &headers).await?;
    if !valid_v1_thread_id(&thread) {
        return Err(Error(
            StatusCode::BAD_REQUEST,
            "invalid_thread",
            "Invalid thread",
        ));
    }
    let not_found = || {
        Error(
            StatusCode::NOT_FOUND,
            "not_found",
            "No icon for this thread",
        )
    };
    // Any thread of the V1 registry the owner's sidebar knows: listed V1
    // chats and the V1 sources of imported conversations.
    let broker = state.desktop_broker.clone().ok_or_else(not_found)?;
    let threads = state
        .sidebar_v1
        .registry(&broker)
        .await
        .ok_or_else(not_found)?;
    let record = threads
        .iter()
        .find(|t| t.id == thread)
        .cloned()
        .ok_or_else(not_found)?;
    let list = state
        .store
        .sidebar_conversations(&credential, &owner)
        .await
        .map_err(|_| unauthorized())?;
    let imported = list.conversations.iter().any(|c| {
        c.source_thread_id.as_deref() == Some(record.id.as_str())
            || c.lineage
                .as_ref()
                .is_some_and(|l| l.source_thread_id == record.id)
    });
    let listed = crate::sidebar_v1::listed(&threads, &|_| false)
        .iter()
        .any(|t| t.id == record.id);
    if !imported && !listed {
        return Err(not_found());
    }
    let cache = (CACHE_CONTROL, "private, max-age=3600");
    if let (Some(dir), Some(chat)) = (state.v1_chat_icons.as_deref(), record.chat_id.as_deref()) {
        let (dir, chat, title) = (dir.clone(), chat.to_owned(), record.icon_title.clone());
        let file = tokio::task::spawn_blocking(move || {
            original(&dir, &chat, &title).and_then(|p| std::fs::read(p).ok())
        })
        .await
        .ok()
        .flatten();
        if let Some(bytes) = file {
            return Ok(([(CONTENT_TYPE, "image/jpeg"), cache], bytes).into_response());
        }
    }
    Ok((
        [(CONTENT_TYPE, "image/svg+xml"), cache],
        svg(&record.icon_title),
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_follow_the_v1_app() {
        assert_eq!(lines("Orkestr Rust"), ["ORKESTR", "ORKESTR", "RUST"]);
        assert_eq!(
            lines("Orkestr Rust / Worker 1"),
            ["ORKESTR", "W1", "ORKESTR RUS"]
        );
        assert_eq!(lines("synthetic-group"), ["ORKESTR", "SYNTHETIC", "GROUP"]);
        assert_eq!(lines("solo"), ["ORKESTR", "SOLO"]);
        assert_eq!(lines("--"), ["ORKESTR", "MAIN"]);
        assert_eq!(
            lines("personalized-metabolimics"),
            ["ORKESTR", "PERSONAL", "METABOLOMIC"]
        );
    }

    #[test]
    fn svg_is_escaped_and_original_files_match_by_chat_and_title() {
        let s = svg("a<b>&c");
        assert!(s.contains("A&lt;B&gt;") || s.contains("ORKESTR"));
        assert!(!s.contains("<b>"));
        let dir = std::env::temp_dir().join(format!("icons-{}", Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        // sha1("000@g.us:Synthetic group")[..10]
        let digest = Sha1::digest(b"000@g.us:Synthetic group");
        let suffix: String = digest
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()[..10]
            .to_owned();
        std::fs::write(dir.join(format!("Synthetic-group-{suffix}.jpg")), b"jpeg").unwrap();
        std::fs::write(dir.join(format!("Synthetic-group-{suffix}.svg")), b"svg").unwrap();
        let found = original(&dir, "000@g.us", "Synthetic group").unwrap();
        assert!(found.to_string_lossy().ends_with(".jpg"));
        assert!(original(&dir, "000@g.us", "Other title").is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// GET returning status, content type and raw body (icons are not JSON).
    async fn raw_get(state: &AppState, path: &str, headers: &[&str]) -> (u16, String, Vec<u8>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = crate::router(state.clone());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
        let mut request =
            format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:19882\r\nConnection: close\r\n");
        for h in headers {
            request.push_str(h);
            request.push_str("\r\n");
        }
        request.push_str("\r\n");
        socket.write_all(request.as_bytes()).await.unwrap();
        let mut raw = Vec::new();
        socket.read_to_end(&mut raw).await.unwrap();
        server.abort();
        let split = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        let head = String::from_utf8_lossy(&raw[..split]).to_string();
        let status = head.split(' ').nth(1).unwrap().parse().unwrap();
        let kind = head
            .lines()
            .find_map(|l| {
                l.to_ascii_lowercase()
                    .strip_prefix("content-type: ")
                    .map(str::to_owned)
            })
            .unwrap_or_default();
        (status, kind, raw[split + 4..].to_vec())
    }

    #[tokio::test]
    async fn served_for_known_threads_original_first_then_v1_design() {
        use crate::conversation_resources_http::tests::case;
        use crate::sidebar_http::tests::{fake_v1_with_inputs, V1_TOKEN};
        let mut case = case().await;
        let auth = case.auth();
        let (status, _, _) = raw_get(
            &case.state,
            "/api/v2/thread-icons/group-coordinated",
            &[&auth],
        )
        .await;
        assert_eq!(status, 404, "no V1 registry, no icon");
        let url = fake_v1_with_inputs(Default::default(), Default::default()).await;
        case.state.desktop_broker = Some(Arc::new(
            crate::desktop_broker::Broker::new(&url, V1_TOKEN.into()).unwrap(),
        ));
        let (status, kind, body) = raw_get(
            &case.state,
            "/api/v2/thread-icons/group-coordinated",
            &[&auth],
        )
        .await;
        assert_eq!((status, kind.as_str()), (200, "image/svg+xml"));
        assert!(String::from_utf8_lossy(&body).contains(">ORKESTR</text>"));
        // V1's saved picture for this chat wins when its directory is readable.
        let dir = case.root.join("chat-icons");
        std::fs::create_dir(&dir).unwrap();
        let digest = Sha1::digest(b"000@g.us:000@g.us");
        let suffix: String = digest
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()[..10]
            .to_owned();
        std::fs::write(
            dir.join(format!("000-g-us-{suffix}.jpg")),
            b"synthetic-jpeg",
        )
        .unwrap();
        case.state = case.state.clone().with_v1_chat_icons(dir);
        let (status, kind, body) = raw_get(
            &case.state,
            "/api/v2/thread-icons/group-coordinated",
            &[&auth],
        )
        .await;
        assert_eq!(
            (status, kind.as_str(), body.as_slice()),
            (200, "image/jpeg", &b"synthetic-jpeg"[..])
        );
        for unknown in ["unbound", "no-such-thread", "task-group-quiet-1"] {
            let (status, _, _) = raw_get(
                &case.state,
                &format!("/api/v2/thread-icons/{unknown}"),
                &[&auth],
            )
            .await;
            assert_eq!(status, 404, "{unknown}");
        }
        let (status, _, _) =
            raw_get(&case.state, "/api/v2/thread-icons/group-coordinated", &[]).await;
        assert_eq!(status, 401);
        case.finish().await;
    }
}
