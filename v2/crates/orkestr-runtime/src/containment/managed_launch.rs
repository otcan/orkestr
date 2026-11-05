//! Private descriptor transfer for an immutable split-identity service launcher.
//! This never turns a PID or JSON reply into dispatch authority.
use super::Error;
use std::fs::File;
use std::io::Read;
use std::os::fd::{FromRawFd, OwnedFd};
use std::os::unix::fs::MetadataExt;
use std::os::unix::net::UnixStream;
use std::path::Path;

pub struct ManagedLaunchDescriptors {
    role: String,
    descriptors: Vec<OwnedFd>,
    setup: Option<serde_json::Value>,
    preferences: (Option<String>, Option<String>),
    workspace_worker: bool,
}
impl ManagedLaunchDescriptors {
    pub fn role(&self) -> &str {
        &self.role
    }
    pub fn workspace_worker(&self) -> bool {
        self.workspace_worker
    }
    pub(super) fn set_workspace_worker(&mut self, enabled: bool) -> Result<(), Error> {
        if self.setup.is_some()
            || enabled && (!self.role.starts_with("worker-") || self.mode() != "fresh")
        {
            return Err(Error::AuthorityProtocol);
        }
        self.workspace_worker = enabled;
        Ok(())
    }
    pub fn mode(&self) -> &'static str {
        if self.descriptors.len() == 5 {
            "resume"
        } else {
            "fresh"
        }
    }
    pub(super) fn attach_resume(&mut self, bootstrap: &UnixStream) -> Result<(), Error> {
        if self.descriptors.len() != 4 || self.setup.is_some() || self.role.starts_with("worker-") {
            return Err(Error::AuthorityProtocol);
        }
        self.descriptors
            .push(bootstrap.try_clone().map_err(|_| Error::Io)?.into());
        Ok(())
    }
    pub fn descriptors(&self) -> &[OwnedFd] {
        &self.descriptors
    }
    pub fn setup(&self) -> Result<&serde_json::Value, Error> {
        self.setup.as_ref().ok_or(Error::AuthorityProtocol)
    }
    pub fn preferences(&self) -> serde_json::Value {
        serde_json::json!({"model":self.preferences.0,"effort":self.preferences.1})
    }
    pub(super) fn set_preferences(
        &mut self,
        value: (Option<String>, Option<String>),
    ) -> Result<(), Error> {
        if self.role != "claude" && (value.0.is_some() || value.1.is_some()) {
            return Err(Error::Unsupported);
        }
        if value
            .0
            .as_ref()
            .is_some_and(|v| !orkestr_v2_contracts::launch_model_valid(v))
            || value
                .1
                .as_ref()
                .is_some_and(|v| !orkestr_v2_contracts::CLAUDE_EFFORTS.contains(&v.as_str()))
        {
            return Err(Error::InvalidScope);
        }
        self.preferences = value;
        Ok(())
    }
    /// Only MetadataChild's live issuer scope may attest a setup. This method
    /// is private to containment, has no HTTP/JSON constructor and is one-use.
    pub(super) fn attest_setup(
        &mut self,
        binding: &orkestr_v2_application::runtime::Binding,
        incarnation: &str,
        provider: orkestr_v2_application::runtime::ProviderKind,
        resume_setup_id: Option<&str>,
    ) -> Result<(), Error> {
        use orkestr_v2_application::runtime::{ProviderKind, Role, SessionState};
        // A pre-run Starting binding is deliberately still Unconfigured;
        // provider selection belongs to the issuer context until native init.
        let resuming = self.mode() == "resume";
        let valid = if resuming {
            binding.provider_kind == provider
                && binding.state == SessionState::Ready
                && binding.native_session_id.is_some()
                && matches!(binding.role, Role::Deep | Role::Fast)
        } else {
            binding.provider_kind == ProviderKind::Unconfigured
                && binding.state == SessionState::Starting
                && binding.native_session_id.is_none()
        };
        if !valid || resuming != resume_setup_id.is_some() {
            return Err(Error::AuthorityProtocol);
        }
        let role = match binding.role {
            Role::Deep => "deep",
            Role::Fast => "fast",
            Role::Worker => "worker",
        };
        let provider = match provider {
            ProviderKind::Codex => "codex",
            ProviderKind::Claude => "claude",
            _ => return Err(Error::Unsupported),
        };
        let expected = if self.role == "claude" {
            provider == "claude" && matches!(binding.role, Role::Deep | Role::Fast)
        } else {
            provider == "codex"
                && if self.role.starts_with("worker-") {
                    role == "worker"
                } else {
                    self.role == role
                }
        };
        if !expected || self.setup.is_some() || incarnation.is_empty() || incarnation.len() > 128 {
            return Err(Error::AuthorityProtocol);
        }
        self.setup = Some(
            serde_json::json!({"session_id":binding.session_id.to_string(),
            "owner_id":binding.owner_id.to_string(),"conversation_id":binding.conversation_id.to_string(),
            "generation":binding.generation,"incarnation":incarnation,"role":role,"provider":provider}),
        );
        if resuming {
            self.setup.as_mut().ok_or(Error::AuthorityProtocol)?["native_session_id"] =
                serde_json::json!(binding.native_session_id);
            self.setup.as_mut().ok_or(Error::AuthorityProtocol)?["resume_setup_id"] =
                serde_json::json!(resume_setup_id);
        }
        Ok(())
    }
}

pub(super) struct Configuration {
    pub role: String,
}

pub(super) fn configuration(program: &Path) -> Result<Option<Configuration>, Error> {
    let Some(root) = program.parent() else {
        return Ok(None);
    };
    let descriptor = root.join("service.json");
    if !descriptor.exists() {
        return Ok(None);
    }
    for path in std::iter::once(descriptor.as_path()).chain(descriptor.ancestors().skip(1)) {
        let meta = std::fs::symlink_metadata(path).map_err(|_| Error::InvalidPath)?;
        if meta.uid() != 0 || meta.mode() & 0o022 != 0 || meta.file_type().is_symlink() {
            return Err(Error::InvalidPath);
        }
    }
    let mut bytes = Vec::new();
    File::open(&descriptor)
        .map_err(|_| Error::InvalidPath)?
        .take(65537)
        .read_to_end(&mut bytes)
        .map_err(|_| Error::Io)?;
    if bytes.len() > 65536 {
        return Err(Error::InvalidPath);
    }
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| Error::InvalidPath)?;
    let fields = [
        "authority_uid",
        "authority_gid",
        "executor_uid",
        "executor_gid",
        "provider_home",
    ];
    let present = fields
        .iter()
        .filter(|key| value.get(**key).is_some())
        .count();
    if present == 0 {
        return Ok(None);
    }
    if present != fields.len() || value["format"] != "orkestr-v2-codex-service-v1" {
        return Err(Error::InvalidPath);
    }
    unsafe extern "C" {
        fn geteuid() -> u32;
    }
    // SAFETY: geteuid has no arguments and no memory access.
    let uid = unsafe { geteuid() };
    if value["authority_uid"].as_u64() != Some(u64::from(uid))
        || value["executor_uid"] == value["authority_uid"]
        || value["executor_uid"] != value["uid"]
        || value["executor_gid"] != value["gid"]
    {
        return Err(Error::InvalidScope);
    }
    let role = match program.file_name().and_then(|v| v.to_str()) {
        Some("launcher.py") => "deep",
        Some("launcher-fast.py") => "fast",
        Some("launcher-claude.py") => "claude",
        Some("launcher-worker-0.py") => "worker-0",
        Some("launcher-worker-1.py") => "worker-1",
        Some("launcher-worker-2.py") => "worker-2",
        Some("launcher-worker-3.py") => "worker-3",
        _ => return Err(Error::Unsupported),
    };
    Ok(Some(Configuration { role: role.into() }))
}

fn pipe() -> Result<(OwnedFd, OwnedFd), Error> {
    unsafe extern "C" {
        fn pipe2(fds: *mut i32, flags: i32) -> i32;
    }
    let mut descriptors = [-1; 2];
    // SAFETY: pipe2 receives a live two-element output buffer. O_CLOEXEC keeps
    // both ends private until Command or SCM_RIGHTS explicitly transfers them.
    if unsafe { pipe2(descriptors.as_mut_ptr(), 0o2000000) } != 0 {
        return Err(Error::Io);
    }
    // SAFETY: successful pipe2 returned two fresh owned descriptors.
    Ok(unsafe {
        (
            OwnedFd::from_raw_fd(descriptors[0]),
            OwnedFd::from_raw_fd(descriptors[1]),
        )
    })
}

pub(super) struct Prepared {
    pub input: OwnedFd,
    pub output: OwnedFd,
    pub child_input: OwnedFd,
    pub child_output: OwnedFd,
    pub lifecycle: UnixStream,
    pub transfer: ManagedLaunchDescriptors,
}
pub(super) fn prepare(config: Configuration, provider: &UnixStream) -> Result<Prepared, Error> {
    let (child_input, input) = pipe()?;
    let (output, child_output) = pipe()?;
    let (manager, lifecycle) = UnixStream::pair().map_err(|_| Error::Io)?;
    let transfer = ManagedLaunchDescriptors {
        role: config.role,
        setup: None,
        preferences: (None, None),
        workspace_worker: false,
        descriptors: vec![
            child_input.try_clone().map_err(|_| Error::Io)?,
            child_output.try_clone().map_err(|_| Error::Io)?,
            provider.try_clone().map_err(|_| Error::Io)?.into(),
            manager.into(),
        ],
    };
    Ok(Prepared {
        input,
        output,
        child_input,
        child_output,
        lifecycle,
        transfer,
    })
}

#[cfg(test)]
mod tests;
