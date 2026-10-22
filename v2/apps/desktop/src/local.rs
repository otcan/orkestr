//! First-run configuration in the platform app-data directory.
//!
//! Layout (all private to the user):
//! - `desktop.json`: `{ "schema": 1, "port": <u16> }`, the loopback port.
//! - `bootstrap.token`: 64 hex characters, mode 0600. It lets only this app
//!   create the first owner account; the server rejects it once an owner exists.
//! - `home/`: the server's data (`ORKESTR_V2_HOME`).
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, Write};
use std::net::{Ipv4Addr, TcpListener};
use std::path::{Path, PathBuf};

const CONFIG: &str = "desktop.json";
const TOKEN: &str = "bootstrap.token";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct Stored {
    schema: u32,
    port: u16,
}

#[derive(Debug, Clone)]
pub struct Local {
    pub data_dir: PathBuf,
    pub home: PathBuf,
    pub port: u16,
    pub token: String,
}

impl Local {
    /// Loads the configuration, creating it on first run.
    pub fn prepare(data_dir: &Path) -> io::Result<Self> {
        private_dir(data_dir)?;
        let home = data_dir.join("home");
        private_dir(&home)?;
        let token = match fs::read_to_string(data_dir.join(TOKEN)) {
            Ok(value) if valid_token(value.trim()) => value.trim().to_owned(),
            _ => {
                let token = new_token()?;
                write_private(&data_dir.join(TOKEN), token.as_bytes())?;
                token
            }
        };
        let port = match fs::read(data_dir.join(CONFIG))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Stored>(&bytes).ok())
        {
            Some(stored) if stored.schema == 1 && stored.port >= 1024 => stored.port,
            _ => {
                let port = free_port()?;
                save_port(data_dir, port)?;
                port
            }
        };
        Ok(Self {
            data_dir: data_dir.to_owned(),
            home,
            port,
            token,
        })
    }

    /// Keeps the saved port while it is free; otherwise picks and saves a new one.
    pub fn ensure_port(&mut self) -> io::Result<u16> {
        if !port_available(self.port) {
            self.port = free_port()?;
            save_port(&self.data_dir, self.port)?;
        }
        Ok(self.port)
    }

    pub fn origin(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

pub fn valid_token(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn new_token() -> io::Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| io::Error::other(error.to_string()))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// A random free loopback port chosen by the operating system.
pub fn free_port() -> io::Result<u16> {
    Ok(TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?
        .local_addr()?
        .port())
}

pub fn port_available(port: u16) -> bool {
    TcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_ok()
}

fn save_port(data_dir: &Path, port: u16) -> io::Result<()> {
    let body = serde_json::to_vec_pretty(&Stored { schema: 1, port })?;
    write_private(&data_dir.join(CONFIG), &body)
}

fn private_dir(path: &Path) -> io::Result<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Atomic replace of a file readable only by the current user.
fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let temporary = path.with_extension("tmp");
    let _ = fs::remove_file(&temporary);
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&temporary, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "orkestr-desktop-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn first_run_creates_private_token_port_and_home_once() {
        let dir = scratch("first-run");
        let first = Local::prepare(&dir).unwrap();
        assert!(valid_token(&first.token));
        assert!(first.port >= 1024);
        assert!(first.home.is_dir());
        assert_eq!(first.origin(), format!("http://127.0.0.1:{}", first.port));
        let again = Local::prepare(&dir).unwrap();
        assert_eq!((again.token, again.port), (first.token, first.port));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&dir.join(TOKEN)), 0o600);
            assert_eq!(mode(&dir), 0o700);
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn damaged_files_are_regenerated() {
        let dir = scratch("damaged");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(TOKEN), "short").unwrap();
        fs::write(dir.join(CONFIG), "{not json").unwrap();
        let local = Local::prepare(&dir).unwrap();
        assert!(valid_token(&local.token));
        assert_ne!(local.port, 0);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_busy_saved_port_is_replaced_and_saved() {
        let dir = scratch("busy");
        let mut local = Local::prepare(&dir).unwrap();
        let blocker = TcpListener::bind((Ipv4Addr::LOCALHOST, local.port)).unwrap();
        let busy = local.port;
        let port = local.ensure_port().unwrap();
        assert_ne!(port, busy);
        drop(blocker);
        assert_eq!(Local::prepare(&dir).unwrap().port, port);
        fs::remove_dir_all(dir).unwrap();
    }
}
