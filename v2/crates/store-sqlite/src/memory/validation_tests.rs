use super::tests::{candidate, decision, enabled, fixture, propose, query, save};
use super::*;
#[tokio::test]
async fn structured_bounds_unknown_fields_and_foreign_references_refuse_before_writes() {
    let f = fixture().await;
    enabled(&f).await;
    let mut invalid = Vec::new();
    let mut c = candidate(&f, " ");
    invalid.push(c.clone());
    c.content = MemoryContent::Preference {
        key: "x".repeat(129),
        value: "v".into(),
    };
    invalid.push(c.clone());
    c.content = MemoryContent::Decision {
        summary: "valid".into(),
        rationale: Some("x".repeat(2049)),
    };
    invalid.push(c.clone());
    c.content = MemoryContent::ProjectSummary {
        summary: "owner scope invalid".into(),
    };
    invalid.push(c.clone());
    c.content = MemoryContent::OpenLoop {
        summary: "valid".into(),
        task_id: Some(TaskId(Uuid::new_v4())),
        due_at_ms: None,
    };
    invalid.push(c.clone());
    c.content = MemoryContent::Fact {
        statement: "bad\0control".into(),
    };
    invalid.push(c.clone());
    c = candidate(&f, "valid");
    c.source.origin = "../path".into();
    invalid.push(c.clone());
    c = candidate(&f, "valid");
    c.source.captured_at_ms = -1;
    invalid.push(c.clone());
    for (i, candidate) in invalid.into_iter().enumerate() {
        assert_eq!(
            f.store
                .propose_memory_authenticated(
                    &f.credential,
                    &format!("invalid-{i}"),
                    MemoryOperation::Create { candidate }
                )
                .await,
            Err(MemoryError::Invalid)
        );
    }
    let mut c = candidate(&f, "foreign project");
    c.scope = MemoryScope::Project {
        project_id: ProjectId(Uuid::new_v4()),
    };
    assert_eq!(
        f.store
            .propose_memory_authenticated(
                &f.credential,
                "foreign",
                MemoryOperation::Create { candidate: c }
            )
            .await,
        Err(MemoryError::NotFound)
    );
    let mut c = candidate(&f, "unknown event");
    c.source.event_id = Some(EventId(Uuid::new_v4()));
    assert_eq!(
        f.store
            .propose_memory_authenticated(
                &f.credential,
                "event",
                MemoryOperation::Create { candidate: c }
            )
            .await,
        Err(MemoryError::NotFound)
    );
    let mut value = serde_json::to_value(candidate(&f, "valid")).unwrap();
    value["source"]["trust"] = "owner_authored".into();
    assert!(serde_json::from_value::<MemoryCandidate>(value).is_err());
    assert!(f
        .store
        .export_memories_authenticated(&f.credential)
        .await
        .unwrap()
        .is_empty());
}
#[tokio::test]
async fn foreign_current_browser_cannot_replay_or_read_another_owners_memory() {
    let f = fixture().await;
    enabled(&f).await;
    let (p, r) = save(&f, "saved", "private synthetic").await;
    let other = fixture().await;
    let credential = format!("browser:{}", "cd".repeat(32));
    other
        .store
        .save_session(&credential, &other.owner)
        .await
        .unwrap();
    other
        .store
        .set_memory_enabled_authenticated(&credential, true)
        .await
        .unwrap();
    assert_eq!(
        other.store.authenticate(&credential).await.unwrap(),
        Some(other.owner.clone())
    );
    assert_eq!(
        f.store
            .retrieve_memories_authenticated(&credential, &query())
            .await,
        Err(MemoryError::Unauthorized)
    );
    assert_eq!(
        f.store
            .save_memory_authenticated(
                &credential,
                &p,
                &decision(&p, MemoryConsentAction::Remember)
            )
            .await,
        Err(MemoryError::Unauthorized)
    );
    assert_eq!(
        other
            .store
            .propose_memory_authenticated(
                &credential,
                "forget",
                MemoryOperation::Forget {
                    memory_id: r.memory_id,
                    expected_revision: 1
                }
            )
            .await,
        Err(MemoryError::NotFound)
    );
}
#[tokio::test]
async fn all_six_categories_store_structured_records_and_owner_limit_fails_closed() {
    use orkestr_v2_application::IntakeStore;
    let f = fixture().await;
    enabled(&f).await;
    let project = f
        .store
        .create_project(
            &f.owner,
            &ProjectInput {
                client_request_id: "synthetic-project".into(),
                name: "Synthetic".into(),
            },
        )
        .await
        .unwrap()
        .project
        .project_id;
    let contents = vec![
        MemoryContent::Preference {
            key: "synthetic-style".into(),
            value: "brief".into(),
        },
        MemoryContent::Fact {
            statement: "synthetic fact".into(),
        },
        MemoryContent::Decision {
            summary: "synthetic decision".into(),
            rationale: Some("synthetic rationale".into()),
        },
        MemoryContent::Commitment {
            summary: "synthetic commitment".into(),
            task_id: None,
            due_at_ms: Some(1700000000000),
        },
        MemoryContent::OpenLoop {
            summary: "synthetic question".into(),
            task_id: None,
            due_at_ms: None,
        },
        MemoryContent::ProjectSummary {
            summary: "synthetic project".into(),
        },
    ];
    for (i, content) in contents.into_iter().enumerate() {
        let mut c = candidate(&f, "unused");
        c.content = content;
        if i == 5 {
            c.scope = MemoryScope::Project {
                project_id: project.clone(),
            };
        }
        let p = propose(
            &f,
            &format!("category-{i}"),
            MemoryOperation::Create { candidate: c },
        )
        .await;
        f.store
            .save_memory_authenticated(
                &f.credential,
                &p,
                &decision(&p, MemoryConsentAction::Remember),
            )
            .await
            .unwrap();
    }
    assert_eq!(
        f.store
            .export_memories_authenticated(&f.credential)
            .await
            .unwrap()
            .len(),
        6
    );
    // Deliberate oversized ledger fixture proves no silently incomplete export.
    let json = serde_json::to_string(&candidate(&f, "synthetic cap record")).unwrap();
    sqlx::query("WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v+1 FROM n WHERE v<4995) INSERT INTO memory_records(id,owner_id,revision,candidate_json,trust,consented_at_ms,updated_at_ms) SELECT printf('synthetic-overflow-%d',v),?,1,?,'owner_authored',1,1 FROM n")
        .bind(f.owner.to_string()).bind(json).execute(&f.store.pool).await.unwrap();
    assert_eq!(
        f.store.export_memories_authenticated(&f.credential).await,
        Err(MemoryError::Limit)
    );
    let p = propose(
        &f,
        "over-cap",
        MemoryOperation::Create {
            candidate: candidate(&f, "cannot add"),
        },
    )
    .await;
    assert_eq!(
        f.store
            .save_memory_authenticated(
                &f.credential,
                &p,
                &decision(&p, MemoryConsentAction::Remember)
            )
            .await,
        Err(MemoryError::Limit)
    );
}
