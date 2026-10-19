use super::*;

pub(super) struct Fixture {
    pub(super) store: Store,
    pub(super) owner: OwnerId,
    pub(super) credential: String,
    pub(super) path: std::path::PathBuf,
}
pub(super) async fn fixture() -> Fixture {
    let dir = std::env::temp_dir().join(format!("memory-service-{}", Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    let path = dir.join("core.sqlite3");
    let store = Store::open(&path).await.unwrap();
    store
        .setup("synthetic-memory-owner", "synthetic-hash")
        .await
        .unwrap();
    let owner = store
        .credentials("synthetic-memory-owner")
        .await
        .unwrap()
        .unwrap()
        .0;
    let credential = format!("browser:{}", "ab".repeat(32));
    store.save_session(&credential, &owner).await.unwrap();
    Fixture {
        store,
        owner,
        credential,
        path,
    }
}
pub(super) fn candidate(f: &Fixture, text: &str) -> MemoryCandidate {
    MemoryCandidate {
        scope: MemoryScope::Owner,
        content: MemoryContent::Fact {
            statement: text.into(),
        },
        source: MemorySource {
            kind: MemorySourceKind::Owner,
            actor_id: f.owner.to_string(),
            origin: "explicit-owner-control".into(),
            captured_at_ms: 1700000000000,
            task_id: None,
            event_id: None,
            cursor: None,
        },
    }
}
pub(super) fn query() -> MemoryQuery {
    MemoryQuery {
        project_id: None,
        query: String::new(),
        limit: 100,
    }
}
pub(super) fn decision(p: &MemoryProposal, action: MemoryConsentAction) -> MemoryOwnerDecision {
    MemoryOwnerDecision {
        action,
        digest: p.digest.clone(),
    }
}
pub(super) async fn enabled(f: &Fixture) {
    f.store
        .set_memory_enabled_authenticated(&f.credential, true)
        .await
        .unwrap();
}
pub(super) async fn propose(f: &Fixture, key: &str, operation: MemoryOperation) -> MemoryProposal {
    f.store
        .propose_memory_authenticated(&f.credential, key, operation)
        .await
        .unwrap()
}
pub(super) async fn save(f: &Fixture, key: &str, text: &str) -> (MemoryProposal, MemoryReceipt) {
    let p = propose(
        f,
        key,
        MemoryOperation::Create {
            candidate: candidate(f, text),
        },
    )
    .await;
    let r = f
        .store
        .save_memory_authenticated(
            &f.credential,
            &p,
            &decision(&p, MemoryConsentAction::Remember),
        )
        .await
        .unwrap();
    (p, r)
}
async fn counts(f: &Fixture) -> Vec<i64> {
    let mut out = Vec::new();
    for table in [
        "memory_settings",
        "memory_records",
        "memory_decisions",
        "messages",
        "events",
        "reasoning_inbox",
        "outbox",
    ] {
        out.push(
            sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
                .fetch_one(&f.store.pool)
                .await
                .unwrap(),
        );
    }
    out
}
#[tokio::test]
async fn default_off_proposal_is_transient_explicit_save_reopens_without_native_effects() {
    let f = fixture().await;
    assert_eq!(
        f.store
            .propose_memory_authenticated(
                &f.credential,
                "k",
                MemoryOperation::Create {
                    candidate: candidate(&f, "synthetic fact")
                }
            )
            .await,
        Err(MemoryError::Disabled)
    );
    enabled(&f).await;
    let before = counts(&f).await;
    let p = propose(
        &f,
        "k",
        MemoryOperation::Create {
            candidate: candidate(&f, "  synthetic fact  "),
        },
    )
    .await;
    assert_eq!(before, counts(&f).await);
    let r = f
        .store
        .save_memory_authenticated(
            &f.credential,
            &p,
            &decision(&p, MemoryConsentAction::Remember),
        )
        .await
        .unwrap();
    let read = Store::open(&f.path).await.unwrap();
    let records = read
        .retrieve_memories_authenticated(&f.credential, &query())
        .await
        .unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].memory_id, r.memory_id);
    assert_eq!(records[0].trust, MemoryTrust::OwnerAuthored);
    assert_eq!(
        records[0].candidate.content,
        MemoryContent::Fact {
            statement: "synthetic fact".into()
        }
    );
    assert_eq!(&counts(&f).await[3..], &before[3..]);
    assert_eq!(
        read.export_memories_authenticated(&f.credential)
            .await
            .unwrap(),
        records
    );
}
#[tokio::test]
async fn consent_digest_external_source_and_changed_key_refuse_without_partial_writes() {
    let f = fixture().await;
    enabled(&f).await;
    let mut c = candidate(&f, "external synthetic claim");
    c.source.kind = MemorySourceKind::Web;
    c.source.actor_id = "synthetic-web-source".into();
    let p = propose(&f, "external", MemoryOperation::Create { candidate: c }).await;
    let before = counts(&f).await;
    assert_eq!(
        f.store
            .save_memory_authenticated(
                &f.credential,
                &p,
                &decision(&p, MemoryConsentAction::Remember)
            )
            .await,
        Err(MemoryError::Unauthorized)
    );
    let mut d = decision(&p, MemoryConsentAction::Approve);
    d.digest = "0".repeat(64);
    assert_eq!(
        f.store
            .save_memory_authenticated(&f.credential, &p, &d)
            .await,
        Err(MemoryError::Unauthorized)
    );
    let mut changed = p.clone();
    changed.request_key = "changed".into();
    assert_eq!(
        f.store
            .save_memory_authenticated(
                &f.credential,
                &changed,
                &decision(&p, MemoryConsentAction::Approve)
            )
            .await,
        Err(MemoryError::Invalid)
    );
    assert_eq!(before, counts(&f).await);
    f.store
        .save_memory_authenticated(
            &f.credential,
            &p,
            &decision(&p, MemoryConsentAction::Approve),
        )
        .await
        .unwrap();
    assert_eq!(
        f.store
            .retrieve_memories_authenticated(&f.credential, &query())
            .await
            .unwrap()[0]
            .trust,
        MemoryTrust::OwnerConfirmed
    );
    let changed = propose(
        &f,
        "external",
        MemoryOperation::Create {
            candidate: candidate(&f, "different"),
        },
    )
    .await;
    assert_eq!(
        f.store
            .save_memory_authenticated(
                &f.credential,
                &changed,
                &decision(&changed, MemoryConsentAction::Remember)
            )
            .await,
        Err(MemoryError::Conflict)
    );
}
#[tokio::test]
async fn correction_forget_version_cas_and_old_receipts_cannot_resurrect_content() {
    let f = fixture().await;
    enabled(&f).await;
    let (old, r) = save(&f, "original", "old synthetic content").await;
    let p = propose(
        &f,
        "correct",
        MemoryOperation::Correct {
            memory_id: r.memory_id,
            expected_revision: 1,
            candidate: candidate(&f, "new synthetic content"),
        },
    )
    .await;
    let corrected = f
        .store
        .save_memory_authenticated(
            &f.credential,
            &p,
            &decision(&p, MemoryConsentAction::Correct),
        )
        .await
        .unwrap();
    assert_eq!(corrected.revision, 2);
    let stale = propose(
        &f,
        "stale",
        MemoryOperation::Correct {
            memory_id: r.memory_id,
            expected_revision: 1,
            candidate: candidate(&f, "stale"),
        },
    )
    .await;
    let before = counts(&f).await;
    assert_eq!(
        f.store
            .save_memory_authenticated(
                &f.credential,
                &stale,
                &decision(&stale, MemoryConsentAction::Correct)
            )
            .await,
        Err(MemoryError::Conflict)
    );
    assert_eq!(before, counts(&f).await);
    let stored: String = sqlx::query_scalar("SELECT candidate_json FROM memory_records")
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert!(!stored.contains("old synthetic content"));
    let forget = propose(
        &f,
        "forget",
        MemoryOperation::Forget {
            memory_id: r.memory_id,
            expected_revision: 2,
        },
    )
    .await;
    let receipt = f
        .store
        .save_memory_authenticated(
            &f.credential,
            &forget,
            &decision(&forget, MemoryConsentAction::Forget),
        )
        .await
        .unwrap();
    assert!(receipt.forgotten);
    for (proposal, action) in [
        (&old, MemoryConsentAction::Remember),
        (&p, MemoryConsentAction::Correct),
        (&forget, MemoryConsentAction::Forget),
    ] {
        f.store
            .save_memory_authenticated(&f.credential, proposal, &decision(proposal, action))
            .await
            .unwrap();
    }
    assert!(f
        .store
        .export_memories_authenticated(&f.credential)
        .await
        .unwrap()
        .is_empty());
    let columns: Vec<String> =
        sqlx::query_scalar("SELECT name FROM pragma_table_info('memory_decisions')")
            .fetch_all(&f.store.pool)
            .await
            .unwrap();
    assert_eq!(
        columns,
        vec![
            "owner_id",
            "request_key",
            "proposal_digest",
            "action",
            "memory_id",
            "revision",
            "forgotten"
        ]
    );
}
#[tokio::test]
async fn revoke_expire_disable_and_machine_credentials_fence_fresh_and_historical_decisions() {
    let f = fixture().await;
    enabled(&f).await;
    let (p, r) = save(&f, "one", "synthetic").await;
    f.store
        .save_session(&"cd".repeat(32), &f.owner)
        .await
        .unwrap();
    assert_eq!(
        f.store
            .set_memory_enabled_authenticated(&"cd".repeat(32), true)
            .await,
        Err(MemoryError::Unauthorized)
    );
    f.store
        .set_memory_enabled_authenticated(&f.credential, false)
        .await
        .unwrap();
    assert_eq!(
        f.store
            .save_memory_authenticated(
                &f.credential,
                &p,
                &decision(&p, MemoryConsentAction::Remember)
            )
            .await,
        Err(MemoryError::Disabled)
    );
    enabled(&f).await;
    assert_eq!(
        f.store
            .save_memory_authenticated(
                &f.credential,
                &p,
                &decision(&p, MemoryConsentAction::Remember)
            )
            .await
            .unwrap(),
        r
    );
    sqlx::query("UPDATE auth_sessions SET expires_at=unixepoch()-1 WHERE token_hash=?")
        .bind(crate::digest(&f.credential))
        .execute(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(
        f.store
            .save_memory_authenticated(
                &f.credential,
                &p,
                &decision(&p, MemoryConsentAction::Remember)
            )
            .await,
        Err(MemoryError::Unauthorized)
    );
    f.store.save_session(&f.credential, &f.owner).await.unwrap();
    f.store.revoke_session(&f.credential).await.unwrap();
    let before = counts(&f).await;
    assert_eq!(
        f.store
            .save_memory_authenticated(
                &f.credential,
                &p,
                &decision(&p, MemoryConsentAction::Remember)
            )
            .await,
        Err(MemoryError::Unauthorized)
    );
    assert_eq!(
        f.store.export_memories_authenticated(&f.credential).await,
        Err(MemoryError::Unauthorized)
    );
    assert_eq!(before, counts(&f).await);
}
#[tokio::test]
async fn separate_pool_same_key_has_one_winner_and_conflicting_proposals_refuse() {
    let f = fixture().await;
    enabled(&f).await;
    let p = propose(
        &f,
        "race",
        MemoryOperation::Create {
            candidate: candidate(&f, "exact"),
        },
    )
    .await;
    let other = Store::open(&f.path).await.unwrap();
    let d = decision(&p, MemoryConsentAction::Remember);
    let (a, b) = tokio::join!(
        f.store.save_memory_authenticated(&f.credential, &p, &d),
        other.save_memory_authenticated(&f.credential, &p, &d)
    );
    assert_eq!(a.unwrap(), b.unwrap());
    assert_eq!(counts(&f).await[1..3], [1, 1]);
}
