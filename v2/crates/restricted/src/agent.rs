//! The turn loop: owner message -> model -> tool calls -> broker -> model ... -> reply.
//! The runner polls for new owner messages in enabled restricted threads (one turn
//! per thread at a time). It never starts the GPU: if the model endpoint is down the
//! thread says so and waits for the owner.
use crate::broker::Broker;
use crate::llm::{tool_definitions, ChatBackend, SYSTEM_PROMPT};
use orkestr_v2_store_sqlite::{RestrictedContextRow, RestrictedRunnerThread, Store};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub type Endpoints = HashMap<String, Arc<dyn ChatBackend>>;

pub struct Runner {
    pub store: Store,
    pub broker: Arc<Broker>,
    pub endpoints: Endpoints,
    pub poll: Duration,
}

/// Rebuild OpenAI messages from stored rows, repairing what a crash could leave behind:
/// a leading non-user row, or tool calls whose results are missing.
pub fn build_messages(rows: &[RestrictedContextRow]) -> Vec<Value> {
    let start = rows
        .iter()
        .position(|r| r.role == "user")
        .unwrap_or(rows.len());
    let rows = &rows[start..];
    let mut out = vec![json!({"role":"system","content":SYSTEM_PROMPT})];
    let mut i = 0;
    while i < rows.len() {
        let r = &rows[i];
        match r.role.as_str() {
            "user" => {
                out.push(json!({"role":"user","content":r.content.clone().unwrap_or_default()}))
            }
            "assistant" => {
                let calls: Option<Vec<Value>> = r
                    .tool_calls_json
                    .as_deref()
                    .and_then(|j| serde_json::from_str(j).ok());
                match calls {
                    Some(calls) if !calls.is_empty() => {
                        let ids: HashSet<String> = calls
                            .iter()
                            .filter_map(|c| c["id"].as_str().map(str::to_owned))
                            .collect();
                        let mut j = i + 1;
                        let mut answered = HashSet::new();
                        while j < rows.len() && rows[j].role == "tool" {
                            if let Some(id) = &rows[j].tool_call_id {
                                answered.insert(id.clone());
                            }
                            j += 1;
                        }
                        if answered == ids {
                            out.push(
                                json!({"role":"assistant","content":r.content,"tool_calls":calls}),
                            );
                            for t in &rows[i + 1..j] {
                                out.push(json!({"role":"tool","tool_call_id":t.tool_call_id,"content":t.content.clone().unwrap_or_default()}));
                            }
                        }
                        i = j;
                        continue;
                    }
                    _ => out.push(
                        json!({"role":"assistant","content":r.content.clone().unwrap_or_default()}),
                    ),
                }
            }
            _ => {}
        }
        i += 1;
    }
    out
}

impl Runner {
    pub async fn run_turn(&self, thread: &RestrictedRunnerThread) {
        let (conv, sess) = (&thread.conversation_id, thread.session_id.as_str());
        let notice = |text: String| async move {
            let _ = self
                .store
                .restricted_append(conv, sess, "notice", Some(&text), None, None)
                .await;
        };
        let Some(llm) = self.endpoints.get(&thread.policy.endpoint) else {
            return notice(format!(
                "The model endpoint '{}' is not configured on this installation.",
                thread.policy.endpoint
            ))
            .await;
        };
        let tools = tool_definitions();
        for _ in 0..thread.policy.max_steps {
            let Ok(rows) = self.store.restricted_context(conv, sess).await else {
                return;
            };
            let messages = build_messages(&rows);
            let completion = match llm
                .complete(thread.policy.model.as_deref(), &messages, &tools)
                .await
            {
                Ok(c) => c,
                Err(error) => {
                    return notice(format!("The model is unavailable: {error}. If its GPU is off, start it explicitly; Orkestr does not start it for you.")).await;
                }
            };
            if completion.tool_calls.is_empty() {
                let text = completion
                    .content
                    .unwrap_or_else(|| "(the model returned no reply)".into());
                let _ = self
                    .store
                    .restricted_append(conv, sess, "assistant", Some(&text), None, None)
                    .await;
                return;
            }
            let calls: Vec<Value> = completion
                .tool_calls
                .iter()
                .map(|c| json!({"id":c.id,"type":"function","function":{"name":c.name,"arguments":c.arguments}}))
                .collect();
            let _ = self
                .store
                .restricted_append(
                    conv,
                    sess,
                    "assistant",
                    completion.content.as_deref(),
                    Some(&Value::Array(calls).to_string()),
                    None,
                )
                .await;
            for call in &completion.tool_calls {
                let result = self
                    .broker
                    .handle(thread, &call.name, &call.arguments)
                    .await;
                let _ = self
                    .store
                    .restricted_append(conv, sess, "tool", Some(&result), None, Some(&call.id))
                    .await;
            }
        }
        notice(format!(
            "Stopped after {} model steps without a final answer.",
            thread.policy.max_steps
        ))
        .await;
    }

    /// Poll forever; returns when `stop` resolves. Spawn it once per server.
    pub async fn run(self: Arc<Self>, mut stop: tokio::sync::watch::Receiver<bool>) {
        let _ = self.store.restricted_recover().await;
        let active: Arc<Mutex<HashSet<String>>> = Default::default();
        loop {
            if let Ok(threads) = self.store.restricted_enabled_threads().await {
                for thread in threads {
                    let key = thread.conversation_id.to_string();
                    if active.lock().unwrap().contains(&key) {
                        continue;
                    }
                    if let Ok(Some(_)) = self.store.restricted_take_input(&thread).await {
                        active.lock().unwrap().insert(key.clone());
                        let (me, active) = (self.clone(), active.clone());
                        tokio::spawn(async move {
                            me.run_turn(&thread).await;
                            let _ = me
                                .store
                                .restricted_finish_input(&thread.conversation_id)
                                .await;
                            active.lock().unwrap().remove(&key);
                        });
                    }
                }
            }
            tokio::select! {
                _ = tokio::time::sleep(self.poll) => {}
                _ = stop.changed() => return,
            }
        }
    }
}
