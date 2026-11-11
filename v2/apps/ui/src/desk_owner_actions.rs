use crate::transport::Failure;
use dioxus::prelude::*;
use orkestr_v2_contracts::{stop_needs_confirmation, DesktopResource, DesktopRuntime};
use orkestr_v2_ui::{
    desk_presentation::{link_grant, stop_outcome, stop_warning},
    session_scope::SessionScope,
};
use serde_json::{json, Value};

#[derive(Clone, PartialEq)]
struct DeskLink {
    url: String,
    expires_at: Option<String>,
}

#[derive(Clone, PartialEq)]
struct Notice {
    text: String,
    /// An "outcome unknown" notice is answered by the next refresh.
    until_refresh: bool,
}

/// Owner Start/Stop/Link state for one desk row. It is held by the row so the
/// buttons (in the Actions cell) and any notice (in the detail row under it)
/// share it.
#[derive(Clone, Copy, PartialEq)]
pub struct OwnerActions {
    busy: Signal<Option<&'static str>>,
    confirming: Signal<bool>,
    notice: Signal<Option<Notice>>,
    uncertain: Signal<bool>,
    link: Signal<Option<DeskLink>>,
    /// The runtime an action reported, until a newer inventory replaces it.
    runtime_after: Signal<Option<(String, i64)>>,
    observed: Signal<i64>,
}

pub fn use_owner_actions(observed_at_ms: i64) -> OwnerActions {
    let actions = OwnerActions {
        busy: use_signal(|| None),
        confirming: use_signal(|| false),
        notice: use_signal(|| None),
        uncertain: use_signal(|| false),
        link: use_signal(|| None),
        runtime_after: use_signal(|| None),
        observed: use_signal(|| observed_at_ms),
    };
    // A refreshed inventory is the re-check an unknown outcome asks for.
    use_effect(use_reactive((&observed_at_ms,), move |(observed_at_ms,)| {
        let mut a = actions;
        if *a.observed.peek() == observed_at_ms {
            return;
        }
        a.observed.set(observed_at_ms);
        a.uncertain.set(false);
        if a.notice.peek().as_ref().is_some_and(|n| n.until_refresh) {
            a.notice.set(None);
        }
    }));
    actions
}

impl OwnerActions {
    /// The runtime to show: what the last action reported until the inventory
    /// has been observed again, then the inventory.
    pub fn runtime_state(&self, inventory_state: &str) -> String {
        match (self.runtime_after)() {
            Some((state, at)) if at == (self.observed)() => state,
            _ => inventory_state.to_owned(),
        }
    }
    pub fn has_notice(&self) -> bool {
        (self.confirming)()
            || (self.link)().is_some()
            || (self.notice)().is_some()
            || (self.uncertain)()
    }
}

fn say(mut notice: Signal<Option<Notice>>, text: impl Into<String>, until_refresh: bool) {
    notice.set(Some(Notice {
        text: text.into(),
        until_refresh,
    }));
}

fn report(
    error: Failure,
    actions: OwnerActions,
    onexpired: EventHandler<()>,
    onchanged: EventHandler<()>,
) {
    let mut uncertain = actions.uncertain;
    match error.status {
        401 => onexpired.call(()),
        // The action may or may not have happened: no retry until a refresh.
        0 | 408 | 500.. => {
            uncertain.set(true);
            say(actions.notice, error.message, true);
        }
        // The server saw newer state; show it instead of the stale row.
        409 => {
            say(actions.notice, error.message, false);
            onchanged.call(());
        }
        _ => say(actions.notice, error.message, false),
    }
}

#[allow(clippy::too_many_arguments)]
fn send(
    actions: OwnerActions,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
    onchanged: EventHandler<()>,
    action: &'static str,
    slug: String,
    csrf: String,
    body: Value,
) {
    if actions.busy.peek().is_some() || *actions.uncertain.peek() {
        return;
    }
    let owner = session_scope.peek().generation();
    let OwnerActions {
        mut busy,
        mut confirming,
        mut notice,
        mut link,
        mut runtime_after,
        observed,
        ..
    } = actions;
    busy.set(Some(action));
    notice.set(None);
    confirming.set(false);
    spawn(async move {
        let path = format!("/api/v2/desktops/{slug}/{action}");
        let result = crate::transport::request::<Value>("POST", &path, body, &csrf, "").await;
        if !session_scope.read().is_current(owner) {
            return;
        }
        busy.set(None);
        let value = match result {
            Ok(value) => value,
            Err(error) => return report(error, actions, onexpired, onchanged),
        };
        if let Some(state) = value["state"].as_str() {
            runtime_after.set(Some((state.to_owned(), *observed.peek())));
        }
        match action {
            "start" => {
                say(notice, "Desk started.", false);
                onchanged.call(());
            }
            "stop" => {
                link.set(None);
                let text = stop_outcome(
                    value["reservation_after_verified"] != false,
                    value["interrupted_holder"].as_str(),
                );
                say(notice, text, false);
                onchanged.call(());
            }
            _ => match value["url"].as_str() {
                Some(url) => link.set(Some(DeskLink {
                    url: url.to_owned(),
                    expires_at: value["expires_at"].as_str().map(str::to_owned),
                })),
                None => say(
                    notice,
                    "No link was returned; refresh and try again.",
                    false,
                ),
            },
        }
    });
}

fn stop_body(desk: &DesktopResource, confirm: bool) -> Value {
    json!({
        "expected_lease_state": desk.lease_state,
        "expected_holder": desk.holder,
        "confirm_interruption": confirm,
    })
}

/// Start, Stop and Link, each only when the desk's runtime allows it. The
/// server re-checks that state: this view never decides on its own that Stop
/// is safe.
#[component]
pub fn DeskOwnerButtons(
    actions: OwnerActions,
    desk: DesktopResource,
    runtime_state: String,
    csrf: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
    onchanged: EventHandler<()>,
) -> Element {
    let runtime = DesktopRuntime::from_state(&runtime_state);
    let needs_confirmation = stop_needs_confirmation(&desk.lease_state, runtime);
    let busy = (actions.busy)();
    let blocked = busy.is_some() || (actions.uncertain)();
    let mut confirming = actions.confirming;
    let go = move |action: &'static str, slug: String, csrf: String, body: Value| {
        send(
            actions,
            session_scope,
            onexpired,
            onchanged,
            action,
            slug,
            csrf,
            body,
        )
    };
    rsx! {
        div { class: "desk-owner-buttons", role: "group", "aria-label": "Actions for {desk.label}",
            if runtime.can_start() {
                button { r#type: "button", disabled: blocked, onclick: {
                    let (slug, csrf) = (desk.slug.clone(), csrf.clone());
                    move |_| go("start", slug.clone(), csrf.clone(), json!({}))
                }, if busy == Some("start") { "Starting…" } else { "Start" } }
            }
            if runtime.can_stop() {
                button { r#type: "button", disabled: blocked, onclick: {
                    let (desk, csrf) = (desk.clone(), csrf.clone());
                    move |_| {
                        if needs_confirmation {
                            confirming.set(true);
                        } else {
                            go("stop", desk.slug.clone(), csrf.clone(), stop_body(&desk, false));
                        }
                    }
                }, if busy == Some("stop") { "Stopping…" } else { "Stop" } }
            }
            if runtime.can_link() && (actions.link)().is_none() {
                button { r#type: "button", disabled: blocked, onclick: {
                    let (slug, csrf) = (desk.slug.clone(), csrf.clone());
                    move |_| go("link", slug.clone(), csrf.clone(), json!({}))
                }, if busy == Some("link") { "Creating link…" } else { "Link" } }
            }
        }
    }
}

/// The confirmation, link and outcome for one desk, shown under its row only
/// while they apply.
#[component]
pub fn DeskOwnerNotices(
    actions: OwnerActions,
    desk: DesktopResource,
    runtime_state: String,
    csrf: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
    onchanged: EventHandler<()>,
) -> Element {
    let runtime = DesktopRuntime::from_state(&runtime_state);
    let blocked = (actions.busy)().is_some() || (actions.uncertain)();
    let (mut confirming, mut notice, mut link) = (actions.confirming, actions.notice, actions.link);
    rsx! {
        if confirming() {
            div { class: "desk-confirm", role: "alert",
                p { {stop_warning(&desk.label, &desk.lease_state, desk.holder.as_deref(), desk.expires_at.as_deref(), runtime)} }
                div { class: "desk-confirm-actions",
                    button { r#type: "button", class: "danger", disabled: blocked, onclick: {
                        let (desk, csrf) = (desk.clone(), csrf.clone());
                        move |_| send(actions, session_scope, onexpired, onchanged, "stop", desk.slug.clone(), csrf.clone(), stop_body(&desk, true))
                    }, "Stop and interrupt" }
                    button { r#type: "button", onclick: move |_| confirming.set(false), "Keep it running" }
                }
            }
        }
        if let Some(desk_link) = link() {
            div { class: "desk-notice desk-link",
                div {
                    a { href: "{desk_link.url}", target: "_blank", rel: "noopener noreferrer", "Open desk link" }
                    p { class: "field-help", {link_grant(desk_link.expires_at.as_deref(), &desk.lease_state)} }
                }
                button { r#type: "button", class: "desk-dismiss", "aria-label": "Hide the link for {desk.label}", onclick: move |_| link.set(None), "Hide" }
            }
        }
        if let Some(current) = notice() {
            div { class: "desk-notice",
                p { role: "status", "{current.text}" }
                button { r#type: "button", class: "desk-dismiss", "aria-label": "Dismiss the message for {desk.label}", onclick: move |_| notice.set(None), "Dismiss" }
            }
        }
        if (actions.uncertain)() {
            p { class: "field-help", "This action’s outcome needs checking. Refresh the list before trying again." }
        }
    }
}
