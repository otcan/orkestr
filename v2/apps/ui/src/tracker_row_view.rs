use crate::tracker_controller::*;
use dioxus::prelude::*;
use orkestr_v2_contracts::{TrackerRow, TrackerRowEdit, TrackerStatus};
use serde_json::json;

#[component]
pub fn RowEditor(row: TrackerRow, onclose: EventHandler<()>) -> Element {
    let mut ui = use_context::<TrackerUi>();
    let original = row.clone();
    let mut draft = use_signal(move || row);
    let current = draft();
    rsx! {
        div {class:"tracker-dialog-backdrop",
            section {class:"tracker-row-editor",role:"dialog","aria-modal":"true","aria-label":"Edit application",
                onkeydown:move |event|{if event.key()==Key::Escape {onclose.call(());}},
                h3 {"Review application"}
                if !(ui.notice)().is_empty() {p {role:"status",{(ui.notice)()}}}
                label {"Company" input {value:current.company,maxlength:120,oninput:move |e|draft.write().company=e.value()}}
                label {"Role" input {value:current.role,maxlength:160,oninput:move |e|draft.write().role=e.value()}}
                label {"Status" select {value:current.status.as_str(),onchange:move |e|{if let Some(status)=TrackerStatus::parse(&e.value()){draft.write().status=status;}},
                    for status in TrackerStatus::ALL {option {value:status.as_str(),"{status.label()}"}}
                }}
                label {"Next step" input {value:current.next_step.clone().unwrap_or_default(),oninput:move |e|draft.write().next_step=Some(e.value())}}
                label {"Job link" input {r#type:"url",value:current.link.clone().unwrap_or_default(),oninput:move |e|draft.write().link=Some(e.value())}}
                label {"Notes" textarea {value:current.notes,maxlength:orkestr_v2_contracts::TRACKER_NOTES_MAX.to_string(),oninput:move |e|draft.write().notes=e.value()}}
                label {class:"tracker-consent",input {r#type:"checkbox",checked:current.needs_review,onchange:move |e|draft.write().needs_review=e.checked()},"Needs review"}
                label {class:"tracker-consent",input {r#type:"checkbox",checked:current.archived,onchange:move |e|draft.write().archived=e.checked()},"Archived"}
                p {class:"tracker-hint","Manual status changes are recorded in this application’s history. Open Thunderbird to review the original mail."}
                div {class:"tracker-buttons",
                    button {disabled:(ui.busy)(),onclick:move |_|{
                        let value=draft();
                        let edit=TrackerRowEdit {expected_revision:original.revision,company:Some(value.company),role:Some(value.role),status:Some(value.status),
                            next_step:Some(value.next_step.unwrap_or_default()),link:Some(value.link.unwrap_or_default()),notes:Some(value.notes),needs_review:Some(value.needs_review),archived:Some(value.archived)};
                        if !edit.is_valid(){ui.notice.set("Check the company, link and text fields.".into());return;}
                        ui.row_change(format!("/rows/{}",original.id),json!(edit),onclose);
                    },"Save changes"}
                    button {onclick:move |_|onclose.call(()),"Close"}
                }
            }
        }
    }
}
