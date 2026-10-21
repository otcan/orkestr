//! Path classification for file actions. Symlinks are resolved physically, one
//! component at a time (including `..` after a symlink), so traversal tricks,
//! symlinks planted through a writable sandbox mount and dangling links all end up
//! as the real location that is then compared with the thread workspace.
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathClass {
    /// Inside the thread workspace, fully resolved.
    Inside(PathBuf),
    /// A real location outside the workspace that is not otherwise forbidden.
    Outside(PathBuf),
    /// Never available to the model; the string is the reason shown to it.
    Denied(String),
}

/// Fixed system locations that hold credentials or host control.
const SYSTEM_ROOTS: &[&str] = &[
    "/proc",
    "/sys",
    "/dev",
    "/boot",
    "/root",
    "/etc/shadow",
    "/etc/gshadow",
    "/etc/sudoers",
    "/etc/sudoers.d",
    "/etc/orkestr",
    "/etc/ssh",
    "/etc/ssl/private",
    "/var/lib/orkestr-coordinator",
    "/run/secrets",
    "/run/docker.sock",
    "/var/run/docker.sock",
    "/run/user",
];
const SECRET_NAMES: &[&str] = &[
    ".ssh",
    ".gnupg",
    ".aws",
    ".kube",
    ".netrc",
    ".git-credentials",
    ".npmrc",
    ".pypirc",
    ".docker",
    ".secrets",
    "secrets",
    "credentials",
    "credentials.json",
    "kubeconfig",
    "shadow",
    ".pgpass",
    ".claude",
    ".codex",
];

/// Whether a single file name is one the model must never see or touch.
pub fn is_secret_name(name: &str) -> bool {
    secret_component(name)
}

fn secret_component(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    SECRET_NAMES.contains(&n.as_str())
        || n == ".env"
        || n.starts_with(".env.")
        || n.ends_with(".env")
        || n.starts_with("id_rsa")
        || n.starts_with("id_dsa")
        || n.starts_with("id_ecdsa")
        || n.starts_with("id_ed25519")
        || [
            ".pem",
            ".key",
            ".p12",
            ".pfx",
            ".kubeconfig",
            ".keystore",
            ".jks",
        ]
        .iter()
        .any(|suffix| n.ends_with(suffix))
        || (n.starts_with("service-account") && n.ends_with(".json"))
}

/// Components of `real` after `base`, as plain names.
fn names_after<'a>(real: &'a Path, base: Option<&Path>) -> Vec<&'a str> {
    let rest = base.and_then(|b| real.strip_prefix(b).ok()).unwrap_or(real);
    rest.components()
        .filter_map(|c| match c {
            Component::Normal(n) => n.to_str(),
            _ => None,
        })
        .collect()
}

/// Resolve `requested` against `workspace` without trusting any component.
pub fn resolve(workspace: &Path, requested: &str) -> Result<PathBuf, String> {
    if requested.is_empty() || requested.contains('\0') {
        return Err("invalid path".into());
    }
    let ws =
        std::fs::canonicalize(workspace).map_err(|_| "workspace is not available".to_string())?;
    let start = Path::new(requested);
    let mut cur = if start.is_absolute() {
        PathBuf::from("/")
    } else {
        ws.clone()
    };
    let mut pending: Vec<Component> = start.components().collect();
    pending.reverse();
    let mut steps = 0_u32;
    let mut missing = false;
    while let Some(component) = pending.pop() {
        steps += 1;
        if steps > 512 {
            return Err("path is too complex".into());
        }
        match component {
            Component::RootDir | Component::Prefix(_) => cur = PathBuf::from("/"),
            Component::CurDir => {}
            Component::ParentDir => {
                cur.pop();
            }
            Component::Normal(name) => {
                let next = cur.join(name);
                if missing {
                    cur = next;
                    continue;
                }
                match std::fs::symlink_metadata(&next) {
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                        missing = true;
                        cur = next;
                    }
                    Err(_) => return Err("path is not accessible".into()),
                    Ok(md) if md.file_type().is_symlink() => {
                        cur = std::fs::canonicalize(&next).map_err(|_| {
                            "path goes through a dangling or looping symlink".to_string()
                        })?;
                    }
                    Ok(_) => cur = next,
                }
            }
        }
    }
    Ok(cur)
}

pub fn classify(workspace: &Path, extra_deny_roots: &[PathBuf], requested: &str) -> PathClass {
    let real = match resolve(workspace, requested) {
        Ok(p) => p,
        Err(reason) => return PathClass::Denied(reason),
    };
    let ws = match std::fs::canonicalize(workspace) {
        Ok(p) => p,
        Err(_) => return PathClass::Denied("workspace is not available".into()),
    };
    for root in SYSTEM_ROOTS
        .iter()
        .map(PathBuf::from)
        .chain(extra_deny_roots.iter().cloned())
    {
        if real.starts_with(&root) && !ws.starts_with(&root) {
            return PathClass::Denied("that location holds credentials or host state".into());
        }
    }
    let inside = real.starts_with(&ws);
    let names = names_after(&real, if inside { Some(&ws) } else { None });
    if names.iter().any(|n| secret_component(n)) {
        return PathClass::Denied("credentials and secrets are never available".into());
    }
    if names
        .windows(2)
        .any(|w| w[0].eq_ignore_ascii_case(".git") && w[1].eq_ignore_ascii_case("config"))
    {
        return PathClass::Denied("credentials and secrets are never available".into());
    }
    if inside {
        return PathClass::Inside(real);
    }
    if names.iter().any(|n| n.eq_ignore_ascii_case(".orkestr")) {
        return PathClass::Denied(
            "other threads' data and Orkestr state are never available".into(),
        );
    }
    PathClass::Outside(real)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    struct Tree {
        root: PathBuf,
        ws: PathBuf,
    }
    impl Tree {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("rt-paths-{}", uuid::Uuid::new_v4()));
            let ws = root.join("ws");
            std::fs::create_dir_all(ws.join("sub")).unwrap();
            std::fs::create_dir_all(root.join("other")).unwrap();
            std::fs::create_dir_all(root.join("ws-evil")).unwrap();
            std::fs::write(ws.join("a.txt"), "a").unwrap();
            std::fs::write(root.join("other/secret.txt"), "s").unwrap();
            std::fs::write(root.join("ws-evil/x"), "x").unwrap();
            Self {
                ws: std::fs::canonicalize(&ws).unwrap(),
                root: std::fs::canonicalize(&root).unwrap(),
            }
        }
        fn class(&self, p: &str) -> PathClass {
            classify(&self.ws, &[], p)
        }
    }
    impl Drop for Tree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn plain_inside_paths() {
        let t = Tree::new();
        for p in ["a.txt", "./a.txt", "sub/../a.txt", "sub/new/file.txt", "."] {
            assert!(matches!(t.class(p), PathClass::Inside(_)), "{p}");
        }
        assert!(matches!(
            t.class(&format!("{}/a.txt", t.ws.display())),
            PathClass::Inside(_)
        ));
    }
    #[test]
    fn traversal_and_absolute_escapes_leave_the_workspace() {
        let t = Tree::new();
        for p in [
            "../other/secret.txt",
            "sub/../../other/secret.txt",
            "../../../../../../etc/passwd",
            "/etc/passwd",
        ] {
            assert!(
                matches!(t.class(p), PathClass::Outside(_)),
                "{p} -> {:?}",
                t.class(p)
            );
        }
    }
    #[test]
    fn sibling_with_the_same_prefix_is_not_inside() {
        let t = Tree::new();
        let p = format!("{}/ws-evil/x", t.root.display());
        assert!(matches!(t.class(&p), PathClass::Outside(_)));
        assert!(matches!(t.class("../ws-evil/x"), PathClass::Outside(_)));
    }
    #[test]
    fn symlinks_resolve_to_their_real_target() {
        let t = Tree::new();
        symlink(t.root.join("other"), t.ws.join("dirlink")).unwrap();
        symlink(t.root.join("other/secret.txt"), t.ws.join("filelink")).unwrap();
        symlink("a.txt", t.ws.join("inner")).unwrap();
        symlink("/nonexistent/target", t.ws.join("dangling")).unwrap();
        symlink("loop2", t.ws.join("loop1")).unwrap();
        symlink("loop1", t.ws.join("loop2")).unwrap();
        assert!(matches!(
            t.class("dirlink/secret.txt"),
            PathClass::Outside(_)
        ));
        assert!(matches!(t.class("filelink"), PathClass::Outside(_)));
        assert!(matches!(t.class("inner"), PathClass::Inside(_)));
        assert!(matches!(t.class("dangling"), PathClass::Denied(_)));
        assert!(matches!(t.class("dangling/x"), PathClass::Denied(_)));
        assert!(matches!(t.class("loop1"), PathClass::Denied(_)));
        // `..` after a symlink is physical: other/.. is the tree root, not the workspace.
        assert!(matches!(
            t.class("dirlink/../ws/a.txt"),
            PathClass::Inside(_)
        ));
        assert!(matches!(
            t.class("dirlink/../other/secret.txt"),
            PathClass::Outside(_)
        ));
        // A write target below a symlinked directory is outside too.
        assert!(matches!(t.class("dirlink/new.txt"), PathClass::Outside(_)));
    }
    #[test]
    fn symlink_to_system_secrets_is_denied_not_merely_outside() {
        let t = Tree::new();
        symlink("/etc/shadow", t.ws.join("s")).unwrap();
        symlink("/proc/self/environ", t.ws.join("e")).unwrap();
        symlink("/root", t.ws.join("r")).unwrap();
        for p in [
            "s",
            "e",
            "r/.bashrc",
            "/proc/self/environ",
            "/etc/orkestr/runpod.env",
            "/var/lib/orkestr-coordinator/LLM.md",
        ] {
            assert!(
                matches!(t.class(p), PathClass::Denied(_)),
                "{p} -> {:?}",
                t.class(p)
            );
        }
    }
    #[test]
    fn secret_names_are_denied_even_inside_the_workspace() {
        let t = Tree::new();
        for p in [
            ".env",
            ".ENV",
            ".env.local",
            "prod.env",
            "sub/.ssh/id_rsa",
            "id_ed25519",
            "k.pem",
            "x/server.key",
            ".aws/credentials",
            "service-account-prod.json",
            ".git/config",
            ".git-credentials",
            "sub/.netrc",
        ] {
            assert!(matches!(t.class(p), PathClass::Denied(_)), "{p}");
        }
        assert!(matches!(t.class("environment.txt"), PathClass::Inside(_)));
        assert!(matches!(t.class(".gitignore"), PathClass::Inside(_)));
    }
    #[test]
    fn orkestr_state_and_other_workspaces_are_denied() {
        let t = Tree::new();
        let managed = t.root.join(".orkestr/workspaces/other-thread");
        std::fs::create_dir_all(&managed).unwrap();
        assert!(matches!(
            t.class(&managed.display().to_string()),
            PathClass::Denied(_)
        ));
        assert!(matches!(
            t.class("../.orkestr/workspaces/other-thread/notes"),
            PathClass::Denied(_)
        ));
        // A workspace that itself lives under .orkestr/workspaces is still usable.
        assert!(matches!(
            classify(&managed, &[], "notes.md"),
            PathClass::Inside(_)
        ));
        assert!(matches!(
            classify(&managed, &[], "../another/notes.md"),
            PathClass::Denied(_)
        ));
    }
    #[test]
    fn operator_deny_roots_apply_after_resolution() {
        let t = Tree::new();
        let deny = vec![t.root.join("other")];
        assert!(matches!(
            classify(&t.ws, &deny, "../other/secret.txt"),
            PathClass::Denied(_)
        ));
        symlink(t.root.join("other"), t.ws.join("l")).unwrap();
        assert!(matches!(
            classify(&t.ws, &deny, "l/secret.txt"),
            PathClass::Denied(_)
        ));
    }
    #[test]
    fn odd_inputs_are_not_special() {
        let t = Tree::new();
        // No tilde, variable or percent expansion: these are ordinary file names.
        for p in ["~/x", "$HOME/x", "%2e%2e/x", "..\\x", "a.txt/"] {
            assert!(matches!(t.class(p), PathClass::Inside(_)), "{p}");
        }
        assert!(resolve(&t.ws, "a\0b").is_err());
        assert!(resolve(&t.ws, "").is_err());
        let deep = "a/".repeat(600);
        assert!(matches!(t.class(&deep), PathClass::Denied(_)));
        assert!(matches!(
            classify(Path::new("/nonexistent-ws"), &[], "x"),
            PathClass::Denied(_)
        ));
    }
}
