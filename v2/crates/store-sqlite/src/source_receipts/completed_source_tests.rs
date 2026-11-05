use super::*;

#[tokio::test]
async fn completed_source_continues_only_through_its_exact_accepted_binding_release() {
    let (f, source, message, query) = fixture().await;
    let original_message_id: String =
        sqlx::query_scalar("SELECT message_id FROM production_runs WHERE id=?")
            .bind(source.run.run_id.to_string())
            .fetch_one(&f.store.pool)
            .await
            .unwrap();
    let context = orkestr_v2_contracts::SourceContextQuery {
        source_run_id: source.run.run_id.clone(),
        source_message_id: orkestr_v2_contracts::MessageId(
            Uuid::parse_str(&original_message_id).unwrap(),
        ),
    };
    f.handle
        .append_provider_event(
            &f.owner,
            &source,
            &input(&source, 1, ProviderEvent::Started),
        )
        .await
        .unwrap();
    let completed = f
        .handle
        .append_provider_event(
            &f.owner,
            &source,
            &input(
                &source,
                2,
                ProviderEvent::CompletedProposal { synthetic: false },
            ),
        )
        .await
        .unwrap();
    let revision = f
        .store
        .execution_status(&f.owner, &f.conversation)
        .await
        .unwrap()
        .unwrap()
        .revision;
    f.store
        .accept_execution(
            &f.owner,
            &f.conversation,
            &ExecutionAcceptanceRequest {
                run_id: source.run.run_id.clone(),
                completion_event_id: completed.event_id,
                expected_revision: revision,
                request_key: "accept-source-before-root-review".into(),
            },
        )
        .await
        .unwrap();
    let proof = f
        .store
        .source_context(&f.token, &f.owner, &f.conversation, &context)
        .await
        .unwrap();
    assert!(proof.eligible_for_continuation);
    let generation: i64 = sqlx::query_scalar("SELECT generation FROM session_bindings WHERE id=?")
        .bind(source.run.session_id.to_string())
        .fetch_one(&f.store.pool)
        .await
        .unwrap();
    assert_eq!(generation, proof.binding_generation + 1);
    for (change, restore) in [
        ("generation=generation+1", "generation=generation-1"),
        ("state='retired'", "state='ready'"),
        (
            "native_session_id='foreign-source'",
            "native_session_id='synthetic-native-deep'",
        ),
    ] {
        sqlx::query(&format!("UPDATE session_bindings SET {change} WHERE id=?"))
            .bind(source.run.session_id.to_string())
            .execute(&f.store.pool)
            .await
            .unwrap();
        assert!(
            !f.store
                .source_context(&f.token, &f.owner, &f.conversation, &context)
                .await
                .unwrap()
                .eligible_for_continuation
        );
        assert!(matches!(
            admit(&f, &message, &query).await,
            Err(StoreError::ProviderGenerationMismatch)
        ));
        sqlx::query(&format!("UPDATE session_bindings SET {restore} WHERE id=?"))
            .bind(source.run.session_id.to_string())
            .execute(&f.store.pool)
            .await
            .unwrap();
    }
    let admitted = admit(&f, &message, &query).await.unwrap();
    let receipt = f
        .store
        .source_receipt(&f.token, &f.owner, &f.conversation, &query)
        .await
        .unwrap();
    assert_eq!(
        receipt.admission.unwrap().source_binding_generation,
        proof.binding_generation
    );
    // Real reuse occupies a new generation; the old decision cannot cross it.
    let binding = f
        .handle
        .ensure_role_bindings(&f.owner, &f.conversation)
        .await
        .unwrap()
        .deep;
    let claim = f
        .handle
        .claim_next(
            &f.owner,
            &f.conversation,
            &binding.session_id,
            std::time::Duration::from_secs(60),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claim.message_id, admitted.receipt.message_id);
    f.handle
        .admit_run(
            &claim,
            &binding.session_id,
            binding.generation,
            "new-source-turn",
        )
        .await
        .unwrap();
    assert!(
        !f.store
            .source_context(&f.token, &f.owner, &f.conversation, &context)
            .await
            .unwrap()
            .eligible_for_continuation
    );
    let another = MessageInput {
        client_message_id: "another-old-source-decision".into(),
        ..message
    };
    assert!(matches!(
        admit(&f, &another, &query).await,
        Err(StoreError::ProviderGenerationMismatch)
    ));
    close(f).await;
}
