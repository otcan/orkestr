//! `start_gpu` through the host's `orkestr-llm` helper. The helper (and its root
//! watchdog) own every cost rule: off by default, 15 minute idle stop, 2 hour session
//! cap, daily hour/spend/start caps and the credit floor. This module only asks it to
//! start after the owner approved that exact request, and reports its answer.
use crate::broker::GpuControl;
use crate::exec::run_bounded_env;
use async_trait::async_trait;
use serde_json::Value;
use std::process::Command;
use std::time::Duration;

pub struct CliGpu {
    /// Absolute path of the helper, e.g. `/usr/local/bin/orkestr-llm`.
    pub command: String,
}

fn run(command: &str, args: &[&str], timeout: Duration) -> Result<(Option<i32>, String), String> {
    let mut c = Command::new(command);
    c.args(args);
    let out = run_bounded_env(c, &[], None, timeout, 16 * 1024, || {})
        .map_err(|e| format!("cannot run the GPU helper: {e}"))?;
    if out.timed_out {
        return Err("the GPU helper timed out".into());
    }
    let mut text = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    if text.is_empty() {
        text = String::from_utf8_lossy(&out.stderr).trim().to_owned();
    }
    Ok((out.status, text.chars().take(600).collect()))
}

/// Turns `orkestr-llm status --json` into `Ok(description)` or `Err(why a start is pointless)`.
pub fn describe_status(json: &str) -> Result<String, String> {
    let v: Value = serde_json::from_str(json)
        .map_err(|_| "the GPU helper returned an unreadable status".to_string())?;
    if !v["session"].is_null() {
        return Err(
            "the GPU is already started; it may still be booting (check again in a few minutes)"
                .into(),
        );
    }
    if let Some(why) = v["start_blocked"].as_str() {
        return Err(format!("the GPU cannot be started now: {why}"));
    }
    let n = |x: &Value| x.as_f64().unwrap_or(f64::NAN);
    let (gpu, dph) = (
        v["offer"]["gpu"].as_str().unwrap_or("GPU"),
        n(&v["offer"]["dph"]),
    );
    let today = &v["today_utc"];
    let caps = &v["caps"];
    Ok(format!(
        "Provider {} offers {gpu} at about ${dph:.2}/h plus about $0.13 download per start. Credit ${:.2}. Today: {:.1} of {} h, ${:.2} of ${:.2}, {} of {} starts. It stops after {} minutes without requests and at {} h per session.",
        v["backend"].as_str().unwrap_or("?"),
        n(&v["credit_usd"]),
        n(&today["hours"]),
        caps["hours_per_day"],
        n(&today["spend_usd"]),
        n(&caps["usd_per_day"]),
        today["starts"],
        caps["starts_per_day"],
        caps["idle_minutes"],
        caps["session_hours"],
    ))
}

#[async_trait]
impl GpuControl for CliGpu {
    async fn precheck(&self) -> Result<String, String> {
        let command = self.command.clone();
        let (_, text) = tokio::task::spawn_blocking(move || {
            run(&command, &["status", "--json"], Duration::from_secs(30))
        })
        .await
        .map_err(|_| "GPU status task failed".to_string())??;
        describe_status(&text)
    }
    async fn start(&self, _reason: &str) -> Result<String, String> {
        let command = self.command.clone();
        // No `--wait`: the helper returns once the instance is requested; booting takes minutes.
        let (code, text) = tokio::task::spawn_blocking(move || {
            run(&command, &["start"], Duration::from_secs(120))
        })
        .await
        .map_err(|_| "GPU start task failed".to_string())??;
        match code {
            Some(0) => Ok(format!("{text}\nThe model endpoint will answer in about 5 to 15 minutes; the GPU stops by itself when idle.")),
            _ => Err(text),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    const STATUS: &str = r#"{"backend":"vast","session":null,"start_blocked":null,"credit_usd":3.5,"offer":{"gpu":"L40S","dph":0.81},
      "today_utc":{"hours":0.34,"spend_usd":1.01,"starts":1},
      "caps":{"idle_minutes":15,"session_hours":2,"hours_per_day":4,"usd_per_day":5.0,"starts_per_day":3}}"#;

    #[test]
    fn status_becomes_an_owner_facing_cost_line() {
        let text = describe_status(STATUS).unwrap();
        for needle in [
            "vast",
            "L40S",
            "$0.81/h",
            "Credit $3.50",
            "1 of 3 starts",
            "15 minutes",
            "2 h per session",
        ] {
            assert!(text.contains(needle), "{needle}: {text}");
        }
    }
    #[test]
    fn blocked_running_or_garbled_status_is_a_reason_not_a_prompt() {
        let blocked = STATUS.replace(
            r#""start_blocked":null"#,
            r#""start_blocked":"daily cap reached""#,
        );
        assert!(describe_status(&blocked)
            .unwrap_err()
            .contains("daily cap reached"));
        let running = STATUS.replace(r#""session":null"#, r#""session":{"started_at":1}"#);
        assert!(describe_status(&running)
            .unwrap_err()
            .contains("already started"));
        assert!(describe_status("not json").is_err());
    }

    fn fake_helper(script: &str) -> (std::path::PathBuf, String) {
        let dir = std::env::temp_dir().join(format!("rt-gpu-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("orkestr-llm");
        std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        let log = dir.join("calls").display().to_string();
        (path, log)
    }

    #[tokio::test]
    async fn start_runs_only_the_start_subcommand_and_reports_refusals() {
        let (path, log) = fake_helper(&format!("echo \"$@\" >> {log}\ncase \"$1\" in status) echo '{status}';; start) echo 'started vast instance 1'; exit 0;; esac", log = "CALLS", status = STATUS.replace('\n', " ")));
        let script = std::fs::read_to_string(&path)
            .unwrap()
            .replace("CALLS", &log);
        std::fs::write(&path, script).unwrap();
        let gpu = CliGpu {
            command: path.display().to_string(),
        };
        assert!(gpu.precheck().await.unwrap().contains("L40S"));
        let started = gpu.start("why").await.unwrap();
        assert!(started.contains("started vast instance 1") && started.contains("stops by itself"));
        // Only `status --json` and `start` were ever invoked; no --wait, no other subcommand.
        assert_eq!(
            std::fs::read_to_string(&log).unwrap(),
            "status --json\nstart\n"
        );

        let (refuse, _) = fake_helper("echo 'REFUSED: daily cap reached'; exit 3");
        let err = CliGpu {
            command: refuse.display().to_string(),
        }
        .start("x")
        .await
        .unwrap_err();
        assert!(err.contains("REFUSED: daily cap reached"));
        assert!(CliGpu {
            command: "/nonexistent/orkestr-llm".into()
        }
        .start("x")
        .await
        .is_err());
    }
}
