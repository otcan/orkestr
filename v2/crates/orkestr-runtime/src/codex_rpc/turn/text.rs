//! Bounded assistant-item snapshots. Text remains evidence, never authority.
use crate::ports::Blocker;
use orkestr_v2_application::runtime::MAX_PROVIDER_PROGRESS_BYTES;
use serde_json::Value;

const MAX_ITEMS: usize = 128;
/// Marks a reply taken from the last progress message of a turn that ended
/// without a final answer.
pub(crate) const NO_FINAL_NOTE: &str = "(Ended without a final answer; last update:)";
/// Reply for a completed turn that produced no message at all.
pub(crate) const NO_TEXT_NOTICE: &str =
    "(The turn completed without a reply. Ask for a status update if you need one.)";
/// Leads the progress snapshot of an asynchronous question
/// (`request_user_input_async`: an agent message with `delivery: "async"`).
/// The question is interim output, never the turn's final answer: delivery
/// layers (the WhatsApp adapter) recognize this exact prefix and send it on
/// at once, while the turn continues to its single final answer.
pub const ASYNC_QUESTION_PREFIX: &str = "\u{2753} Question while I keep working:\n\n";
/// Heads the questions repeated at the end of the final answer, so the
/// conversation record keeps every question the turn asked.
pub(crate) const OPEN_QUESTIONS_HEADING: &str = "\u{2753} Questions asked during this turn:";

/// Static reason for a refused turn (diagnostics only; never provider text).
fn refused(reason: &'static str) -> Blocker {
    eprintln!("codex turn text refused: {reason}");
    Blocker::Protocol
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Commentary,
    Partial,
    Final,
}

struct Item {
    id: Option<String>,
    text: String,
    phase: Option<Phase>,
    boundary: bool,
    completed: bool,
    deltas: bool,
    /// `delivery: "async"`: an interim question, never the final answer.
    question: bool,
    next_snapshot: usize,
}

#[derive(Default)]
pub(super) struct TurnText {
    items: Vec<Item>,
    final_item: Option<usize>,
    last_emitted: Option<(usize, usize)>,
}

fn identifier(value: &Value) -> Result<&str, Blocker> {
    value
        .as_str()
        .filter(|value| !value.is_empty() && value.len() <= 512)
        .ok_or(Blocker::Protocol)
}

fn phase(item: &Value) -> Result<Option<Phase>, Blocker> {
    match item.get("phase") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => match value.as_str() {
            "commentary" => Ok(Some(Phase::Commentary)),
            "partial_answer" => Ok(Some(Phase::Partial)),
            "final_answer" => Ok(Some(Phase::Final)),
            _ => Err(Blocker::Protocol),
        },
        _ => Err(Blocker::Protocol),
    }
}

/// Whether an agent message is an asynchronous question for the user.
fn async_question(item: &Value) -> Result<bool, Blocker> {
    match item.get("delivery") {
        None | Some(Value::Null) => Ok(false),
        Some(Value::String(value)) if value == "async" => Ok(true),
        _ => Err(refused("agent message delivery")),
    }
}

impl TurnText {
    fn insert(&mut self, id: Option<&str>) -> Result<usize, Blocker> {
        if self.items.len() == MAX_ITEMS {
            return Err(Blocker::Protocol);
        }
        let index = self.items.len();
        self.items.push(Item {
            id: id.map(str::to_owned),
            text: String::new(),
            phase: None,
            boundary: false,
            completed: false,
            deltas: false,
            question: false,
            next_snapshot: 1,
        });
        Ok(index)
    }

    fn delta_item(&mut self, params: &Value) -> Result<usize, Blocker> {
        if let Some(id) = params.get("itemId") {
            let id = identifier(id)?;
            if let Some(index) = self
                .items
                .iter()
                .position(|item| item.id.as_deref() == Some(id))
            {
                return Ok(index);
            }
            // Legacy delta-only streams have no item lifecycle. Once a lifecycle
            // is present, an unknown item's delta cannot invent a new message.
            if self.items.iter().any(|item| item.boundary) {
                return Err(Blocker::Protocol);
            }
            return self.insert(Some(id));
        }
        let mut open = self
            .items
            .iter()
            .enumerate()
            .filter(|(_, item)| !item.completed);
        match (open.next(), open.next()) {
            (Some((index, _)), None) => Ok(index),
            (None, None) if self.items.is_empty() => self.insert(None),
            _ => Err(Blocker::Protocol),
        }
    }

    fn snapshot(&mut self, index: usize, complete: bool) -> Option<String> {
        let item = &mut self.items[index];
        let size = item.text.len();
        if size == 0 || self.last_emitted == Some((index, size)) {
            return None;
        }
        if !complete && size < item.next_snapshot {
            return None;
        }
        // Geometric byte thresholds bound live snapshot storage linearly in the
        // item size. Completed/final selection always emits the exact full text.
        item.next_snapshot = size * 2;
        self.last_emitted = Some((index, size));
        Some(item.text.clone())
    }

    pub(super) fn receive(
        &mut self,
        method: &str,
        params: &Value,
    ) -> Result<Option<String>, Blocker> {
        if method == "item/agentMessage/delta" {
            let delta = params
                .get("delta")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
                .ok_or(Blocker::Protocol)?;
            let index = self.delta_item(params)?;
            let item = &mut self.items[index];
            if item.completed
                || delta.len() > MAX_PROVIDER_PROGRESS_BYTES
                || item.text.len() + delta.len() > MAX_PROVIDER_PROGRESS_BYTES
            {
                return Err(Blocker::Protocol);
            }
            item.deltas = true;
            item.text.push_str(delta);
            if item.question {
                return Ok(None);
            }
            return Ok(self.snapshot(index, false));
        }
        let value = params.get("item").ok_or(Blocker::Protocol)?;
        if value.get("type").and_then(Value::as_str) != Some("agentMessage") {
            return Ok(None);
        }
        let id = identifier(value.get("id").ok_or(Blocker::Protocol)?)?;
        let text = value
            .get("text")
            .and_then(Value::as_str)
            .ok_or(Blocker::Protocol)?;
        if text.len() > MAX_PROVIDER_PROGRESS_BYTES {
            return Err(Blocker::Protocol);
        }
        let phase = phase(value)?;
        let question = async_question(value)?;
        let completed = method == "item/completed";
        let index = match self
            .items
            .iter()
            .position(|item| item.id.as_deref() == Some(id))
        {
            Some(index) => index,
            None if completed
                && self.items.len() == 1
                && self.items[0].id.is_none()
                && !self.items[0].boundary
                && self.items[0].text == text =>
            {
                self.items[0].id = Some(id.to_owned());
                0
            }
            None => self.insert(Some(id))?,
        };
        let item = &mut self.items[index];
        if item.completed
            || (!completed && item.boundary)
            || matches!((item.phase, phase), (Some(a), Some(b)) if a != b)
            || (item.boundary && item.question != question)
        {
            return Err(Blocker::Protocol);
        }
        item.phase = phase.or(item.phase);
        item.question = question;
        if completed {
            // A completed snapshot must agree with all observed deltas. A model
            // may provide a full completed item without streaming any deltas.
            if (item.deltas && item.text != text) || !text.starts_with(&item.text) {
                return Err(Blocker::Protocol);
            }
            if item.phase == Some(Phase::Final) && !item.question && !text.trim().is_empty() {
                if self.final_item.is_some_and(|previous| previous != index) {
                    return Err(refused("second final answer in one turn"));
                }
                self.final_item = Some(index);
            }
            item.text = text.to_owned();
            item.completed = true;
            if item.question {
                // Delivered at once as interim output; the turn continues.
                item.boundary = true;
                return Ok(self.question_snapshot(index));
            }
        } else if !text.is_empty() {
            if !item.text.is_empty() && item.text != text {
                return Err(Blocker::Protocol);
            }
            item.text = text.to_owned();
        }
        item.boundary = true;
        if item.question {
            return Ok(None);
        }
        Ok(self.snapshot(index, completed))
    }

    /// Whether this turn delivered (or began) an asynchronous question: owner
    /// visible output, so a capacity retry would repeat it.
    pub(super) fn asked_question(&self) -> bool {
        self.items.iter().any(|item| item.question)
    }

    /// The marked snapshot of one completed asynchronous question.
    fn question_snapshot(&mut self, index: usize) -> Option<String> {
        let text = self.items[index].text.trim();
        if text.is_empty() {
            return None;
        }
        let marked = format!("{ASYNC_QUESTION_PREFIX}{text}");
        self.last_emitted = Some((index, self.items[index].text.len()));
        Some(if marked.len() <= MAX_PROVIDER_PROGRESS_BYTES {
            marked
        } else {
            self.items[index].text.clone()
        })
    }

    /// Questions of this turn the final text does not already contain.
    fn open_questions(&self, final_text: &str) -> Vec<&str> {
        self.items
            .iter()
            .filter(|item| item.question && item.completed)
            .map(|item| item.text.trim())
            .filter(|text| !text.is_empty() && !final_text.contains(*text))
            .collect()
    }

    /// The final answer followed by the turn's open questions, when they fit.
    fn with_open_questions(&self, final_text: &str) -> Option<String> {
        let open = self.open_questions(final_text);
        if open.is_empty() {
            return None;
        }
        let mut text = format!("{}\n\n{OPEN_QUESTIONS_HEADING}", final_text.trim_end());
        for (number, question) in open.iter().enumerate() {
            text.push_str(&format!("\n{}. {}", number + 1, question));
        }
        (text.len() <= MAX_PROVIDER_PROGRESS_BYTES).then_some(text)
    }

    fn terminal_items(&self, turn: &Value) -> Result<(), Blocker> {
        let Some(items) = turn.get("items") else {
            return Ok(());
        };
        let items = items
            .as_array()
            .filter(|items| items.len() <= MAX_ITEMS)
            .ok_or_else(|| refused("terminal items over bound"))?;
        let view = match turn.get("itemsView") {
            None => "full",
            Some(value) => value
                .as_str()
                .ok_or_else(|| refused("terminal itemsView type"))?,
        };
        if !matches!(view, "full" | "summary" | "notLoaded")
            || (view == "notLoaded" && !items.is_empty())
        {
            return Err(refused("terminal itemsView value"));
        }
        let mut seen = Vec::new();
        for value in items {
            value
                .as_object()
                .ok_or_else(|| refused("terminal item shape"))?;
            if value.get("type").and_then(Value::as_str) != Some("agentMessage") {
                continue;
            }
            let id = identifier(value.get("id").ok_or_else(|| refused("terminal item id"))?)?;
            let item = self
                .items
                .iter()
                .find(|item| item.id.as_deref() == Some(id))
                .ok_or_else(|| refused("terminal agent message never observed"))?;
            if seen.contains(&id)
                || !item.completed
                || value.get("text").and_then(Value::as_str) != Some(item.text.as_str())
                || phase(value)?.is_some_and(|phase| Some(phase) != item.phase)
            {
                return Err(refused("terminal agent message differs from observed"));
            }
            seen.push(id);
        }
        if view == "full" && seen.len() != self.items.len() {
            return Err(refused(
                "observed agent message missing from full terminal items",
            ));
        }
        Ok(())
    }

    pub(super) fn finish(&mut self, turn: &Value) -> Result<Option<String>, Blocker> {
        self.terminal_items(turn)?;
        if self.items.is_empty() {
            // The turn completed with tool work but no message at all: say so
            // explicitly rather than failing or leaving the owner without a reply.
            return Ok(Some(NO_TEXT_NOTICE.to_owned()));
        }
        let lifecycle = self.items.iter().any(|item| item.boundary);
        let index = if lifecycle {
            if self.items.iter().any(|item| !item.completed) {
                return Err(refused("agent message never completed"));
            }
            match self.final_item.or_else(|| {
                self.items.iter().rposition(|item| {
                    item.phase.is_none() && !item.question && !item.text.trim().is_empty()
                })
            }) {
                Some(index) => index,
                // A completed turn with commentary but no final answer (V1 shows
                // the last message): use the last non-empty agent message, marked.
                None => {
                    let last = self
                        .items
                        .iter()
                        .rposition(|item| !item.question && !item.text.trim().is_empty());
                    let reply = match last {
                        Some(last) => format!("{NO_FINAL_NOTE}\n\n{}", self.items[last].text),
                        // Only questions: they are the reply.
                        None if !self.open_questions("").is_empty() => {
                            match self.with_open_questions("") {
                                Some(text) => text.trim_start().to_owned(),
                                None => NO_TEXT_NOTICE.to_owned(),
                            }
                        }
                        None => NO_TEXT_NOTICE.to_owned(),
                    };
                    return Ok(Some(match (last, self.with_open_questions(&reply)) {
                        (Some(_), Some(text)) => text,
                        _ => reply,
                    }));
                }
            }
        } else {
            // Legacy missing-phase/ID streams retain only their last message;
            // known commentary/partial phases are never promoted to an answer.
            self.items
                .iter()
                .rposition(|item| !item.text.trim().is_empty())
                .ok_or(Blocker::Protocol)?
        };
        if self.items[index].text.trim().is_empty() {
            return Err(Blocker::Protocol);
        }
        if let Some(text) = self.with_open_questions(&self.items[index].text) {
            // The completion payload is the latest progress: always emit it.
            self.last_emitted = None;
            return Ok(Some(text));
        }
        Ok(self.snapshot(index, true))
    }
}
