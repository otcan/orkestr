//! Bounded child processes for the two helpers the broker uses: `docker` (sandbox)
//! and `curl` (HTTP). Environment is cleared, output is capped, and a deadline kills
//! the child. Runs on the blocking pool.
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Debug, Default)]
pub struct Output {
    pub status: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub timed_out: bool,
    pub truncated: bool,
}

type Shared = std::sync::Arc<std::sync::Mutex<(Vec<u8>, bool)>>;

fn capped_reader<R: Read + Send + 'static>(
    mut reader: R,
    cap: usize,
) -> (Shared, std::thread::JoinHandle<()>) {
    let shared: Shared = Default::default();
    let sink = shared.clone();
    let handle = std::thread::spawn(move || {
        let mut buf = [0_u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let mut guard = sink.lock().unwrap();
                    let room = cap.saturating_sub(guard.0.len());
                    if n > room {
                        guard.1 = true;
                    }
                    guard.0.extend_from_slice(&buf[..n.min(room)]);
                }
            }
        }
    });
    (shared, handle)
}

/// `on_timeout` runs once when the deadline passes, before the child is killed
/// (the sandbox uses it to `docker kill` the named container).
pub fn run_bounded(
    command: Command,
    stdin: Option<Vec<u8>>,
    timeout: Duration,
    cap: usize,
    on_timeout: impl FnOnce(),
) -> std::io::Result<Output> {
    run_bounded_env(command, &[], stdin, timeout, cap, on_timeout)
}

/// Like [`run_bounded`], with an explicit list of extra environment variables.
pub fn run_bounded_env(
    mut command: Command,
    env: &[(&str, &str)],
    stdin: Option<Vec<u8>>,
    timeout: Duration,
    cap: usize,
    on_timeout: impl FnOnce(),
) -> std::io::Result<Output> {
    command
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .envs(env.iter().copied())
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn()?;
    let writer = stdin.and_then(|data| {
        child.stdin.take().map(|mut pipe| {
            std::thread::spawn(move || {
                let _ = pipe.write_all(&data);
            })
        })
    });
    let out = child.stdout.take().map(|r| capped_reader(r, cap));
    let err = child.stderr.take().map(|r| capped_reader(r, cap));
    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status.code();
        }
        if Instant::now() >= deadline {
            timed_out = true;
            on_timeout();
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    if let Some(w) = writer {
        let _ = w.join();
    }
    // After a timeout a grandchild may still hold the pipes open: keep what was read
    // and do not wait for the readers.
    let collect = |reader: Option<(Shared, std::thread::JoinHandle<()>)>| match reader {
        Some((shared, handle)) => {
            if !timed_out {
                let _ = handle.join();
            }
            std::mem::take(&mut *shared.lock().unwrap())
        }
        None => Default::default(),
    };
    let (stdout, t1) = collect(out);
    let (stderr, t2) = collect(err);
    Ok(Output {
        status,
        stdout,
        stderr,
        timed_out,
        truncated: t1 || t2,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn captures_caps_and_times_out() {
        let mut c = Command::new("sh");
        c.args(["-c", "echo hi; echo err >&2; exit 3"]);
        let o = run_bounded(c, None, Duration::from_secs(5), 1024, || {}).unwrap();
        assert_eq!(
            (o.status, o.stdout.as_slice(), o.stderr.as_slice()),
            (Some(3), &b"hi\n"[..], &b"err\n"[..])
        );

        let mut c = Command::new("sh");
        c.args(["-c", "yes | head -c 100000"]);
        let o = run_bounded(c, None, Duration::from_secs(5), 100, || {}).unwrap();
        assert_eq!(o.stdout.len(), 100);
        assert!(o.truncated);

        let mut c = Command::new("sh");
        c.args(["-c", "sleep 30"]);
        let fired = std::cell::Cell::new(false);
        let started = Instant::now();
        let o = run_bounded(c, None, Duration::from_millis(100), 100, || fired.set(true)).unwrap();
        assert!(o.timed_out && fired.get() && started.elapsed() < Duration::from_secs(5));
    }
    #[test]
    fn environment_is_not_inherited() {
        std::env::set_var("RT_SECRET_PROBE", "leak");
        let mut c = Command::new("sh");
        c.args(["-c", "echo \"[$RT_SECRET_PROBE]\""]);
        let o = run_bounded(c, None, Duration::from_secs(5), 100, || {}).unwrap();
        assert_eq!(o.stdout, b"[]\n");
    }
}
