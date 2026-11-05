//! Actual consumption first; lookup never promotes summary or author to intent.
use super::*;
use orkestr_v2_contracts::{ConversationId, InputAuthor, RootIntakeQuery};

async fn intake_fixture() -> (
    Case,
    Store,
    String,
    ManagedOperationParent,
    ManagedCallerEvidence,
) {
    let (mut f, bound, token, parent, source) = fixture().await;
    // Binding a window intentionally revoked its bootstrap token. Lookup uses
    // a separate current reviewer session, never the retired bootstrap credential.
    f.token = "browser:synthetic-intake-reviewer".into();
    f.store.save_session(&f.token, &f.owner).await.unwrap();
    (f, bound, token, parent, source)
}

#[tokio::test]
async fn root_intake_resolves_exact_consumed_operation_and_preserves_original_text() {
    let (f, bound, token, parent, source) = intake_fixture().await;
    let id = Uuid::new_v4();
    let ManagedOperationConsumption::Operation(operation) = bound
        .consume_managed_operation(&token, &parent, id, &source, &request())
        .await
        .unwrap()
    else {
        panic!()
    };
    let query = RootIntakeQuery { operation_id: id };
    let before = fixtures::snapshot(&f.store).await;
    let proof = f
        .store
        .root_intake(&f.token, &f.owner, &f.conversation, &query)
        .await
        .unwrap();
    assert_eq!(proof.operation_id, id);
    assert_eq!(proof.source_run_id, parent.parent.run.run_id);
    assert_eq!(proof.source_session_id, parent.parent.run.session_id);
    assert_eq!(proof.operation_state, "delivery_unknown");
    assert_eq!(proof.agent_request.summary, "Agent-requested summary");
    assert_eq!(proof.consumed_inputs.len(), 1);
    let input = &proof.consumed_inputs[0];
    assert_eq!(input.original_text, "Synthetic owner input");
    assert_eq!(
        input.original_text_sha256,
        crate::digest(&input.original_text)
    );
    assert!(
        input.authentication_kind.is_none(),
        "legacy is never backfilled as owner authentication"
    );
    assert_eq!(fixtures::snapshot(&f.store).await, before);
    bound
        .complete_managed_operation(&token, operation, ManagedOperationOutcome::Submitted)
        .await
        .unwrap();
    assert_eq!(
        f.store
            .root_intake(&f.token, &f.owner, &f.conversation, &query)
            .await
            .unwrap()
            .operation_state,
        "submitted"
    );
    for (credential, conversation, operation_id) in [
        ("revoked", f.conversation.clone(), id),
        (f.token.as_str(), ConversationId(Uuid::new_v4()), id),
        (f.token.as_str(), f.conversation.clone(), Uuid::new_v4()),
    ] {
        assert!(f
            .store
            .root_intake(
                credential,
                &f.owner,
                &conversation,
                &RootIntakeQuery { operation_id }
            )
            .await
            .is_err());
    }
    f.store.close().await;
    std::fs::remove_dir_all(f.root).unwrap();
}

#[tokio::test]
async fn root_intake_projects_each_group_member_with_its_own_actual_authentication() {
    let (f, bound, token, parent, source) = intake_fixture().await;
    let id = Uuid::new_v4();
    bound
        .consume_managed_operation(&token, &parent, id, &source, &request())
        .await
        .unwrap();
    f.store
        .save_session("browser:synthetic-intake", &f.owner)
        .await
        .unwrap();
    let second = f
        .store
        .admit_authenticated_attributed(
            "browser:synthetic-intake",
            &f.owner,
            &f.conversation,
            &MessageInput {
                client_message_id: "group-correction".into(),
                text: "Synthetic correction: read only".into(),
            },
            None,
            None,
            None,
            Some(InputAuthor::Owner),
        )
        .await
        .unwrap();
    // A controlled projection fixture for the grouping already qualified by
    // deep_groups tests. No lookup command is allowed to form such a group.
    sqlx::query("UPDATE reasoning_inbox SET state='consumed',admitted_run_id=? WHERE message_id=?")
        .bind(parent.parent.run.run_id.to_string())
        .bind(second.receipt.message_id.to_string())
        .execute(&f.store.pool)
        .await
        .unwrap();
    let proof = f
        .store
        .root_intake(
            &f.token,
            &f.owner,
            &f.conversation,
            &RootIntakeQuery { operation_id: id },
        )
        .await
        .unwrap();
    assert_eq!(proof.consumed_inputs.len(), 2);
    assert!(proof.consumed_inputs[0].authentication_kind.is_none());
    assert_eq!(
        proof.consumed_inputs[1].authentication_kind.as_deref(),
        Some("browser")
    );
    assert_eq!(proof.consumed_inputs[1].author, Some(InputAuthor::Owner));
    assert_eq!(
        proof.consumed_inputs[1].message_id,
        second.receipt.message_id
    );
    assert_eq!(
        proof.consumed_inputs[1].original_text,
        "Synthetic correction: read only"
    );
    assert_ne!(
        proof.agent_request.summary,
        proof.consumed_inputs[1].original_text
    );
    f.store.close().await;
    std::fs::remove_dir_all(f.root).unwrap();
}

#[tokio::test]
async fn root_intake_rejects_changed_captured_evidence_without_any_write() {
    let (f, bound, token, parent, source) = intake_fixture().await;
    let id = Uuid::new_v4();
    bound
        .consume_managed_operation(&token, &parent, id, &source, &request())
        .await
        .unwrap();
    sqlx::query("UPDATE managed_operations SET request_json=json_set(request_json,'$.evidence.request.arguments.summary','forged owner instruction') WHERE id=?")
        .bind(id.to_string()).execute(&f.store.pool).await.unwrap();
    let before = fixtures::snapshot(&f.store).await;
    assert!(f
        .store
        .root_intake(
            &f.token,
            &f.owner,
            &f.conversation,
            &RootIntakeQuery { operation_id: id }
        )
        .await
        .is_err());
    assert_eq!(fixtures::snapshot(&f.store).await, before);
    f.store.close().await;
    std::fs::remove_dir_all(f.root).unwrap();
}
