//! `run_sandboxed`: a throwaway container with no secrets, no network unless
//! granted, CPU/memory/time limits and only the thread's workspace mounted
//! (read-only unless the owner made it writable). Nothing from the server's
//! environment, filesystem or sockets is passed in.
use crate::exec::run_bounded;
use async_trait::async_trait;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

pub const OUTPUT_CAP: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SandboxSpec {
    pub name: String,
    pub image: String,
    pub workspace: PathBuf,
    pub writable: bool,
    /// `None` = no network at all. `Some(network)` = attach to that docker network.
    pub network: Option<String>,
    pub cpus: u32,
    pub memory_mb: u32,
    pub timeout: Duration,
    pub command: String,
    pub uid: u32,
    pub gid: u32,
}
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SandboxResult {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub truncated: bool,
    /// The sandbox itself could not run (docker missing, image absent...).
    pub error: Option<String>,
}
impl SandboxResult {
    pub fn render(&self) -> String {
        if let Some(error) = &self.error {
            return format!("sandbox unavailable: {error}");
        }
        let mut text = String::new();
        if self.timed_out {
            text.push_str("timed out and was killed\n");
        } else {
            text.push_str(&format!(
                "exit code {}\n",
                self.exit_code.map_or("unknown".into(), |c| c.to_string())
            ));
        }
        if !self.stdout.is_empty() {
            text.push_str("--- stdout ---\n");
            text.push_str(&self.stdout);
            if !self.stdout.ends_with('\n') {
                text.push('\n');
            }
        }
        if !self.stderr.is_empty() {
            text.push_str("--- stderr ---\n");
            text.push_str(&self.stderr);
            if !self.stderr.ends_with('\n') {
                text.push('\n');
            }
        }
        if self.truncated {
            text.push_str("[output truncated]\n");
        }
        text
    }
    pub fn ok(&self) -> bool {
        self.error.is_none() && !self.timed_out && self.exit_code == Some(0)
    }
}

#[async_trait]
pub trait Sandbox: Send + Sync {
    async fn run(&self, spec: SandboxSpec) -> SandboxResult;
}

/// Workspace owner's ids (never root) so a writable mount stays writable by the
/// owner and the container never runs as uid 0.
pub fn mount_identity(workspace: &Path) -> (u32, u32) {
    match std::fs::metadata(workspace) {
        Ok(md) if md.uid() != 0 && md.gid() != 0 => (md.uid(), md.gid()),
        _ => (65534, 65534),
    }
}

/// The complete `docker run` argument list (after the docker command itself).
pub fn docker_args(spec: &SandboxSpec) -> Vec<String> {
    let mut a: Vec<String> = ["run", "--rm", "--pull", "never", "--init"]
        .map(String::from)
        .to_vec();
    a.extend(["--name".into(), spec.name.clone()]);
    a.extend([
        "--network".into(),
        spec.network.clone().unwrap_or_else(|| "none".into()),
    ]);
    a.extend(
        [
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
        ]
        .map(String::from),
    );
    a.extend(["--pids-limit".into(), "128".into()]);
    a.extend([
        "--memory".into(),
        format!("{}m", spec.memory_mb),
        "--memory-swap".into(),
        format!("{}m", spec.memory_mb),
    ]);
    a.extend(["--cpus".into(), spec.cpus.to_string()]);
    a.extend([
        "--ulimit".into(),
        "nofile=256:256".into(),
        "--ulimit".into(),
        "core=0".into(),
    ]);
    a.extend(["--user".into(), format!("{}:{}", spec.uid, spec.gid)]);
    a.extend(["--tmpfs".into(), "/tmp:rw,noexec,nosuid,size=64m".into()]);
    a.extend([
        "--mount".into(),
        format!(
            "type=bind,source={},target=/work{}",
            spec.workspace.display(),
            if spec.writable { "" } else { ",readonly" }
        ),
    ]);
    a.extend(["--workdir".into(), "/work".into()]);
    // Only these two variables exist inside; nothing is inherited from the server.
    a.extend([
        "--env".into(),
        "HOME=/tmp".into(),
        "--env".into(),
        "PATH=/usr/local/bin:/usr/bin:/bin".into(),
    ]);
    a.extend([
        "--entrypoint".into(),
        "sh".into(),
        spec.image.clone(),
        "-c".into(),
        spec.command.clone(),
    ]);
    a
}

pub struct DockerSandbox {
    /// e.g. `["docker"]` or `["sudo", "-n", "docker"]`.
    pub docker: Vec<String>,
}
impl DockerSandbox {
    pub fn new(docker: Vec<String>) -> Self {
        Self { docker }
    }
}
#[async_trait]
impl Sandbox for DockerSandbox {
    async fn run(&self, spec: SandboxSpec) -> SandboxResult {
        let docker = self.docker.clone();
        let result = tokio::task::spawn_blocking(move || {
            let (program, base) = docker
                .split_first()
                .ok_or("docker command is not configured")?;
            let mut command = Command::new(program);
            command.args(base).args(docker_args(&spec));
            let kill = {
                let (program, base) = (program.clone(), base.to_vec());
                let name = spec.name.clone();
                move || {
                    let _ = Command::new(&program)
                        .args(&base)
                        .args(["kill", &name])
                        .output();
                }
            };
            // Allow container start-up on top of the run limit.
            run_bounded(
                command,
                None,
                spec.timeout + Duration::from_secs(10),
                OUTPUT_CAP,
                kill,
            )
            .map_err(|e| format!("could not start docker: {e}"))
        })
        .await;
        match result {
            Ok(Ok(out)) => {
                let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
                // Daemon-side failures (missing image, bad flag) have no container exit code of ours.
                let daemon_failure = out.status == Some(125)
                    || out.status == Some(126) && stderr.contains("docker:");
                SandboxResult {
                    exit_code: out.status,
                    stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
                    stderr: stderr.clone(),
                    timed_out: out.timed_out,
                    truncated: out.truncated,
                    error: daemon_failure
                        .then(|| stderr.lines().next().unwrap_or("docker failed").to_owned()),
                }
            }
            Ok(Err(error)) => SandboxResult {
                error: Some(error),
                ..Default::default()
            },
            Err(_) => SandboxResult {
                error: Some("sandbox task failed".into()),
                ..Default::default()
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> SandboxSpec {
        SandboxSpec {
            name: "orkestr-rt-test".into(),
            image: "python:3.12-slim".into(),
            workspace: "/srv/ws/one".into(),
            writable: false,
            network: None,
            cpus: 1,
            memory_mb: 256,
            timeout: Duration::from_secs(30),
            command: "echo hi; echo --privileged".into(),
            uid: 1000,
            gid: 1000,
        }
    }
    fn has(args: &[String], pair: &[&str]) -> bool {
        args.windows(pair.len())
            .any(|w| w.iter().zip(pair).all(|(a, b)| a == b))
    }

    #[test]
    fn container_is_locked_down() {
        let a = docker_args(&spec());
        for pair in [
            &["--network", "none"][..],
            &["--cap-drop", "ALL"],
            &["--security-opt", "no-new-privileges"],
            &["--pull", "never"],
            &["--memory", "256m"],
            &["--memory-swap", "256m"],
            &["--cpus", "1"],
            &["--pids-limit", "128"],
            &["--user", "1000:1000"],
            &["--entrypoint", "sh"],
            &["--workdir", "/work"],
        ] {
            assert!(has(&a, pair), "{pair:?} missing in {a:?}");
        }
        assert!(a.contains(&"--read-only".to_string()));
        // Exactly one mount: the workspace, read-only by default.
        assert_eq!(a.iter().filter(|x| *x == "--mount").count(), 1);
        assert!(a
            .iter()
            .any(|x| x == "type=bind,source=/srv/ws/one,target=/work,readonly"));
        for banned in [
            "--privileged",
            "-v",
            "--volume",
            "--device",
            "--pid",
            "--ipc",
            "--uts",
            "--cap-add",
            "--env-file",
            "--userns",
            "--network=host",
        ] {
            assert!(!a.iter().any(|x| x == banned), "{banned}");
        }
        // The model's command is a single argv element after the image: it cannot add flags.
        let image = a.iter().position(|x| x == "python:3.12-slim").unwrap();
        assert_eq!(&a[image + 1..], ["-c", "echo hi; echo --privileged"]);
        assert_eq!(a[image - 2], "--entrypoint");
        // Only fixed environment inside.
        let envs: Vec<&String> = a
            .iter()
            .enumerate()
            .filter(|(_, x)| *x == "--env")
            .map(|(i, _)| &a[i + 1])
            .collect();
        assert_eq!(envs, ["HOME=/tmp", "PATH=/usr/local/bin:/usr/bin:/bin"]);
    }
    #[test]
    fn writable_and_network_are_explicit() {
        let mut s = spec();
        s.writable = true;
        s.network = Some("restricted-egress".into());
        let a = docker_args(&s);
        assert!(a
            .iter()
            .any(|x| x == "type=bind,source=/srv/ws/one,target=/work"));
        assert!(has(&a, &["--network", "restricted-egress"]));
    }
    #[test]
    fn identity_is_never_root() {
        assert_eq!(mount_identity(Path::new("/")), (65534, 65534));
        assert_eq!(mount_identity(Path::new("/nonexistent")), (65534, 65534));
    }
    #[test]
    fn render_reports_each_outcome() {
        let ok = SandboxResult {
            exit_code: Some(0),
            stdout: "a".into(),
            ..Default::default()
        };
        assert!(
            ok.ok()
                && ok.render().contains("exit code 0")
                && ok.render().contains("--- stdout ---")
        );
        let timeout = SandboxResult {
            timed_out: true,
            ..Default::default()
        };
        assert!(!timeout.ok() && timeout.render().starts_with("timed out"));
        let down = SandboxResult {
            error: Some("no docker".into()),
            ..Default::default()
        };
        assert_eq!(down.render(), "sandbox unavailable: no docker");
    }
}
