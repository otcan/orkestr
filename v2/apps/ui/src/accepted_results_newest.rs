//! Opening a chat reads its newest accepted replies first: the newest page of
//! 50, then the page below it, which fill the inline window. A forward read
//! from the start took one sequential request per 20 replies of history and
//! dropped all but the newest 100.
use crate::accepted_results_bridge::start;
use dioxus::prelude::*;
use orkestr_v2_contracts::{AcceptedResult, AcceptedResults};
use orkestr_v2_ui::accepted_results::{older_cursor, valid_newest_page, NEWEST_PAGES};
use serde_json::{json, Value};

/// The newest replies of `conversation`, oldest first, read through
/// `channel` (so leaving the chat stops the read). `None` when they cannot
/// be read this way (an older server, a failed or unverifiable read, or
/// `wanted` turned false); the caller then reads forward from the start.
pub async fn read(
    conversation: &str,
    mut channel: Signal<Option<document::Eval>>,
    wanted: impl Fn() -> bool,
) -> Option<Vec<AcceptedResult>> {
    let mut rows: Vec<AcceptedResult> = Vec::new();
    let mut before = i64::MAX;
    for _ in 0..NEWEST_PAGES {
        let eval = start(
            json!({"conversation": conversation, "after": "0", "before": before.to_string()}),
            false,
        );
        channel.set(Some(eval));
        let result = eval.join::<Value>().await;
        if !wanted() {
            return None;
        }
        channel.set(None);
        let page = match result {
            Ok(value) if value["status"] == 200 => {
                serde_json::from_str::<AcceptedResults>(value["text"].as_str().unwrap_or(""))
                    .ok()?
            }
            _ => return None,
        };
        if !valid_newest_page(&page, conversation, before) {
            return None;
        }
        let older = older_cursor(&page);
        // Each page is older than the rows already read.
        let mut page_rows = page.results;
        page_rows.append(&mut rows);
        rows = page_rows;
        match older {
            Some(cursor) => before = cursor,
            None => break,
        }
    }
    Some(rows)
}
