//! Closed operator configuration; never accepted from HTTP.
mod conversation_workspaces;
pub(crate) mod host_full_access;
pub(crate) mod loading;
pub(crate) mod roles;
pub(crate) mod workspace_exec;
pub(crate) mod workspace_exec_trusted;
use orkestr_v2_contracts::{ConversationId, OwnerId};
use serde::Deserialize;
use std::path::PathBuf;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct BetaConfig {
    pub schema_version: u32,
    pub owner_id: OwnerId,
    pub conversation_id: ConversationId,
    pub manager_socket: PathBuf,
    pub launcher: PathBuf,
    pub launcher_sha256: String,
    pub workspace: PathBuf,
    pub namespace: String,
    pub supervisor_key: String,
    #[serde(default)]
    pub roles: Option<roles::Roles>,
    #[serde(default)]
    pub workspace_exec: Option<workspace_exec::WorkspaceExecConfig>,
    /// Further conversations with their own project and workspace, each with
    /// the same command profile shape (trusted or not) as `workspace_exec`.
    #[serde(default)]
    pub additional_workspace_exec: Vec<workspace_exec::WorkspaceExecConfig>,
    /// Owner-wide bound on concurrently live execution windows (conversations
    /// with active Deep work). Further fresh-window intents queue durably.
    #[serde(default)]
    pub max_active_windows: Option<u32>,
    /// Owner/instance-level V1-equivalent full access; absent by default.
    #[serde(default)]
    pub host_full_access: Option<host_full_access::HostFullAccess>,
    /// Total window lifetime (minutes) an active window may be extended to
    /// while its Deep or Worker runs are still working. Default 60, at most 240.
    #[serde(default)]
    pub window_max_minutes: Option<u32>,
    /// Per-conversation override of `window_max_minutes` (for example long
    /// desk and bank flows).
    #[serde(default)]
    pub conversation_window_max_minutes: std::collections::HashMap<ConversationId, u32>,
    /// Optional Claude Deep runtime for conversations that select it (or all
    /// conversations without a choice when `default` is set).
    #[serde(default)]
    pub claude: Option<ClaudeWindow>,
    /// Per-conversation Codex and Claude Deep/Fast working directory (for
    /// example a migrated V1 thread's workspace with its AGENTS.md or
    /// CLAUDE.md). Host full access only; Workers keep their own workspaces.
    #[serde(default)]
    pub conversation_workspaces:
        std::collections::HashMap<ConversationId, conversation_workspaces::ConversationWorkspace>,
}

/// Operator-pinned Claude service launcher. Account and full-access
/// environment stay in the root-owned package, never in this file.
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ClaudeWindow {
    pub launcher: PathBuf,
    pub launcher_sha256: String,
    pub workspace: PathBuf,
    #[serde(default)]
    pub default: bool,
    /// Present each input on a Claude Fast companion as well.
    #[serde(default)]
    pub fast: bool,
}
/// Bound on per-conversation Deep/Fast working directories.
pub(crate) const MAX_CONVERSATION_WORKSPACES: usize = 128;

/// Absolute, normalized and bounded; never the filesystem root.
pub(crate) fn conversation_workspace_path(path: &std::path::Path) -> bool {
    use std::path::Component;
    path.is_absolute()
        && path != std::path::Path::new("/")
        && path.to_str().is_some_and(|text| {
            !text.contains('\0')
                && text.len() <= 4096
                && !text.ends_with('/')
                && !text.ends_with("/.")
                && !text.contains("/./")
                && !text.contains("//")
        })
        && path
            .components()
            .all(|c| matches!(c, Component::RootDir | Component::Normal(_)))
}

/// Default total window lifetime while work is still running (minutes).
/// Beta config file bound: room for many per-conversation command profiles.
pub(crate) const MAX_BETA_CONFIG_BYTES: u64 = 262_144;
/// Conversations with their own workspace besides the primary profile.
pub(crate) const MAX_ADDITIONAL_WORKSPACE_EXEC: usize = 128;
pub(crate) const DEFAULT_WINDOW_MAX_MINUTES: u32 = 60;
/// Default number of conversations that may hold a live window at once.
pub(crate) const DEFAULT_ACTIVE_WINDOWS: u32 = 8;
/// Upper bound; the root manager's independent ceiling stays above it.
pub(crate) const MAX_ACTIVE_WINDOWS: u32 = 12;
impl BetaConfig {
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        let key = |s: &str| {
            !s.is_empty()
                && s.len() <= 128
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
        };
        if self.schema_version != 1
            || self.owner_id.0.is_nil()
            || self.conversation_id.0.is_nil()
            || !self.manager_socket.is_absolute()
            || !self.launcher.is_absolute()
            || !self.workspace.is_absolute()
            || !key(&self.namespace)
            || !key(&self.supervisor_key)
            || self.launcher_sha256.len() != 64
            || !self
                .launcher_sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("invalid beta configuration");
        }
        if let Some(roles) = &self.roles {
            roles.validate(&self.launcher)?;
        }
        if self
            .max_active_windows
            .is_some_and(|value| value == 0 || value > MAX_ACTIVE_WINDOWS)
        {
            return Err("invalid beta window capacity");
        }
        if let Some(access) = &self.host_full_access {
            access.validate()?;
        }
        if self
            .window_max_minutes
            .iter()
            .chain(self.conversation_window_max_minutes.values())
            .any(|minutes| !(15..=240).contains(minutes))
            || self.conversation_window_max_minutes.len() > 64
        {
            return Err("invalid window lifetime ceiling");
        }
        if !self.conversation_workspaces.is_empty()
            && (self.host_full_access.is_none()
                || self.conversation_workspaces.len() > MAX_CONVERSATION_WORKSPACES
                || self
                    .conversation_workspaces
                    .iter()
                    .any(|(conversation, path)| conversation.0.is_nil() || !path.valid()))
        {
            return Err("invalid conversation workspaces");
        }
        if let Some(claude) = &self.claude {
            if !claude.launcher.is_absolute()
                || !claude.workspace.is_absolute()
                || claude.launcher == self.launcher
                || claude.launcher_sha256.len() != 64
                || !claude
                    .launcher_sha256
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return Err("invalid Claude window configuration");
            }
        }
        if let Some(profile) = &self.workspace_exec {
            profile.validate_with(self.host_full_access.as_ref())?;
            if self.roles.is_none() {
                return Err("workspace execution requires configured Worker roles");
            }
        } else if !self.additional_workspace_exec.is_empty() {
            return Err("additional workspace execution requires workspace_exec");
        }
        if self.additional_workspace_exec.len() > MAX_ADDITIONAL_WORKSPACE_EXEC {
            return Err("too many additional workspace execution profiles");
        }
        workspace_exec::validate_set(
            self.workspace_profiles().collect(),
            self.host_full_access.as_ref(),
        )
    }

    /// Every configured command profile, primary first.
    pub(crate) fn workspace_profiles(
        &self,
    ) -> impl Iterator<Item = &workspace_exec::WorkspaceExecConfig> {
        self.workspace_exec
            .iter()
            .chain(self.additional_workspace_exec.iter())
    }

    /// The window provider for a conversation: its owner setting, or the
    /// instance default while settings were never changed. Claude without a
    /// configured runtime is refused, and a window never silently continues a
    /// committed native identity of the other provider.
    pub(crate) fn window_provider(
        &self,
        launch: &orkestr_v2_contracts::TurnLaunch,
        native: Option<orkestr_v2_application::runtime::ProviderKind>,
    ) -> Result<orkestr_v2_application::runtime::ProviderKind, &'static str> {
        use orkestr_v2_application::runtime::ProviderKind;
        use orkestr_v2_contracts::ConversationProvider;
        let claude_default = self.claude.as_ref().is_some_and(|c| c.default);
        let selected = match launch.provider {
            ConversationProvider::Codex if launch.settings_revision == 0 && claude_default => {
                ProviderKind::Claude
            }
            ConversationProvider::Codex => ProviderKind::Codex,
            ConversationProvider::Claude => ProviderKind::Claude,
        };
        if selected == ProviderKind::Claude && self.claude.is_none() {
            return Err("selected conversation provider is not configured");
        }
        if native.is_some_and(|native| native != selected) {
            return Err("conversation provider switch requires a handoff window");
        }
        Ok(selected)
    }

    /// This conversation's window lifetime ceiling in milliseconds.
    pub(crate) fn window_max_lifetime_ms(&self) -> i64 {
        self.window_max_lifetime_ms_for(&self.conversation_id)
    }

    /// The window lifetime ceiling of any conversation in milliseconds.
    pub(crate) fn window_max_lifetime_ms_for(&self, conversation: &ConversationId) -> i64 {
        let minutes = self
            .conversation_window_max_minutes
            .get(conversation)
            .copied()
            .or(self.window_max_minutes)
            .unwrap_or(DEFAULT_WINDOW_MAX_MINUTES);
        i64::from(minutes) * 60_000
    }

    pub(crate) fn active_windows(&self) -> u32 {
        self.max_active_windows.unwrap_or(DEFAULT_ACTIVE_WINDOWS)
    }

    /// The command profile of this conversation, if it has one.
    pub(crate) fn workspace_profile(&self) -> Option<&workspace_exec::WorkspaceExecConfig> {
        self.workspace_profiles()
            .find(|profile| profile.conversation_id == self.conversation_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> serde_json::Value {
        serde_json::json!({
            "schema_version":1,
            "owner_id":"11111111-1111-4111-8111-111111111111",
            "conversation_id":"22222222-2222-4222-8222-222222222222",
            "manager_socket":"/run/example-manager/control.sock",
            "launcher":"/opt/example-package/launcher",
            "launcher_sha256":"a".repeat(64),
            "workspace":"/srv/example-workspace",
            "namespace":"beta-deep", "supervisor_key":"beta-supervisor"
        })
    }
    #[test]
    fn closed_schema_rejects_authority_and_limit_overrides() {
        let valid: BetaConfig = serde_json::from_value(input()).unwrap();
        valid.validate().unwrap();
        for name in [
            "token",
            "machine_token_file",
            "role",
            "provider",
            "limits",
            "account",
        ] {
            let mut value = input();
            value[name] = serde_json::json!("override");
            assert!(
                serde_json::from_value::<BetaConfig>(value).is_err(),
                "{name}"
            );
        }
    }
    #[test]
    fn window_provider_follows_settings_default_and_refuses_unconfigured_or_switch() {
        use orkestr_v2_application::runtime::ProviderKind;
        use orkestr_v2_contracts::{ConversationProvider, ConversationSettings};
        let conversation = ConversationId("22222222-2222-4222-8222-222222222222".parse().unwrap());
        let mut launch = ConversationSettings::defaults(conversation).launch();
        let codex: BetaConfig = serde_json::from_value(input()).unwrap();
        assert_eq!(
            codex.window_provider(&launch, None),
            Ok(ProviderKind::Codex)
        );
        let mut value = input();
        value["claude"] = serde_json::json!({"launcher":"/opt/example-package/launcher-claude",
            "launcher_sha256":"b".repeat(64), "workspace":"/srv/example-claude", "default":true});
        let claude: BetaConfig = serde_json::from_value(value).unwrap();
        claude.validate().unwrap();
        // Untouched settings take the operator default; an explicit choice wins.
        assert_eq!(
            claude.window_provider(&launch, None),
            Ok(ProviderKind::Claude)
        );
        launch.settings_revision = 1;
        assert_eq!(
            claude.window_provider(&launch, None),
            Ok(ProviderKind::Codex)
        );
        launch.provider = ConversationProvider::Claude;
        assert_eq!(
            claude.window_provider(&launch, None),
            Ok(ProviderKind::Claude)
        );
        assert!(codex.window_provider(&launch, None).is_err());
        // A committed native identity of the other provider is never continued.
        assert!(claude
            .window_provider(&launch, Some(ProviderKind::Codex))
            .is_err());
        assert_eq!(
            claude.window_provider(&launch, Some(ProviderKind::Claude)),
            Ok(ProviderKind::Claude)
        );
    }
    #[test]
    fn window_lifetime_ceiling_defaults_overrides_and_bounds() {
        let primary = "22222222-2222-4222-8222-222222222222";
        let other = ConversationId("33333333-3333-4333-8333-333333333333".parse().unwrap());
        let config: BetaConfig = serde_json::from_value(input()).unwrap();
        assert_eq!(config.window_max_lifetime_ms(), 3_600_000);
        let mut value = input();
        value["window_max_minutes"] = serde_json::json!(30);
        value["conversation_window_max_minutes"] = serde_json::json!({ primary: 120 });
        let config: BetaConfig = serde_json::from_value(value.clone()).unwrap();
        config.validate().unwrap();
        assert_eq!(config.window_max_lifetime_ms(), 7_200_000);
        assert_eq!(config.window_max_lifetime_ms_for(&other), 1_800_000);
        for bad in [14, 241] {
            let mut value = value.clone();
            value["conversation_window_max_minutes"] = serde_json::json!({ primary: bad });
            let config: BetaConfig = serde_json::from_value(value).unwrap();
            assert!(config.validate().is_err(), "{bad}");
        }
    }
    #[test]
    fn conversation_workspaces_require_host_access_and_normal_paths() {
        let primary = "22222222-2222-4222-8222-222222222222";
        let mut value = input();
        value["conversation_workspaces"] = serde_json::json!({ primary: "/srv/v1-thread" });
        let config: BetaConfig = serde_json::from_value(value.clone()).unwrap();
        assert!(config.validate().is_err(), "requires host_full_access");
        value["host_full_access"] =
            serde_json::json!({"environment":{"HOME":"/home/example","PATH":"/usr/bin"}});
        let config: BetaConfig = serde_json::from_value(value.clone()).unwrap();
        config.validate().unwrap();
        let mut shared = value.clone();
        shared["conversation_workspaces"] =
            serde_json::json!({ primary: {"path":"/srv/shared-thread", "shared":true} });
        serde_json::from_value::<BetaConfig>(shared.clone())
            .unwrap()
            .validate()
            .unwrap();
        shared["conversation_workspaces"][primary]["shared"] = serde_json::json!(false);
        assert!(serde_json::from_value::<BetaConfig>(shared.clone())
            .unwrap()
            .validate()
            .is_err());
        for bad in [
            serde_json::json!({"path":"/srv/x"}),
            serde_json::json!({"path":"/srv/x", "shared":true, "extra":true}),
        ] {
            shared["conversation_workspaces"][primary] = bad;
            assert!(serde_json::from_value::<BetaConfig>(shared.clone()).is_err());
        }
        for bad in ["relative", "/", "/srv/../etc", "/srv/./x", "/srv/x/"] {
            let mut value = value.clone();
            value["conversation_workspaces"] = serde_json::json!({ primary: bad });
            let config: BetaConfig = serde_json::from_value(value).unwrap();
            assert!(config.validate().is_err(), "{bad}");
        }
        let mut value = value.clone();
        value["conversation_workspaces"] =
            serde_json::json!({ "00000000-0000-0000-0000-000000000000": "/srv/x" });
        let config: BetaConfig = serde_json::from_value(value).unwrap();
        assert!(config.validate().is_err(), "nil conversation");
    }
    #[test]
    fn each_conversation_finds_only_its_own_command_profile() {
        let profile = |conversation: &str, project: &str, workspace: &str| {
            serde_json::json!({"conversation_id":conversation, "project_id":project,
                "workspace":workspace, "allowed_roots":[workspace],
                "protected_roots":["/srv/private"], "cgroup_root":"/sys/fs/cgroup/example",
                "toolchain_root":"/opt/example-command-image"})
        };
        let primary = "22222222-2222-4222-8222-222222222222";
        let other = "33333333-3333-4333-8333-333333333333";
        let mut value = input();
        value["workspace_exec"] = profile(
            primary,
            "44444444-4444-4444-8444-444444444444",
            "/srv/project",
        );
        value["additional_workspace_exec"] = serde_json::json!([profile(
            other,
            "55555555-5555-4555-8555-555555555555",
            "/srv/pa"
        )]);
        let mut config: BetaConfig = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(config.workspace_profiles().count(), 2);
        assert_eq!(
            config.workspace_profile().unwrap().workspace,
            PathBuf::from("/srv/project")
        );
        config.conversation_id = ConversationId(other.parse().unwrap());
        assert_eq!(
            config.workspace_profile().unwrap().workspace,
            PathBuf::from("/srv/pa")
        );
        config.conversation_id =
            ConversationId("66666666-6666-4666-8666-666666666666".parse().unwrap());
        assert!(config.workspace_profile().is_none());
        // Additional profiles never stand alone.
        let mut lone = value;
        lone.as_object_mut().unwrap().remove("workspace_exec");
        let lone: BetaConfig = serde_json::from_value(lone).unwrap();
        assert!(lone.validate().is_err());
    }
    #[test]
    fn window_capacity_defaults_and_is_bounded() {
        let valid: BetaConfig = serde_json::from_value(input()).unwrap();
        assert_eq!(valid.active_windows(), DEFAULT_ACTIVE_WINDOWS);
        for (value, ok) in [(1, true), (12, true), (0, false), (13, false)] {
            let mut config = input();
            config["max_active_windows"] = serde_json::json!(value);
            let config: BetaConfig = serde_json::from_value(config).unwrap();
            assert_eq!(config.validate().is_ok(), ok, "{value}");
            if ok {
                assert_eq!(config.active_windows(), value);
            }
        }
        let mut negative = input();
        negative["max_active_windows"] = serde_json::json!(-1);
        assert!(serde_json::from_value::<BetaConfig>(negative).is_err());
    }
    #[test]
    fn relative_paths_nil_scope_and_noncanonical_digest_refuse() {
        for (key, bad) in [
            ("schema_version", serde_json::json!(2)),
            (
                "owner_id",
                serde_json::json!("00000000-0000-0000-0000-000000000000"),
            ),
            ("manager_socket", serde_json::json!("relative.sock")),
            ("workspace", serde_json::json!("relative")),
            ("launcher_sha256", serde_json::json!("A".repeat(64))),
            ("namespace", serde_json::json!("invalid namespace")),
        ] {
            let mut value = input();
            value[key] = bad;
            let config: BetaConfig = serde_json::from_value(value).unwrap();
            assert!(config.validate().is_err(), "{key}");
        }
    }
}
