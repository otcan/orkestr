use orkestr_v2_application::runtime::{
    ProductionSupervisorConfig, ProductionTakeover, ProviderKind,
};
use orkestr_v2_contracts::{AutomaticReplyPermissionRequest, ConversationId};
use orkestr_v2_store_sqlite::{AutomaticReplyProducer, Store};
use std::path::PathBuf;
use uuid::Uuid;

pub struct Case {
    pub root: PathBuf,
    pub store: Store,
    pub bound: Store,
    pub token: String,
    pub conversation: ConversationId,
    pub producer: AutomaticReplyProducer,
    pub input: Uuid,
}
impl Case {
    pub async fn new(enabled: bool) -> Self {
        let root = PathBuf::from(std::env::var_os("ORKESTR_V2_HOME").expect("isolated home"))
            .join(format!("automatic-reply-socket-{}", Uuid::new_v4()));
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
        let token = "ab".repeat(32);
        store.save_session(&token, &owner).await.unwrap();
        let bound = store
            .authorize_supervisor(
                &token,
                ProductionSupervisorConfig {
                    provider: ProviderKind::Codex,
                    namespace: "synthetic-reply".into(),
                    supervisor_key: "synthetic-supervisor".into(),
                    takeover: ProductionTakeover::First,
                },
            )
            .await
            .unwrap();
        let producer = bound
            .bind_automatic_reply_route(
                &token,
                &conversation,
                Uuid::new_v4(),
                "synthetic-account",
                0,
            )
            .await
            .unwrap();
        let input = bound
            .register_automatic_reply_input(&token, &producer, Uuid::new_v4(), "synthetic-input")
            .await
            .unwrap()
            .input_id;
        let c = Self {
            root,
            store,
            bound,
            token,
            conversation,
            producer,
            input,
        };
        if enabled {
            c.permission(true, 0, "enable").await;
        }
        c
    }
    pub async fn permission(&self, enabled: bool, revision: i64, key: &str) {
        self.store
            .set_automatic_reply_permission_authenticated(
                &self.token,
                &self.conversation,
                &AutomaticReplyPermissionRequest {
                    route_id: self.producer.route_id(),
                    expected_route_generation: self.producer.route_generation(),
                    expected_permission_revision: revision,
                    request_key: key.into(),
                    enabled,
                },
            )
            .await
            .unwrap();
    }
    pub async fn cleanup(self) {
        self.bound.close().await;
        self.store.close().await;
        std::fs::remove_dir_all(self.root).unwrap();
    }
}
