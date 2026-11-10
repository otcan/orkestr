//! Current credentials, rather than cached OwnerId, guard decisions and replay.
use super::*;

#[tokio::test]
async fn revoked_and_expired_browser_credentials_cannot_accept_or_replay() {
    for committed in [false, true] {
        for expired in [false, true] {
            let (c, _h, _p, request) = acceptance::proposal().await;
            let credential = format!("browser:{}", Uuid::new_v4().simple());
            c.store.save_session(&credential, &c.owner).await.unwrap();
            assert_eq!(
                c.store.authenticate(&credential).await.unwrap(),
                Some(c.owner.clone())
            );
            if committed {
                let receipt = c
                    .store
                    .accept_execution_authenticated(&credential, &c.conversation, &request)
                    .await
                    .unwrap();
                assert_eq!(
                    c.store
                        .accept_execution_authenticated(&credential, &c.conversation, &request)
                        .await
                        .unwrap(),
                    receipt
                );
            }
            if expired {
                // Synthetic owned database fault injection; never read or print auth rows.
                let mut db = sqlx::SqliteConnection::connect_with(
                    &sqlx::sqlite::SqliteConnectOptions::new()
                        .filename(c.root.join("core.sqlite3")),
                )
                .await
                .unwrap();
                sqlx::query("UPDATE auth_sessions SET expires_at=unixepoch()-1")
                    .execute(&mut db)
                    .await
                    .unwrap();
                db.close().await.unwrap();
            } else {
                c.store.revoke_session(&credential).await.unwrap();
            }
            let before = oracle::rows(&c.root).await;
            let reopened = Store::open(&c.root.join("core.sqlite3")).await.unwrap();
            for store in [&c.store, &reopened] {
                assert_eq!(store.authenticate(&credential).await.unwrap(), None);
                assert!(matches!(
                    store
                        .accept_execution_authenticated(&credential, &c.conversation, &request)
                        .await,
                    Err(RuntimeStoreError::Unauthorized)
                ));
                assert_eq!(oracle::rows(&c.root).await, before);
            }
            reopened.close().await;
        }
    }
}

#[cfg(feature = "fixture-test-controls")]
#[tokio::test]
async fn session_invalidated_after_lookup_cannot_commit_or_replay() {
    use orkestr_v2_store_sqlite::ProductionCheckpoint;
    for committed in [false, true] {
        for expired in [false, true] {
            let (mut c, _h, _p, request) = acceptance::proposal().await;
            let credential = format!("browser:{}", Uuid::new_v4().simple());
            c.store.save_session(&credential, &c.owner).await.unwrap();
            if committed {
                c.store
                    .accept_execution_authenticated(&credential, &c.conversation, &request)
                    .await
                    .unwrap();
            }
            let marker = c.root.join("after-authentication");
            c.store
                .production_arm_owner_checkpoint(
                    &c.owner,
                    &c.conversation,
                    ProductionCheckpoint::AcceptanceAfterAuthentication,
                    marker.clone(),
                )
                .await
                .unwrap();
            let writer = c.store.clone();
            let key = credential.clone();
            let conversation = c.conversation.clone();
            let pending = tokio::spawn(async move {
                writer
                    .accept_execution_authenticated(&key, &conversation, &request)
                    .await
            });
            tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    if let Ok(bytes) = std::fs::read(&marker) {
                        if bytes == b"acceptance-after-authentication" {
                            break;
                        }
                    }
                    assert!(
                        !pending.is_finished(),
                        "acceptance exited before synchronization"
                    );
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            let other = Store::open(&c.root.join("core.sqlite3")).await.unwrap();
            if expired {
                let mut db = sqlx::SqliteConnection::connect_with(
                    &sqlx::sqlite::SqliteConnectOptions::new()
                        .filename(c.root.join("core.sqlite3")),
                )
                .await
                .unwrap();
                sqlx::query("UPDATE auth_sessions SET expires_at=unixepoch()-1")
                    .execute(&mut db)
                    .await
                    .unwrap();
                db.close().await.unwrap();
            } else {
                other.revoke_session(&credential).await.unwrap();
            }
            assert_eq!(other.authenticate(&credential).await.unwrap(), None);
            let before = oracle::rows(&c.root).await;
            std::fs::remove_file(marker).unwrap();
            assert!(matches!(
                tokio::time::timeout(Duration::from_secs(10), pending)
                    .await
                    .unwrap()
                    .unwrap(),
                Err(RuntimeStoreError::Unauthorized)
            ));
            assert_eq!(oracle::rows(&c.root).await, before);
            other.close().await;
        }
    }
}
