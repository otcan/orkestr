//! Trusted provider-specific launcher boundary, not a credential broker server.
//!
//! Register this module only in trusted Runtime composition. A launcher path is
//! server-private configuration, never a request field. The launcher keeps its
//! canonical account configuration internally and creates a fresh native session.
//! It must not adopt an existing session or return credential/profile/socket
//! locators. JSON replies are untrusted data, never a dispatch capability.
//!
//! This reuses MetadataAuthority's real issuer fence and owned process lineage.
//! MetadataChild::confirm and ReadyMetadataChild::attach_and_enqueue remain the
//! only readiness/consumed-dispatch transfer. There is intentionally no generic
//! forward, interrupt, environment override, or client-selected command method.
//! OpenOwnedSession is admitted only by the typed, one-attempt metadata method;
//! the raw metadata whitelist remains unchanged.
//! This is NOT OS isolation: same-UID filesystem and /proc access remain open,
//! including access to canonical credentials outside this clean environment.
//! Host integration must separate trusted connector privilege from untrusted
//! workers. Interrupt forwarding additionally needs a durable Core cancel receipt.
use super::metadata::{MetadataAuthority, MetadataChild};
use super::{ChildDirectories, Error, TransportBounds};
use orkestr_v2_store_sqlite::{BoundSessionMetadata, Store};
use std::ffi::OsString;
use std::path::{Path, PathBuf};

pub(super) struct BrokerLaunch(());

pub(crate) const PROTOCOL: &str = "orkestr-v2-provider-broker-v1";

/// Fixed trusted installation configuration. Not Clone, Debug or deserializable.
/// This is not itself inference authority: issuance and every subsequent action
/// still require Core authority. File/UID isolation must be enforced externally.
pub(crate) struct TrustedLauncher {
    executable: PathBuf,
}
mod workspace;

impl TrustedLauncher {
    /// Trusted composition only. Never call with a path from web/worker input.
    /// Symlink aliases are refused, but replacement races require an immutable
    /// installation/controlled parent; this does not prove executable provenance.
    pub(crate) fn configured(executable: &Path) -> Result<Self, Error> {
        if !executable.is_absolute() || !executable.is_file() {
            return Err(Error::InvalidPath);
        }
        let canonical = executable.canonicalize().map_err(|_| Error::InvalidPath)?;
        if canonical != executable {
            return Err(Error::InvalidPath);
        }
        Ok(Self {
            executable: canonical,
        })
    }

    pub(crate) fn open_metadata_fd_retained(
        &self,
        store: Store,
        grant: BoundSessionMetadata,
        directories: ChildDirectories,
        bounds: TransportBounds,
        resources: Box<dyn Send + 'static>,
    ) -> Result<(MetadataAuthority, MetadataChild), Error> {
        let resume = grant.binding().native_session_id.is_some();
        let authority = MetadataAuthority::new_retained(store, grant, resources)?;
        let child = authority
            .issue_executor(
                &self.executable,
                &if resume {
                    [
                        "resume-owned-session".into(),
                        "--protocol".into(),
                        PROTOCOL.into(),
                    ]
                } else {
                    launch_arguments()
                },
                directories,
                bounds,
            )?
            .spawn_with_provider_fd()?;
        Ok((authority, child.mark_broker_launcher(BrokerLaunch(()))))
    }

    pub(crate) fn open_worker_metadata_fd_retained(
        &self,
        store: Store,
        grant: BoundSessionMetadata,
        directories: ChildDirectories,
        bounds: TransportBounds,
        resources: Box<dyn Send + 'static>,
    ) -> Result<(MetadataAuthority, MetadataChild), Error> {
        if grant.provider() != orkestr_v2_application::runtime::ProviderKind::Codex
            || grant.binding().role != orkestr_v2_application::runtime::Role::Worker
            || grant.binding().native_session_id.is_some()
        {
            return Err(Error::AuthorityProtocol);
        }
        let authority = MetadataAuthority::new_retained(store, grant, resources)?;
        let child = authority
            .issue_executor(
                &self.executable,
                &[
                    "open-owned-worker-session".into(),
                    "--protocol".into(),
                    PROTOCOL.into(),
                ],
                directories,
                bounds,
            )?
            .spawn_with_provider_fd()?;
        Ok((authority, child.mark_broker_launcher(BrokerLaunch(()))))
    }

    /// No client args, account ID, environment, profile directory or socket.
    /// The provider/account selection belongs inside this specific launcher.
    pub(crate) fn open_metadata(
        &self,
        store: Store,
        grant: BoundSessionMetadata,
        directories: ChildDirectories,
        bounds: TransportBounds,
    ) -> Result<(MetadataAuthority, MetadataChild), Error> {
        let authority = MetadataAuthority::new(store, grant)?;
        let child = authority
            .issue_executor(&self.executable, &launch_arguments(), directories, bounds)?
            .spawn()?;
        Ok((authority, child.mark_broker_launcher(BrokerLaunch(()))))
    }
}

fn launch_arguments() -> [OsString; 3] {
    [
        "open-owned-session".into(),
        "--protocol".into(),
        PROTOCOL.into(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_arguments_cannot_carry_client_configuration() {
        let _open = TrustedLauncher::open_metadata;
        assert_eq!(
            launch_arguments(),
            [
                OsString::from("open-owned-session"),
                OsString::from("--protocol"),
                OsString::from("orkestr-v2-provider-broker-v1"),
            ]
        );
    }

    #[test]
    fn reject_relative_and_absent_launcher() {
        assert!(matches!(
            TrustedLauncher::configured(Path::new("provider")),
            Err(Error::InvalidPath)
        ));
        assert!(matches!(
            TrustedLauncher::configured(Path::new("/nonexistent-synthetic-provider-launcher")),
            Err(Error::InvalidPath)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn reject_configured_symlink_alias_without_running_it() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!("broker-config-test-{}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        let target = root.join("target");
        let alias = root.join("alias");
        std::fs::write(&target, b"synthetic launcher; never executed").unwrap();
        symlink(&target, &alias).unwrap();
        assert!(matches!(
            TrustedLauncher::configured(&alias),
            Err(Error::InvalidPath)
        ));
        assert!(TrustedLauncher::configured(&target).is_ok());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn real_metadata_grant_opens_only_fixed_owned_launcher_and_revokes() {
        owned_case(0).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn revoked_grant_cannot_open_broker() {
        owned_case(1).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn queue_full_open_quarantines_without_retry() {
        owned_case(2).await;
    }

    async fn owned_case(mode: u8) {
        use orkestr_v2_application::runtime::*;
        use std::os::unix::fs::PermissionsExt;
        use std::time::{Duration, Instant};
        let root =
            std::env::temp_dir().join(format!("broker-owned-test-{}-{mode}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        for name in ["workspace", "home", "tmp"] {
            std::fs::create_dir(root.join(name)).unwrap();
        }
        let script = root.join("launcher");
        std::fs::write(
            &script,
            br#"#!/usr/bin/python3
import json, os, sys
print(json.dumps({"argv":sys.argv[1:],"environment":sorted(os.environ)}),flush=True)
for line in sys.stdin:
 print(line.strip(),flush=True)
"#,
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let store = Store::open(&root.join("state.sqlite3")).await.unwrap();
        let conversation = store
            .setup("synthetic-owner", "synthetic-hash")
            .await
            .unwrap();
        let owner = store
            .credentials("synthetic-owner")
            .await
            .unwrap()
            .unwrap()
            .0;
        let token = "cd".repeat(32);
        store.save_session(&token, &owner).await.unwrap();
        let bound = store
            .authorize_supervisor(
                &token,
                ProductionSupervisorConfig {
                    provider: ProviderKind::Codex,
                    namespace: "subscription:local".into(),
                    supervisor_key: "synthetic-broker".into(),
                    takeover: ProductionTakeover::First,
                },
            )
            .await
            .unwrap();
        let binding = bound
            .ensure_role_bindings(&owner, &conversation)
            .await
            .unwrap()
            .deep;
        let grant = bound.authorize_session_metadata(&binding).await.unwrap();
        let launcher = TrustedLauncher::configured(&script).unwrap();
        let (authority, child) = launcher
            .open_metadata(
                bound,
                grant,
                ChildDirectories::new(
                    &root.join("workspace"),
                    &root.join("home"),
                    &root.join("tmp"),
                )
                .unwrap(),
                TransportBounds::default(),
            )
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let frame = loop {
            match child.poll_stdout().unwrap() {
                super::super::Output::Frame(frame) => break frame,
                super::super::Output::Pending if Instant::now() < deadline => {
                    std::thread::yield_now()
                }
                other => panic!("unexpected synthetic peer output: {other:?}"),
            }
        };
        let reply: serde_json::Value = serde_json::from_slice(&frame).unwrap();
        assert_eq!(
            reply["argv"],
            serde_json::json!(["open-owned-session", "--protocol", PROTOCOL])
        );
        let env = reply["environment"].as_array().unwrap();
        assert!(env
            .iter()
            .all(|name| ["PATH", "LANG", "LC_ALL", "HOME", "TMPDIR"]
                .contains(&name.as_str().unwrap())));
        // A peer claiming arbitrary handles cannot create a turn authority. The
        // metadata transport continues rejecting inference and unknown broker JSON.
        assert!(matches!(
            child.enqueue_metadata(br#"{"id":1,"method":"turn/start","params":{}}"#),
            Err(Error::InvalidFrame)
        ));
        assert!(matches!(
            child.enqueue_metadata(br#"{"owned_handle":"forged","method":"OpenOwnedSession"}"#),
            Err(Error::InvalidFrame)
        ));
        assert!(child.poll_exit().unwrap().is_none());
        match mode {
            0 => {
                let mut codec = child.open_broker_metadata().unwrap();
                assert!(codec.request().is_err()); // already submitted internally
                child.flush_stdin().unwrap();
                let request = loop {
                    match child.poll_stdout().unwrap() {
                        super::super::Output::Frame(frame) => break frame,
                        super::super::Output::Pending if Instant::now() < deadline => {
                            std::thread::yield_now()
                        }
                        other => panic!("unexpected synthetic request: {other:?}"),
                    }
                };
                let request: serde_json::Value = serde_json::from_slice(&request).unwrap();
                assert_eq!(request["method"], "OpenOwnedSession");
                assert_eq!(
                    request["params"]["identity"]["session_id"],
                    serde_json::json!(binding.session_id)
                );
                let mut response = serde_json::json!({"id":1,"result":{
                    "protocol":PROTOCOL,"identity":request["params"]["identity"],
                    "metadata_only":true,"owned_handle":"synthetic_owned"}});
                response["result"]["identity"]["session_id"] = serde_json::json!("foreign-session");
                assert!(codec.receive(response.to_string().as_bytes()).is_err());
                assert!(matches!(
                    child.open_broker_metadata(),
                    Err(Error::AuthorityProtocol)
                ));
                assert!(matches!(child.flush_stdin(), Err(Error::Revoked)));
            }
            1 => {
                store.revoke_session(&token).await.unwrap();
                assert!(matches!(child.open_broker_metadata(), Err(Error::Revoked)));
                assert!(matches!(child.flush_stdin(), Err(Error::Revoked)));
            }
            2 => {
                for _ in 0..TransportBounds::default().max_pending_frames {
                    child
                        .enqueue_metadata(
                            br#"{"id":2,"method":"account/read","params":{"refreshToken":false}}"#,
                        )
                        .unwrap();
                }
                assert!(matches!(
                    child.open_broker_metadata(),
                    Err(Error::Backpressure)
                ));
                assert!(child.open_broker_metadata().is_err());
                assert!(matches!(child.flush_stdin(), Err(Error::Revoked)));
            }
            _ => unreachable!(),
        }
        store.revoke_session(&token).await.unwrap();
        assert!(matches!(child.flush_stdin(), Err(Error::Revoked)));
        authority.revoke().unwrap();
        assert!(matches!(child.flush_stdin(), Err(Error::Revoked)));
        drop(child);
        drop(authority);
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }
}
