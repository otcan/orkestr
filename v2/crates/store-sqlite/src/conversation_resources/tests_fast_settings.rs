use super::tests_settings::Case;
use super::*;
use orkestr_v2_contracts::*;

#[tokio::test]
async fn fast_preferences_do_not_admit_input_or_change_deep_and_foreign_owners_are_refused() {
    let case = Case::new().await;
    let deep = case
        .store
        .conversation_settings(&case.token, &case.owner, &case.conversation)
        .await
        .unwrap();
    let before = case
        .count(
            "SELECT (SELECT count(*) FROM reasoning_inbox)+(SELECT count(*) FROM production_runs)",
        )
        .await;
    let update = FastRoleSettingsUpdate {
        expected_revision: 0,
        model: Some("gpt-6-luna".into()),
        reasoning_effort: Some("low".into()),
    };
    let selected = case
        .store
        .update_fast_role_settings(&case.token, &case.owner, &case.conversation, &update)
        .await
        .unwrap();
    assert_eq!(selected.revision, 1);
    assert_eq!(
        case.count(
            "SELECT (SELECT count(*) FROM reasoning_inbox)+(SELECT count(*) FROM production_runs)"
        )
        .await,
        before
    );
    assert_eq!(
        case.store
            .conversation_settings(&case.token, &case.owner, &case.conversation)
            .await
            .unwrap(),
        deep
    );
    assert_eq!(
        case.store
            .update_fast_role_settings(
                &case.token,
                &OwnerId(uuid::Uuid::new_v4()),
                &case.conversation,
                &update
            )
            .await,
        Err(ResourceError::Unauthorized)
    );
    case.finish().await;
}
