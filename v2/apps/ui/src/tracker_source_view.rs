use crate::tracker_controller::*;
use dioxus::prelude::*;
use orkestr_v2_ui::tracker_setup::SourceForm;
use serde_json::json;

#[component]
pub fn SourceSetup() -> Element {
    let mut ui = use_context::<TrackerUi>();
    let mut form = use_signal(SourceForm::default);
    let mut approved_revision = use_signal(|| None::<i64>);
    let mut observed_revision = use_signal(|| None::<i64>);
    let mut changing = use_signal(|| false);
    use_effect(move || {
        let revision = ui.data.read().as_ref().map(|d| d.mail.source_revision);
        if revision != *observed_revision.peek() {
            observed_revision.set(revision);
            let approved = form.peek().acknowledged;
            form.write().acknowledged = false;
            approved_revision.set(None);
            if approved {
                ui.notice
                    .set("The mail selection changed. Review your folders before saving.".into());
            }
        }
    });
    let Some(data) = (ui.data)() else {
        return rsx! {};
    };
    let selected = data.mail.source.is_some();
    let snapshot = form();
    let sources = (ui.sources)();
    let review_revision = data.mail.source_revision;
    rsx! {
        section { class: "tracker-setup", "aria-label": "Mail folder setup",
            h3 { "1. Choose local mail folders" }
            if selected && !changing() {
                p { class: "tracker-connected", "Inbox and Sent folders selected. Access is read-only." }
                div { class: "tracker-buttons",
                    button { disabled: (ui.busy)(), onclick: move |_| changing.set(true), "Change folders" }
                    button { disabled: (ui.busy)(), onclick: move |_| ui.remove_source(), "Remove mail access" }
                }
            } else if !data.mail.local_mail_supported {
                p { "Reading local mail is not available on this system yet." }
            } else {
                p { "Sign in to Thunderbird on the computer running Orkestr, and synchronize both Inbox and Sent mail for offline use." }
                p { "Only the folders you choose below will be read. Finish syncing before continuing." }
                button { disabled: (ui.busy)(), onclick: move |_| { form.set(SourceForm::default()); ui.discover(); }, "Find mail folders" }
                if sources.is_empty() {
                    p { class: "tracker-hint",
                        if (ui.discovered)() { "No Inbox/Sent folders were found. Check Thunderbird’s offline settings, then try again." }
                        else { "Use “Find mail folders” after Thunderbird has finished syncing." }
                    }
                }
                for source in sources {
                    {
                        let id=source.id.to_string(); let picked=snapshot.source_id.as_deref()==Some(id.as_str());
                        let name=if source.label.is_empty() { "Mail profile".to_owned() } else {source.label.clone()};
                        rsx! { div { class: "tracker-source",
                            label { class: "tracker-source-name",
                                input { r#type: "radio", name: "tracker-mail-profile", checked: picked,
                                    onchange: move |_| form.write().choose(id.clone()) }
                                "{name}"
                            }
                            if !source.ready { p { "Inbox or Sent mail was not found in this profile. Check Thunderbird’s offline settings and try again." } }
                            if picked {
                                div { class: "tracker-folder-columns",
                                    fieldset { legend { "Inbox" }
                                        for folder in source.inbox {
                                            { let id=folder.id.to_string(); let checked=snapshot.inbox.contains(&id);
                                                rsx! { label { input { r#type: "checkbox", checked, onchange: move |_| form.write().toggle(id.clone(),false) } "{folder.label}" } }
                                            }
                                        }
                                    }
                                    fieldset { legend { "Sent" }
                                        for folder in source.sent {
                                            { let id=folder.id.to_string(); let checked=snapshot.sent.contains(&id);
                                                rsx! { label { input { r#type: "checkbox", checked, onchange: move |_| form.write().toggle(id.clone(),true) } "{folder.label}" } }
                                            }
                                        }
                                    }
                                }
                            }
                        } }
                    }
                }
                if snapshot.source_id.is_some() {
                    label { class: "tracker-consent",
                        input { r#type: "checkbox", checked: snapshot.acknowledged,
                            onchange: move |event| {
                                form.write().acknowledged=event.checked();
                                approved_revision.set(event.checked().then_some(review_revision));
                            } }
                        "I have synced these Inbox and Sent folders locally and allow Orkestr to read them."
                    }
                    button { disabled: (ui.busy)(), onclick: move |_| {
                        let Some(revision)=*approved_revision.peek() else {ui.notice.set("Confirm local synchronization and read-only access.".into());return;};
                        let request=form.peek().selection("pending",revision);
                        match request {
                            Ok(request) => {
                                let mut body=json!(request); body.as_object_mut().unwrap().remove("request_key");
                                ui.start("selection",body); form.write().acknowledged=false; changing.set(false);
                            }
                            Err(message) => ui.notice.set(message.into()),
                        }
                    }, "Use these folders" }
                }
                if selected { button { onclick: move |_| changing.set(false), "Keep current selection" } }
            }
        }
    }
}
