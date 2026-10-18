use dioxus::prelude::*;
use orkestr_v2_contracts::{ConversationSnapshot, Project, ProjectPage};
use orkestr_v2_ui::Projection;
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub struct Failure {
    pub status: u16,
    pub message: String,
}
impl From<String> for Failure {
    fn from(message: String) -> Self {
        Self { status: 0, message }
    }
}

#[derive(Clone, Deserialize)]
pub struct BrowserSession {
    pub csrf_token: String,
    pub global_conversation_id: String,
}

#[derive(Deserialize)]
struct Response {
    status: u16,
    body: Value,
}

pub async fn request<T: DeserializeOwned>(
    method: &str,
    path: &str,
    body: Value,
    csrf: &str,
    bootstrap: &str,
) -> Result<T, Failure> {
    let eval = document::eval(include_str!("request.js"));
    eval.send(json!({"method":method,"path":path,"body":body,"csrf":csrf,"bootstrap":bootstrap}))
        .map_err(|_| Failure::from("Browser bridge unavailable".to_string()))?;
    let response: Response = eval.join().await.map_err(|_| {
        Failure::from(
            "Connection interrupted; receipt unknown. Retry retains the same request.".to_string(),
        )
    })?;
    if !(200..300).contains(&response.status) {
        return Err(Failure {
            status: response.status,
            message: response.body["message"]
                .as_str()
                .unwrap_or("API request rejected")
                .into(),
        });
    }
    serde_json::from_value(response.body)
        .map_err(|_| Failure::from("Unexpected API contract".to_string()))
}

pub async fn key() -> Result<String, Failure> {
    document::eval("return crypto.randomUUID();")
        .join()
        .await
        .map_err(|_| Failure::from("Secure request ID generation unavailable".to_string()))
}

pub async fn delay() {
    let _ = document::eval("await new Promise(resolve => setTimeout(resolve, 1500)); return null;")
        .await;
}

pub async fn projects(csrf: &str) -> Result<Vec<Project>, Failure> {
    let mut result = Vec::new();
    let mut after = 0;
    loop {
        let page: ProjectPage = request(
            "GET",
            &format!("/api/v2/projects?after={after}&limit=100"),
            Value::Null,
            csrf,
            "",
        )
        .await?;
        result.extend(page.projects);
        if result.len() > 10000 {
            return Err("Project list exceeds client limit".to_string().into());
        }
        match page.next_cursor {
            Some(next) if next > after => after = next,
            None => return Ok(result),
            _ => return Err("Invalid project cursor".to_string().into()),
        }
    }
}

pub async fn history_page(
    id: &str,
    csrf: &str,
    after: i64,
) -> Result<ConversationSnapshot, Failure> {
    let page: ConversationSnapshot = request(
        "GET",
        &format!("/api/v2/conversations/{id}?after={after}&limit=100"),
        Value::Null,
        csrf,
        "",
    )
    .await?;
    if page.conversation_id.to_string() != id {
        return Err("Snapshot scope mismatch".to_string().into());
    }
    if page.last_sequence < after {
        return Err("Snapshot watermark moved backwards".to_string().into());
    }
    if page
        .messages
        .iter()
        .any(|message| message.sequence <= after)
        || page.next_cursor.is_some_and(|next| next <= after)
    {
        return Err("Invalid snapshot cursor".to_string().into());
    }
    Ok(page)
}

pub async fn snapshot(
    id: &str,
    csrf: &str,
    after: i64,
    mut projection: Projection,
) -> Result<Projection, Failure> {
    let mut after = after;
    let mut initial_watermark = None;
    let mut pages = 0;
    loop {
        pages += 1;
        if pages > 1000 {
            return Err(
                "History changed too quickly or exceeds the current scan limit; retry snapshot"
                    .to_string()
                    .into(),
            );
        }
        let page = history_page(id, csrf, after).await?;
        let watermark = *initial_watermark.get_or_insert(page.last_sequence);
        let next = page.next_cursor;
        projection
            .page(page)
            .map_err(|message| Failure::from(message.to_string()))?;
        match next {
            Some(next) if next > after => after = next,
            None => {
                projection.watermark = watermark;
                return Ok(projection);
            }
            _ => return Err("Invalid snapshot cursor".to_string().into()),
        }
    }
}

#[derive(Deserialize)]
pub struct StreamItem {
    pub status: u16,
    pub event: String,
    pub id: Option<String>,
    pub body: Option<orkestr_v2_contracts::ConversationEvent>,
}

pub async fn event(id: &str, cursor: i64) -> Result<StreamItem, Failure> {
    let eval = document::eval(include_str!("stream.js"));
    eval.send(json!({"path":format!("/api/v2/conversations/{id}/events"),"cursor":cursor}))
        .map_err(|_| Failure::from("Stream bridge unavailable".to_string()))?;
    let raw: Value = eval.join().await.map_err(|_| {
        Failure::from("Disconnected; reconnecting from last applied cursor".to_string())
    })?;
    Ok(serde_json::from_value(raw).unwrap_or(StreamItem {
        status: 200,
        event: "resync_required".into(),
        id: None,
        body: None,
    }))
}
