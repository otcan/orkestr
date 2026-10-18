use orkestr_v2_domain::{ApplyResult, ConversationKind, Engine, Envelope, Event};

fn main() {
    let mut engine = Engine::new();
    let scenario = [
        Envelope {
            event_id: "event-001".into(),
            event: Event::ConversationCreated {
                id: "home".into(),
                kind: ConversationKind::Home,
                parent_id: None,
            },
        },
        Envelope {
            event_id: "event-002".into(),
            event: Event::ConversationCreated {
                id: "project-orkestr-v2".into(),
                kind: ConversationKind::Project,
                parent_id: Some("home".into()),
            },
        },
        Envelope {
            event_id: "event-003".into(),
            event: Event::TaskQueued {
                id: "prototype-domain".into(),
                conversation_id: "project-orkestr-v2".into(),
            },
        },
        Envelope {
            event_id: "event-004".into(),
            event: Event::TaskStarted {
                task_id: "prototype-domain".into(),
                worker_id: "demo-worker".into(),
            },
        },
        Envelope {
            event_id: "event-005".into(),
            event: Event::TaskCompleted {
                task_id: "prototype-domain".into(),
                worker_id: "demo-worker".into(),
                result_ref: "synthetic-result-001".into(),
            },
        },
    ];

    for event in scenario {
        assert_eq!(engine.apply(event), Ok(ApplyResult::Applied));
    }
    println!(
        "Orkestr v2 domain demo: {} conversations, {} tasks, {} events (in memory only).",
        engine.conversations().len(),
        engine.tasks().len(),
        engine.journal().len()
    );
}
