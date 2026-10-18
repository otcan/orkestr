use orkestr_v2_domain::{ConversationKind, Envelope, Event, JournalRecord};
use orkestr_v2_store_sqlite::Store;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args_os()
        .nth(1)
        .ok_or("usage: durable <explicit-synthetic-database-path>")?;
    let store = Store::open(path).await?;
    let receipt = store
        .append(&JournalRecord::new(Envelope {
            event_id: "demo-home-created".into(),
            event: Event::ConversationCreated {
                id: "demo-home".into(),
                kind: ConversationKind::Home,
                parent_id: None,
            },
        }))
        .await?;
    let snapshot = store.replay().await?;
    println!(
        "Offline metadata only: sequence={}, duplicate={}, conversations={}",
        receipt.sequence,
        receipt.duplicate,
        snapshot.conversations.len()
    );
    store.close().await?;
    Ok(())
}
