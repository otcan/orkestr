//! ORK-804: the owner-wide list of writes waiting for the owner's Allow.
use super::super::super::tests::{setup, Case};
use super::super::super::thread_asks::tests::asking_turn;
use super::*;

const BROWSER: &str = "browser:local-files-waiting";

fn request(key: &str, operation: LocalFileOperation, path: &str) -> LocalFileRequestCreate {
    LocalFileRequestCreate {
        request_key: key.into(),
        operation,
        path: Some(path.into()),
        paths: vec![],
        content_base64: (operation == LocalFileOperation::Write).then(|| "aGk=".into()),
        timeout_ms: None,
    }
}
fn poll(tab: Uuid) -> LocalFilePoll {
    LocalFilePoll {
        connection_id: tab,
        folder_name: "Synthetic folder".into(),
        takeover: false,
    }
}
async fn queue(f: &Case, grant: &str, key: &str, operation: LocalFileOperation) -> Uuid {
    let write = operation == LocalFileOperation::Write;
    f.store
        .create_local_file_request(
            grant,
            &f.conversation,
            &request(key, operation, "notes.txt"),
            write.then_some(b"hi".as_slice()),
        )
        .await
        .unwrap()
        .request
        .request_id
}
async fn sql(f: &Case, statement: &str) {
    sqlx::query(statement).execute(&f.store.pool).await.unwrap();
}
async fn waiting(f: &Case, credential: &str) -> Vec<LocalFileWriteWaiting> {
    f.store
        .local_file_writes_waiting(credential, &f.owner)
        .await
        .unwrap()
        .conversations
}

#[tokio::test]
async fn only_open_unexpired_writes_with_a_live_tab_are_listed() {
    let f = setup().await;
    let c = f.conversation.clone();
    f.store.save_session(BROWSER, &f.owner).await.unwrap();
    // The owner's browser or machine session; never anyone else's.
    for credential in ["", "unknown-credential"] {
        assert_eq!(
            f.store
                .local_file_writes_waiting(credential, &f.owner)
                .await,
            Err(ResourceError::Unauthorized)
        );
    }
    assert_eq!(
        f.store
            .local_file_writes_waiting(BROWSER, &OwnerId(Uuid::new_v4()))
            .await,
        Err(ResourceError::Unauthorized)
    );
    assert_eq!(waiting(&f, BROWSER).await, vec![]);
    let grant = f
        .store
        .issue_local_file_grant(&f.token, &f.owner, &c)
        .await
        .unwrap()
        .grant;
    asking_turn(&f, &c, "local-files-waiting").await;
    let tab = Uuid::new_v4();
    f.store
        .poll_local_files(BROWSER, &f.owner, &c, &poll(tab))
        .await
        .unwrap();
    // Reads are not writes the owner has to allow.
    queue(&f, &grant, "list", LocalFileOperation::List).await;
    assert_eq!(waiting(&f, BROWSER).await, vec![]);
    let first = queue(&f, &grant, "w-1", LocalFileOperation::Write).await;
    let second = queue(&f, &grant, "w-2", LocalFileOperation::Write).await;
    let listed = waiting(&f, &f.token).await;
    assert_eq!(listed.len(), 1, "one entry per conversation");
    let entry = &listed[0];
    assert_eq!(entry.conversation_id, c);
    assert_eq!(entry.folder_name, "Synthetic folder");
    assert_eq!(entry.writes, 2);
    assert!(!entry.conversation_name.is_empty());
    let deadline: i64 = sqlx::query_scalar(
        "SELECT min(deadline_ms) FROM local_file_requests WHERE operation='write'",
    )
    .fetch_one(&f.store.pool)
    .await
    .unwrap();
    assert_eq!(entry.deadline_ms, deadline);
    assert!(LocalFileWritesWaiting {
        conversations: listed.clone()
    }
    .is_valid());
    // Taken by the tab (shown to the owner) they still wait.
    f.store
        .poll_local_files(BROWSER, &f.owner, &c, &poll(tab))
        .await
        .unwrap();
    assert_eq!(waiting(&f, BROWSER).await[0].writes, 2);
    // Answered: no longer waiting.
    let refused = LocalFileFinish {
        connection_id: tab,
        outcome: LocalFileOutcome::Failed,
        error: Some("refused_by_owner".into()),
        listing: None,
        hashes: None,
        written: None,
        upload_id: None,
        empty: false,
        files: vec![],
        last_modified_ms: None,
    };
    f.store
        .finish_local_file_request(BROWSER, &f.owner, &c, first, &refused, None)
        .await
        .unwrap();
    assert_eq!(waiting(&f, BROWSER).await[0].writes, 1);
    // Past its deadline it is not listed, before anything settled it (the
    // list itself writes nothing).
    sql(
        &f,
        &format!("UPDATE local_file_requests SET deadline_ms=1 WHERE id='{second}'"),
    )
    .await;
    assert_eq!(waiting(&f, BROWSER).await, vec![]);
    let state: String = sqlx::query_scalar("SELECT state FROM local_file_requests WHERE id=?")
        .bind(second.to_string())
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(state, "working", "a read-only list");
    // A tab that stopped polling cannot be asked: nothing is listed.
    queue(&f, &grant, "w-3", LocalFileOperation::Write).await;
    sql(
        &f,
        "UPDATE conversation_directory SET name='Synthetic\nchat'",
    )
    .await;
    let listed = waiting(&f, BROWSER).await;
    assert_eq!(
        (listed.len(), listed[0].conversation_name.as_str()),
        (1, "Synthetic chat")
    );
    sql(&f, "UPDATE local_file_connections SET seen_ms=1").await;
    assert_eq!(waiting(&f, BROWSER).await, vec![]);
}

#[tokio::test]
async fn a_queue_deeper_than_older_uis_accept_is_reported_capped() {
    // ORK-810: writes are queued, not refused, so a batch can exceed the
    // count UI releases before it validate. The kept list caps it.
    let f = setup().await;
    let c = f.conversation.clone();
    f.store.save_session(BROWSER, &f.owner).await.unwrap();
    let grant = f
        .store
        .issue_local_file_grant(&f.token, &f.owner, &c)
        .await
        .unwrap()
        .grant;
    asking_turn(&f, &c, "local-files-waiting-deep").await;
    f.store
        .poll_local_files(BROWSER, &f.owner, &c, &poll(Uuid::new_v4()))
        .await
        .unwrap();
    for i in 0..LOCAL_FILE_OPEN_MAX + 3 {
        queue(&f, &grant, &format!("deep-{i}"), LocalFileOperation::Write).await;
    }
    let listed = waiting(&f, BROWSER).await;
    assert_eq!(listed[0].writes, LOCAL_FILE_OPEN_MAX as u32);
    assert!(LocalFileWritesWaiting {
        conversations: listed
    }
    .is_valid());
}
