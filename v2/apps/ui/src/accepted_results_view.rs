use crate::accepted_payloads_view::Reader;
use crate::accepted_results_bridge::start;
use dioxus::prelude::*;
use orkestr_v2_contracts::{
    AcceptedResult, AcceptedResults, ConversationPost, ExecutionStatus, RunId,
};
use orkestr_v2_ui::chat_timeline::{self, Input, Row};
use orkestr_v2_ui::{
    accepted_payloads::{adds_work, Answer, HINT_AFTER_MS},
    accepted_results::{next_chat_page, refresh_cursor, valid_page, CHAT_PAGES},
    execution::Execution,
    live_answer::LiveAnswer,
    session_scope::SessionScope,
};
use serde_json::{json, Value};
use std::{
    cell::Cell,
    collections::{BTreeMap, BTreeSet},
    rc::Rc,
};

/// The current run, for the answer drawn below the settled messages.
#[derive(Clone, PartialEq)]
pub struct LiveContext {
    pub status: Option<ExecutionStatus>,
    pub csrf: String,
    pub execution: Signal<Execution>,
}

#[component]
pub fn AcceptedReplies(
    id: String,
    #[props(default)] messages: Vec<Input>,
    #[props(default)] posts: Vec<ConversationPost>,
    #[props(default)] update: Option<Signal<i64>>,
    #[props(default)] inline: bool,
    #[props(default)] live: Option<LiveContext>,
    /// Receives the files of the shown messages, newest first (the Files
    /// panel's "In this chat", ORK-809).
    #[props(default)]
    files: Option<Signal<Vec<orkestr_v2_ui::chat_files::ChatFile>>>,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
) -> Element {
    let owner = session_scope.read().generation();
    let mut mounted = use_signal(|| true);
    let mut channel = use_signal(|| None::<document::Eval>);
    let mut after = use_signal(|| 0_i64);
    let mut reload = use_signal(|| 0_u64);
    let mut page = use_signal(|| None::<AcceptedResults>);
    let mut collected = use_signal(BTreeMap::<i64, AcceptedResult>::new);
    let silent = use_signal(BTreeSet::<i64>::new);
    let mut answer = use_signal(LiveAnswer::default);
    let revision = use_hook(|| Rc::new(Cell::new(0_i64)));
    let read_ticket = use_hook(|| Rc::new(Cell::new(0_u64)));
    let mut notice = use_signal(String::new);
    let mut busy = use_signal(|| false);
    let mut window_start = use_signal(|| 0_i64);
    let now = crate::message_time_view::use_now();
    let times = crate::message_time_view::use_message_times(id.clone(), window_start);
    // Answer texts (ORK-797): read in batches, kept for the page, never polled.
    let loaded = use_signal(|| 0_u64);
    let failed = use_signal(BTreeSet::<String>::new);
    let mut reading = use_signal(Vec::<AcceptedResult>::new);
    let payload_channel = use_signal(|| None::<document::Eval>);
    let reader = Reader {
        generation: owner,
        mounted,
        session_scope,
        channel: payload_channel,
        loaded,
        failed,
        silent,
        answer,
        onexpired,
    };
    use_drop(move || {
        mounted.set(false);
        if let Some(eval) = channel.read().as_ref() {
            let _ = eval.send(json!({"stop":true}));
        }
        reader.stop();
    });
    let reader_id = id.clone();
    use_resource(move || {
        let rows = reading();
        let conversation = reader_id.clone();
        async move {
            if !rows.is_empty() {
                reader.read(conversation, rows).await;
            }
        }
    });
    let read_id = id.clone();
    use_resource(move || {
        let fallback = after();
        let _ = reload();
        let accepted = update.map_or(0, |view| view());
        let is_live = inline && accepted > revision.get();
        let newest_shown = collected.peek().keys().next_back().copied();
        let cursor = refresh_cursor(newest_shown, is_live, fallback);
        if is_live {
            revision.set(accepted);
        }
        let ticket = read_ticket.get() + 1;
        read_ticket.set(ticket);
        let read_ticket = read_ticket.clone();
        let id = read_id.clone();
        async move {
            if let Some(old) = channel.peek().as_ref() {
                let _ = old.send(json!({"stop":true}));
            }
            busy.set(true);
            notice.set("Loading accepted replies…".into());
            let mut cursor = cursor;
            for _ in 0..CHAT_PAGES {
                let eval = start(json!({"conversation":id,"after":cursor.to_string()}), false);
                channel.set(Some(eval));
                let result = eval.join::<Value>().await;
                if !mounted()
                    || !session_scope.read().is_current(owner)
                    || read_ticket.get() != ticket
                {
                    return;
                }
                channel.set(None);
                match result {
                    Ok(value) if value["status"] == 200 => {
                        match serde_json::from_str::<AcceptedResults>(
                            value["text"].as_str().unwrap_or(""),
                        ) {
                            Ok(results) if valid_page(&results, &id, cursor) => {
                                notice.set(
                                    if results.results.is_empty() {
                                        "No accepted replies on this page."
                                    } else {
                                        "Replies you explicitly accepted."
                                    }
                                    .into(),
                                );
                                if inline
                                    && chat_timeline::merge_replies(
                                        &mut collected.write(),
                                        &results.results,
                                    )
                                    .is_err()
                                {
                                    notice.set(
                                        "Accepted reply identity changed. Reload history.".into(),
                                    );
                                    break;
                                }
                                let next = next_chat_page(&results, inline, cursor);
                                if !is_live {
                                    page.set(Some(results));
                                }
                                match next {
                                    Some(next) => cursor = next,
                                    None => break,
                                }
                            }
                            _ => {
                                notice.set(
                                    "Accepted replies could not be verified. Refresh to retry."
                                        .into(),
                                );
                                break;
                            }
                        }
                    }
                    Ok(value) if matches!(value["status"].as_u64(), Some(401 | 403)) => {
                        onexpired.call(());
                        break;
                    }
                    _ => {
                        notice.set("Accepted replies unavailable. Refresh to retry.".into());
                        break;
                    }
                }
            }
            busy.set(false);
            // Texts read before show at once; only new answers start a read.
            let shown: Vec<AcceptedResult> = if inline {
                collected.peek().values().cloned().collect()
            } else {
                page.peek()
                    .as_ref()
                    .map(|p| p.results.clone())
                    .unwrap_or_default()
            };
            let todo = reader.plan(&id, &shown);
            if adds_work(&reading.peek(), &todo) {
                reading.set(todo);
            }
        }
    });
    let next = page.read().as_ref().and_then(|p| p.next_after_sequence);
    let results = if inline {
        collected.read().values().cloned().collect()
    } else {
        page.read()
            .as_ref()
            .map(|p| p.results.clone())
            .unwrap_or_default()
    };
    let _ = loaded();
    let answers = crate::accepted_payloads_view::answers(owner, &id, &results, &failed.read());
    let rows = chat_timeline::ordered(&messages, &results, &posts);
    // Every file of the shown messages: the owner's attachments and the
    // files of each answer whose text the chat has read.
    let shown_files = match (&rows, files.is_some()) {
        (Ok(rows), true) => {
            let silent_rows = silent.read();
            orkestr_v2_ui::chat_files::newest_first(
                rows.iter()
                    .filter(|row| !row.is_notice() && !row.is_silenced(&silent_rows))
                    .filter_map(|row| match row {
                        Row::Input(input) if !input.revisions.deleted => Some((
                            row.sequence(),
                            if input.actor == "owner" {
                                "You".to_string()
                            } else {
                                input.actor.clone()
                            },
                            input.text.as_str(),
                        )),
                        Row::Reply(reply) if !reply.payload_removed => {
                            match answers.get(&reply.acceptance_sequence) {
                                Some(Answer::Read(Some(text))) => {
                                    Some((row.sequence(), "Assistant".to_string(), text.as_str()))
                                }
                                _ => None,
                            }
                        }
                        _ => None,
                    }),
            )
        }
        _ => Vec::new(),
    };
    use_effect(use_reactive((&shown_files,), move |(list,)| {
        if let Some(mut sink) = files {
            if *sink.peek() != list {
                sink.set(list);
            }
        }
    }));
    // Times start just before the oldest row on screen.
    let first = rows
        .as_ref()
        .ok()
        .and_then(|r| r.first().map(|row| row.sequence() - 1))
        .unwrap_or(0);
    if *window_start.peek() != first {
        window_start.set(first);
    }
    let status_now = live.as_ref().and_then(|live| live.status.clone());
    use_effect(use_reactive((&status_now,), move |(status,)| {
        let ended = status.and_then(|status| answer.peek().newly_unanswered(&status));
        if let Some(run) = ended {
            answer.write().unanswered(&run);
        }
    }));
    let live_rows = answer.read().rows(status_now.as_ref());
    let times_now = times.read();
    rsx! { section { class: if inline { "chat-transcript" } else { "accepted-history" }, "aria-label":"Accepted replies",
        if !inline { h2 { "Accepted replies" } }
        if let Ok(rows) = rows {
            if inline && rows.is_empty() && !busy() { p { class: "empty-conversation", "Start a conversation. Your messages and accepted replies will appear here." } }
            ol { class: if inline { "chat-messages" } else { "messages" },
                for row in rows.into_iter().filter(|row| !row.is_silenced(&silent.read()) && !row.is_silent_notice()) {
                    li { key: "{row.key()}", hidden: matches!(&row, Row::Reply(reply) if live_rows.covers(&reply.run_id)), class: match &row { _ if row.is_notice() => "revision-notice-row", Row::Input(_) => "user-message", Row::Reply(_) => "assistant-message", Row::Post(_) => "assistant-message post-message" }, "data-replyable": "{inline && row.is_replyable()}",
                        match &row {
                            Row::Input(input) if input.revisions.notice.is_some() => rsx! {
                                if let Some(notice) = &input.revisions.notice { p { class: "revision-notice", role: "status", "{chat_timeline::notice_line(notice)}" } }
                            },
                            Row::Input(input) if input.revisions.deleted => rsx! { article { "data-message-id": "{input.id}",
                                strong { if input.actor == "owner" { "You" } else { "{input.actor}" } }
                                p { class: "message-removed", "You deleted this message." }
                                if inline {
                                    if let Some(context) = &live { crate::message_actions_view::MessageMenu { key: "menu-{input.id}", message_id: input.id.clone(), history: Some(crate::message_actions_view::History { conversation: id.clone(), csrf: context.csrf.clone() }), onexpired } }
                                }
                            } },
                            Row::Input(input) => rsx! { article { "data-message-id": "{input.id}",
                                strong { if input.actor == "owner" { "You" } else { "{input.actor}" } }
                                if let Some(quote) = &input.reply_to {
                                    blockquote { class: "reply-quote", "data-reply-quote": "true", "data-reply-unavailable": "{quote.unavailable}",
                                        cite { "{chat_timeline::quote_label(quote)}" }
                                        if !quote.unavailable { p { "{quote.text}" } }
                                    }
                                }
                                crate::rich_text_view::RichText { text: orkestr_v2_ui::message_file_refs::display_text(&input.text), attachments: !orkestr_v2_ui::message_file_refs::references(&input.text).is_empty() }
                                crate::message_files_view::MessageFiles {key: "files-{input.id}", conversation:id.clone(),message:input.id.clone(),text:input.text.clone(),session_scope}
                                if let Some(source) = input.revisions.edited_from {
                                    small { class: "message-edited", "{chat_timeline::edited_label(source)}" }
                                }
                                if inline {
                                    // One actions menu: Reply, Copy text, and Edit, Delete, History where allowed.
                                    crate::message_actions_view::MessageMenu { key: "menu-{input.id}-{input.revisions.revision}", message_id: input.id.clone(),
                                        reply: Some(crate::message_actions_view::ReplyTarget { draft_key: id.clone(), composer: "composer".into(),
                                            author: if input.actor == "owner" { chat_timeline::QuoteAuthor::Owner } else { chat_timeline::QuoteAuthor::Other }, text: input.text.clone() }),
                                        copy: Some(orkestr_v2_ui::message_file_refs::display_text(&input.text)),
                                        revise: live.as_ref().filter(|_| input.revisions.can_revise).map(|context| crate::message_actions_view::Revise { conversation: id.clone(), text: input.text.clone(), revision: input.revisions.revision, csrf: context.csrf.clone() }),
                                        history: live.as_ref().filter(|_| input.revisions.edited_from.is_some()).map(|context| crate::message_actions_view::History { conversation: id.clone(), csrf: context.csrf.clone() }),
                                        onexpired }
                                }
                                crate::outbox_view::TimelineDelivery { message_id: input.id.clone() }
                            } },
                            Row::Reply(reply) => rsx! { AcceptedReply { conversation:id.clone(), row:reply.clone(), session_scope, onexpired,
                                answer: answers.get(&reply.acceptance_sequence).cloned().unwrap_or(Answer::Loading) } },
                            Row::Post(post) => rsx! { crate::conversation_posts_view::PostBubble { post: post.clone() } },
                        }
                        if let Row::Post(post) = &row {
                            crate::message_time_view::MessageTime { at_ms: post.created_ms, now_ms: now() }
                        } else if let (false, Some(time)) = (row.is_notice(), times_now.get(&row.sequence())) {
                            crate::message_time_view::MessageTime { at_ms: time.at_ms, now_ms: now(), receipts: time.receipts.clone() }
                        }
                    }
                }
            }
        } else { p { role: "alert", "Conversation order could not be verified. Reload history." } }
        if inline {
            crate::outbox_view::OutboxBubbles { target: orkestr_v2_ui::outbox::Target::Native(id.clone()), shown: messages.iter().map(|m| m.id.clone()).collect::<Vec<_>>() }
            if let Some(shown) = live_rows.finishing.clone() {
                div { key: "finishing-{shown.run}", class: "chat-messages live-answer-row",
                    crate::progress_view::LiveBubble { text: Some(shown.text) }
                }
            }
            if let (Some(current), Some(context)) = (live_rows.writing.clone(), live.as_ref()) {
                div { key: "writing-{current.run_id.as_ref().map(ToString::to_string).unwrap_or_default()}", class: "chat-messages live-answer-row",
                    // A key only takes effect at the root of a block: each payload is read afresh.
                    if let Some(progress) = current.progress.clone() {
                        crate::progress_view::ProgressView { key: "{progress.payload_id}",
                            retained: current.run_id.as_ref().and_then(|run| answer.read().text(run).map(str::to_owned)),
                            onobserved: move |(run, text): (RunId, Option<String>)| {
                                if answer.peek().text(&run) != text.as_deref() { answer.write().observed(&run, text); }
                            },
                            status: current.clone(), csrf: context.csrf.clone(), execution: context.execution, session_scope, onexpired, plain: true }
                    }
                }
            }
        }
        if !inline { details { class: "transcript-pages",
            summary { "Reply history pages" }
            p { role:"status", "{notice}" }
            button { disabled:busy(), onclick:move |_|{after.set(0);reload+=1;}, "Refresh accepted replies" }
            button { disabled:busy()||next.is_none(), onclick:move |_|{if let Some(cursor)=next{after.set(cursor);}}, "Next 20 accepted replies" }
        } }
    } }
}

#[component]
fn AcceptedReply(
    conversation: String,
    row: AcceptedResult,
    /// What the chat has read for this reply (ORK-797). Text once read stays.
    answer: Answer,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
) -> Element {
    let waiting = answer == Answer::Loading && !row.payload_removed && row.payload_id.is_some();
    // A quiet hint, and only when no text has come for a few seconds.
    let mut slow = use_signal(|| false);
    let waited = use_hook(|| waiting);
    use_future(move || async move {
        if waited {
            crate::transport::sleep(HINT_AFTER_MS).await;
            slow.set(true);
        }
    });
    let notice = if row.payload_removed || answer == Answer::Read(None) {
        "Answer text removed."
    } else if row.payload_id.is_none() {
        "No text was recorded for this answer."
    } else if answer == Answer::Failed {
        "This answer could not be loaded."
    } else {
        ""
    };
    let shown = match &answer {
        Answer::Read(Some(text))
            if !row.payload_removed && !orkestr_v2_ui::payload::silent_assistant_reply(text) =>
        {
            Some(text.clone())
        }
        _ => None,
    };
    let reply_conversation = conversation.clone();
    let payload_id = row
        .payload_id
        .as_ref()
        .map(ToString::to_string)
        .unwrap_or_default();
    rsx! { article {
        "data-run-id": "{row.run_id}",
        "data-completion-event-id": "{row.completion_event_id}",
        "data-acceptance-event-id": "{row.acceptance_event_id}",
        "data-payload-id": "{payload_id}",
        strong { "Assistant" }
        span { class: "reply-state", "{notice}" }
        if waiting && slow() { span { class: "reply-loading", role: "status", "aria-label": "Loading answer" } }
        if let Some(text)=shown.clone(){div { class: "accepted-output", "data-accepted-output": "true", crate::rich_text_view::RichText { text: orkestr_v2_ui::message_file_refs::display_text(&text), attachments: !orkestr_v2_ui::message_file_refs::references(&text).is_empty() }
            crate::message_files_view::MessageFiles {key: "files-{row.completion_event_id}",conversation:reply_conversation.clone(),message:row.completion_event_id.to_string(),text,session_scope}
        }}
        if let Some(text)=shown{
            crate::message_actions_view::MessageMenu { message_id: row.completion_event_id.to_string(),
                copy: Some(orkestr_v2_ui::message_file_refs::display_text(&text)),
                reply: Some(crate::message_actions_view::ReplyTarget { draft_key: reply_conversation.clone(), composer: "composer".into(), author: chat_timeline::QuoteAuthor::Assistant, text }),
                onexpired }
        }
    } }
}
