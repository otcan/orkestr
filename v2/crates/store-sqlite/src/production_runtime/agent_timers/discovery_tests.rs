use super::super::tests::setup;
use super::super::thread_asks::tests::{asking_turn, conversation};
use super::*;

#[tokio::test]
async fn timer_discovery_refresh_revocation_and_scope() {
    let f = setup().await;
    let c = f.conversation.clone();
    let read = f
        .store
        .agent_timer_discovery(&f.token, &f.owner, &c)
        .await
        .unwrap();
    assert!(!read.grant.issued && !read.running_deep && !read.recurring_allowed);
    let issued = f
        .store
        .issue_agent_timer_grant(&f.token, &f.owner, &c)
        .await
        .unwrap();
    asking_turn(&f, &c, "discovery-turn").await;
    let read = f
        .store
        .agent_timer_discovery(&f.token, &f.owner, &c)
        .await
        .unwrap();
    assert!(read.grant.issued && read.eligible && read.running_deep && read.recurring_allowed);
    assert!(!serde_json::to_string(&read)
        .unwrap()
        .contains(&issued.grant));
    let other = conversation(&f, "OtherDiscovery").await;
    assert!(
        !f.store
            .agent_timer_discovery(&f.token, &f.owner, &other)
            .await
            .unwrap()
            .grant
            .issued
    );
    f.store
        .revoke_agent_timer_grant(&f.token, &f.owner, &c)
        .await
        .unwrap();
    let revoked = f
        .store
        .agent_timer_discovery(&f.token, &f.owner, &c)
        .await
        .unwrap();
    assert!(!revoked.grant.issued);
    assert_eq!(revoked.grant.generation, read.grant.generation);
    assert_eq!(
        f.store.agent_timer_discovery("wrong", &f.owner, &c).await,
        Err(ResourceError::Unauthorized)
    );
    assert_eq!(
        f.store
            .agent_timer_discovery(&f.token, &f.owner, &ConversationId(Uuid::new_v4()))
            .await,
        Err(ResourceError::NotFound)
    );
}
