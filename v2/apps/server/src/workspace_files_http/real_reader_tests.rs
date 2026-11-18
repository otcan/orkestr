//! End to end with the real workspace reader (`v2/tools/workspace_reader.py`):
//! the traversal, symlink escape, deny list and size caps are enforced by
//! the reader and must reach the browser as fixed refusals.
use super::super::reader::SocketReader;
use super::*;
use std::path::{Path as FsPath, PathBuf};

/// The real workspace reader, run by the test's own user on a temporary
/// folder; Core talks to it over its socket exactly as on a host.
struct RealReader {
    child: std::process::Child,
    socket: PathBuf,
}
impl Drop for RealReader {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
async fn real_reader(root: &FsPath, conversation: &ConversationId) -> RealReader {
    let pinned = root.join("pinned");
    std::fs::create_dir_all(&pinned).unwrap();
    std::fs::create_dir_all(root.join("shared")).unwrap();
    let plan = root.join("beta.json");
    let mut pinned_folders = serde_json::Map::new();
    pinned_folders.insert(
        conversation.to_string(),
        serde_json::json!({"path": pinned.to_str().unwrap(), "shared": true}),
    );
    let shared = root.join("shared");
    std::fs::write(
        &plan,
        serde_json::json!({"workspace": shared.to_str().unwrap(),
            "conversation_workspaces": pinned_folders})
        .to_string(),
    )
    .unwrap();
    let socket = root.join("reader.sock");
    let script = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tools/workspace_reader.py"
    );
    let child = std::process::Command::new("python3")
        .args(["-I", "-S", "-B", script, "serve", "--plan"])
        .arg(plan)
        .arg("--peer-uid")
        .arg(rustix::process::getuid().as_raw().to_string())
        .arg("--socket")
        .arg(&socket)
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .spawn()
        .expect("python3 runs the workspace reader");
    for _ in 0..200 {
        if socket.exists() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    assert!(socket.exists(), "the workspace reader started");
    RealReader { child, socket }
}

#[tokio::test]
async fn the_real_reader_confines_every_request_to_the_folder() {
    let case = case().await;
    let owner = cookie(&case);
    let root = std::fs::canonicalize(&case.root).unwrap().join("folders");
    std::fs::create_dir_all(&root).unwrap();
    let reader = real_reader(&root, &case.conversation).await;
    let pinned = root.join("pinned");
    let outside = root.join("outside");
    std::fs::create_dir_all(pinned.join("docs")).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("private.txt"), "outside the folder").unwrap();
    std::fs::write(pinned.join("docs/plan.md"), "# Plan\n").unwrap();
    std::fs::write(pinned.join(".env"), "SECRET=1").unwrap();
    std::os::unix::fs::symlink(&outside, pinned.join("escape")).unwrap();
    std::os::unix::fs::symlink(outside.join("private.txt"), pinned.join("escape.txt")).unwrap();
    std::os::unix::fs::symlink(".env", pinned.join("settings")).unwrap();
    std::os::unix::fs::symlink("docs/plan.md", pinned.join("readme")).unwrap();
    // Sparse: above the download cap without writing 25 MiB.
    std::fs::File::create(pinned.join("huge.iso"))
        .unwrap()
        .set_len(WORKSPACE_DOWNLOAD_MAX + 1)
        .unwrap();
    std::fs::write(
        pinned.join("big.log"),
        vec![b'l'; WORKSPACE_TEXT_PREVIEW_MAX as usize + 100],
    )
    .unwrap();
    let state = case
        .state
        .clone()
        .with_workspace_reader(Arc::new(SocketReader::new(reader.socket.clone())));

    let reply = get(&state, &url(&case, "", ""), &[&owner]).await;
    assert_eq!(reply.status, 200);
    let value = reply.json();
    assert_eq!(
        (
            value["state"].as_str(),
            value["root_kind"].as_str(),
            value["root_name"].as_str(),
            value["hidden"].as_u64()
        ),
        (Some("ready"), Some("conversation"), Some("pinned"), Some(2))
    );
    let names: Vec<&str> = value["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect();
    assert_eq!(names[0], "docs", "folders first");
    assert!(!names.contains(&".env") && !names.contains(&"settings"));
    let escape = value["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["name"] == "escape")
        .unwrap();
    assert_eq!(
        (escape["kind"].as_str(), escape["target"].as_str()),
        (Some("link"), Some("outside"))
    );

    // A symlink that leaves the folder is never followed.
    for (route, path) in [
        ("", "escape"),
        ("/preview", "escape/private.txt"),
        ("/file", "escape.txt"),
    ] {
        let reply = get(&state, &url(&case, route, path), &[&owner]).await;
        assert_eq!(
            (reply.status, reply.code().as_str()),
            (403, "workspace_path_outside"),
            "{route} {path}"
        );
        assert!(!String::from_utf8_lossy(&reply.body).contains("outside the folder"));
    }
    // A harmless name linked to a protected file stays protected.
    let reply = get(&state, &url(&case, "/file", "settings"), &[&owner]).await;
    assert_eq!(
        (reply.status, reply.code().as_str()),
        (403, "workspace_protected")
    );
    // An in-folder link opens; previews and downloads stay within their caps.
    let reply = get(&state, &url(&case, "/file", "readme"), &[&owner]).await;
    assert_eq!(
        (reply.status, reply.body.as_slice()),
        (200, b"# Plan\n".as_slice())
    );
    let reply = get(&state, &url(&case, "/preview", "big.log"), &[&owner]).await;
    assert_eq!(
        (
            reply.json()["preview"]["truncated"].as_bool(),
            reply.json()["preview"]["text"].as_str().map(str::len)
        ),
        (Some(true), Some(WORKSPACE_TEXT_PREVIEW_MAX as usize))
    );
    let reply = get(&state, &url(&case, "/file", "huge.iso"), &[&owner]).await;
    assert_eq!(
        (reply.status, reply.code().as_str()),
        (413, "workspace_file_too_large")
    );
    let reply = get(&state, &url(&case, "/file", "missing.txt"), &[&owner]).await;
    assert_eq!(
        (reply.status, reply.code().as_str()),
        (404, "workspace_not_found")
    );
    // A missing folder is a state, not an error.
    std::fs::rename(&pinned, root.join("moved")).unwrap();
    let reply = get(&state, &url(&case, "", ""), &[&owner]).await;
    assert_eq!(
        (reply.status, reply.json()["state"].as_str()),
        (200, Some("missing"))
    );
    drop(reader);
    case.finish().await;
}
