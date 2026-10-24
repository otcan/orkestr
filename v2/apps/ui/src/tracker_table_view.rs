use crate::tracker_controller::*;
use dioxus::prelude::*;
use orkestr_v2_contracts::TrackerRow;
use orkestr_v2_ui::tracker_table::{self as table, Column, Filter, Sort};
use serde_json::json;

#[component]
pub fn TrackerTable() -> Element {
    let ui = use_context::<TrackerUi>();
    let mut filter = use_signal(|| Filter::Open);
    let mut query = use_signal(String::new);
    let mut sort = use_signal(Sort::default);
    let mut page = use_signal(|| 0usize);
    let mut editing = use_signal(|| None::<TrackerRow>);
    let mut keep = use_signal(String::new);
    let mut absorb = use_signal(String::new);
    let Some(data) = (ui.data)() else {
        return rsx! {};
    };
    let rows = table::visible(&data.page.rows, filter(), &query(), sort());
    let total = rows.len();
    let last = total.saturating_sub(1) / 100;
    let shown_page = page().min(last);
    let rows: Vec<_> = rows.into_iter().skip(shown_page * 100).take(100).collect();
    let can_merge = keep() != absorb()
        && data.page.rows.iter().any(|r| r.id.to_string() == keep())
        && data.page.rows.iter().any(|r| r.id.to_string() == absorb());
    let csv = format!("{}/export.csv?delimiter=comma", ui.base());
    rsx! {
        section {class:"tracker-ledger", "aria-label":"Applications table",
            div {class:"tracker-heading",h3 {"Your applications"} a {href:csv,download:"job-tracker.csv","Download CSV"}}
            if data.page.backlog.pending>0 {p {class:"tracker-hint","Some mail could not be linked to an application. Review the original messages in Thunderbird."}}
            if data.page.backlog.overflow>0 {p {class:"tracker-hint","Some mail was not added because the review queue reached its limit."}}
            div {class:"tracker-filters",for choice in Filter::ALL {
                button {class:if filter()==choice {"selected"}else{""},onclick:move |_|{filter.set(choice);page.set(0);},"{choice.label()} ({table::count(&data.page.rows,choice)})"}
            }}
            label {class:"tracker-search","Search applications" input {r#type:"search",value:query(),oninput:move |e|{query.set(e.value());page.set(0);},placeholder:"Company, role, notes or next step"}}
            if rows.is_empty() {p {class:"tracker-empty","No applications match this view. Choose another filter, or check your selected mail folders."}}
            else {
                div {class:"tracker-table-scroll",table {class:"tracker-table",
                    thead {tr {for column in Column::ALL {th {button {onclick:move |_|{sort.set(sort().toggle(column));page.set(0);},"{column.label()}"}}} th {"Actions"}}}
                    tbody {for row in rows {
                        {let item=row.clone();let applied=row.applied_ms.map(table::day).unwrap_or_else(||"—".into());let contact=table::day(row.last_contact_ms);
                            rsx!{tr {key:"{row.id}",
                                td {"{row.company}" if row.needs_review {span {class:"tracker-review"," Needs review"}}}
                                td {"{row.role}"}td {"{row.status.label()}"}td {"{row.source}"}td {"{applied}"}td {"{contact}"}
                                td {if let Some(step)=&row.next_step {"{step}"}}
                                td {button {onclick:move |_|editing.set(Some(item.clone())),"Review / edit"}
                                    if let Some(link)=&row.link {a {href:link.clone(),target:"_blank",rel:"noopener noreferrer","Open job"}}
                                }
                            }}
                        }
                    }}
                }}
                p {class:"tracker-hint","Dates are shown in UTC. Manual edits and mail updates are kept in the application history."}
                if total>100 {div {class:"tracker-buttons",button {disabled:shown_page==0,onclick:move |_|page.set(shown_page.saturating_sub(1)),"Previous"}
                    span {"Page {shown_page+1} of {last+1}"}
                    button {disabled:shown_page==last,onclick:move |_|page.set(shown_page+1),"Next"}
                }}
            }
            if data.page.rows.len()>1 {
                details {class:"tracker-merge",summary {"Merge duplicate entries"}
                    p {"Choose the entry to keep and the duplicate to merge into it. Both histories are preserved."}
                    label {"Keep" select {value:keep(),onchange:move |e|keep.set(e.value()),option {value:"","Choose an entry"}
                        for row in &data.page.rows {option {value:row.id.to_string(),"{row.company} — {row.role}"}}
                    }}
                    label {"Merge from" select {value:absorb(),onchange:move |e|absorb.set(e.value()),option {value:"","Choose the duplicate"}
                        for row in &data.page.rows {option {value:row.id.to_string(),"{row.company} — {row.role}"}}
                    }}
                    button {disabled:!can_merge || (ui.busy)(),onclick:move |_|{
                        let body=json!({"keep":keep(),"absorb":absorb()});
                        ui.row_change("/merge".into(),body,EventHandler::new(move |_|{absorb.set(String::new());}));
                    },"Merge selected entries"}
                }
            }
            if let Some(row)=editing() {
                crate::tracker_row_view::RowEditor {key:"{row.id}-{row.revision}",row,onclose:move |_|editing.set(None)}
            }
        }
    }
}
