//! Optional trusted owner command profile. Closed operator JSON only; every
//! credential and skill list defaults to empty and nothing here is reachable
//! from HTTP, browser or model input.
use orkestr_runtime::workspace_exec::profile::{Mount, MountKind, Resources, TrustedProfile};
use serde::Deserialize;
use std::{collections::BTreeMap, path::PathBuf, time::Duration};

const GIB: u64 = 1024 * 1024 * 1024;
const MIB: u64 = 1024 * 1024;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TrustedConfig {
    #[serde(default)]
    pub network: bool,
    #[serde(default)]
    pub host_toolchain: bool,
    #[serde(default)]
    pub workspace_target: Option<PathBuf>,
    #[serde(default)]
    pub home: Option<PathBuf>,
    #[serde(default)]
    pub path: Option<Vec<PathBuf>>,
    #[serde(default)]
    pub toolchain_mounts: Vec<PathBuf>,
    #[serde(default)]
    pub cache_mounts: Vec<PathBuf>,
    #[serde(default)]
    pub environment: BTreeMap<String, String>,
    /// Explicit allowlists; all default to empty.
    #[serde(default)]
    pub credential_mounts: Vec<PathBuf>,
    #[serde(default)]
    pub credential_env_files: Vec<PathBuf>,
    #[serde(default)]
    pub skill_mounts: Vec<PathBuf>,
    #[serde(default)]
    pub command_timeout_ms: Option<u32>,
    #[serde(default)]
    pub command_output_bytes: Option<u32>,
    #[serde(default)]
    pub job_timeout_ms: Option<u32>,
    #[serde(default)]
    pub job_output_bytes: Option<u32>,
    #[serde(default)]
    pub max_jobs: Option<u8>,
    #[serde(default)]
    pub worker_run_ms: Option<u32>,
    #[serde(default)]
    pub memory_bytes: Option<u64>,
    #[serde(default)]
    pub pids: Option<u32>,
    #[serde(default)]
    pub cpus: Option<u32>,
    #[serde(default)]
    pub tmp_bytes: Option<u64>,
    #[serde(default)]
    pub home_bytes: Option<u64>,
    #[serde(default)]
    pub file_bytes: Option<u64>,
    #[serde(default)]
    pub open_files: Option<u32>,
}

impl TrustedConfig {
    /// Worker run budget for a conversation that waits on background jobs.
    pub(crate) fn worker_run_ms(&self) -> u32 {
        self.worker_run_ms.unwrap_or(1_800_000)
    }

    pub(crate) fn profile(&self) -> Result<TrustedProfile, &'static str> {
        if !(30_000..=3_600_000).contains(&self.worker_run_ms()) {
            return Err("trusted Worker run budget out of bounds");
        }
        let (default_target, default_home) = ("/workspace", "/home/worker");
        let mounts = [
            (MountKind::Toolchain, &self.toolchain_mounts),
            (MountKind::Cache, &self.cache_mounts),
            (MountKind::Credential, &self.credential_mounts),
            (MountKind::Skill, &self.skill_mounts),
        ]
        .into_iter()
        .flat_map(|(kind, paths)| {
            paths.iter().map(move |path| Mount {
                kind,
                path: path.clone(),
            })
        })
        .collect();
        Ok(TrustedProfile {
            network: self.network,
            host_root: self.host_toolchain,
            workspace_target: self
                .workspace_target
                .clone()
                .unwrap_or_else(|| default_target.into()),
            home: self.home.clone().unwrap_or_else(|| default_home.into()),
            path: self.path.clone().unwrap_or_else(|| {
                ["/usr/local/bin", "/usr/bin", "/bin"]
                    .map(PathBuf::from)
                    .into()
            }),
            mounts,
            environment: self.environment.clone().into_iter().collect(),
            credential_env_files: self.credential_env_files.clone(),
            resources: Resources {
                memory_bytes: self.memory_bytes.unwrap_or(8 * GIB),
                pids: self.pids.unwrap_or(1024),
                cpus: self.cpus.unwrap_or(4),
                tmp_bytes: self.tmp_bytes.unwrap_or(4 * GIB),
                home_bytes: self.home_bytes.unwrap_or(256 * MIB),
                file_bytes: self.file_bytes.unwrap_or(16 * GIB),
                open_files: self.open_files.unwrap_or(4096),
            },
            sync_timeout: Duration::from_millis(self.command_timeout_ms.unwrap_or(30_000).into()),
            sync_output: self.command_output_bytes.unwrap_or(128 * 1024) as usize,
            job_timeout: Duration::from_millis(self.job_timeout_ms.unwrap_or(1_800_000).into()),
            job_output: self.job_output_bytes.unwrap_or(4 * 1024 * 1024) as usize,
            max_jobs: self.max_jobs.unwrap_or(1).into(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_trusted_section_has_no_network_credentials_or_skills() {
        let config: TrustedConfig = serde_json::from_value(serde_json::json!({})).unwrap();
        let profile = config.profile().unwrap();
        profile.validate(&[]).unwrap();
        assert!(!profile.network && !profile.host_root && !profile.credentials_exposed());
        assert!(profile.mounts.is_empty() && profile.credential_env_files.is_empty());
        assert_eq!(profile.max_jobs, 1);
        assert_eq!(profile.job_timeout, Duration::from_secs(1800));
    }

    #[test]
    fn credentials_are_only_explicit_and_unknown_fields_refuse() {
        let config: TrustedConfig = serde_json::from_value(serde_json::json!({
            "network": true, "host_toolchain": true,
            "toolchain_mounts": ["/opt/example-sdk"],
            "credential_env_files": ["/srv/example/service.env"],
            "skill_mounts": ["/srv/example/skills/demo"],
        }))
        .unwrap();
        let profile = config.profile().unwrap();
        profile.validate(&[]).unwrap();
        assert!(profile.credentials_exposed());
        for field in ["owner_id", "command", "credentials", "allow_all"] {
            let mut value = serde_json::json!({});
            value[field] = serde_json::json!(true);
            assert!(serde_json::from_value::<TrustedConfig>(value).is_err());
        }
        let long: TrustedConfig =
            serde_json::from_value(serde_json::json!({"worker_run_ms": 3_600_001})).unwrap();
        assert!(long.profile().is_err());
    }
}
