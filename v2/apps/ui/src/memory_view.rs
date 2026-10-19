use dioxus::prelude::*;
use orkestr_v2_contracts::*;
use orkestr_v2_ui::{
    memory_client::{self, MemoryRoute},
    memory_state::MemoryState,
    session_scope::SessionScope,
};
use serde::Deserialize;
use serde_json::json;
use std::{cell::Cell, rc::Rc};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Records {
    records: Vec<MemoryRecord>,
}
#[derive(Clone)]
enum Action {
    Load,
    Toggle(bool),
    Query,
    Propose(Option<Box<MemoryRecord>>, bool),
    Decide(MemoryConsentAction),
    Export,
}

#[component]
pub fn MemoryView(
    csrf: String,
    project: Option<ProjectId>,
    session_scope: Signal<SessionScope>,
    onexpired: EventHandler<()>,
) -> Element {
    let mut state = use_signal(MemoryState::default);
    let mut owner = use_signal(|| None::<OwnerId>);
    let mut records = use_signal(Vec::<MemoryRecord>::new);
    let mut reviewed = use_signal(|| None::<MemoryProposal>);
    let mut text = use_signal(String::new);
    let mut query = use_signal(String::new);
    let mut notice = use_signal(|| "Checking Memory settings…".to_string());
    let mut busy = use_signal(|| false);
    let mut uncertain = use_signal(|| false);
    let channel = use_signal(|| None::<document::Eval>);
    let active = use_hook(|| Rc::new(Cell::new(true)));
    let dropped = active.clone();
    use_drop(move || {
        dropped.set(false);
        state.write().retire();
        if let Some(eval) = channel.read().as_ref() {
            let _ = eval.send(json!({"stop":true}));
        }
    });
    let selected = project.clone();
    use_hook(move || state.write().select(selected));
    let submit = Callback::new(move |action: Action| {
        if busy() {
            return;
        }
        let active = active.clone();
        let csrf = csrf.clone();
        let project = project.clone();
        let session = session_scope.read().generation();
        let generation = state.read().generation();
        busy.set(true);
        spawn(async move {
            let result=async {
                let (route,method,body)=match &action {
                    Action::Load=>(MemoryRoute::Settings,"GET",None),
                    Action::Toggle(enabled)=>(MemoryRoute::Settings,"PUT",Some(memory_client::body(&json!({"enabled":enabled}))?)),
                    Action::Query=>(MemoryRoute::Query,"POST",Some(memory_client::body(&MemoryQuery{project_id:project.clone(),query:query(),limit:50})?)),
                    Action::Export=>(MemoryRoute::Export,"GET",None),
                    Action::Decide(choice)=>{let request=state.write().confirm(*choice)?;uncertain.set(true);(MemoryRoute::Decisions,"POST",Some(memory_client::body(&request)?))},
                    Action::Propose(record,forget)=>{
                        let operation=if let Some(record)=record {
                            if *forget {MemoryOperation::Forget{memory_id:record.memory_id,expected_revision:record.revision}}
                            else {let mut candidate=record.candidate.clone();candidate.content=MemoryContent::Fact{statement:text()};MemoryOperation::Correct{memory_id:record.memory_id,expected_revision:record.revision,candidate}}
                        } else {
                            MemoryOperation::Create{candidate:MemoryCandidate{scope:project.clone().map(|project_id|MemoryScope::Project{project_id}).unwrap_or(MemoryScope::Owner),content:MemoryContent::Fact{statement:text()},source:MemorySource{kind:MemorySourceKind::Owner,actor_id:owner().ok_or("Refresh Memory settings first.")?.to_string(),origin:"owner_memory_editor".into(),captured_at_ms:0,task_id:None,event_id:None,cursor:None}}}
                        };
                        let key=crate::transport::key().await.map_err(|_|"Could not prepare Memory review.")?;
                        (MemoryRoute::Proposals,"POST",Some(memory_client::body(&json!({"request_key":key,"operation":operation}))?))
                    }
                };
                if !active.get()||!session_scope.read().is_current(session){return Ok(());}
                let (status,raw)=crate::memory_transport::request(route,method,body,&csrf,channel).await?;
                if !active.get()||!session_scope.read().is_current(session)||generation!=state.read().generation(){return Ok(());}
                if status==401 {state.write().retire();records.set(vec![]);reviewed.set(None);onexpired.call(());return Ok(());}
                if !(200..300).contains(&status) {
                    if matches!(action,Action::Decide(_)) {uncertain.set(status==0||status>=500);if status!=0&&status<500{state.write().resolved(generation);reviewed.set(None);}}
                    return Err(match status {409=>"Memory changed or is disabled. Refresh settings and review again.",403=>"Memory change refused. Refresh your session.",422=>"Memory limit reached. Narrow the request.",0=>"Request not confirmed. Retry the original decision before editing.",_=>"Memory is unavailable. Refresh before trying again."}.into());
                }
                match action {
                    Action::Load=>{let settings:MemorySettings=memory_client::decode(route,&raw)?;let enabled=settings.enabled;let id=settings.owner_id.clone();if state.write().settings(generation,settings){owner.set(Some(id));if !enabled{records.set(vec![]);reviewed.set(None);uncertain.set(false);}notice.set(if enabled{"Memory is on. Save only what you explicitly review."}else{"Memory is off. Nothing is saved here without your permission."}.into());}},
                    Action::Toggle(_)=>{state.write().retire();state.write().select(project.clone());owner.set(None);records.set(vec![]);reviewed.set(None);uncertain.set(false);notice.set("Setting updated. Refresh settings to continue.".into());},
                    Action::Query|Action::Export=>{let result:Records=memory_client::decode(route,&raw)?;if result.records.iter().any(|r|Some(&r.owner_id)!=owner.read().as_ref()){return Err("Memory owner changed. Refresh settings.".into());}
                    if matches!(action,Action::Export){crate::memory_transport::export_file(&raw).await?;notice.set("Export offered as memory-export.json. Check your browser downloads.".into());}else{records.set(result.records);notice.set("Current saved memories loaded (up to 50).".into());}},
                    Action::Propose(_,_)=>{let proposal:MemoryProposal=memory_client::decode(route,&raw)?;if state.write().review(generation,proposal.clone()){reviewed.set(Some(proposal));notice.set("Review the normalized change below. It is not saved yet.".into());}else{return Err("Review expired. Refresh and try again.".into());}},
                    Action::Decide(_)=>{let _:MemoryReceipt=memory_client::decode(route,&raw)?;state.write().resolved(generation);reviewed.set(None);records.set(vec![]);uncertain.set(false);notice.set("Decision recorded. Retrieve again to see current saved memories.".into());}
                }
                Ok::<(),String>(())
            }.await;
            if active.get() && session_scope.read().is_current(session) {
                if let Err(error) = result {
                    notice.set(error);
                }
                busy.set(false);
            }
        });
    });
    use_future(move || async move {
        submit.call(Action::Load);
    });
    let enabled = state.read().enabled() == Some(true);
    rsx! {section {"aria-label":"Memory",
        h2 {"Memory"} p {"Optional saved facts for your own use. Enabling Memory does not automatically save conversations."}
        p {role:"status","{notice}"}
        button {disabled:busy(),onclick:move |_|submit.call(Action::Load),"Refresh settings"}
        if state.read().enabled().is_some(){button {disabled:busy()||uncertain(),onclick:move |_|submit.call(Action::Toggle(!enabled)),if enabled{"Turn Memory off"}else{"Enable Memory"}}}
        if enabled {
            label {r#for:"memory-search","Find saved memories"} input {id:"memory-search",value:"{query}",oninput:move |e|query.set(e.value())}
            button {disabled:busy()||uncertain(),onclick:move |_|submit.call(Action::Query),"Retrieve memories"}
            button {disabled:busy()||uncertain(),onclick:move |_|submit.call(Action::Export),"Export Memory as a separate file"}
            label {r#for:"memory-editor","Fact to remember or replacement text"}
            textarea {id:"memory-editor",value:"{text}",disabled:busy()||uncertain(),oninput:move |e|{if state.write().edit().is_ok(){text.set(e.value());reviewed.set(None);}}}
            button {disabled:busy()||uncertain()||text().trim().is_empty(),onclick:move |_|submit.call(Action::Propose(None,false)),"Review new memory"}
            for record in records() {
                article {key:"{record.memory_id}",p {"{content_label(&record.candidate.content)}"}
                    button {disabled:busy()||uncertain()||text().trim().is_empty(),onclick:{let r=record.clone();move |_|submit.call(Action::Propose(Some(Box::new(r.clone())),false))},"Review correction using replacement text"}
                    button {disabled:busy()||uncertain(),onclick:move |_|submit.call(Action::Propose(Some(Box::new(record.clone())),true)),"Review forgetting this memory"}
                }
            }
            if let Some(proposal)=reviewed() {
                MemoryReview {proposal,busy:busy(),uncertain:uncertain(),onconfirm:move |action|submit.call(Action::Decide(action))}

            }
        }
    }}
}

#[component]
fn MemoryReview(
    proposal: MemoryProposal,
    busy: bool,
    uncertain: bool,
    onconfirm: EventHandler<MemoryConsentAction>,
) -> Element {
    let action = match proposal.operation {
        MemoryOperation::Create { .. } => MemoryConsentAction::Remember,
        MemoryOperation::Correct { .. } => MemoryConsentAction::Correct,
        MemoryOperation::Forget { .. } => MemoryConsentAction::Forget,
    };
    let label = if uncertain {
        "Retry original decision"
    } else {
        "Confirm this Memory change"
    };
    rsx! {section {"aria-label":"Review Memory change",h3 {"Review before saving"}
        p {"{review_label(&proposal.operation)}"}
        details {summary {"Review details"} pre {"{serde_json::to_string_pretty(&proposal.operation).unwrap_or_default()}"}}
        button {disabled:busy,onclick:move |_|onconfirm.call(action),"{label}"}
    }}
}

fn content_label(content: &MemoryContent) -> String {
    match content {
        MemoryContent::Preference { key, value } => format!("{key}: {value}"),
        MemoryContent::Fact { statement } => statement.clone(),
        MemoryContent::Decision { summary, .. }
        | MemoryContent::Commitment { summary, .. }
        | MemoryContent::OpenLoop { summary, .. }
        | MemoryContent::ProjectSummary { summary } => summary.clone(),
    }
}
fn review_label(operation: &MemoryOperation) -> String {
    match operation {
        MemoryOperation::Create { candidate } => {
            format!("Remember: {}", content_label(&candidate.content))
        }
        MemoryOperation::Correct { candidate, .. } => format!(
            "Replace saved memory with: {}",
            content_label(&candidate.content)
        ),
        MemoryOperation::Forget { .. } => {
            "Forget this saved memory. Refresh retrieval after confirmation.".into()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn screen() -> Element {
        let session_scope = use_signal(SessionScope::default);
        rsx! { MemoryView { csrf:"synthetic".to_string(), project:None, session_scope, onexpired:move |_|{} } }
    }
    #[test]
    fn memory_screen_builds_before_settings_without_consent_or_records() {
        let mut dom = VirtualDom::new(screen);
        let mutations = dom.rebuild_to_vec();
        assert!(!mutations.edits.is_empty());
    }
    fn review_screen() -> Element {
        let proposal:MemoryProposal=serde_json::from_value(json!({"schema_version":1,"request_key":"synthetic","operation":{"operation":"forget","memory_id":"00000000-0000-4000-8000-000000000002","expected_revision":9007199254740993_u64},"digest":"a".repeat(64)})).unwrap();
        rsx! {MemoryReview {proposal,busy:false,uncertain:true,onconfirm:move |_|{}}}
    }
    #[test]
    fn normalized_review_renders_explicit_retry_and_exact_revision() {
        let mut dom = VirtualDom::new(review_screen);
        let rendered = format!("{:?}", dom.rebuild_to_vec().edits);
        assert!(rendered.contains("Retry original decision"));
        assert!(rendered.contains("Forget this saved memory"));
        assert!(rendered.contains("9007199254740993"));
    }
}
