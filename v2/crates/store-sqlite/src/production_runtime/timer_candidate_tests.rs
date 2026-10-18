use super::*;
use crate::history_import::timers::{authority::DurableTimerEnable, *};
use crate::production_runtime::tests::{setup, snapshot};

#[tokio::test]
async fn discovery_is_bounded_current_owner_scoped_metadata_only() {
    let f = setup().await;
    let mut namespaces = Vec::new();
    for i in 0..4 {
        let namespace = Uuid::new_v4();
        f.store
            .import_dormant_timer(
                &f.token,
                &f.owner,
                &TimerImportRequest {
                    namespace,
                    source_namespace: "synthetic".into(),
                    source_timer_id: format!("timer-{i}"),
                    source_enabled: true,
                    schedule: TimerSchedule::Interval { every_ms: 86400000 },
                },
            )
            .await
            .unwrap();
        if i != 3 {
            f.store
                .enable_durable_timer(
                    &f.token,
                    &f.owner,
                    &DurableTimerEnable {
                        timer: TimerEnableRequest {
                            namespace,
                            expected_revision: 1,
                            request_key: format!("enable-{i}"),
                            conversation_id: f.conversation.clone(),
                        },
                        instruction: "Synthetic owner task".into(),
                    },
                )
                .await
                .unwrap();
            namespaces.push(namespace);
        }
    }
    namespaces.sort_by_key(|id| id.to_string());
    let before = snapshot(&f.store).await;
    assert!(f.store.timer_scheduler_candidates(None, 2).await.is_err());
    assert!(f.handle.timer_scheduler_candidates(None, 0).await.is_err());
    assert!(f.handle.timer_scheduler_candidates(None, 33).await.is_err());
    assert!(f
        .handle
        .timer_scheduler_candidates(Some(Uuid::nil()), 1)
        .await
        .is_err());
    assert_eq!(
        f.handle.timer_scheduler_candidates(None, 2).await.unwrap(),
        namespaces[..2]
    );
    assert_eq!(
        f.handle
            .timer_scheduler_candidates(Some(namespaces[1]), 2)
            .await
            .unwrap(),
        namespaces[2..]
    );
    assert!(f
        .handle
        .timer_scheduler_candidates(Some(namespaces[2]), 2)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(snapshot(&f.store).await, before);
    f.store
        .revoke_durable_timer(&f.token, &f.owner, namespaces[0], 2, "disable".into())
        .await
        .unwrap();
    assert_eq!(
        f.handle.timer_scheduler_candidates(None, 32).await.unwrap(),
        namespaces[1..]
    );
    // A fresh pool can rediscover through an authenticated bound reattachment;
    // no browser session or serialized scheduler issuer is needed.
    f.store.close().await;
    let reopened = Store::open(&f.root.join("core.sqlite3")).await.unwrap();
    let attached = f.handle.reattach_supervisor(&reopened).await.unwrap();
    assert_eq!(
        attached.timer_scheduler_candidates(None, 32).await.unwrap(),
        namespaces[1..]
    );
    reopened.revoke_session(&f.token).await.unwrap();
    assert!(attached.timer_scheduler_candidates(None, 32).await.is_err());
    reopened.close().await;
    std::fs::remove_dir_all(f.root).unwrap();
}
