//! A refusal keeps the manager's receipt; only an excluding receipt proves
//! that a window was never admitted. Pure parsing, no socket.
use super::*;

fn client() -> ManagerClient {
    let parent = process(std::process::id()).unwrap().0;
    ManagerClient::new(
        PathBuf::from("/unused-synthetic.sock"),
        OwnerId(Uuid::from_u128(1)),
        ConversationId(Uuid::from_u128(2)),
        parent,
    )
    .unwrap()
}

/// The manager's latest window for the conversation (generation 1).
fn latest(state: &str) -> Value {
    let (reason, outcome) = if state == "retired" {
        (json!("runtime_refused"), json!("failed"))
    } else {
        (Value::Null, Value::Null)
    };
    json!({"owner_id":Uuid::from_u128(1),"conversation_id":Uuid::from_u128(2),
        "window_id":Uuid::from_u128(31),"generation":1,"state":state,"attempts":0,
        "reserved_bytes":0,"boot_id":Uuid::from_u128(4),"opened_at_ms":1000,
        "work_deadline_ms":871000,"expires_at_ms":901000,"limits":ExecutionWindowLimits::default(),
        "reason":reason,"outcome":outcome,"run_id":null,"terminal_event_id":null})
}

fn idle() -> Value {
    json!({"owner_id":Uuid::from_u128(1),"conversation_id":Uuid::from_u128(2),
        "window_id":null,"generation":0,"state":"idle"})
}

/// The refused opening: generation 2, after the manager's generation 1.
fn opening() -> Window {
    Window {
        window_id: Uuid::from_u128(32),
        generation: 2,
    }
}

#[test]
fn a_refusal_keeps_its_receipt_and_closed_code() {
    let client = client();
    let answer = json!({"ok":false,"code":"control_refused","receipt":latest("retired"),
        "reason":"input_reused"});
    let refusal = client.refusal(&answer).unwrap().unwrap();
    assert_eq!(refusal.reason.as_deref(), Some("input_reused"));
    assert!(refusal.receipt.never_admitted(&opening()));
    // A manager that sends no code: the receipt alone.
    let answer = json!({"ok":false,"code":"control_refused","receipt":latest("retired")});
    let refusal = client.refusal(&answer).unwrap().unwrap();
    assert_eq!(refusal.reason, None);
    // A malformed code is dropped, never a protocol error: it is diagnostic.
    for reason in [
        json!("Input Reused"),
        json!(""),
        json!("x".repeat(65)),
        json!("input-reused"),
        json!(7),
        Value::Null,
    ] {
        let answer = json!({"ok":false,"code":"control_refused","receipt":latest("retired"),
            "reason":reason});
        let refusal = client.refusal(&answer).unwrap().unwrap();
        assert_eq!(refusal.reason, None, "{reason}");
    }
}

#[test]
fn only_known_failure_shapes_parse() {
    let client = client();
    assert!(client
        .refusal(&json!({"ok":false,"code":"control_unavailable"}))
        .unwrap()
        .is_none());
    for answer in [
        json!({"ok":false,"code":"control_unavailable","receipt":latest("retired")}),
        json!({"ok":false,"code":"control_refused"}),
        json!({"ok":false,"code":"control_refused","receipt":latest("retired"),"reason":"a","extra":1}),
        json!({"ok":false,"code":"refused_elsewhere","receipt":latest("retired")}),
        json!({"ok":false,"code":"control_refused","receipt":{"state":"retired"}}),
    ] {
        assert!(
            matches!(client.refusal(&answer), Err(ManagerError::Protocol)),
            "{answer}"
        );
    }
}

#[test]
fn only_an_excluding_receipt_proves_the_window_was_never_admitted() {
    let client = client();
    let none = client.receipt(&idle()).unwrap();
    let retired = client.receipt(&latest("retired")).unwrap();
    assert!(none.never_admitted(&opening()));
    assert!(retired.never_admitted(&opening()));
    // The manager's latest window is this one, a later one, or still holds
    // custody (an admission may have committed): nothing is proven.
    let same = Window {
        window_id: Uuid::from_u128(31),
        generation: 1,
    };
    let earlier = Window {
        window_id: Uuid::from_u128(30),
        generation: 1,
    };
    assert!(!retired.never_admitted(&same));
    assert!(!retired.never_admitted(&earlier));
    for state in ["active", "draining", "expired", "reconciliation"] {
        let receipt = client.receipt(&latest(state)).unwrap();
        assert!(!receipt.never_admitted(&opening()), "{state}");
    }
    let refused = |receipt: Value| RefusedAdmission {
        window: opening(),
        refusal: Refusal {
            receipt: client.receipt(&receipt).unwrap(),
            reason: Some("input_reused".into()),
        },
    };
    assert!(refused(latest("retired")).is_definite());
    assert!(!refused(latest("reconciliation")).is_definite());
}

#[test]
fn only_a_code_about_the_request_itself_is_definite() {
    // Review of 2026-11-28: `window_capacity` clears by itself. Failing the
    // open at once would spend a timer firing's one retry while the manager
    // is still full, so it keeps the uncertain path like any passing cause.
    let client = client();
    let refused = |reason: Option<&str>| RefusedAdmission {
        window: opening(),
        refusal: Refusal {
            receipt: client.receipt(&latest("retired")).unwrap(),
            reason: reason.map(str::to_owned),
        },
    };
    for code in [
        "input_reused",
        "idempotency_conflict",
        "window_generation",
        "window_predecessor",
    ] {
        assert!(refused(Some(code)).is_definite(), "{code}");
    }
    for code in [
        "window_capacity",
        "package_inventory",
        "manager_custody_fault",
        "qualification_changed",
        "window_deadlines",
        "window_reused",
        "scope",
        "a_future_code",
    ] {
        assert!(!refused(Some(code)).is_definite(), "{code}");
    }
    // An older manager sends no code: nothing is proven.
    assert!(!refused(None).is_definite());
    // A definite code with a receipt that does not exclude the window.
    let live = RefusedAdmission {
        window: opening(),
        refusal: Refusal {
            receipt: client.receipt(&latest("active")).unwrap(),
            reason: Some("input_reused".into()),
        },
    };
    assert!(!live.is_definite());
}
