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
