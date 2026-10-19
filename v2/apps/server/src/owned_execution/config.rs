//! Local operator input only. This type is never an HTTP request or response.
use orkestr_v2_contracts::ConversationId;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    net::SocketAddr,
    path::{Path, PathBuf},
};

#[derive(Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum Provider {
    #[default]
    Codex,
    Claude,
}

/// A private factory selection, never a role chosen by an HTTP request.
#[derive(Clone, Copy, Default, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub(super) enum ExecutionRole {
    #[default]
    Deep,
    Fast,
}

impl Provider {
    pub(super) fn kind(self) -> orkestr_v2_application::runtime::ProviderKind {
        match self {
            Self::Codex => orkestr_v2_application::runtime::ProviderKind::Codex,
            Self::Claude => orkestr_v2_application::runtime::ProviderKind::Claude,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Config {
    pub schema_version: u32,
    pub mode: String,
    pub conversation_id: ConversationId,
    pub machine_token_file: PathBuf,
    pub launcher: PathBuf,
    pub launcher_sha256: String,
    pub workspace: PathBuf,
    pub namespace: String,
    pub supervisor_key: String,
    #[serde(default)]
    pub provider: Provider,
    #[serde(default)]
    pub role: ExecutionRole,
    #[serde(default)]
    pub execution_budget: super::budget::ExecutionBudget,
    #[serde(default)]
    pub worker: Option<crate::worker_execution::WorkerPolicy>,
}

fn canonical(path: &Path) -> Result<(), &'static str> {
    if !path.is_absolute() || path.canonicalize().ok().as_deref() != Some(path) {
        return Err("execution configuration requires canonical absolute paths");
    }
    Ok(())
}

#[cfg(unix)]
pub(super) fn private_file(
    path: &Path,
    home: &Path,
    max_bytes: u64,
) -> Result<Vec<u8>, &'static str> {
    use std::os::unix::fs::MetadataExt;
    canonical(path)?;
    let info = fs::symlink_metadata(path).map_err(|_| "execution private file unavailable")?;
    let owner = fs::metadata(home)
        .map_err(|_| "execution home unavailable")?
        .uid();
    if !info.is_file()
        || info.nlink() != 1
        || info.uid() != owner
        || info.mode() & 0o777 != 0o600
        || info.len() > max_bytes
    {
        return Err("execution file must be private, unaliased and owned by the data-home owner");
    }
    let bytes = fs::read(path).map_err(|_| "execution private file unavailable")?;
    if bytes.len() as u64 > max_bytes {
        return Err("execution private file exceeds limit");
    }
    Ok(bytes)
}

#[cfg(not(unix))]
pub(super) fn private_file(_: &Path, _: &Path, _: u64) -> Result<Vec<u8>, &'static str> {
    Err("owned execution requires Unix file ownership checks")
}

impl Config {
    pub(super) fn load(path: &Path, home: &Path, bind: SocketAddr) -> Result<Self, &'static str> {
        if !bind.ip().is_loopback() {
            return Err("isolated execution acceptance requires a loopback listener");
        }
        canonical(home)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if !home.is_dir()
                || fs::metadata(home)
                    .map_err(|_| "execution home unavailable")?
                    .mode()
                    & 0o777
                    != 0o700
            {
                return Err("isolated execution requires a private data home");
            }
        }
        let config: Self = serde_json::from_slice(&private_file(path, home, 16 * 1024)?)
            .map_err(|_| "invalid execution configuration")?;
        let key = |value: &str| {
            !value.is_empty()
                && value.len() <= 128
                && value
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
        };
        if config.schema_version != 1
            || config.mode != "isolated-acceptance-v1"
            || config.conversation_id.0.is_nil()
            || !key(&config.namespace)
            || !key(&config.supervisor_key)
        {
            return Err("unsupported execution configuration");
        }
        if let Some(policy) = &config.worker {
            policy.validate()?;
        }
        config.execution_budget.validate()?;
        if config.role == ExecutionRole::Fast
            && (config.provider != Provider::Codex || config.worker.is_some())
        {
            return Err("Fast presentation requires its own Codex factory without Workers");
        }
        if config.provider == Provider::Claude
            && (config.worker.is_some() || config.execution_budget.max_run_ms > 45_000)
        {
            return Err("Claude Worker execution and extended leases are not available");
        }
        canonical(&config.workspace)?;
        if !config.workspace.is_dir()
            || config.workspace.starts_with(home)
            || home.starts_with(&config.workspace)
        {
            return Err("execution workspace must be separate from the data home");
        }
        config.verify_launcher()?;
        // Reject invalid token files before issuing any supervisor or child authority.
        config.token(home)?;
        Ok(config)
    }

    pub(super) fn verify_launcher(&self) -> Result<(), &'static str> {
        canonical(&self.launcher)?;
        let info =
            fs::symlink_metadata(&self.launcher).map_err(|_| "execution launcher unavailable")?;
        if !info.is_file() || info.len() > 16 * 1024 * 1024 {
            return Err("invalid execution launcher");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if info.nlink() != 1 || info.mode() & 0o022 != 0 || info.mode() & 0o111 == 0 {
                return Err(
                    "execution launcher must be executable and protected from other writers",
                );
            }
        }
        let bytes = fs::read(&self.launcher).map_err(|_| "execution launcher unavailable")?;
        let actual = format!("{:x}", Sha256::digest(bytes));
        if self.launcher_sha256.len() != 64 || actual != self.launcher_sha256 {
            return Err("execution launcher checksum mismatch");
        }
        Ok(())
    }

    pub(super) fn token(&self, home: &Path) -> Result<String, &'static str> {
        let raw = private_file(&self.machine_token_file, home, 65)?;
        let value = std::str::from_utf8(&raw).map_err(|_| "invalid execution machine token")?;
        let value = value.strip_suffix('\n').unwrap_or(value);
        if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("invalid execution machine token");
        }
        Ok(value.to_owned())
    }
}
