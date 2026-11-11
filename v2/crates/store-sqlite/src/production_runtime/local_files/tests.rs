use super::super::tests::{setup, Case};
use super::super::thread_asks::tests::{asking_turn, conversation};
use super::view::package_name;
use super::*;
use orkestr_v2_contracts::{
    LocalFileDigest, LocalFileEntry, LocalFileHashes, LocalFileKind, LocalFileListing,
    LocalFileWritten, LOCAL_FILE_PATHS_MAX,
};

const BROWSER: &str = "browser:local-files-tab";

async fn browser(f: &Case) -> String {
    f.store.save_session(BROWSER, &f.owner).await.unwrap();
    BROWSER.into()
}
fn list(key: &str, path: &str) -> LocalFileRequestCreate {
    LocalFileRequestCreate {
        request_key: key.into(),
        operation: LocalFileOperation::List,
        path: Some(path.into()),
        paths: vec![],
        content_base64: None,
        timeout_ms: None,
    }
}
fn with(
    key: &str,
    operation: LocalFileOperation,
    path: Option<&str>,
    paths: &[&str],
) -> LocalFileRequestCreate {
    LocalFileRequestCreate {
        request_key: key.into(),
        operation,
        path: path.map(Into::into),
        paths: paths.iter().map(|p| p.to_string()).collect(),
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
fn done(tab: Uuid) -> LocalFileFinish {
    LocalFileFinish {
        connection_id: tab,
        outcome: LocalFileOutcome::Done,
        error: None,
        listing: None,
        hashes: None,
        written: None,
        upload_id: None,
        empty: false,
        files: vec![],
        last_modified_ms: None,
    }
}
fn failed(tab: Uuid, code: &str) -> LocalFileFinish {
    LocalFileFinish {
        outcome: LocalFileOutcome::Failed,
        error: Some(code.into()),
        ..done(tab)
    }
}
/// A granted conversation with a running Deep turn and a connected tab.
async fn ready(f: &Case) -> (String, String, Uuid) {
    let grant = f
        .store
        .issue_local_file_grant(&f.token, &f.owner, &f.conversation)
        .await
        .unwrap()
        .grant;
    asking_turn(f, &f.conversation, "local-files").await;
    let tab = Uuid::new_v4();
    let credential = browser(f).await;
    f.store
        .poll_local_files(&credential, &f.owner, &f.conversation, &poll(tab))
        .await
        .unwrap();
    (grant, credential, tab)
}
async fn sql(f: &Case, statement: &str) {
    sqlx::query(statement).execute(&f.store.pool).await.unwrap();
}

#[tokio::test]
async fn grant_turn_and_tab_authority() {
    let f = setup().await;
    let c = f.conversation.clone();
    let other = conversation(&f, "Other").await;
    let request = list("k-1", "");
    assert_eq!(
        f.store
            .create_local_file_request(&"0".repeat(64), &c, &request, None)
            .await,
        Err(ResourceError::Unauthorized)
    );
    let grant = f
        .store
        .issue_local_file_grant(&f.token, &f.owner, &c)
        .await
        .unwrap();
    assert_eq!(grant.binding.generation, 1);
    // A grant only works for its own conversation.
    assert_eq!(
        f.store
            .create_local_file_request(&grant.grant, &other, &request, None)
            .await,
        Err(ResourceError::Unauthorized)
    );
    // No running Deep turn: the grant does nothing.
    assert_eq!(
        f.store
            .create_local_file_request(&grant.grant, &c, &request, None)
            .await,
        Err(ResourceError::Conflict("local_files_no_running_turn"))
    );
    asking_turn(&f, &c, "turn").await;
    // No tab connected: a clear refusal, nothing queued.
    assert_eq!(
        f.store
            .create_local_file_request(&grant.grant, &c, &request, None)
            .await,
        Err(ResourceError::Conflict("local_files_not_connected"))
    );
    // Only an interactive browser session may act as the tab: not the
    // machine bearer, not a service credential session.
    let tab = Uuid::new_v4();
    assert_eq!(
        f.store
            .poll_local_files(&f.token, &f.owner, &c, &poll(tab))
            .await,
        Err(ResourceError::Unauthorized)
    );
    sqlx::query("INSERT INTO service_credentials(id,owner_id,label,token_hash,expires_at) VALUES('service-1',?,'synthetic grants',?,unixepoch()+600)")
        .bind(f.owner.to_string()).bind(crate::digest("synthetic-service-key"))
        .execute(&f.store.pool).await.unwrap();
    for (token, credential) in [
        ("browser:service", Some("service-1")),
        ("browser:dangling", None),
    ] {
        sqlx::query("INSERT INTO auth_sessions(token_hash,owner_id,expires_at,kind,service_credential_id) VALUES(?,?,unixepoch()+600,'service_browser',?)")
            .bind(crate::digest(token)).bind(f.owner.to_string()).bind(credential)
            .execute(&f.store.pool).await.unwrap();
    }
    assert_eq!(
        f.store
            .poll_local_files("browser:service", &f.owner, &c, &poll(tab))
            .await,
        Err(ResourceError::Unauthorized)
    );
    // The owner's dedicated service credential may provision the grant (as
    // for agent timers), but only while the credential itself is live.
    let read = f
        .store
        .local_file_grant("browser:service", &f.owner, &c)
        .await
        .unwrap();
    assert!(read.issued && read.generation == 1);
    assert_eq!(
        f.store
            .local_file_grant("browser:dangling", &f.owner, &c)
            .await,
        Err(ResourceError::Unauthorized)
    );
    sqlx::query("UPDATE service_credentials SET revoked=1 WHERE id='service-1'")
        .execute(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(
        f.store
            .issue_local_file_grant("browser:service", &f.owner, &c)
            .await
            .map(|_| ()),
        Err(ResourceError::Unauthorized)
    );
    let credential = browser(&f).await;
    f.store
        .poll_local_files(&credential, &f.owner, &c, &poll(tab))
        .await
        .unwrap();
    let receipt = f
        .store
        .create_local_file_request(&grant.grant, &c, &request, None)
        .await
        .unwrap();
    assert!(receipt.created);
    assert_eq!(receipt.request.state, LocalFileState::Queued);
    // The owner credential never reads agent requests through the grant
    // route, and the tab of another conversation sees nothing here.
    assert_eq!(
        f.store
            .local_file_request(&f.token, &c, receipt.request.request_id)
            .await,
        Err(ResourceError::Unauthorized)
    );
    let elsewhere = f
        .store
        .poll_local_files(&credential, &f.owner, &other, &poll(Uuid::new_v4()))
        .await
        .unwrap();
    assert!(elsewhere.requests.is_empty());
    // Revocation is immediate and fails what is still open.
    f.store
        .revoke_local_file_grant(&f.token, &f.owner, &c)
        .await
        .unwrap();
    assert_eq!(
        f.store
            .local_file_request(&grant.grant, &c, receipt.request.request_id)
            .await,
        Err(ResourceError::Unauthorized)
    );
    let log = f
        .store
        .local_files_overview(&credential, &f.owner, &c, 20)
        .await
        .unwrap();
    assert!(!log.grant.issued);
    assert_eq!(
        log.requests[0].error.as_deref(),
        Some("local_files_grant_revoked")
    );
}

#[tokio::test]
async fn list_hash_and_write_round_trip_bound_to_the_request() {
    let f = setup().await;
    let c = f.conversation.clone();
    let (grant, credential, tab) = ready(&f).await;
    let first = f
        .store
        .create_local_file_request(&grant, &c, &list("ls", "docs"), None)
        .await
        .unwrap();
    // A replay is the same request; the same key with another body conflicts.
    let again = f
        .store
        .create_local_file_request(&grant, &c, &list("ls", "docs"), None)
        .await
        .unwrap();
    assert!(!again.created);
    assert_eq!(again.request.request_id, first.request.request_id);
    assert_eq!(
        f.store
            .create_local_file_request(&grant, &c, &list("ls", "other"), None)
            .await,
        Err(ResourceError::Conflict("local_file_request_conflict"))
    );
    let id = first.request.request_id;
    let held = f
        .store
        .poll_local_files(&credential, &f.owner, &c, &poll(tab))
        .await
        .unwrap();
    assert_eq!(held.requests.len(), 1);
    assert_eq!(held.requests[0].state, LocalFileState::Working);
    // A result of the wrong shape is refused.
    let mut wrong = done(tab);
    wrong.hashes = Some(LocalFileHashes { files: vec![] });
    assert_eq!(
        f.store
            .finish_local_file_request(&credential, &f.owner, &c, id, &wrong, None)
            .await,
        Err(ResourceError::Invalid)
    );
    let mut bad = done(tab);
    bad.listing = Some(LocalFileListing {
        entries: vec![LocalFileEntry {
            name: "../escape".into(),
            kind: LocalFileKind::File,
            size: Some(1),
            last_modified_ms: None,
        }],
        truncated: false,
    });
    assert_eq!(
        f.store
            .finish_local_file_request(&credential, &f.owner, &c, id, &bad, None)
            .await,
        Err(ResourceError::Invalid)
    );
    let mut listing = done(tab);
    listing.listing = Some(LocalFileListing {
        entries: vec![LocalFileEntry {
            name: "plan.md".into(),
            kind: LocalFileKind::File,
            size: Some(12),
            last_modified_ms: Some(1),
        }],
        truncated: false,
    });
    let finished = f
        .store
        .finish_local_file_request(&credential, &f.owner, &c, id, &listing, None)
        .await
        .unwrap();
    assert_eq!(finished.state, LocalFileState::Done);
    // A retried result after a lost answer is the recorded one.
    assert_eq!(
        f.store
            .finish_local_file_request(&credential, &f.owner, &c, id, &listing, None)
            .await
            .unwrap(),
        finished
    );
    let seen = f.store.local_file_request(&grant, &c, id).await.unwrap();
    assert!(
        matches!(seen.result, Some(LocalFileResult::Listing(ref l)) if l.entries[0].name == "plan.md")
    );
    assert!(
        seen.status_text.starts_with("Listed \"docs\": 1 entries"),
        "{}",
        seen.status_text
    );

    // Hashes must name exactly the requested files, in order.
    let hash = f
        .store
        .create_local_file_request(
            &grant,
            &c,
            &with("h", LocalFileOperation::Hash, None, &["a.txt", "b/c.txt"]),
            None,
        )
        .await
        .unwrap();
    f.store
        .poll_local_files(&credential, &f.owner, &c, &poll(tab))
        .await
        .unwrap();
    let digest = |path: &str| LocalFileDigest {
        path: path.into(),
        size: 2,
        sha256: "a".repeat(64),
    };
    let mut swapped = done(tab);
    swapped.hashes = Some(LocalFileHashes {
        files: vec![digest("b/c.txt"), digest("a.txt")],
    });
    assert_eq!(
        f.store
            .finish_local_file_request(
                &credential,
                &f.owner,
                &c,
                hash.request.request_id,
                &swapped,
                None
            )
            .await,
        Err(ResourceError::Invalid)
    );
    let mut hashes = done(tab);
    hashes.hashes = Some(LocalFileHashes {
        files: vec![digest("a.txt"), digest("b/c.txt")],
    });
    f.store
        .finish_local_file_request(
            &credential,
            &f.owner,
            &c,
            hash.request.request_id,
            &hashes,
            None,
        )
        .await
        .unwrap();

    // A write carries its content; the tab must report exactly those bytes.
    let content = b"hi";
    let write = f
        .store
        .create_local_file_request(
            &grant,
            &c,
            &with("w", LocalFileOperation::Write, Some("out/new.txt"), &[]),
            Some(content),
        )
        .await
        .unwrap();
    assert_eq!(write.request.content_bytes, Some(2));
    let sha = write.request.content_sha256.clone().unwrap();
    assert!(write.request.status_text.contains("not done yet"));
    assert_eq!(
        f.store
            .local_file_content(&credential, &f.owner, &c, write.request.request_id, tab)
            .await,
        Err(ResourceError::NotFound),
        "only a write the tab holds"
    );
    let held = f
        .store
        .poll_local_files(&credential, &f.owner, &c, &poll(tab))
        .await
        .unwrap();
    assert!(held.requests[0].status_text.contains("confirm"));
    assert_eq!(
        f.store
            .local_file_content(
                &credential,
                &f.owner,
                &c,
                write.request.request_id,
                Uuid::new_v4()
            )
            .await,
        Err(ResourceError::NotFound),
        "another tab cannot read it"
    );
    assert_eq!(
        f.store
            .local_file_content(&credential, &f.owner, &c, write.request.request_id, tab)
            .await
            .unwrap(),
        content
    );
    let mut lying = done(tab);
    lying.written = Some(LocalFileWritten {
        bytes_written: 2,
        sha256: "b".repeat(64),
        created: true,
    });
    assert_eq!(
        f.store
            .finish_local_file_request(
                &credential,
                &f.owner,
                &c,
                write.request.request_id,
                &lying,
                None
            )
            .await,
        Err(ResourceError::Invalid)
    );
    let mut written = done(tab);
    written.written = Some(LocalFileWritten {
        bytes_written: 2,
        sha256: sha,
        created: true,
    });
    let view = f
        .store
        .finish_local_file_request(
            &credential,
            &f.owner,
            &c,
            write.request.request_id,
            &written,
            None,
        )
        .await
        .unwrap();
    assert!(
        view.status_text.starts_with("Wrote 2 bytes"),
        "{}",
        view.status_text
    );
    let cleared: Option<Vec<u8>> =
        sqlx::query_scalar("SELECT content FROM local_file_requests WHERE id=?")
            .bind(write.request.request_id.to_string())
            .fetch_one(&f.store.pool)
            .await
            .unwrap();
    assert_eq!(cleared, None, "write content is not kept after the request");
    // An owner refusal is a failure the agent sees as such.
    let refused = f
        .store
        .create_local_file_request(
            &grant,
            &c,
            &with("w2", LocalFileOperation::Write, Some("x.txt"), &[]),
            Some(b"x"),
        )
        .await
        .unwrap();
    f.store
        .poll_local_files(&credential, &f.owner, &c, &poll(tab))
        .await
        .unwrap();
    assert_eq!(
        f.store
            .finish_local_file_request(
                &credential,
                &f.owner,
                &c,
                refused.request.request_id,
                &failed(tab, "made up"),
                None
            )
            .await,
        Err(ResourceError::Invalid)
    );
    f.store
        .finish_local_file_request(
            &credential,
            &f.owner,
            &c,
            refused.request.request_id,
            &failed(tab, "refused_by_owner"),
            None,
        )
        .await
        .unwrap();
    let seen = f
        .store
        .local_file_request(&grant, &c, refused.request.request_id)
        .await
        .unwrap();
    assert_eq!(
        (seen.state, seen.error.as_deref()),
        (LocalFileState::Failed, Some("refused_by_owner"))
    );
    assert!(seen.status_text.contains("refused the write"));
}

#[tokio::test]
async fn uploads_must_be_the_requested_file_or_archive() {
    let f = setup().await;
    let c = f.conversation.clone();
    let (grant, credential, tab) = ready(&f).await;
    let read = f
        .store
        .create_local_file_request(
            &grant,
            &c,
            &with("r", LocalFileOperation::Read, Some("docs/plan.md"), &[]),
            None,
        )
        .await
        .unwrap();
    let package = f
        .store
        .create_local_file_request(
            &grant,
            &c,
            &with(
                "p",
                LocalFileOperation::Package,
                None,
                &["a.txt", "docs/plan.md"],
            ),
            None,
        )
        .await
        .unwrap();
    let empty = f
        .store
        .create_local_file_request(
            &grant,
            &c,
            &with("e", LocalFileOperation::Read, Some("empty.txt"), &[]),
            None,
        )
        .await
        .unwrap();
    f.store
        .poll_local_files(&credential, &f.owner, &c, &poll(tab))
        .await
        .unwrap();
    let facts = |name: &str| LocalFileUploadFacts {
        upload_id: Uuid::new_v4(),
        filename: name.into(),
        media_type: "text/plain".into(),
        byte_length: 12,
        sha256: Some("c".repeat(64)),
        local_file: Some(format!("/synthetic/exports/{name}")),
        note: "[synthetic]".into(),
    };
    let finish = |upload: &LocalFileUploadFacts| LocalFileFinish {
        upload_id: Some(upload.upload_id),
        ..done(tab)
    };
    // The upload must be the requested file, as the server verified it.
    let other = facts("other.md");
    assert_eq!(
        f.store
            .finish_local_file_request(
                &credential,
                &f.owner,
                &c,
                read.request.request_id,
                &finish(&other),
                Some(&other)
            )
            .await,
        Err(ResourceError::Invalid)
    );
    let unverified = facts("plan.md");
    assert_eq!(
        f.store
            .finish_local_file_request(
                &credential,
                &f.owner,
                &c,
                read.request.request_id,
                &finish(&unverified),
                None
            )
            .await,
        Err(ResourceError::Invalid)
    );
    let mut huge = facts("plan.md");
    huge.byte_length = LOCAL_FILE_READ_MAX + 1;
    assert_eq!(
        f.store
            .finish_local_file_request(
                &credential,
                &f.owner,
                &c,
                read.request.request_id,
                &finish(&huge),
                Some(&huge)
            )
            .await,
        Err(ResourceError::Invalid)
    );
    let plan = facts("plan.md");
    let view = f
        .store
        .finish_local_file_request(
            &credential,
            &f.owner,
            &c,
            read.request.request_id,
            &finish(&plan),
            Some(&plan),
        )
        .await
        .unwrap();
    assert!(
        view.status_text
            .contains("prepared as /synthetic/exports/plan.md"),
        "{}",
        view.status_text
    );
    // A package is the request's archive with exactly the requested members.
    let archive = facts(&package_name(package.request.request_id));
    let mut members = finish(&archive);
    members.files = vec![LocalFileMember {
        path: "a.txt".into(),
        size: 1,
    }];
    assert_eq!(
        f.store
            .finish_local_file_request(
                &credential,
                &f.owner,
                &c,
                package.request.request_id,
                &members,
                Some(&archive)
            )
            .await,
        Err(ResourceError::Invalid)
    );
    members.files.push(LocalFileMember {
        path: "docs/plan.md".into(),
        size: 11,
    });
    let view = f
        .store
        .finish_local_file_request(
            &credential,
            &f.owner,
            &c,
            package.request.request_id,
            &members,
            Some(&archive),
        )
        .await
        .unwrap();
    assert!(matches!(view.result, Some(LocalFileResult::Uploaded(ref u)) if u.files.len() == 2));
    // An empty file needs no upload.
    let nothing = LocalFileFinish {
        empty: true,
        ..done(tab)
    };
    let view = f
        .store
        .finish_local_file_request(
            &credential,
            &f.owner,
            &c,
            empty.request.request_id,
            &nothing,
            None,
        )
        .await
        .unwrap();
    assert!(
        matches!(view.result, Some(LocalFileResult::Uploaded(ref u)) if u.byte_length == 0 && u.upload_id.is_none())
    );
}

#[tokio::test]
async fn deadlines_disconnects_and_takeover_settle_before_any_read() {
    let f = setup().await;
    let c = f.conversation.clone();
    let (grant, credential, tab) = ready(&f).await;
    let late = f
        .store
        .create_local_file_request(&grant, &c, &list("late", ""), None)
        .await
        .unwrap();
    f.store
        .poll_local_files(&credential, &f.owner, &c, &poll(tab))
        .await
        .unwrap();
    sql(&f, "UPDATE local_file_requests SET deadline_ms=1").await;
    let seen = f
        .store
        .local_file_request(&grant, &c, late.request.request_id)
        .await
        .unwrap();
    assert_eq!(
        (seen.state, seen.error.as_deref()),
        (LocalFileState::Failed, Some("expired"))
    );
    let mut listing = done(tab);
    listing.listing = Some(LocalFileListing {
        entries: vec![],
        truncated: false,
    });
    assert_eq!(
        f.store
            .finish_local_file_request(
                &credential,
                &f.owner,
                &c,
                late.request.request_id,
                &listing,
                None
            )
            .await,
        Err(ResourceError::Conflict("local_file_request_finished")),
        "a request the agent was told expired is never performed later"
    );
    // Another tab cannot silently take over a live connection.
    let second = Uuid::new_v4();
    let queued = f
        .store
        .create_local_file_request(&grant, &c, &list("q", ""), None)
        .await
        .unwrap();
    f.store
        .poll_local_files(&credential, &f.owner, &c, &poll(tab))
        .await
        .unwrap();
    assert_eq!(
        f.store
            .poll_local_files(&credential, &f.owner, &c, &poll(second))
            .await,
        Err(ResourceError::Conflict("local_files_connected_elsewhere"))
    );
    let taken = f
        .store
        .poll_local_files(
            &credential,
            &f.owner,
            &c,
            &LocalFilePoll {
                takeover: true,
                ..poll(second)
            },
        )
        .await
        .unwrap();
    assert_eq!(
        taken.requests[0].request_id, queued.request.request_id,
        "offered to the chosen tab again"
    );
    assert_eq!(
        f.store
            .finish_local_file_request(
                &credential,
                &f.owner,
                &c,
                queued.request.request_id,
                &listing,
                None
            )
            .await,
        Err(ResourceError::Conflict("local_file_request_not_held"))
    );
    assert!(f
        .store
        .poll_local_files(&credential, &f.owner, &c, &poll(tab))
        .await
        .is_err());
    // A tab that stops polling is disconnected: its requests fail at once.
    sql(&f, "UPDATE local_file_connections SET seen_ms=1").await;
    let seen = f
        .store
        .local_file_request(&grant, &c, queued.request.request_id)
        .await
        .unwrap();
    assert_eq!(seen.error.as_deref(), Some("local_files_disconnected"));
    assert_eq!(
        f.store
            .create_local_file_request(&grant, &c, &list("after", ""), None)
            .await,
        Err(ResourceError::Conflict("local_files_not_connected"))
    );
    // Disconnecting explicitly fails what is open, too.
    f.store
        .poll_local_files(&credential, &f.owner, &c, &poll(second))
        .await
        .unwrap();
    let open = f
        .store
        .create_local_file_request(&grant, &c, &list("open", ""), None)
        .await
        .unwrap();
    f.store
        .disconnect_local_files(
            &credential,
            &f.owner,
            &c,
            &LocalFileDisconnect { connection_id: tab },
        )
        .await
        .unwrap();
    assert_eq!(
        f.store
            .local_file_request(&grant, &c, open.request.request_id)
            .await
            .unwrap()
            .state,
        LocalFileState::Queued,
        "another tab's disconnect changes nothing"
    );
    f.store
        .disconnect_local_files(
            &credential,
            &f.owner,
            &c,
            &LocalFileDisconnect {
                connection_id: second,
            },
        )
        .await
        .unwrap();
    let seen = f
        .store
        .local_file_request(&grant, &c, open.request.request_id)
        .await
        .unwrap();
    assert_eq!(
        (seen.state, seen.error.as_deref()),
        (LocalFileState::Failed, Some("local_files_disconnected"))
    );
    let log = f
        .store
        .local_files_overview(&credential, &f.owner, &c, 20)
        .await
        .unwrap();
    assert!(log.connection.is_none());
    assert_eq!(log.requests.len(), 3, "every request stays in the log");
}

#[tokio::test]
async fn invalid_paths_and_caps_are_refused() {
    let f = setup().await;
    let c = f.conversation.clone();
    let (grant, _, _) = ready(&f).await;
    for path in ["../outside", "/etc", "a/../../b", "a\\b"] {
        assert_eq!(
            f.store
                .create_local_file_request(
                    &grant,
                    &c,
                    &with("t", LocalFileOperation::Read, Some(path), &[]),
                    None
                )
                .await,
            Err(ResourceError::Invalid),
            "{path}"
        );
    }
    let too_many: Vec<String> = (0..=LOCAL_FILE_PATHS_MAX)
        .map(|i| format!("f{i}"))
        .collect();
    let refs: Vec<&str> = too_many.iter().map(String::as_str).collect();
    assert_eq!(
        f.store
            .create_local_file_request(
                &grant,
                &c,
                &with("t", LocalFileOperation::Hash, None, &refs),
                None
            )
            .await,
        Err(ResourceError::Invalid)
    );
    let big = vec![0u8; LOCAL_FILE_WRITE_MAX + 1];
    assert_eq!(
        f.store
            .create_local_file_request(
                &grant,
                &c,
                &with("t", LocalFileOperation::Write, Some("x"), &[]),
                Some(&big)
            )
            .await,
        Err(ResourceError::Invalid)
    );
    for i in 0..LOCAL_FILE_OPEN_MAX {
        f.store
            .create_local_file_request(&grant, &c, &list(&format!("k{i}"), ""), None)
            .await
            .unwrap();
    }
    assert_eq!(
        f.store
            .create_local_file_request(&grant, &c, &list("one-more", ""), None)
            .await,
        Err(ResourceError::Conflict("local_files_rate_limited"))
    );
}
