//! Deterministic tool-result text for trusted operations. Core bounds and
//! digests whatever is returned here exactly like any command output.
use super::jobs::{JobState, Record, Started};
use orkestr_runtime::worker_sandbox::WorkerOutput;
use orkestr_v2_store_sqlite::WorkspaceExecOutput;
use std::time::Duration;
use uuid::Uuid;

fn text(stdout: String, exit_code: Option<i32>, signal: Option<i32>) -> WorkspaceExecOutput {
    WorkspaceExecOutput {
        stdout: stdout.into_bytes(),
        stderr: vec![],
        exit_code,
        signal,
    }
}

pub(super) fn timed_out(timeout: Duration) -> WorkerOutput {
    WorkerOutput {
        exit_code: Some(124),
        signal: None,
        stdout: vec![],
        stderr: format!(
            "command timed out after {}s and was stopped; run long commands with background=true",
            timeout.as_secs()
        )
        .into_bytes(),
    }
}

pub(super) fn started(started: &Started, timeout: Duration) -> WorkspaceExecOutput {
    match started {
        Started::Started(id) => text(
            format!(
                "job={id} state=running timeout_s={}\nPoll with {{\"job\":\"{id}\",\"action\":\"wait\"}}.",
                timeout.as_secs()
            ),
            Some(0),
            None,
        ),
        Started::Busy(maximum) => text(
            format!("job refused: {maximum} background job(s) already running; wait for or cancel one"),
            Some(1),
            None,
        ),
    }
}

fn state(state: JobState) -> &'static str {
    match state {
        JobState::Running => "running",
        JobState::Exited => "exited",
        JobState::Signaled => "signaled",
        JobState::TimedOut => "timed_out",
        JobState::Cancelled => "cancelled",
        JobState::Failed => "failed",
        JobState::Lost => "lost",
    }
}

/// A finished job reports its own exit status as the tool result's status,
/// so a failed build is a failed tool call; a running job is a successful poll.
pub(super) fn status(id: Uuid, record: Option<Record>) -> WorkspaceExecOutput {
    let Some(record) = record else {
        return text(format!("job={id} state=unknown"), Some(2), None);
    };
    let elapsed = record
        .finished_at_ms
        .unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_millis() as i64)
        })
        .saturating_sub(record.started_at_ms)
        / 1000;
    let header = format!(
        "job={id} state={} elapsed_s={elapsed} exit_code={} signal={} output_bytes={}\n--- last output ---\n",
        state(record.state),
        record.exit_code.map_or("none".into(), |c| c.to_string()),
        record.signal.map_or("none".into(), |s| s.to_string()),
        record.output_bytes,
    );
    let (exit_code, signal) = match record.state {
        JobState::Running => (Some(0), None),
        JobState::Exited => (record.exit_code, None),
        JobState::Signaled => (None, record.signal),
        JobState::TimedOut => (Some(124), None),
        JobState::Cancelled => (Some(130), None),
        JobState::Failed | JobState::Lost => (Some(125), None),
    };
    let exit_code = exit_code.filter(|c| (0..=255).contains(c));
    let signal = signal.filter(|s| (1..=64).contains(s));
    let (exit_code, signal) = if exit_code.is_none() && signal.is_none() {
        (Some(125), None)
    } else {
        (exit_code, signal)
    };
    // Core shows the last 2 KiB of a long stream; keep the header in front.
    let mut tail = record.tail;
    if tail.len() > 2048 - header.len().min(1024) {
        let mut start = tail.len() - (2048 - header.len().min(1024));
        while !tail.is_char_boundary(start) {
            start += 1;
        }
        tail = tail.split_off(start);
    }
    text(format!("{header}{tail}"), exit_code, signal)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(state: JobState, exit_code: Option<i32>, signal: Option<i32>) -> Record {
        Record {
            id: Uuid::nil(),
            state,
            command_sha256: "0".repeat(64),
            started_at_ms: 1_000,
            finished_at_ms: Some(61_000),
            exit_code,
            signal,
            output_bytes: 10,
            tail: "error: synthetic\n".into(),
        }
    }

    #[test]
    fn status_maps_job_outcome_to_one_valid_tool_status() {
        let id = Uuid::new_v4();
        let exited = status(id, Some(record(JobState::Exited, Some(101), None)));
        assert_eq!((exited.exit_code, exited.signal), (Some(101), None));
        let text = String::from_utf8(exited.stdout).unwrap();
        assert!(text.contains("state=exited elapsed_s=60 exit_code=101"));
        assert!(text.ends_with("error: synthetic\n"));
        let signaled = status(id, Some(record(JobState::Signaled, None, Some(9))));
        assert_eq!((signaled.exit_code, signaled.signal), (None, Some(9)));
        assert_eq!(
            status(id, Some(record(JobState::TimedOut, None, None))).exit_code,
            Some(124)
        );
        assert_eq!(
            status(id, Some(record(JobState::Lost, None, None))).exit_code,
            Some(125)
        );
        assert_eq!(status(id, None).exit_code, Some(2));
        let mut long = record(JobState::Running, None, None);
        long.tail = "é".repeat(4000);
        let output = status(id, Some(long));
        assert_eq!(output.exit_code, Some(0));
        assert!(output.stdout.len() <= 2048 + 256);
        assert!(String::from_utf8(output.stdout).is_ok());
    }
}
