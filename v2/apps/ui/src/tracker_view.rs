use crate::tracker_controller::*;
use dioxus::prelude::*;
use orkestr_v2_ui::session_scope::SessionScope;

#[component]
pub fn Tracker(
    conversation: String,
    csrf: String,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
) -> Element {
    let generation = session_scope.read().generation();
    let namespace = session_scope
        .read()
        .retention_namespace()
        .unwrap_or_default()
        .to_owned();
    let conversation = use_signal(move || conversation);
    let csrf = use_signal(move || csrf);
    let binding = use_signal(move || namespace);
    let ui = TrackerUi {
        conversation,
        csrf,
        binding,
        session: session_scope,
        generation,
        expired: onexpired,
        data: use_signal(|| None),
        needs_setup: use_signal(|| false),
        busy: use_signal(|| false),
        notice: use_signal(String::new),
        reload: use_signal(|| 0),
        epoch: use_signal(|| 0),
        sources: use_signal(Vec::new),
        discovered: use_signal(|| false),
        pending: use_signal(Vec::new),
    };
    use_context_provider(move || ui);
    use_future(move || async move {
        loop {
            let revision = *ui.reload.peek();
            crate::tracker_poll::refresh(ui).await;
            let mut waited = 0;
            loop {
                crate::transport::sleep(500).await;
                if !ui.session.read().is_current(generation) {
                    return;
                }
                waited += 500;
                let checking = !ui.pending.peek().is_empty()
                    || ui
                        .data
                        .peek()
                        .as_ref()
                        .is_some_and(|d| !d.mail.checks.is_empty());
                if !*ui.busy.peek()
                    && (*ui.reload.peek() != revision
                        || (checking && waited >= 2000)
                        || waited >= 15000)
                {
                    break;
                }
            }
        }
    });
    let data = (ui.data)();
    rsx! {
        document::Style { {include_str!("tracker.css")} }
        section { class: "tracker-screen", "aria-label": "Job tracker",
            header { class: "tracker-heading",
                div { h2 { "Job tracker" } p { "Applications, replies and next steps in one place." } }
                button { disabled: (ui.busy)(), onclick: move |_| { let mut reload=ui.reload; reload+=1; }, "Refresh" }
            }
            if !(ui.notice)().is_empty() { p { class: "tracker-notice", role: "status", "{ui.notice}" } }
            Recovery {}
            if (ui.needs_setup)() {
                section { class: "tracker-setup",
                    h3 { "Set up in this chat" }
                    p { "Build a job table from selected local mail folders. Choose what to read in the next step." }
                    button { disabled: (ui.busy)(), onclick: move |_| ui.setup(), "Set up job tracker" }
                }
            } else if let Some(data) = data {
                crate::tracker_source_view::SourceSetup {}
                if data.mail.source.is_some() {
                    crate::tracker_automation_view::MailChecks {}
                }
                crate::tracker_table_view::TrackerTable {}
            } else { p { "Loading tracker…" } }
        }
    }
}
#[component]
fn Recovery() -> Element {
    let ui = use_context::<TrackerUi>();
    let pending = (ui.pending)();
    if pending.is_empty() {
        return rsx! {};
    }
    rsx! {
        section { class: "tracker-recovery", "aria-label": "Saved tracker changes",
            h3 { "Saved changes" }
            p { "A response was interrupted or a check is still running. Check its status or retry the same saved change." }
            for decision in pending {
                {
                    let retry=decision.clone();
                    let check_key=(decision.kind=="check").then(|| decision.key().unwrap_or_default().to_owned());
                    let can_stop_schedule=decision.kind=="automation_enable" && ui.data.peek().is_some();
                    let label=match decision.kind.as_str() { "check"=>"Mail check", "selection"=>"Mail folder selection", "source_remove"=>"Remove mail access", "automation_enable"=>"Recurring schedule", _=>"Stop recurring checks" };
                    rsx! { div { class: "tracker-recovery-row",
                        span { "{label}" }
                        button { disabled: (ui.busy)(), onclick: move |_| ui.retry(retry.clone()), "Retry saved change" }
                        if let Some(key)=check_key { button { onclick: move |_| ui.stop_check(key.clone()), "Stop check" } }
                        if can_stop_schedule { button { onclick: move |_| ui.stop_automation(), "Stop recurring checks" } }
                    } }
                }
            }
        }
    }
}
