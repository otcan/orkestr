use orkestr_v2_contracts::{
    ConversationId, ConversationProvider, WhatsAppChatProvision, WhatsAppChatStage,
};
use orkestr_v2_ui::whatsapp_chat::{self, ChatForm};

fn id(n: u8) -> String {
    format!("00000000-0000-4000-8000-0000000000{n:02x}")
}

#[test]
fn a_retry_continues_the_same_request() {
    let mut form = ChatForm {
        name: "  Synthetic chat ".into(),
        effort: "low".into(),
        ..Default::default()
    };
    let first = form.prepare(id(1)).unwrap();
    assert_eq!(
        (
            first.name.as_str(),
            first.reasoning_effort.as_deref(),
            first.model.clone()
        ),
        ("Synthetic chat", Some("low"), None)
    );
    form.name = "Edited".into();
    assert_eq!(form.prepare(id(2)).unwrap(), first);
    form.refused();
    assert_eq!(form.prepare(id(2)).unwrap().client_request_id, id(2));
}

#[test]
fn invalid_forms_are_not_sent() {
    let mut form = ChatForm {
        name: "Synthetic".into(),
        effort: "xhigh".into(),
        provider: ConversationProvider::Claude,
        ..Default::default()
    };
    assert!(form.prepare(id(1)).is_err());
    assert!(form.pending.is_none());
    form.effort.clear();
    form.workspace = "relative".into();
    assert!(form.prepare(id(1)).is_err());
    form.workspace = "/srv/synthetic".into();
    assert!(form.prepare(id(1)).is_ok());
    assert_eq!(ChatForm::default().efforts().len(), 8);
}

#[test]
fn statuses_explain_the_stage() {
    let mut provision = WhatsAppChatProvision {
        client_request_id: id(1),
        conversation_id: serde_json::from_value::<ConversationId>(serde_json::json!(id(5)))
            .unwrap(),
        name: "Synthetic".into(),
        v1_thread_id: "synthetic-thread".into(),
        remote_thread_id: id(2),
        workspace: None,
        chat_id: Some("1@g.us".into()),
        stage: WhatsAppChatStage::RelayPending,
        error: None,
        archived: false,
        created_at_ms: 1,
        updated_at_ms: 1,
    };
    assert!(whatsapp_chat::status(&provision).contains("registers the group"));
    provision.stage = WhatsAppChatStage::Group;
    provision.error = Some("adapter_binding_conflict".into());
    assert!(whatsapp_chat::status(&provision).contains("Retry continues"));
}
