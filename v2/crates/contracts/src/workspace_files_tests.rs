use super::*;

#[test]
fn paths_stay_relative_and_inside() {
    assert_eq!(workspace_path_parts(""), Ok(vec![]));
    assert_eq!(
        workspace_path_parts("docs/plan.md"),
        Ok(vec!["docs", "plan.md"])
    );
    for (path, error) in [
        ("..", WorkspacePathError::Traversal),
        ("docs/../..", WorkspacePathError::Traversal),
        ("./docs", WorkspacePathError::Traversal),
        ("/etc/passwd", WorkspacePathError::Absolute),
        ("docs//plan.md", WorkspacePathError::Invalid),
        ("docs/", WorkspacePathError::Invalid),
        ("a\nb", WorkspacePathError::Invalid),
        ("a\0b", WorkspacePathError::Invalid),
        (".ssh/id_ed25519", WorkspacePathError::Protected),
        ("docs/.env", WorkspacePathError::Protected),
        ("project/.codex/notes.txt", WorkspacePathError::Protected),
    ] {
        assert_eq!(workspace_path_parts(path), Err(error), "{path:?}");
    }
    assert_eq!(
        workspace_path_parts(&"x".repeat(WORKSPACE_PATH_BYTES_MAX + 1)),
        Err(WorkspacePathError::Invalid)
    );
    assert_eq!(
        workspace_path_parts(&vec!["a"; WORKSPACE_PATH_PARTS_MAX + 1].join("/")),
        Err(WorkspacePathError::Invalid)
    );
}

#[test]
fn secret_shaped_names_are_protected() {
    // The same cases as the workspace reader's own tests.
    for name in [
        ".ssh",
        ".codex",
        ".claude",
        ".aws",
        ".env",
        ".env.local",
        "prod.env",
        "server.key",
        "cert.pem",
        "id_ed25519",
        "id_rsa.pub",
        "auth.json",
        "github_token.txt",
        "authToken.json",
        "TOKEN",
        "api_key.txt",
        "apiKey.js",
        "client_secret.json",
        "credentials",
        "my-passwords.txt",
        ".git-credentials",
        ".netrc",
        "secrets",
    ] {
        assert!(workspace_name_protected(name), "{name}");
        assert!(!workspace_name_shown(name), "{name}");
    }
    for name in [
        "tokenizer.py",
        "keys.md",
        "environment.md",
        "monkey.png",
        "notes.md",
    ] {
        assert!(!workspace_name_protected(name), "{name}");
        assert!(workspace_name_shown(name), "{name}");
    }
}

#[test]
fn only_raster_images_preview_and_text_is_utf8() {
    assert_eq!(workspace_image_type("photo.JPG"), Some("image/jpeg"));
    assert_eq!(workspace_image_type("chart.png"), Some("image/png"));
    assert_eq!(workspace_image_type("diagram.svg"), None);
    assert_eq!(workspace_image_type("png"), None);
    assert_eq!(workspace_text(b"hello\n", false), Some("hello\n".into()));
    assert_eq!(workspace_text(b"bin\0ary", false), None);
    assert_eq!(workspace_text(&[0xff, 0xfe], false), None);
    // "é" cut after its first byte at the preview limit.
    assert_eq!(workspace_text(b"caf\xc3", true), Some("caf".into()));
    assert_eq!(workspace_text(b"caf\xc3", false), None);
}

#[test]
fn entries_are_closed() {
    let file = WorkspaceEntry {
        name: "notes.md".into(),
        kind: WorkspaceEntryKind::File,
        size: Some(3),
        modified_ms: 1,
        target: None,
    };
    assert!(file.is_valid() && file.opens_as_file() && !file.opens_as_folder());
    let link = WorkspaceEntry {
        name: "latest".into(),
        kind: WorkspaceEntryKind::Link,
        size: None,
        modified_ms: 1,
        target: Some(WorkspaceLinkTarget::Dir),
    };
    assert!(link.is_valid() && link.opens_as_folder());
    let outside = WorkspaceEntry {
        target: Some(WorkspaceLinkTarget::Outside),
        ..link.clone()
    };
    assert!(outside.is_valid() && !outside.opens_as_folder() && !outside.opens_as_file());
    for bad in [
        WorkspaceEntry {
            size: None,
            ..file.clone()
        },
        WorkspaceEntry {
            name: ".env".into(),
            ..file.clone()
        },
        WorkspaceEntry {
            name: "a/b".into(),
            ..file.clone()
        },
        WorkspaceEntry {
            target: None,
            ..link.clone()
        },
    ] {
        assert!(!bad.is_valid(), "{bad:?}");
    }
}
