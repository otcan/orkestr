use orkestr_v2_contracts::{V1Timer, V1WhatsAppOptions};
use orkestr_v2_ui::v1_manage::{options_update, schedule, TimerForm};

fn id(n: u8) -> String {
    format!("00000000-0000-4000-8000-0000000000{n:02x}")
}

#[test]
fn timer_form_creates_once_and_edits_existing() {
    let mut form = TimerForm {
        label: "Synthetic brief".into(),
        prompt: "Synthetic prompt".into(),
        ..Default::default()
    };
    let first = form.prepare(id(1)).unwrap();
    assert_eq!(
        (
            first.cadence.as_str(),
            first.time.as_deref(),
            first.every.clone()
        ),
        ("daily", Some("09:00"), None)
    );
    assert_eq!(
        form.prepare(id(2)).unwrap().client_request_id,
        id(1),
        "retry keeps the request"
    );
    let timer = V1Timer {
        id: "timer-1".into(),
        label: Some("Synthetic".into()),
        cadence: Some("interval".into()),
        time: None,
        every: Some("2h".into()),
        timezone: None,
        run_at: None,
        prompt: Some("p".into()),
        enabled: true,
        owned_by_v2: false,
        next_run_at: None,
        last_run_at: None,
        last_error: None,
    };
    assert_eq!(schedule(&timer), "Every 2h");
    let mut edit = TimerForm::edit(&timer);
    assert_eq!(edit.editing.as_deref(), Some("timer-1"));
    assert_eq!(edit.prepare(id(3)).unwrap().every.as_deref(), Some("2h"));
    let mut bad = TimerForm {
        label: "x".into(),
        prompt: " ".into(),
        ..Default::default()
    };
    assert!(bad.prepare(id(4)).is_err());
    assert!(bad.pending.is_none());
}

#[test]
fn whatsapp_participants_are_parsed_and_checked() {
    let options = V1WhatsAppOptions {
        thread_id: "t".into(),
        chat_id: Some("0@g.us".into()),
        display_name: None,
        enabled: true,
        reply_prefix: None,
        suppress_updates: true,
        suppress_debug_footer: false,
        additional_participants_enabled: true,
        additional_participant_ids: vec![],
        delegated: false,
    };
    let update = options_update(
        &options,
        " synthetic: ",
        "10000000001@c.us, 10000000001@c.us\n20000000002@lid",
    )
    .unwrap();
    assert_eq!(
        update.additional_participant_ids,
        vec!["10000000001@c.us", "20000000002@lid"]
    );
    assert_eq!(update.reply_prefix.as_deref(), Some("synthetic:"));
    assert!(options_update(&options, "", "nobody").is_err());
}
