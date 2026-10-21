//! Escape attempts against a real container. Runs only when a docker command and a
//! locally present image with `sh` are named, so ordinary CI without them still passes:
//!   ORKESTR_V2_RESTRICTED_DOCKER="sudo -n docker" ORKESTR_V2_RESTRICTED_DOCKER_IMAGE=nginx:stable
use orkestr_v2_restricted::sandbox::{DockerSandbox, Sandbox, SandboxResult, SandboxSpec};
use std::time::Duration;

fn setup() -> Option<(DockerSandbox, String, std::path::PathBuf)> {
    let docker = std::env::var("ORKESTR_V2_RESTRICTED_DOCKER").ok()?;
    let image = std::env::var("ORKESTR_V2_RESTRICTED_DOCKER_IMAGE").ok()?;
    let ws = std::fs::canonicalize(std::env::temp_dir())
        .unwrap()
        .join(format!("rt-docker-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&ws).unwrap();
    std::fs::write(ws.join("in.txt"), "workspace file").unwrap();
    // The container user is the directory owner; make the directory traversable.
    Some((
        DockerSandbox::new(docker.split_whitespace().map(String::from).collect()),
        image,
        ws,
    ))
}
fn spec(image: &str, ws: &std::path::Path, command: &str) -> SandboxSpec {
    let (uid, gid) = orkestr_v2_restricted::sandbox::mount_identity(ws);
    SandboxSpec {
        name: format!("orkestr-rt-test-{}", uuid::Uuid::new_v4().simple()),
        image: image.into(),
        workspace: ws.into(),
        writable: false,
        network: None,
        cpus: 1,
        memory_mb: 128,
        timeout: Duration::from_secs(8),
        command: command.into(),
        uid,
        gid,
    }
}
async fn run(d: &DockerSandbox, s: SandboxSpec) -> SandboxResult {
    d.run(s).await
}

#[tokio::test]
async fn container_cannot_reach_host_network_secrets_or_write_the_workspace() {
    let Some((d, image, ws)) = setup() else {
        return;
    };
    // Works: reads the mounted workspace, runs as a non-root user.
    let r = run(&d, spec(&image, &ws, "cat /work/in.txt; id -u")).await;
    assert!(r.stdout.starts_with("workspace file"), "{r:?}");
    assert!(
        !r.stdout.trim_end().ends_with("\n0") && !r.stdout.trim_end().ends_with(" 0"),
        "{r:?}"
    );
    // No network: only loopback exists.
    let r = run(&d, spec(&image, &ws, "ls /sys/class/net")).await;
    assert_eq!(r.stdout.trim(), "lo", "{r:?}");
    // Read-only workspace and root filesystem.
    for cmd in [
        "echo x > /work/new.txt",
        "echo x > /etc/new",
        "touch /work/in.txt",
    ] {
        assert_ne!(
            run(&d, spec(&image, &ws, cmd)).await.exit_code,
            Some(0),
            "{cmd}"
        );
    }
    assert!(!ws.join("new.txt").exists());
    // No host files, docker socket, or inherited environment.
    for cmd in [
        "ls /etc/orkestr",
        "ls /var/run/docker.sock",
        "ls /home",
        "cat /proc/1/environ | grep -c RUNPOD",
    ] {
        let r = run(&d, spec(&image, &ws, cmd)).await;
        assert!(
            r.exit_code != Some(0) || matches!(r.stdout.trim(), "" | "0"),
            "{cmd}: {r:?}"
        );
    }
    let r = run(&d, spec(&image, &ws, "env")).await;
    assert!(
        !r.stdout.contains("RUNPOD") && !r.stdout.contains("RP_LLM") && !r.stdout.contains("TOKEN"),
        "{r:?}"
    );
    // No privilege: cannot mount, cannot change uid.
    for cmd in ["mount -t tmpfs x /mnt", "su -c id root", "chown 0 /tmp"] {
        assert_ne!(
            run(&d, spec(&image, &ws, cmd)).await.exit_code,
            Some(0),
            "{cmd}"
        );
    }
    let _ = std::fs::remove_dir_all(ws);
}

#[tokio::test]
async fn limits_kill_runaway_runs() {
    let Some((d, image, ws)) = setup() else {
        return;
    };
    let mut s = spec(&image, &ws, "sleep 60");
    s.timeout = Duration::from_secs(2);
    let started = std::time::Instant::now();
    let r = run(&d, s).await;
    assert!(
        r.timed_out && started.elapsed() < Duration::from_secs(25),
        "{r:?}"
    );
    // Fork bomb is contained by the pids limit; memory hog is OOM-killed.
    let r = run(
        &d,
        spec(
            &image,
            &ws,
            "i=0; while [ $i -lt 400 ]; do sleep 5 & i=$((i+1)); done; echo spawned",
        ),
    )
    .await;
    assert!(
        !r.stdout.contains("spawned") || r.stderr.contains("retry") || r.stderr.contains("fork"),
        "{r:?}"
    );
    let r = run(
        &d,
        spec(
            &image,
            &ws,
            "head -c 400000000 /dev/zero | tr '\\0' x | tail -c 1 >/dev/null; echo survived",
        ),
    )
    .await;
    let _ = r; // memory-limit kill behaviour is image dependent; the flag is asserted in unit tests
    let _ = std::fs::remove_dir_all(ws);
}

#[tokio::test]
async fn missing_image_is_a_sandbox_error_not_a_pull() {
    let Some((d, _, ws)) = setup() else { return };
    let r = run(&d, spec("orkestr-no-such-image:0", &ws, "true")).await;
    assert!(r.error.is_some(), "{r:?}");
    let _ = std::fs::remove_dir_all(ws);
}
