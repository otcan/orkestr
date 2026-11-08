use super::*;
use sqlx::sqlite::SqlitePoolOptions;

async fn consumed(f: &Case, metadata: BoundSessionMetadata) -> Box<ConsumedProviderDispatch> {
    let session = metadata.binding().session_id.clone();
    let ready = f
        .handle
        .confirm_metadata_session(
            metadata,
            NativeSessionConfirmation {
                session_id: session,
                expected_generation: 1,
                native_session_id: "synthetic-native".into(),
                protocol_version: "codex-rpc-1".into(),
                source_event_key: "synthetic-ready".into(),
            },
        )
        .await
        .unwrap();
    let claim = claim(f, ready.binding()).await;
    let candidate = f
        .handle
        .admit_run(
            &claim,
            &ready.binding().session_id,
            ready.binding().generation,
            "synthetic-run",
        )
        .await
        .unwrap();
    let DispatchClaimResult::Reserved(reservation) = f
        .handle
        .claim_provider_dispatch(&candidate, "synthetic-dispatch")
        .await
        .unwrap()
    else {
        panic!("fresh reservation")
    };
    let ExecutionConsumption::Dispatch(capability) =
        f.handle.consume_execution(&reservation).await.unwrap()
    else {
        panic!("fresh dispatch")
    };
    capability
}

#[derive(Clone, Copy)]
enum Mutation {
    Output,
    EveryOutput,
    GitSwap,
    Mode,
    RootPolicy,
    ExpiredOutput,
}

async fn mutation_store(
    f: &Case,
    check: &Arc<RootCheck>,
    mutation: Mutation,
) -> (Store, Arc<AtomicBool>, usize) {
    let checks = check.physical_checks.load(Ordering::SeqCst);
    let wrote = Arc::new(AtomicBool::new(false));
    let observed = Arc::new(AtomicUsize::new(checks));
    let mut store = f.handle.clone();
    let hook_check = check.clone();
    let hook_wrote = wrote.clone();
    let project = f.root.with_extension("project");
    // The pool's real acquisition hook runs after the Root callback and before
    // BEGIN IMMEDIATE. It deterministically models a separate authorized
    // command publishing its ordinary output in that handoff gap.
    store.pool = SqlitePoolOptions::new()
        .min_connections(1)
        .max_connections(1)
        .before_acquire(move |_, _| {
            let check = hook_check.clone();
            let wrote = hook_wrote.clone();
            let observed = observed.clone();
            let project = project.clone();
            Box::pin(async move {
                let current = check.physical_checks.load(Ordering::SeqCst);
                let changed = current > checks
                    && if matches!(mutation, Mutation::EveryOutput) {
                        observed.swap(current, Ordering::SeqCst) != current
                    } else {
                        !wrote.swap(true, Ordering::SeqCst)
                    };
                if changed {
                    wrote.store(true, Ordering::SeqCst);
                    match mutation {
                        Mutation::GitSwap => {
                            std::fs::rename(project.join(".git"), project.join("old-git")).unwrap();
                            std::fs::create_dir(project.join(".git")).unwrap();
                        }
                        Mutation::Mode => {
                            use std::os::unix::fs::PermissionsExt;
                            std::fs::set_permissions(
                                &project,
                                std::fs::Permissions::from_mode(0o700),
                            )
                            .unwrap();
                        }
                        mutation => {
                            std::fs::write(
                                project.join(format!("ordinary-command-output-{current}")),
                                b"output",
                            )
                            .unwrap();
                            if matches!(mutation, Mutation::RootPolicy) {
                                check.policy_valid.store(false, Ordering::SeqCst);
                            }
                            if matches!(mutation, Mutation::ExpiredOutput) {
                                std::thread::sleep(Duration::from_millis(150));
                            }
                        }
                    }
                }
                Ok(true)
            })
        })
        .connect_with(
            SqliteConnectOptions::new()
                .filename(f.root.join("core.sqlite3"))
                .foreign_keys(true),
        )
        .await
        .unwrap();
    (store, wrote, checks)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn command_output_before_writer_gets_one_fresh_check_and_one_execution_action() {
    let f = setup().await;
    let (metadata, check) = prepared(&f).await;
    let capability = consumed(&f, metadata).await;
    check.probing.store(true, Ordering::SeqCst);
    let (store, wrote, checks) = mutation_store(&f, &check, Mutation::Output).await;
    let mut actions = 0;
    assert_eq!(
        store.with_execution_fence(capability.provider(), || {
            actions += 1;
            Ok::<_, ()>(())
        }),
        Ok(Ok(()))
    );
    assert!(wrote.load(Ordering::SeqCst));
    assert_eq!(actions, 1);
    assert_eq!(check.physical_checks.load(Ordering::SeqCst) - checks, 2);
    assert_eq!(check.calls.load(Ordering::SeqCst), 2);
    assert!(check.independent_writer.load(Ordering::SeqCst));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn changes_cannot_refresh_forever_or_bypass_root_policy_git_mode_or_deadline() {
    for (mutation, expected_checks) in [
        (Mutation::EveryOutput, 2),
        (Mutation::RootPolicy, 2),
        (Mutation::GitSwap, 2),
        (Mutation::Mode, 1),
        (Mutation::ExpiredOutput, 1),
    ] {
        let f = setup().await;
        let (metadata, check) = prepared(&f).await;
        let capability = consumed(&f, metadata).await;
        let (store, wrote, checks) = mutation_store(&f, &check, mutation).await;
        let mut actions = 0;
        assert_eq!(
            store.with_execution_fence(capability.provider(), || {
                actions += 1;
                Ok::<_, ()>(())
            }),
            Err(RuntimeStoreError::Fenced)
        );
        assert!(wrote.load(Ordering::SeqCst));
        assert_eq!(actions, 0);
        assert_eq!(
            check.physical_checks.load(Ordering::SeqCst) - checks,
            expected_checks
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn borrowed_scope_never_opens_another_root_check_while_outer_channel_waits() {
    let f = setup().await;
    let (metadata, check) = prepared(&f).await;
    let capability = consumed(&f, metadata).await;
    let guard = f
        .handle
        .preflight_workspace(&f.owner, &f.conversation)
        .await
        .unwrap();
    let checks = check.physical_checks.load(Ordering::SeqCst);
    // ManagerClient owns this preflight before connecting its waiting outer
    // socket. The nested execution fence borrows the same scoped proof.
    let (_outer, mut waiting) = std::os::unix::net::UnixStream::pair().unwrap();
    waiting.set_nonblocking(true).unwrap();
    std::fs::write(
        f.root.with_extension("project").join("ordinary-output"),
        b"output",
    )
    .unwrap();
    let mut actions = 0;
    assert_eq!(
        guard.with_execution_fence(capability.provider(), || {
            actions += 1;
            Ok::<_, ()>(())
        }),
        Err(RuntimeStoreError::Fenced)
    );
    assert_eq!(actions, 0);
    assert_eq!(check.physical_checks.load(Ordering::SeqCst), checks);
    use std::io::Read;
    assert_eq!(
        waiting.read(&mut [0]).unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn slow_root_execution_attestation_does_not_hold_core_writer() {
    let f = setup().await;
    let (metadata, check) = prepared(&f).await;
    let capability = consumed(&f, metadata).await;
    check.probing.store(true, Ordering::SeqCst);
    assert_eq!(
        f.handle
            .with_execution_fence(capability.provider(), || Ok::<_, ()>(9)),
        Ok(Ok(9))
    );
    assert_eq!(check.calls.load(Ordering::SeqCst), 1);
    assert!(
        check.independent_writer.load(Ordering::SeqCst),
        "Root attestation held the Core SQLite writer while awaiting its peer"
    );
}

struct BudgetCheck {
    inner: Arc<RootCheck>,
    armed: AtomicBool,
    delayed_calls: AtomicUsize,
}
impl RootWorkspaceCustody for BudgetCheck {
    fn check_original_actor(&self) -> Result<()> {
        self.inner.check_original_actor()
    }
    fn check(
        &self,
        paths: &[PathBuf; 3],
        identities: [WorkspaceDirectoryIdentity; 3],
    ) -> Result<()> {
        self.inner.check(paths, identities)?;
        if self.armed.load(Ordering::SeqCst) {
            let call = self.delayed_calls.fetch_add(1, Ordering::SeqCst);
            std::thread::sleep(if call == 0 {
                Duration::from_millis(4_200)
            } else {
                Duration::from_millis(1_200)
            });
        }
        Ok(())
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refresh_keeps_original_five_second_physical_budget() {
    let f = setup().await;
    let check = root_check(&f);
    let budget = Arc::new(BudgetCheck {
        inner: check.clone(),
        armed: AtomicBool::new(false),
        delayed_calls: AtomicUsize::new(0),
    });
    let metadata = prepared_with_check(&f, budget.clone()).await;
    let capability = consumed(&f, metadata).await;
    let (store, wrote, _) = mutation_store(&f, &check, Mutation::Output).await;
    budget.armed.store(true, Ordering::SeqCst);
    let started = std::time::Instant::now();
    let mut actions = 0;
    assert_eq!(
        store.with_execution_fence(capability.provider(), || {
            actions += 1;
            Ok::<_, ()>(())
        }),
        Err(RuntimeStoreError::Unavailable)
    );
    // A renewed five-second budget would let the 1.2s second callback finish
    // after the 4.2s first callback and would incorrectly invoke the action.
    assert!(wrote.load(Ordering::SeqCst));
    assert_eq!(budget.delayed_calls.load(Ordering::SeqCst), 2);
    assert_eq!(actions, 0);
    assert!(started.elapsed() < Duration::from_millis(6_500));
}
