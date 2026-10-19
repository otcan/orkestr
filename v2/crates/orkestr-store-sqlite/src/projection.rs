use crate::Error;
use orkestr_v2_domain::{Conversation, Engine, Task};
use sqlx::{Row, SqliteConnection};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    pub sequence: i64,
    pub conversations: BTreeMap<String, Conversation>,
    pub tasks: BTreeMap<String, Task>,
}

impl Snapshot {
    pub(crate) fn from_engine(engine: Engine, sequence: i64) -> Self {
        Self {
            sequence,
            conversations: engine
                .conversations()
                .iter()
                .map(|(id, v)| (id.clone(), v.clone()))
                .collect(),
            tasks: engine
                .tasks()
                .iter()
                .map(|(id, v)| (id.clone(), v.clone()))
                .collect(),
        }
    }
}

pub(crate) async fn replace(
    connection: &mut SqliteConnection,
    engine: &Engine,
    sequence: i64,
) -> Result<(), Error> {
    sqlx::query("DELETE FROM tasks")
        .execute(&mut *connection)
        .await?;
    sqlx::query("DELETE FROM conversations")
        .execute(&mut *connection)
        .await?;
    for conversation in engine.conversations().values() {
        sqlx::query("INSERT INTO conversations(id, data) VALUES (?, ?)")
            .bind(&conversation.id)
            .bind(serde_json::to_string(conversation)?)
            .execute(&mut *connection)
            .await?;
    }
    for task in engine.tasks().values() {
        sqlx::query("INSERT INTO tasks(id, conversation_id, data) VALUES (?, ?, ?)")
            .bind(&task.id)
            .bind(&task.conversation_id)
            .bind(serde_json::to_string(task)?)
            .execute(&mut *connection)
            .await?;
    }
    sqlx::query("INSERT INTO projection_cursor VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET sequence=excluded.sequence")
        .bind(sequence).execute(&mut *connection).await?;
    Ok(())
}

pub(crate) async fn read(connection: &mut SqliteConnection) -> Result<Snapshot, Error> {
    let sequence = sqlx::query_scalar("SELECT sequence FROM projection_cursor WHERE singleton=1")
        .fetch_one(&mut *connection)
        .await?;
    let mut conversations = BTreeMap::new();
    for row in sqlx::query("SELECT data FROM conversations")
        .fetch_all(&mut *connection)
        .await?
    {
        let item: Conversation = serde_json::from_str(row.try_get("data")?)?;
        conversations.insert(item.id.clone(), item);
    }
    let mut tasks = BTreeMap::new();
    for row in sqlx::query("SELECT data FROM tasks")
        .fetch_all(&mut *connection)
        .await?
    {
        let item: Task = serde_json::from_str(row.try_get("data")?)?;
        tasks.insert(item.id.clone(), item);
    }
    Ok(Snapshot {
        sequence,
        conversations,
        tasks,
    })
}
