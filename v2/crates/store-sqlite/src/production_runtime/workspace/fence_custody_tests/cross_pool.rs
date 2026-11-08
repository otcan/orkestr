use super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn explicit_root_grant_keeps_its_fresh_actor_across_independent_pools() {
    let f = setup().await;
    let (metadata, original_actor) = prepared(&f).await;
    let id = sqlx::query_scalar::<_, String>("SELECT id FROM workspace_projects")
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    let grant = f
        .handle
        .register_workspace(
            &f.token,
            &f.conversation,
            id.parse().unwrap(),
            root_installation(&f, original_actor.clone()),
        )
        .await
        .unwrap();
    let WorkspaceLaunchReservationResult::Reserved(reserved) = f
        .handle
        .reserve_workspace_launch(&f.token, &grant, &metadata, "cross-pool-launch")
        .await
        .unwrap()
    else {
        panic!("fresh reservation")
    };
    let duplicate = WorkspaceLaunchReservation {
        grant: Box::new(reserved.grant.retained()),
        binding: reserved.binding.clone(),
        id: reserved.id.clone(),
        nonce: reserved.nonce.clone(),
        metadata_key: reserved.metadata_key.clone(),
    };
    let pool = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let other = f.handle.reattach_supervisor(&pool).await.unwrap();
    let registry_actor = Arc::new(RootCheck {
        database: f.root.join("core.sqlite3"),
        probing: AtomicBool::new(false),
        calls: AtomicUsize::new(0),
        independent_writer: AtomicBool::new(false),
        original_alive: AtomicBool::new(true),
        policy_valid: AtomicBool::new(true),
        change_during_check: AtomicBool::new(false),
        ordinary_write_during_check: AtomicBool::new(false),
        physical_checks: AtomicUsize::new(0),
    });
    other
        .register_workspace(
            &f.token,
            &f.conversation,
            id.parse().unwrap(),
            root_installation(&f, registry_actor.clone()),
        )
        .await
        .unwrap();
    let registry = other
        .workspace_handles
        .0
        .lock()
        .unwrap()
        .get(&id)
        .unwrap()
        .clone();
    assert!(!Arc::ptr_eq(&grant.installation, &registry));
    // The registry actor cannot substitute for the explicit grant's actor,
    // in either direction. Only that grant is freshly checked for this attempt.
    registry_actor.original_alive.store(false, Ordering::SeqCst);
    let (first, second) = tokio::join!(
        f.handle.consume_workspace_launch(&f.token, reserved),
        other.consume_workspace_launch(&f.token, duplicate),
    );
    assert_eq!(
        [first.unwrap(), second.unwrap()]
            .into_iter()
            .filter(|result| matches!(result, WorkspaceLaunchConsumption::Launch(_)))
            .count(),
        1
    );
    assert!(matches!(
        other
            .reserve_workspace_launch(&f.token, &grant, &metadata, "cross-pool-launch")
            .await
            .unwrap(),
        WorkspaceLaunchReservationResult::ReconciliationRequired
    ));
    original_actor.original_alive.store(false, Ordering::SeqCst);
    assert!(other
        .reserve_workspace_launch(&f.token, &grant, &metadata, "cross-pool-launch")
        .await
        .is_err());
}
