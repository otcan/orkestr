//! Root-attested bootstrap without granting Core traversal of private projects.
//! Local trusted composition only; no Deserialize/HTTP or locator grant issuer.
use super::*;

/// A retained live Root-manager channel, scoped by trusted operator bootstrap
/// to one owner/conversation/project. Implementations MUST authenticate the
/// exact original Root PID/start before sending, perform a fresh descriptor-
/// anchored path/Git association check and refuse unknown/lost replies. A
/// cached fingerprint, filesystem path or model-supplied JSON is insufficient.
pub trait RootWorkspaceCustody: Send + Sync {
    /// Local original-actor liveness only: no IPC, provider or blocking wait.
    /// An implementation must opt in before a preflight can cross into a writer.
    fn check_original_actor(&self) -> Result<()> {
        Err(RuntimeStoreError::Unavailable)
    }
    /// Explicit contract: the authenticated Root checks each retained inode's
    /// named executor ACL and rejects every unselected effective writer on
    /// every check. Default false preserves strict Unix mode-only custody.
    fn verifies_named_executor_acl(&self) -> bool {
        false
    }
    fn check(
        &self,
        paths: &[PathBuf; 3],
        identities: [WorkspaceDirectoryIdentity; 3],
    ) -> Result<()>;
}

impl WorkspaceOperatorAllowlist {
    /// Only the authenticated original Root manager can supply these handles.
    /// The callback above remains retained and is invoked for EVERY existing
    /// Store installation/metadata/command fence, including initial bootstrap.
    /// One exception: the repeated fences of one metadata setup share the
    /// setup's fresh check for at most SETUP_ATTESTATION, after local checks,
    /// and readiness confirmation checks afresh (setup_attestation.rs).
    /// No Unix owner, traversal permission, project generation or fingerprint
    /// is rewritten. Historical rows still require exact fresh correspondence.
    pub fn installation_from_root(
        &self,
        paths: [PathBuf; 3],
        descriptors: [OwnedFd; 3],
        custody: Arc<dyn RootWorkspaceCustody>,
    ) -> Result<WorkspaceInstallation> {
        let paths = paths
            .map(|path| normal(&path))
            .into_iter()
            .collect::<Result<Vec<_>>>()?;
        if !self.roots.contains(&paths[0]) {
            return Err(RuntimeStoreError::Fenced);
        }
        let mut directories = Vec::new();
        for (path, descriptor) in paths.into_iter().zip(descriptors) {
            let file = File::from(descriptor);
            let meta = file.metadata().map_err(db)?;
            let forbidden = if custody.verifies_named_executor_acl() {
                0o002
            } else {
                0o022
            };
            if !meta.is_dir() || meta.uid() != self.uid || meta.mode() & forbidden != 0 {
                return Err(RuntimeStoreError::Fenced);
            }
            directories.push(Directory {
                file,
                path,
                identity: WorkspaceDirectoryIdentity {
                    device: meta.dev(),
                    inode: meta.ino(),
                    uid: meta.uid(),
                },
            });
        }
        let [workspace, git, common]: [Directory; 3] = directories
            .try_into()
            .map_err(|_| RuntimeStoreError::Fenced)?;
        let installation = Installation {
            workspace,
            git,
            common,
            root_custody: Some(custody),
        };
        for protected in &self.protected {
            installation.reject_overlap(protected)?;
        }
        installation.check()?;
        Ok(WorkspaceInstallation {
            inner: Arc::new(installation),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        os::unix::fs::PermissionsExt,
        sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    };

    struct RootCheck {
        valid: AtomicBool,
        calls: AtomicUsize,
        expected: [PathBuf; 3],
    }
    impl RootWorkspaceCustody for RootCheck {
        fn check_original_actor(&self) -> Result<()> {
            if self.valid.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err(RuntimeStoreError::Fenced)
            }
        }
        fn check(&self, paths: &[PathBuf; 3], _: [WorkspaceDirectoryIdentity; 3]) -> Result<()> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.valid.load(Ordering::SeqCst) && paths == &self.expected {
                Ok(())
            } else {
                Err(RuntimeStoreError::Fenced)
            }
        }
    }

    #[test]
    fn root_checks_are_fresh_while_core_only_retains_private_project_descriptors() {
        let root = PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").unwrap())
            .join(format!("root-project-{}", Uuid::new_v4()));
        let project = root.join("project");
        let git = project.join(".git");
        std::fs::create_dir_all(&git).unwrap();
        for path in [&root, &project, &git] {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let uid = std::fs::metadata(&project).unwrap().uid();
        let paths = [project.clone(), git.clone(), git.clone()];
        let descriptors = paths.clone().map(|path| File::open(path).unwrap().into());
        let check = Arc::new(RootCheck {
            valid: AtomicBool::new(true),
            calls: AtomicUsize::new(0),
            expected: paths.clone(),
        });
        let allow =
            WorkspaceOperatorAllowlist::new(vec![project], vec![root.join("protected")], uid)
                .unwrap();
        // Existing handles remain valid after Core loses ancestor traversal.
        // The real callback uses authenticated Root; this unit fixture models
        // that independently-held check and never claims cross-UID acceptance.
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o0)).unwrap();
        let installation = allow.installation_from_root(paths, descriptors, check.clone());
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let installation = installation.unwrap();
        installation.inner.check().unwrap();
        assert_eq!(check.calls.load(Ordering::SeqCst), 2);
        check.valid.store(false, Ordering::SeqCst);
        assert!(matches!(
            installation.inner.check(),
            Err(RuntimeStoreError::Fenced)
        ));
        assert_eq!(check.calls.load(Ordering::SeqCst), 3);
        drop(installation);
        std::fs::remove_dir_all(root).unwrap();
    }
}
