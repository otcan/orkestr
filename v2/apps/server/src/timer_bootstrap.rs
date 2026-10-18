//! Trusted local scheduler configuration, never an HTTP/browser selector.
use orkestr_v2_store_sqlite::Store;
use serde::Deserialize;
use std::path::{Path, PathBuf};
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    schema_version: u32,
    machine_token_file: PathBuf,
}
#[cfg(unix)]
fn private_file(path: &Path, home: &Path, cap: u64) -> Result<Vec<u8>, &'static str> {
    use std::os::unix::fs::MetadataExt;
    if !path.is_absolute() || path.canonicalize().ok().as_deref() != Some(path) {
        return Err("timer configuration requires canonical absolute paths");
    }
    let meta = std::fs::symlink_metadata(path).map_err(|_| "timer private file unavailable")?;
    let owner = std::fs::metadata(home)
        .map_err(|_| "timer home unavailable")?
        .uid();
    if !meta.is_file()
        || meta.nlink() != 1
        || meta.uid() != owner
        || meta.mode() & 0o777 != 0o600
        || meta.len() > cap
    {
        return Err("timer file must be private and owned by data-home owner");
    }
    use std::io::Read;
    let file = std::fs::File::open(path).map_err(|_| "timer private file unavailable")?;
    let opened = file
        .metadata()
        .map_err(|_| "timer private file unavailable")?;
    if opened.dev() != meta.dev()
        || opened.ino() != meta.ino()
        || opened.uid() != owner
        || opened.mode() & 0o777 != 0o600
        || opened.nlink() != 1
    {
        return Err("timer private file changed during open");
    }
    let mut bytes = Vec::new();
    file.take(cap + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "timer private file unavailable")?;
    if bytes.len() as u64 > cap {
        return Err("timer private file exceeds limit");
    }
    Ok(bytes)
}
#[cfg(not(unix))]
fn private_file(_: &Path, _: &Path, _: u64) -> Result<Vec<u8>, &'static str> {
    Err("timer bootstrap requires Unix ownership checks")
}
/// No provider is launched. Core supplies a current bound scheduler identity.
pub async fn load(store: &Store, home: &Path, path: &Path) -> Result<Store, &'static str> {
    let config: Config = serde_json::from_slice(&private_file(path, home, 4096)?)
        .map_err(|_| "invalid timer configuration")?;
    if config.schema_version != 1 {
        return Err("unsupported timer configuration");
    }
    let bytes = private_file(&config.machine_token_file, home, 128)?;
    let token = std::str::from_utf8(&bytes)
        .map_err(|_| "invalid timer machine credential")?
        .trim();
    store
        .authorize_timer_supervisor(token)
        .await
        .map_err(|_| "timer supervisor bootstrap refused")
}

#[cfg(all(test, unix))]
#[path = "timer_bootstrap_tests.rs"]
mod tests;
