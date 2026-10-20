//! Exact bwrap layout for the trusted profile. Pure and inspectable: the
//! supervisor appends only `-- /bin/sh -c <command>` and never adds mounts.
use super::profile::{
    environment_key_allowed, environment_value_allowed, TrustedProfile, HOST_ETC,
};
use super::{Error, Result};
use std::path::Path;

pub(super) struct Descriptors {
    pub policy: i32,
    pub image: i32,
    pub workspace: i32,
}

pub(super) struct Layout {
    /// Host-privileged: no bwrap; the supervisor runs `/bin/sh -c` directly.
    pub host: bool,
    pub argv: Vec<String>,
    pub env: Vec<(String, String)>,
    /// Descriptors bwrap itself must inherit; everything else is closed.
    pub pass: Vec<i32>,
}

fn text(path: &Path) -> Result<String> {
    path.to_str().map(str::to_owned).ok_or(Error::InvalidConfig)
}

/// Namespaces, capabilities and seccomp are identical to the restricted profile
/// except that a network-enabled profile shares the host network namespace.
pub(super) fn trusted(
    profile: &TrustedProfile,
    fds: Descriptors,
    credentials: Vec<(String, String)>,
) -> Result<Layout> {
    let mut argv: Vec<String> = [
        "/usr/bin/bwrap",
        "--unshare-user",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        "--unshare-cgroup",
        "--disable-userns",
        "--assert-userns-disabled",
        "--die-with-parent",
        "--new-session",
        "--cap-drop",
        "ALL",
    ]
    .map(String::from)
    .into();
    if !profile.network {
        argv.push("--unshare-net".into());
    }
    let mut push = |items: &[&str]| argv.extend(items.iter().map(|s| s.to_string()));
    let mut pass = vec![fds.policy, fds.workspace];
    if profile.host_root {
        push(&["--ro-bind", "/usr", "/usr"]);
        for (link, target) in [
            ("/bin", "usr/bin"),
            ("/sbin", "usr/sbin"),
            ("/lib", "usr/lib"),
            ("/lib64", "usr/lib64"),
        ] {
            push(&["--symlink", target, link]);
        }
        for name in HOST_ETC {
            let path = format!("/etc/{name}");
            push(&["--ro-bind-try", &path, &path]);
        }
    } else {
        let image = fds.image.to_string();
        push(&["--ro-bind-fd", &image, "/"]);
        pass.push(fds.image);
    }
    let resources = profile.resources;
    let (home, workspace) = (text(&profile.home)?, text(&profile.workspace_target)?);
    let (shm, tmp, home_size) = (
        (16 * 1024 * 1024).to_string(),
        resources.tmp_bytes.to_string(),
        resources.home_bytes.to_string(),
    );
    push(&["--proc", "/proc", "--remount-ro", "/proc", "--dev", "/dev"]);
    push(&[
        "--size",
        &shm,
        "--tmpfs",
        "/dev/shm",
        "--remount-ro",
        "/dev",
    ]);
    push(&["--size", &tmp, "--tmpfs", "/tmp"]);
    push(&["--size", &home_size, "--tmpfs", &home]);
    push(&["--bind-fd", &fds.workspace.to_string(), &workspace]);
    // Parents before children so a nested credential bind is never shadowed.
    let mut mounts: Vec<_> = profile.mounts.iter().collect();
    mounts.sort_by_key(|m| (m.path.components().count(), m.path.clone()));
    for mount in mounts {
        let path = text(&mount.path)?;
        let flag = if mount.kind.writable() {
            "--bind"
        } else {
            "--ro-bind"
        };
        push(&[flag, &path, &path]);
    }
    if profile.host_root {
        // The synthetic root only holds mount points; nothing new is writable.
        push(&["--remount-ro", "/"]);
    }
    push(&["--chdir", &workspace, "--seccomp", &fds.policy.to_string()]);

    let path = profile
        .path
        .iter()
        .map(|p| text(p))
        .collect::<Result<Vec<_>>>()?
        .join(":");
    let mut env = vec![
        ("HOME".to_owned(), home),
        ("PATH".to_owned(), path),
        ("PWD".to_owned(), workspace),
        ("TMPDIR".to_owned(), "/tmp".to_owned()),
        ("LANG".to_owned(), "C.UTF-8".to_owned()),
    ];
    for (key, value) in profile.environment.iter().cloned().chain(credentials) {
        if !environment_key_allowed(&key)
            || !environment_value_allowed(&value)
            || env.iter().any(|(existing, _)| *existing == key)
        {
            return Err(Error::InvalidConfig);
        }
        env.push((key, value));
    }
    Ok(Layout {
        host: false,
        argv,
        env,
        pass,
    })
}

/// Host-privileged layout: the real executor environment, then operator and
/// credential additions, `PWD` at the real project path. Only the workspace
/// descriptor (for `fchdir`) is passed; no namespace, seccomp or mount.
pub(super) fn host(
    profile: &TrustedProfile,
    access: &super::profile::HostAccess,
    workspace: i32,
    credentials: Vec<(String, String)>,
) -> Result<Layout> {
    let mut env: Vec<(String, String)> = access
        .environment
        .iter()
        .filter(|(k, _)| k != "PWD")
        .cloned()
        .collect();
    env.push(("PWD".into(), text(&profile.workspace_target)?));
    for (key, value) in profile.environment.iter().cloned().chain(credentials) {
        if !super::profile::host_environment_key_allowed(&key)
            || !environment_value_allowed(&value)
            || env.iter().any(|(existing, _)| *existing == key)
        {
            return Err(Error::InvalidConfig);
        }
        env.push((key, value));
    }
    Ok(Layout {
        host: true,
        argv: vec![],
        env,
        pass: vec![workspace],
    })
}

/// Bounded `KEY=VALUE` parser for an operator-listed credential file. Any
/// malformed line refuses the command instead of guessing.
pub(super) fn credential_file(bytes: &[u8]) -> Result<Vec<(String, String)>> {
    if bytes.len() > 64 * 1024 {
        return Err(Error::InvalidConfig);
    }
    let text = std::str::from_utf8(bytes).map_err(|_| Error::InvalidConfig)?;
    let mut result = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let (key, value) = line.split_once('=').ok_or(Error::InvalidConfig)?;
        let value = value.trim();
        let value = [('"', '"'), ('\'', '\'')]
            .iter()
            .find_map(|(open, close)| {
                value
                    .strip_prefix(*open)
                    .and_then(|v| v.strip_suffix(*close))
            })
            .unwrap_or(value);
        let key = key.trim();
        if !environment_key_allowed(key) || !environment_value_allowed(value) {
            return Err(Error::InvalidConfig);
        }
        result.push((key.to_owned(), value.to_owned()));
    }
    Ok(result)
}

/// Read every listed credential file now, so rotation applies to the next
/// command and nothing secret is cached in long-lived server state.
pub(super) fn credentials(profile: &TrustedProfile) -> Result<Vec<(String, String)>> {
    let mut result = Vec::new();
    for file in &profile.credential_env_files {
        use std::io::Read;
        let mut bytes = Vec::new();
        std::fs::File::open(file)
            .map_err(|_| Error::InvalidConfig)?
            .take(64 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| Error::InvalidConfig)?;
        result.extend(credential_file(&bytes)?);
    }
    Ok(result)
}

/// One compact JSON document for the supervisor's sealed layout descriptor.
pub(super) fn encode(layout: &Layout) -> Vec<u8> {
    let env: serde_json::Map<_, _> = layout
        .env
        .iter()
        .map(|(k, v)| (k.clone(), serde_json::Value::String(v.clone())))
        .collect();
    if layout.host {
        return serde_json::to_vec(&serde_json::json!({
            "host": true, "env": env, "pass": layout.pass,
        }))
        .unwrap_or_default();
    }
    serde_json::to_vec(&serde_json::json!({
        "argv": layout.argv,
        "env": layout
            .env
            .iter()
            .map(|(k, v)| (k.clone(), serde_json::Value::String(v.clone())))
            .collect::<serde_json::Map<_, _>>(),
        "pass": layout.pass,
    }))
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::super::profile::{Mount, MountKind, Resources};
    use super::*;
    use std::time::Duration;

    fn profile() -> TrustedProfile {
        TrustedProfile {
            network: false,
            host_root: true,
            workspace_target: "/srv/project".into(),
            home: "/home/worker".into(),
            path: vec!["/opt/tool/bin".into(), "/usr/bin".into()],
            mounts: vec![
                Mount {
                    kind: MountKind::Credential,
                    path: "/home/worker/.config/tool/token".into(),
                },
                Mount {
                    kind: MountKind::Cache,
                    path: "/var/cache/builds".into(),
                },
                Mount {
                    kind: MountKind::Toolchain,
                    path: "/opt/tool".into(),
                },
            ],
            environment: vec![("CARGO_HOME".into(), "/var/cache/builds".into())],
            credential_env_files: vec![],
            resources: Resources::RESTRICTED,
            sync_timeout: Duration::from_secs(30),
            sync_output: 4096,
            job_timeout: Duration::from_secs(60),
            job_output: 4096,
            max_jobs: 1,
            host: None,
        }
    }
    fn fds() -> Descriptors {
        Descriptors {
            policy: 10,
            image: 11,
            workspace: 12,
        }
    }
    fn position(argv: &[String], window: &[&str]) -> Option<usize> {
        argv.windows(window.len())
            .position(|w| w.iter().zip(window).all(|(a, b)| a == b))
    }

    #[test]
    fn network_and_root_choice_change_only_their_own_flags() {
        let closed = trusted(&profile(), fds(), vec![]).unwrap();
        assert!(closed.argv.contains(&"--unshare-net".into()));
        assert!(position(&closed.argv, &["--ro-bind", "/usr", "/usr"]).is_some());
        assert!(position(&closed.argv, &["--remount-ro", "/"]).is_some());
        assert!(!closed.argv.contains(&"--ro-bind-fd".into()));
        assert_eq!(closed.pass, vec![10, 12]);
        let mut open = profile();
        open.network = true;
        let open = trusted(&open, fds(), vec![]).unwrap();
        assert!(!open.argv.contains(&"--unshare-net".into()));
        for flag in [
            "--unshare-user",
            "--unshare-pid",
            "--unshare-ipc",
            "--disable-userns",
            "--die-with-parent",
            "--new-session",
        ] {
            assert!(open.argv.contains(&flag.into()), "{flag}");
        }
        assert!(position(&open.argv, &["--cap-drop", "ALL"]).is_some());
        assert!(position(&open.argv, &["--seccomp", "10"]).is_some());
        let mut image = profile();
        image.host_root = false;
        image.mounts.clear();
        let image = trusted(&image, fds(), vec![]).unwrap();
        assert!(position(&image.argv, &["--ro-bind-fd", "11", "/"]).is_some());
        assert!(!image.argv.iter().any(|a| a == "/etc/passwd"));
    }

    #[test]
    fn mounts_follow_home_tmpfs_in_depth_order_with_exact_modes() {
        let layout = trusted(&profile(), fds(), vec![]).unwrap();
        let home = position(&layout.argv, &["--tmpfs", "/home/worker"]).unwrap();
        let workspace = position(&layout.argv, &["--bind-fd", "12", "/srv/project"]).unwrap();
        let tool = position(&layout.argv, &["--ro-bind", "/opt/tool", "/opt/tool"]).unwrap();
        let cache = position(
            &layout.argv,
            &["--bind", "/var/cache/builds", "/var/cache/builds"],
        )
        .unwrap();
        let token = position(
            &layout.argv,
            &[
                "--ro-bind",
                "/home/worker/.config/tool/token",
                "/home/worker/.config/tool/token",
            ],
        )
        .unwrap();
        assert!(home < workspace && workspace < tool && tool < token && cache < token);
        assert!(position(&layout.argv, &["--chdir", "/srv/project"]).is_some());
    }

    #[test]
    fn environment_is_fixed_then_operator_then_credentials_without_overrides() {
        let layout = trusted(
            &profile(),
            fds(),
            vec![("SERVICE_TOKEN".into(), "synthetic".into())],
        )
        .unwrap();
        let keys: Vec<_> = layout.env.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(
            keys,
            [
                "HOME",
                "PATH",
                "PWD",
                "TMPDIR",
                "LANG",
                "CARGO_HOME",
                "SERVICE_TOKEN"
            ]
        );
        assert_eq!(layout.env[1].1, "/opt/tool/bin:/usr/bin");
        // No credential value may appear in bwrap argv (visible in /proc).
        assert!(!layout.argv.iter().any(|a| a.contains("synthetic")));
        for (key, value) in [
            ("PATH", "/evil"),
            ("LD_PRELOAD", "/x.so"),
            ("CARGO_HOME", "dup"),
        ] {
            assert!(trusted(&profile(), fds(), vec![(key.into(), value.into())]).is_err());
        }
    }

    #[test]
    fn host_layout_uses_real_environment_and_only_the_workspace_descriptor() {
        let access = super::super::profile::HostAccess {
            environment: vec![
                ("HOME".into(), "/home/example".into()),
                ("PATH".into(), "/usr/local/bin:/usr/bin".into()),
                ("PWD".into(), "/stale".into()),
            ],
        };
        let layout = host(&profile(), &access, 12, vec![("TOKEN".into(), "x".into())]).unwrap();
        assert!(layout.host && layout.argv.is_empty());
        assert_eq!(layout.pass, vec![12]);
        let keys: Vec<_> = layout.env.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, ["HOME", "PATH", "PWD", "CARGO_HOME", "TOKEN"]);
        assert_eq!(layout.env[2].1, "/srv/project");
        let encoded: serde_json::Value = serde_json::from_slice(&encode(&layout)).unwrap();
        assert_eq!(encoded["host"], true);
        assert!(encoded.get("argv").is_none());
        assert!(host(&profile(), &access, 12, vec![("HOME".into(), "/x".into())]).is_err());
    }

    #[test]
    fn credential_files_parse_strictly() {
        let parsed =
            credential_file(b"# comment\n\nexport API_KEY=\"abc\"\nOTHER='x y'\nPLAIN=v=1\n")
                .unwrap();
        assert_eq!(
            parsed,
            vec![
                ("API_KEY".into(), "abc".into()),
                ("OTHER".into(), "x y".into()),
                ("PLAIN".into(), "v=1".into())
            ]
        );
        for bad in [
            &b"novalue\n"[..],
            b"LD_PRELOAD=/x\n",
            b"lower=1\n",
            b"\xff=1\n",
        ] {
            assert!(credential_file(bad).is_err());
        }
        assert!(credential_file(&vec![b'#'; 64 * 1024 + 1]).is_err());
    }
}
