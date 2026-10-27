use super::*;
use orkestr_v2_contracts::*;
use std::path::PathBuf;
use uuid::Uuid;

pub(crate) struct Case {
    root: PathBuf,
    pub store: Store,
    pub owner: OwnerId,
    pub conversation: ConversationId,
    pub token: String,
}
impl Case {
    pub async fn new() -> Self {
        let base = std::env::var_os("ORKESTR_V2_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let root = base.join(format!("resources-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let store = Store::open(&root.join("core.sqlite3")).await.unwrap();
        let conversation = store
            .setup("synthetic-owner", "synthetic-hash")
            .await
            .unwrap();
        let owner = store
            .credentials("synthetic-owner")
            .await
            .unwrap()
            .unwrap()
            .0;
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        store.save_session(&token, &owner).await.unwrap();
        Self {
            root,
            store,
            owner,
            conversation,
            token,
        }
    }
    /// A second conversation of the same owner.
    pub async fn conversation(&self, name: &str) -> ConversationId {
        let input = ConversationInput {
            client_request_id: format!("test-{name}"),
            name: name.into(),
        };
        self.store
            .create_conversation_authenticated(&self.token, &input)
            .await
            .unwrap()
            .0
            .conversation_id
    }
    pub async fn count(&self, sql: &str) -> i64 {
        sqlx::query_scalar(sql)
            .fetch_one(&self.store.pool)
            .await
            .unwrap()
    }
    pub async fn finish(self) {
        self.store.close().await;
        std::fs::remove_dir_all(self.root).unwrap();
    }
}

fn update(revision: i64, provider: ConversationProvider) -> ConversationSettingsUpdate {
    ConversationSettingsUpdate {
        expected_revision: revision,
        provider,
        model: Some("gpt-5.1-codex".into()),
        reasoning_effort: Some("high".into()),
        honor_no_reply: true,
        reply_prefix: Some("orkestr:".into()),
        reply_footer: None,
        review_before_accepting: false,
        deep_grouping: None,
    }
}

#[tokio::test]
async fn defaults_revisions_and_provider_generation() {
    let case = Case::new().await;
    let (t, o, c) = (&case.token, &case.owner, &case.conversation);
    let initial = case.store.conversation_settings(t, o, c).await.unwrap();
    assert_eq!(initial, ConversationSettings::defaults(c.clone()));

    let first = case
        .store
        .update_conversation_settings(t, o, c, &update(0, ConversationProvider::Codex))
        .await
        .unwrap();
    assert_eq!((first.revision, first.provider_generation), (1, 0));
    // Identical replay at the previous revision is idempotent.
    let replay = case
        .store
        .update_conversation_settings(t, o, c, &update(0, ConversationProvider::Codex))
        .await
        .unwrap();
    assert_eq!(replay, first);
    // A stale writer with different content is refused.
    let mut stale = update(0, ConversationProvider::Codex);
    stale.reply_footer = Some("footer".into());
    assert_eq!(
        case.store
            .update_conversation_settings(t, o, c, &stale)
            .await,
        Err(ResourceError::Conflict("settings_revision_mismatch"))
    );
    // Switch Codex -> Claude bumps the provider generation.
    let mut switch = update(1, ConversationProvider::Claude);
    switch.model = None;
    switch.reasoning_effort = Some("max".into());
    let switched = case
        .store
        .update_conversation_settings(t, o, c, &switch)
        .await
        .unwrap();
    assert_eq!((switched.revision, switched.provider_generation), (2, 1));
    assert_eq!(switched.provider, ConversationProvider::Claude);
    // Changing only decorations keeps the generation.
    let mut quiet = switch.clone();
    quiet.expected_revision = 2;
    quiet.honor_no_reply = false;
    let quiet = case
        .store
        .update_conversation_settings(t, o, c, &quiet)
        .await
        .unwrap();
    assert_eq!(
        (
            quiet.revision,
            quiet.provider_generation,
            quiet.honor_no_reply
        ),
        (3, 1, false)
    );
    // Auto-accept is the default; review is an explicit, persisted opt-in.
    assert!(!quiet.review_before_accepting);
    let mut review = switch.clone();
    review.expected_revision = 3;
    review.honor_no_reply = false;
    review.review_before_accepting = true;
    let reviewed = case
        .store
        .update_conversation_settings(t, o, c, &review)
        .await
        .unwrap();
    assert_eq!(
        (reviewed.revision, reviewed.review_before_accepting),
        (4, true)
    );
    assert_eq!(
        case.store.conversation_settings(t, o, c).await.unwrap(),
        reviewed
    );
    let replay = case
        .store
        .update_conversation_settings(t, o, c, &review)
        .await
        .unwrap();
    assert_eq!(replay, reviewed);
    // Effort must belong to the provider.
    let mut wrong = update(4, ConversationProvider::Claude);
    wrong.reasoning_effort = Some("xhigh".into());
    assert_eq!(
        case.store
            .update_conversation_settings(t, o, c, &wrong)
            .await,
        Err(ResourceError::Invalid)
    );
    case.finish().await;
}

#[tokio::test]
async fn settings_require_exact_owner_credential_and_conversation() {
    let case = Case::new().await;
    let (o, c) = (&case.owner, &case.conversation);
    assert_eq!(
        case.store
            .conversation_settings("f".repeat(64).as_str(), o, c)
            .await,
        Err(ResourceError::Unauthorized)
    );
    assert_eq!(
        case.store
            .conversation_settings(&case.token, o, &ConversationId(Uuid::new_v4()))
            .await,
        Err(ResourceError::NotFound)
    );
    let other = OwnerId(Uuid::new_v4());
    assert_eq!(
        case.store
            .conversation_settings(&case.token, &other, c)
            .await,
        Err(ResourceError::Unauthorized)
    );
    case.finish().await;
}
