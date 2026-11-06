//! Synthetic child and actual Store fencing; no provider or manager endpoint.
use super::*;
use orkestr_v2_application::runtime::*;
use orkestr_v2_store_sqlite::WorkspaceOperatorAllowlist;
use std::os::unix::fs::{MetadataExt, PermissionsExt};

async fn exercise(replace_after_ack: bool) {
    let root = std::env::temp_dir().join(format!(
        "setup-stage-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&root).unwrap();
    for name in ["project/.git", "home", "tmp", "data"] {
        std::fs::create_dir_all(root.join(name)).unwrap();
    }
    let store = Store::open(&root.join("data/core.sqlite3")).await.unwrap();
    let conversation = store.setup("synthetic", "synthetic-hash").await.unwrap();
    let owner = store.credentials("synthetic").await.unwrap().unwrap().0;
    let token = "ab".repeat(32);
    store.save_session(&token, &owner).await.unwrap();
    let bound = store
        .authorize_supervisor(
            &token,
            ProductionSupervisorConfig {
                provider: ProviderKind::Codex,
                namespace: "synthetic".into(),
                supervisor_key: "synthetic".into(),
                takeover: ProductionTakeover::First,
            },
        )
        .await
        .unwrap();
    let project = root.join("project").canonicalize().unwrap();
    let allow = WorkspaceOperatorAllowlist::new(
        vec![project.clone()],
        vec![root.join("data")],
        std::fs::metadata(&project).unwrap().uid(),
    )
    .unwrap();
    let workspace = bound
        .register_workspace(
            &token,
            &conversation,
            "00000000-0000-4000-8000-000000000001".parse().unwrap(),
            allow.installation(&project).unwrap(),
        )
        .await
        .unwrap();
    let binding = bound
        .ensure_role_bindings(&owner, &conversation)
        .await
        .unwrap()
        .deep;
    bound
        .bind_workspace_session(&token, &workspace, &binding)
        .await
        .unwrap();
    let grant = bound.authorize_session_metadata(&binding).await.unwrap();
    let launcher = root.join("synthetic-broker");
    std::fs::write(&launcher, "#!/bin/sh\nexec /bin/cat\n").unwrap();
    std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o700)).unwrap();
    let directories =
        ChildDirectories::new(&project, &root.join("home"), &root.join("tmp")).unwrap();
    crate::setup_diagnostics::take_events();
    let mut acknowledged = false;
    let mut before_open = |_child: &MetadataChild| {
        // A successful callback represents an ACK, not a retry or a new grant.
        if !replace_after_ack {
            return Err(SetupFailure::Protocol(Blocker::Protocol));
        }
        acknowledged = true;
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(bound.replace_workspace(
                &token,
                &workspace,
                allow.installation(&project).unwrap(),
            ))
        })
        .unwrap();
        Ok(())
    };
    let result = PreparingCodex::open_mode(
        bound.clone(),
        grant,
        &launcher,
        &project,
        directories,
        false,
        ToolProfile::None,
        Box::new(()),
        None,
        Some(&mut before_open),
    );
    let events = crate::setup_diagnostics::take_events();
    if replace_after_ack {
        assert!(acknowledged);
        assert!(matches!(
            &result,
            Err(SetupFailure::Transport(crate::containment::Error::Revoked))
        ));
        assert!(events.contains(&(Stage::ManagerBind, "ok")));
        assert!(events.contains(&(Stage::MetadataOpen, "revoked")));
        assert!(events.contains(&(Stage::MetadataFence, "revoked")));
        assert!(!events
            .iter()
            .any(|(stage, _)| *stage == Stage::MetadataEnqueue));
        assert!(bound.authorize_session_metadata(&binding).await.is_err());
    } else {
        assert!(!acknowledged);
        assert!(matches!(
            &result,
            Err(SetupFailure::Protocol(Blocker::Protocol))
        ));
        assert!(events.contains(&(Stage::ManagerBind, "protocol")));
        assert!(!events
            .iter()
            .any(|(stage, _)| *stage == Stage::MetadataOpen));
    }
    drop(result);
    drop(bound);
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn successful_before_open_then_workspace_replacement_is_postbind_failure() {
    exercise(true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refused_before_open_is_bind_failure_without_metadata_open() {
    exercise(false).await;
}
