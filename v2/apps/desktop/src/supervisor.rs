//! Starts the bundled Orkestr server, waits until it answers, restarts it
//! after a crash (with backoff and a crash-loop limit) and stops it on quit.
use std::collections::VecDeque;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

/// Logging switches passed through for support and tests; they cannot
/// change where the server keeps data or whom it trusts.
const DIAGNOSTICS: [&str; 2] = ["ORKESTR_V2_ACCESS_LOG", "ORKESTR_V2_SLOW_MS"];

/// Everything needed to start one server process.
#[derive(Debug, Clone)]
pub struct ServerSpec {
    pub program: PathBuf,
    pub home: PathBuf,
    pub port: u16,
    pub token: String,
    pub ui_dist: PathBuf,
    pub log_dir: PathBuf,
    pub codex: Option<PathBuf>,
}

impl ServerSpec {
    /// The server command with a minimal, explicit environment. Inherited
    /// `ORKESTR_*` variables are dropped so a developer shell cannot point the
    /// desktop server at other data.
    pub fn command(&self) -> Command {
        let mut command = Command::new(&self.program);
        for (key, _) in std::env::vars_os() {
            let name = key.to_string_lossy();
            if name.starts_with("ORKESTR") && !DIAGNOSTICS.contains(&name.as_ref()) {
                command.env_remove(key);
            }
        }
        command
            .env("ORKESTR_V2_HOME", &self.home)
            .env("ORKESTR_V2_BIND", format!("127.0.0.1:{}", self.port))
            .env("ORKESTR_V2_BOOTSTRAP_TOKEN", &self.token)
            .env("ORKESTR_V2_UI_DIST", &self.ui_dist)
            .stdin(Stdio::null());
        if let Some(codex) = &self.codex {
            command.env("ORKESTR_V2_CODEX_BIN", codex);
        }
        #[cfg(target_os = "linux")]
        {
            use std::os::unix::process::CommandExt;
            // The server must not outlive the app, even if the app crashes.
            unsafe {
                command.pre_exec(|| {
                    if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) != 0 {
                        return Err(io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        command
    }

    /// Spawns the server with stdout and stderr in `server.log` (the previous
    /// run is kept as `server.log.1`).
    pub fn spawn(&self) -> io::Result<Child> {
        fs::create_dir_all(&self.log_dir)?;
        let log = self.log_dir.join("server.log");
        if log.exists() {
            let _ = fs::rename(&log, self.log_dir.join("server.log.1"));
        }
        let out = File::create(&log)?;
        let err = out.try_clone()?;
        self.command()
            .stdout(Stdio::from(out))
            .stderr(Stdio::from(err))
            .spawn()
    }
}

/// A minimal HTTP/1.1 GET against the loopback server (no TLS, no proxies).
pub fn http_get(port: u16, path: &str, headers: &[(&str, &str)]) -> io::Result<(u16, String)> {
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    let mut request =
        format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n");
    for (name, value) in headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    request.push_str("\r\n");
    stream.write_all(request.as_bytes())?;
    let mut response = Vec::new();
    stream.take(1 << 20).read_to_end(&mut response)?;
    let text = String::from_utf8_lossy(&response).into_owned();
    let status = text
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "not an HTTP response"))?;
    let body = text
        .split_once("\r\n\r\n")
        .map(|(_, body)| body.to_owned())
        .unwrap_or_default();
    Ok((status, body))
}

pub fn healthy(port: u16) -> bool {
    matches!(http_get(port, "/api/v2/health", &[]), Ok((200, body)) if body.contains("orkestr-v2"))
}

/// Whether the first owner account still has to be created.
pub fn setup_required(port: u16, token: &str) -> io::Result<bool> {
    let (status, body) = http_get(port, "/api/v2/setup", &[("x-orkestr-bootstrap", token)])?;
    if status != 200 {
        return Err(io::Error::other(format!("setup status {status}")));
    }
    let value: serde_json::Value = serde_json::from_str(body.trim())
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    value["setup_required"]
        .as_bool()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing setup_required"))
}

#[derive(Debug)]
pub enum StartError {
    Exited(Option<i32>),
    Timeout,
    Io(io::Error),
}

impl std::fmt::Display for StartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Exited(code) => write!(f, "the server stopped during startup (exit {code:?})"),
            Self::Timeout => write!(f, "the server did not answer in time"),
            Self::Io(error) => write!(f, "the server could not start: {error}"),
        }
    }
}

/// Polls health until the server answers, exits or the deadline passes.
pub fn wait_healthy(child: &mut Child, port: u16, timeout: Duration) -> Result<(), StartError> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait().map_err(StartError::Io)? {
            return Err(StartError::Exited(status.code()));
        }
        if healthy(port) {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(StartError::Timeout);
        }
        thread::sleep(Duration::from_millis(100));
    }
}

/// Asks the server to stop (SIGTERM on Unix) and kills it after `grace`.
pub fn terminate(child: &mut Child, grace: Duration) {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return;
    }
    #[cfg(unix)]
    unsafe {
        libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
    }
    let deadline = Instant::now() + grace;
    while Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Restart policy: at most `limit` restarts within `window`.
#[derive(Debug)]
pub struct CrashBudget {
    limit: usize,
    window: Duration,
    base: Duration,
    restarts: VecDeque<Instant>,
}

impl CrashBudget {
    pub fn new(limit: usize, window: Duration, base: Duration) -> Self {
        Self {
            limit,
            window,
            base,
            restarts: VecDeque::new(),
        }
    }
    /// Records a crash; returns the backoff before the next start, or `None`
    /// when the server keeps crashing and the app should stop retrying.
    pub fn crashed(&mut self, now: Instant) -> Option<Duration> {
        while self
            .restarts
            .front()
            .is_some_and(|t| now.duration_since(*t) > self.window)
        {
            self.restarts.pop_front();
        }
        if self.restarts.len() >= self.limit {
            return None;
        }
        self.restarts.push_back(now);
        Some(self.base * (1 << self.restarts.len().min(5)))
    }
}

pub enum Event {
    /// The server answers on its port (first start or after a restart).
    Ready { first: bool },
    /// The server crashed; it is restarted after the backoff.
    Restarting(String),
    /// The server keeps failing; the app stops retrying.
    Failed(String),
}

/// Runs the server on a background thread until [`Supervisor::shutdown`].
pub struct Supervisor {
    stop: Arc<AtomicBool>,
    child: Arc<Mutex<Option<Child>>>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl Supervisor {
    pub fn start(spec: ServerSpec, on_event: impl Fn(Event) + Send + 'static) -> Self {
        let budget = CrashBudget::new(5, Duration::from_secs(120), Duration::from_millis(500));
        Self::start_with(spec, budget, on_event)
    }

    pub fn start_with(
        spec: ServerSpec,
        mut budget: CrashBudget,
        on_event: impl Fn(Event) + Send + 'static,
    ) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let child = Arc::new(Mutex::new(None::<Child>));
        let (thread_stop, thread_child) = (stop.clone(), child.clone());
        let thread = thread::spawn(move || {
            let mut first = true;
            while !thread_stop.load(Ordering::SeqCst) {
                let reason = match spec.spawn() {
                    Err(error) => StartError::Io(error).to_string(),
                    Ok(mut process) => {
                        let started =
                            wait_healthy(&mut process, spec.port, Duration::from_secs(60));
                        *thread_child.lock().unwrap() = Some(process);
                        match started {
                            Err(error) => error.to_string(),
                            Ok(()) => {
                                on_event(Event::Ready { first });
                                first = false;
                                watch(&thread_child, &thread_stop)
                            }
                        }
                    }
                };
                if let Some(mut process) = thread_child.lock().unwrap().take() {
                    terminate(&mut process, Duration::from_secs(5));
                }
                if thread_stop.load(Ordering::SeqCst) {
                    break;
                }
                match budget.crashed(Instant::now()) {
                    Some(backoff) => {
                        on_event(Event::Restarting(reason));
                        sleep_unless(&thread_stop, backoff);
                    }
                    None => {
                        on_event(Event::Failed(reason));
                        break;
                    }
                }
            }
        });
        Self {
            stop,
            child,
            thread: Mutex::new(Some(thread)),
        }
    }

    pub fn shutdown(&self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(mut process) = self.child.lock().unwrap().take() {
            terminate(&mut process, Duration::from_secs(5));
        }
        if let Some(thread) = self.thread.lock().unwrap().take() {
            let _ = thread.join();
        }
    }
}

/// Waits until the running server exits (returns why) or a stop is requested.
fn watch(child: &Arc<Mutex<Option<Child>>>, stop: &AtomicBool) -> String {
    loop {
        if stop.load(Ordering::SeqCst) {
            return "stopping".into();
        }
        if let Some(process) = child.lock().unwrap().as_mut() {
            if let Ok(Some(status)) = process.try_wait() {
                return format!("the server stopped unexpectedly (exit {:?})", status.code());
            }
        } else {
            return "stopping".into();
        }
        thread::sleep(Duration::from_millis(250));
    }
}

fn sleep_unless(stop: &AtomicBool, duration: Duration) {
    let deadline = Instant::now() + duration;
    while Instant::now() < deadline && !stop.load(Ordering::SeqCst) {
        thread::sleep(Duration::from_millis(50));
    }
}

/// Where Tauri puts an `externalBin` sidecar: next to the app executable.
pub fn sidecar(name: &str) -> io::Result<PathBuf> {
    let exe = std::env::current_exe()?;
    let dir = exe.parent().unwrap_or(Path::new("."));
    let file = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    };
    Ok(dir.join(file))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crash_budget_backs_off_then_gives_up() {
        let mut budget = CrashBudget::new(3, Duration::from_secs(60), Duration::from_millis(500));
        let start = Instant::now();
        let a = budget.crashed(start).unwrap();
        let b = budget.crashed(start).unwrap();
        assert!(b > a);
        assert!(budget.crashed(start).is_some());
        assert!(budget.crashed(start).is_none());
        // Old crashes leave the window.
        assert!(budget.crashed(start + Duration::from_secs(61)).is_some());
    }

    #[test]
    fn server_environment_is_explicit() {
        std::env::set_var("ORKESTR_HOME", "/somewhere/else");
        std::env::set_var("ORKESTR_V2_ACCESS_LOG", "all");
        let spec = ServerSpec {
            program: PathBuf::from("orkestr-v2-server"),
            home: PathBuf::from("/data/home"),
            port: 45678,
            token: "a".repeat(64),
            ui_dist: PathBuf::from("/app/ui"),
            log_dir: PathBuf::from("/data/logs"),
            codex: Some(PathBuf::from("/app/codex")),
        };
        let command = spec.command();
        let envs: Vec<_> = command
            .get_envs()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().into_owned(),
                    v.map(|v| v.to_string_lossy().into_owned()),
                )
            })
            .collect();
        let get = |key: &str| envs.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone());
        assert_eq!(get("ORKESTR_V2_BIND"), Some(Some("127.0.0.1:45678".into())));
        assert_eq!(get("ORKESTR_V2_HOME"), Some(Some("/data/home".into())));
        assert_eq!(get("ORKESTR_V2_UI_DIST"), Some(Some("/app/ui".into())));
        assert_eq!(get("ORKESTR_HOME"), Some(None));
        assert_eq!(
            get("ORKESTR_V2_ACCESS_LOG"),
            None,
            "diagnostics are inherited"
        );
        std::env::remove_var("ORKESTR_HOME");
        std::env::remove_var("ORKESTR_V2_ACCESS_LOG");
    }

    #[cfg(unix)]
    #[test]
    fn supervisor_restarts_a_crashing_server_then_reports_failure() {
        let dir = std::env::temp_dir().join(format!("orkestr-supervisor-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let program = dir.join("fake-server");
        fs::write(&program, "#!/bin/sh\nexit 3\n").unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&program, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let spec = ServerSpec {
            program,
            home: dir.join("home"),
            port: crate::local::free_port().unwrap(),
            token: "b".repeat(64),
            ui_dist: dir.join("ui"),
            log_dir: dir.join("logs"),
            codex: None,
        };
        let (sender, receiver) = std::sync::mpsc::channel();
        let budget = CrashBudget::new(5, Duration::from_secs(60), Duration::from_millis(1));
        let supervisor = Supervisor::start_with(spec, budget, move |event| {
            let _ = sender.send(match event {
                Event::Ready { .. } => "ready",
                Event::Restarting(_) => "restarting",
                Event::Failed(_) => "failed",
            });
        });
        let events: Vec<_> = receiver
            .iter()
            .take_while(|event| *event != "failed")
            .collect();
        assert_eq!(events, vec!["restarting"; 5]);
        supervisor.shutdown();
        assert!(dir.join("logs/server.log").is_file());
        fs::remove_dir_all(dir).unwrap();
    }
}
