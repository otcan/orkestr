//! Tracker tab: the conversation's structured table (sort, filter, search,
//! inline edit, review, merge, archive, CSV export, check mail now) or,
//! when the chat has no tracker yet, the recipe gallery with one-click
//! install of "Job tracking".
use dioxus::prelude::*;
use orkestr_v2_contracts::{
    RecipeCatalog, RecipeInstalled, TrackerEvent, TrackerEventsRequest, TrackerPage, TrackerRow,
    TrackerScanReport, TrackerStatus,
};
use orkestr_v2_ui::{
    session_scope::SessionScope,
    tracker::{count, day, source_label, status_class, visible, Column, Filter, NewRow, Sort},
};
use serde_json::{json, Value};

async fn browser_zone() -> String {
    let eval = document::eval("return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';");
    eval.join::<String>().await.unwrap_or_else(|_| "UTC".into())
}

#[component]
pub fn TrackerScreen(
    conversation: String,
    csrf: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
    onopen: EventHandler<(String, String)>,
) -> Element {
    let owner = session_scope.read().generation();
    let mut page = use_signal(|| None::<TrackerPage>);
    let mut missing = use_signal(|| false);
    let mut status = use_signal(String::new);
    let mut reload = use_signal(|| 0_u32);
    let path = format!("/api/v2/conversations/{conversation}/tracker");
    let read = path.clone();
    use_resource(move || {
        let _ = reload();
        let path = read.clone();
        async move {
            let result = crate::transport::request::<TrackerPage>("GET", &path, Value::Null, "", "").await;
            if !session_scope.read().is_current(owner) {
                return;
            }
            match result {
                Ok(value) => {
                    missing.set(false);
                    page.set(Some(value));
                }
                Err(error) if error.status == 401 => onexpired.call(()),
                Err(error) if error.status == 409 => missing.set(true),
                Err(error) => status.set(format!("Tracker unavailable: {}", error.message)),
            }
        }
    });
    rsx! {
        section { class: "tracker-screen", "aria-label": "Tracker",
            h2 { "Tracker" }
            if missing() {
                RecipeGallery { csrf: csrf.clone(), session_scope, onexpired, onopen }
            } else if let Some(current) = page() {
                TrackerTable { conversation: conversation.clone(), csrf: csrf.clone(), page: current, session_scope, onexpired,
                    onchanged: move |_| reload += 1 }
            } else {
                p { class: "settings-loading", if status().is_empty() { "Loading tracker…" } else { "{status}" } }
            }
        }
    }
}

#[component]
fn RecipeGallery(
    csrf: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
    onopen: EventHandler<(String, String)>,
) -> Element {
    let owner = session_scope.read().generation();
    let mut catalog = use_signal(|| None::<RecipeCatalog>);
    let mut status = use_signal(String::new);
    let mut busy = use_signal(|| false);
    let mut installed = use_signal(|| None::<RecipeInstalled>);
    use_resource(move || async move {
        let result = crate::transport::request::<RecipeCatalog>("GET", "/api/v2/recipes", Value::Null, "", "").await;
        if !session_scope.read().is_current(owner) {
            return;
        }
        match result {
            Ok(value) => catalog.set(Some(value)),
            Err(error) if error.status == 401 => onexpired.call(()),
            Err(error) => status.set(format!("Recipes unavailable: {}", error.message)),
        }
    });
    if let Some(done) = installed() {
        let (id, name) = (done.conversation_id.to_string(), done.conversation_name.clone());
        let mail_text = match done.mail.status.as_str() {
            "ready" => format!("Mail source: Thunderbird inbox found ({} folder).", done.mail.folders.len()),
            "no_profile" => "No Thunderbird profile found yet. Install Thunderbird, sign in to Gmail there, then use “Check mail now”.".to_owned(),
            _ => "Thunderbird was found but no inbox yet. Let it finish syncing, then use “Check mail now”.".to_owned(),
        };
        return rsx! {
            div { class: "recipe-installed", role: "status",
                h3 { "“{done.conversation_name}” is ready" }
                p { "It checks your job mail every hour on weekdays (09:00–20:00) and only writes when something changed." }
                p { class: if done.mail.status == "ready" { "" } else { "warning" }, "{mail_text}" }
                if let Some(grant) = done.tracker_grant.clone() {
                    details { class: "grant",
                        summary { "Assistant access key (shown once)" }
                        p { class: "field-help", "The hourly run reads the tracker with this key. Put it into the assistant environment as ORKESTR_TRACKER_GRANT. It only gives access to this chat's tracker." }
                        code { "{grant}" }
                    }
                }
                button { r#type: "button", class: "primary", onclick: move |_| onopen.call((id.clone(), name.clone())), "Open the job tracker" }
            }
        };
    }
    let Some(list) = catalog() else {
        return rsx! { p { class: "settings-loading", if status().is_empty() { "Loading recipes…" } else { "{status}" } } };
    };
    rsx! {
        p { class: "field-help", "This chat has no tracker. Start a ready-made one:" }
        div { class: "recipe-gallery",
            for recipe in list.recipes {
                article { class: "recipe-card", key: "{recipe.id}",
                    h3 { "{recipe.title}" }
                    p { "{recipe.summary}" }
                    ul {
                        for timer in recipe.timers.iter() {
                            li { "{timer.schedule}" if timer.silent_unless_changed { " · silent unless something changed" } }
                        }
                        if recipe.mail.as_deref() == Some("thunderbird") { li { "Reads your mail from Thunderbird on this computer (read-only)." } }
                    }
                    button { r#type: "button", class: "primary", disabled: busy(), onclick: {
                        let (csrf, id) = (csrf.clone(), recipe.id.clone());
                        move |_| {
                            if busy() { return; }
                            busy.set(true);
                            let (csrf, id) = (csrf.clone(), id.clone());
                            spawn(async move {
                                let zone = browser_zone().await;
                                let key = format!("ui-{}", crate::timer_bridge::now_ms().await);
                                let body = json!({"request_key": key, "timezone": zone});
                                let result = crate::transport::request::<RecipeInstalled>("POST", &format!("/api/v2/recipes/{id}/install"), body, &csrf, "").await;
                                if !session_scope.read().is_current(owner) { return; }
                                busy.set(false);
                                match result {
                                    Ok(value) => installed.set(Some(value)),
                                    Err(error) if error.status == 401 => onexpired.call(()),
                                    Err(error) => status.set(format!("Install failed: {}", error.message)),
                                }
                            });
                        }
                    }, if busy() { "Setting up…" } else { "Set up {recipe.title}" } }
                }
            }
        }
        if !status().is_empty() { p { role: "status", "{status}" } }
    }
}

#[component]
fn TrackerTable(
    conversation: String,
    csrf: String,
    page: TrackerPage,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
    onchanged: EventHandler<()>,
) -> Element {
    let owner = session_scope.read().generation();
    let mut filter = use_signal(|| Filter::Open);
    let mut query = use_signal(String::new);
    let mut sort = use_signal(Sort::default);
    let mut status = use_signal(String::new);
    let mut busy = use_signal(|| false);
    let mut opened = use_signal(|| None::<(String, Vec<TrackerEvent>)>);
    let mut selected = use_signal(Vec::<String>::new);
    let mut adding = use_signal(|| None::<NewRow>);
    let base = format!("/api/v2/conversations/{conversation}/tracker");
    // One write at a time; every answer reloads the table.
    let write = {
        let csrf = csrf.clone();
        Callback::new(move |(method, path, body, done): (&'static str, String, Value, String)| {
            if busy() {
                return;
            }
            busy.set(true);
            let csrf = csrf.clone();
            spawn(async move {
                let result = crate::transport::request::<Value>(method, &path, body, &csrf, "").await;
                if !session_scope.read().is_current(owner) {
                    return;
                }
                busy.set(false);
                match result {
                    Ok(value) => {
                        if let Ok(report) = serde_json::from_value::<TrackerScanReport>(value) {
                            status.set(if report.news {
                                report.summary.join(" · ")
                            } else {
                                format!("No news ({} new emails checked, mail source: {}).", report.stats.new_messages, report.mail.status)
                            });
                        } else {
                            status.set(done);
                        }
                    }
                    Err(error) if error.status == 401 => onexpired.call(()),
                    Err(error) => status.set(error.message),
                }
                onchanged.call(());
            });
        })
    };
    let rows = page.rows.clone();
    let shown: Vec<TrackerRow> = visible(&rows, filter(), &query(), sort()).into_iter().cloned().collect();
    let last_scan = page.last_scan_ms.map(day).unwrap_or_else(|| "never".into());
    let export = format!("{base}/export.csv");
    rsx! {
        div { class: "tracker-toolbar",
            div { class: "filter-chips", role: "group", "aria-label": "Filter",
                for f in Filter::ALL {
                    button { r#type: "button", "aria-pressed": if filter() == f { "true" } else { "false" }, onclick: move |_| filter.set(f),
                        "{f.label()} ({count(&rows, f)})" }
                }
            }
            input { r#type: "search", placeholder: "Search company, role, notes", value: "{query}", oninput: move |e| query.set(e.value()) }
            button { r#type: "button", disabled: busy(), onclick: {
                let path = format!("{base}/mail-scan");
                move |_| write.call(("POST", path.clone(), json!({}), "Mail checked.".into()))
            }, if busy() { "Working…" } else { "Check mail now" } }
            a { class: "button", href: "{export}", download: "job-tracker.csv", "Export CSV" }
            a { class: "button", href: "{export}?delimiter=semicolon", download: "job-tracker.csv", "CSV (;)" }
            button { r#type: "button", onclick: move |_| adding.set(Some(NewRow::default())), "Add application" }
            if selected.read().len() == 2 {
                button { r#type: "button", disabled: busy(), onclick: {
                    let path = format!("{base}/merge");
                    move |_| {
                        let pair = selected.read().clone();
                        selected.set(Vec::new());
                        write.call(("POST", path.clone(), json!({"keep": pair[0], "absorb": pair[1]}), "Rows merged.".into()));
                    }
                }, "Merge selected" }
            }
        }
        p { class: "field-help", "Last mail check: {last_scan}. Rows come from your job mail (LinkedIn, applicant tracking systems, recruiters) and your edits." }
        if let Some(form) = adding() {
            form { class: "settings-form tracker-add", onsubmit: {
                let path = format!("{base}/events");
                move |event: FormEvent| {
                    event.prevent_default();
                    let Some(form) = adding() else { return };
                    let path = path.clone();
                    spawn(async move {
                        let now = crate::timer_bridge::now_ms().await;
                        match form.event(now) {
                            Ok(input) => {
                                adding.set(None);
                                let request = TrackerEventsRequest { request_key: format!("ui-add-{now}"), events: vec![input] };
                                write.call(("POST", path, json!(request), "Added.".into()));
                            }
                            Err(message) => status.set(message.into()),
                        }
                    });
                }
            },
                h3 { "Add application" }
                div { class: "field-row",
                    input { placeholder: "Company", value: "{form.company}", oninput: move |e| if let Some(f) = adding.write().as_mut() { f.company = e.value(); } }
                    input { placeholder: "Role", value: "{form.role}", oninput: move |e| if let Some(f) = adding.write().as_mut() { f.role = e.value(); } }
                }
                input { placeholder: "Job link (https://…)", value: "{form.link}", oninput: move |e| if let Some(f) = adding.write().as_mut() { f.link = e.value(); } }
                select { onchange: move |e| if let Some(f) = adding.write().as_mut() { f.status = TrackerStatus::parse(&e.value()); },
                    for s in TrackerStatus::ALL { option { value: s.as_str(), selected: form.status.unwrap_or(TrackerStatus::Applied) == s, "{s.label()}" } }
                }
                div { class: "field-row",
                    button { r#type: "submit", "Add" }
                    button { r#type: "button", onclick: move |_| adding.set(None), "Cancel" }
                }
            }
        }
        if !status().is_empty() { p { role: "status", class: "settings-status", "{status}" } }
        if shown.is_empty() {
            p { class: "tracker-empty", if rows.is_empty() { "No applications yet. The tracker fills from your job mail; use “Check mail now” after Thunderbird has synced." } else { "No rows match this filter." } }
        } else {
            div { class: "tracker-scroll",
                table { class: "tracker-table",
                    thead { tr {
                        th { span { class: "visually-hidden", "Select" } }
                        for column in Column::ALL {
                            th { "aria-sort": if sort().column == column { if sort().descending { "descending" } else { "ascending" } } else { "none" },
                                button { r#type: "button", onclick: move |_| sort.set(sort().toggle(column)), "{column.label()}" } }
                        }
                        th { "Link" }
                        th { span { class: "visually-hidden", "Actions" } }
                    } }
                    tbody {
                        for row in shown {
                            Row { key: "{row.id}", row: row.clone(), base: base.clone(), busy: busy(), write,
                                checked: selected.read().contains(&row.id.to_string()),
                                ontoggle: move |id: String| { let mut s = selected.write(); if let Some(at) = s.iter().position(|v| *v == id) { s.remove(at); } else if s.len() < 2 { s.push(id); } },
                                onopen: {
                                    let base = base.clone();
                                    move |id: String| {
                                        if opened.read().as_ref().is_some_and(|(open, _)| *open == id) { opened.set(None); return; }
                                        let path = format!("{base}/rows/{id}/events");
                                        spawn(async move {
                                            let result = crate::transport::request::<Value>("GET", &path, Value::Null, "", "").await;
                                            if let Ok(value) = result {
                                                let events: Vec<TrackerEvent> = serde_json::from_value(value["events"].clone()).unwrap_or_default();
                                                opened.set(Some((id, events)));
                                            }
                                        });
                                    }
                                },
                                timeline: opened.read().as_ref().filter(|(open, _)| *open == row.id.to_string()).map(|(_, events)| events.clone()),
                            }
                        }
                    }
                }
            }
        }
    }
}

#[component]
fn Row(
    row: TrackerRow,
    base: String,
    busy: bool,
    checked: bool,
    write: Callback<(&'static str, String, Value, String)>,
    ontoggle: EventHandler<String>,
    onopen: EventHandler<String>,
    timeline: Option<Vec<TrackerEvent>>,
) -> Element {
    let id = row.id.to_string();
    let path = format!("{base}/rows/{id}");
    let save = {
        let (path, row) = (path.clone(), row.clone());
        move |patch: Value, done: &str| {
            let mut body = json!({"expected_revision": row.revision});
            if let (Some(body), Some(patch)) = (body.as_object_mut(), patch.as_object()) {
                body.extend(patch.clone());
            }
            write.call(("POST", path.clone(), body, done.to_owned()));
        }
    };
    let save_status = save.clone();
    let save_step = save.clone();
    let save_review = save.clone();
    let save_archive = save.clone();
    let save_notes = save;
    let next_step = row.next_step.clone().unwrap_or_default();
    let archived = row.archived;
    rsx! {
        tr { class: if row.needs_review { "needs-review" } else { "" },
            td { input { r#type: "checkbox", checked, "aria-label": "Select {row.company}", onchange: { let id = id.clone(); move |_| ontoggle.call(id.clone()) } } }
            td { button { r#type: "button", class: "link-button", onclick: { let id = id.clone(); move |_| onopen.call(id.clone()) }, "{row.company}" }
                if row.needs_review { span { class: "badge", title: "Check this row", "review" } } }
            td { "{row.role}" }
            td { select { class: status_class(row.status), disabled: busy, "aria-label": "Status of {row.company}",
                onchange: move |e| save_status(json!({"status": e.value()}), "Status saved."),
                for s in TrackerStatus::ALL { option { value: s.as_str(), selected: row.status == s, "{s.label()}" } }
            } }
            td { "{source_label(&row.source)}" }
            td { if let Some(applied) = row.applied_ms { "{day(applied)}" } }
            td { "{day(row.last_contact_ms)}" }
            td { input { value: "{next_step}", disabled: busy, "aria-label": "Next step for {row.company}",
                onchange: move |e| save_step(json!({"next_step": e.value()}), "Next step saved.") } }
            td { if let Some(link) = row.link.clone() { a { href: "{link}", target: "_blank", rel: "noopener noreferrer", "Open" } } }
            td { class: "row-actions",
                if row.needs_review { button { r#type: "button", disabled: busy, onclick: move |_| save_review(json!({"needs_review": false}), "Marked as checked."), "Looks right" } }
                button { r#type: "button", disabled: busy, onclick: move |_| save_archive(json!({"archived": !archived}), "Saved."), if archived { "Unarchive" } else { "Archive" } }
            }
        }
        if let Some(events) = timeline {
            tr { class: "timeline-row", td { colspan: "10",
                ol { class: "tracker-timeline",
                    for event in events {
                        li { key: "{event.id}",
                            strong { "{day(event.occurred_ms)} · {event.kind.as_str()}" }
                            " ({source_label(&event.source)}, {event.classifier}, {event.confidence}%)"
                            if let Some(evidence) = event.evidence.clone() { blockquote { "{evidence}" } }
                        }
                    }
                }
                label { class: "field-help", r#for: "notes-{id}", "Notes" }
                textarea { id: "notes-{id}", rows: 2, value: "{row.notes}", disabled: busy,
                    onchange: move |e| save_notes(json!({"notes": e.value()}), "Notes saved.") }
            } }
        }
    }
}

