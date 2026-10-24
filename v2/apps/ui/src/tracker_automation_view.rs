use crate::tracker_controller::*;
use dioxus::prelude::*;
use orkestr_v2_contracts::tracker_automation::TrackerAutomationEnable;
use orkestr_v2_ui::tracker_setup::AutomationForm;
use serde_json::json;

#[component]
pub fn MailChecks() -> Element {
    let mut ui = use_context::<TrackerUi>();
    let mut form = use_signal(move || {
        ui.data
            .peek()
            .as_ref()
            .map(|d| AutomationForm::from_status(&d.automation))
            .unwrap_or_default()
    });
    let mut reviewed = use_signal(|| None::<TrackerAutomationEnable>);
    let mut source_revision = use_signal(|| None);
    use_effect(move || {
        let next = ui.data.read().as_ref().map(|d| {
            (
                d.mail.source_revision,
                d.automation.revision,
                d.automation.timer_revision,
                d.mail.classifier_id.clone(),
                d.mail.classifier_digest.clone(),
            )
        });
        if next != *source_revision.peek() {
            source_revision.set(next);
            form.write().acknowledged = false;
            reviewed.set(None);
        }
    });
    use_future(move || async move {
        let value = document::eval("return Intl.DateTimeFormat().resolvedOptions().timeZone;")
            .join::<String>()
            .await;
        if !ui.session.read().is_current(ui.generation) {
            return;
        }
        let empty = form.peek().timezone.is_empty();
        if empty {
            if let Ok(zone) = value {
                form.write().timezone = zone;
            }
        }
    });
    let Some(data) = (ui.data)() else {
        return rsx! {};
    };
    let current = form();
    let review_before = data.automation.clone();
    let review_source = data.mail.source_revision;
    let review_classifier = (
        data.mail.classifier_id.clone(),
        data.mail.classifier_digest.clone(),
    );
    let preview = current
        .calendar()
        .map(|c| c.describe())
        .unwrap_or_else(str::to_owned);
    let active =
        !data.mail.checks.is_empty() || ui.pending.read().iter().any(|p| p.kind == "check");
    let pending = (ui.pending)();
    rsx! {
        section { class:"tracker-setup", "aria-label":"Mail checks",
            h3 {"2. Check mail"}
            p {"Check once whenever you choose. Updates appear here in the tracker."}
            if !data.mail.scheduler_ready { p {"The mail check service is not ready. Your saved table is still available."} }
            button {disabled:(ui.busy)() || active || !data.mail.scheduler_ready, onclick:move |_| ui.check_once(), "Check mail once"}
            for check in data.mail.checks.iter().filter(|c| !pending.iter().any(|p| p.key()==Some(c.request_key.as_str()))) {
                {let key=check.request_key.clone(); rsx!{div {class:"tracker-recovery-row",span {"A mail check is queued or in progress."} button {onclick:move |_|ui.stop_check(key.clone()),"Stop check"}}}}
            }
            if data.mail.reader.cancelled>0 {p {role:"status","A stopping mail read still holds reader capacity. New reads wait for it to finish."}}
            else if active && data.mail.reader.occupied>0 {p {role:"status","Mail reader capacity is in use. Your check result will appear here."}}
            for message in data.mail.alerts.iter().map(|(_,reason)| match reason.as_str() {
                "selected_mail_source_unavailable"=>"The selected mail folders are unavailable. Check Thunderbird’s offline settings or choose folders again.",
                "installed_recipe_or_rules_changed"=>"The mail rules changed. Review and confirm your recurring schedule again, or request a new check.",
                "source_or_timer_authority_changed"=>"The saved mail check settings changed. Refresh and review your selection.",
                "reader_wait_ended_custody_retained_until_exit" | "previous_reader_still_in_custody"=>"A previous read must finish before this check can continue. This check is still waiting.",
                _=>"The mail reader is busy or unavailable. This check remains queued and will retry.",
            }).collect::<std::collections::BTreeSet<_>>() {p {class:"tracker-hint",role:"status","{message}"}}
            if let Some(report)=data.reports.first() {
                if let Some(warnings)=&report.read_warnings {
                    if warnings.total()>0 {p {class:"tracker-hint","Some mail was skipped: {warnings.skipped_large} over the 4 MiB limit, {warnings.skipped_unsafe} unsafe entries, {warnings.skipped_missing} missing, {warnings.skipped_unsettled} still syncing."}}
                }
                if report.more_mail==Some(true) {p {class:"tracker-hint","More mail remains. Check again to continue, or choose recurring checks below."}}
                if report.news {
                    h4 {"Latest update"}
                    ul {for change in report.changes.iter().filter(|c|c.is_news()).take(10) {li {{change.line()}}}}
                } else {p {"Latest check: no new changes recorded."}}
            }
        }
        section {class:"tracker-setup", "aria-label":"Recurring mail checks",
            h3 {"3. Choose recurring checks (optional)"}
            if data.automation.enabled {
                p {class:"tracker-connected","Recurring checks are scheduled."}
                if let Some(calendar)=&data.automation.calendar {p {{calendar.describe()}}}
                button {onclick:move |_|ui.stop_automation(),"Stop recurring checks"}
            } else {p {"Recurring checks are off. Checking once does not turn them on."}}
            label {"Frequency"
                select {value:if current.frequent {"frequent"} else {"daily"},onchange:move |e|{let mut f=form.write();f.frequent=e.value()=="frequent";f.acknowledged=false;},
                    option {value:"daily","Once a day"} option {value:"frequent","Every 15 minutes"}
                }
            }
            if !current.frequent {label {"Time" input {r#type:"time",value:current.time,oninput:move |e|{let mut f=form.write();f.time=e.value();f.acknowledged=false;}}}}
            else {p {"Checks run every 15 minutes throughout the selected days."}}
            label {"Timezone" input {value:current.timezone,placeholder:"Europe/Berlin",oninput:move |e|{let mut f=form.write();f.timezone=e.value();f.acknowledged=false;}}}
            fieldset {class:"tracker-days",legend {"Days"}
                for (index,name) in ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].iter().enumerate() {
                    {let day=index as u8+1;let checked=current.weekdays.contains(&day);
                        rsx!{label {input {r#type:"checkbox",checked,onchange:move |_|{let mut f=form.write();if f.weekdays.contains(&day){f.weekdays.retain(|d|*d!=day);}else{f.weekdays.push(day);}f.acknowledged=false;}}"{name}"}}
                    }
                }
            }
            p {class:"tracker-schedule-preview","{preview}"}
            label {class:"tracker-consent",input {r#type:"checkbox",checked:current.acknowledged,onchange:move |e|{
                if !e.checked(){form.write().acknowledged=false;reviewed.set(None);return;}
                let mut chosen=form();chosen.acknowledged=true;
                match chosen.enable("pending",&review_before,review_source,(&review_classifier.0,&review_classifier.1)){
                    Ok(request)=>{reviewed.set(Some(request));form.write().acknowledged=true;}
                    Err(message)=>ui.notice.set(message.into()),
                }
            }},"Enable read-only mail checks with this schedule."}
            button {disabled:(ui.busy)() || !current.acknowledged || !data.mail.scheduler_ready,onclick:move |_|{
                if !form.peek().acknowledged{return;}
                let request=reviewed.peek().clone();
                match request {
                    Some(request)=>{let mut body=json!(request);body.as_object_mut().unwrap().remove("request_key");ui.start("automation_enable",body);form.write().acknowledged=false;reviewed.set(None);}
                    None=>ui.notice.set("Review the schedule and confirm recurring checks first.".into()),
                }
            },if data.automation.enabled {"Update recurring schedule"}else{"Enable recurring checks"}}
        }
    }
}
