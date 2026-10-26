//! Capacity terminals are withheld for one retry decision; nothing else is.
use super::*;
use orkestr_v2_contracts::ExecutionFailureClass;
use serde_json::json;

fn active(request: u64) -> TurnStream {
    let mut stream = TurnStream::new("thread-owned", request).unwrap();
    stream
        .receive(
            &json!({"id":request,"result":{"turn":{"id":"turn-owned","status":"inProgress"}}})
                .to_string(),
        )
        .unwrap();
    stream.receive(&json!({"method":"turn/started","params":{"threadId":"thread-owned","turn":{"id":"turn-owned","status":"inProgress"}}}).to_string()).unwrap();
    stream
}
fn fail(stream: &mut TurnStream, turn: serde_json::Value) -> Result<(), Blocker> {
    stream.receive(
        &json!({"method":"turn/completed","params":{"threadId":"thread-owned","turn":turn}})
            .to_string(),
    )
}
fn drain(stream: &mut TurnStream) -> Vec<ProviderEvent> {
    std::iter::from_fn(|| stream.next_event()).collect()
}

#[test]
fn clean_capacity_terminal_is_held_then_released_as_provider_class() {
    let mut stream = active(4);
    assert_eq!(drain(&mut stream), vec![ProviderEvent::Started]);
    fail(
        &mut stream,
        json!({"id":"turn-owned","status":"failed",
        "error":{"class":"capacity"},"sideEffects":false}),
    )
    .unwrap();
    assert_eq!(stream.capacity_held(), Some(true));
    assert!(drain(&mut stream).is_empty(), "held from Core");
    stream.release_capacity_hold().unwrap();
    assert_eq!(
        drain(&mut stream),
        vec![ProviderEvent::FailedWith(ExecutionFailureClass::Provider)]
    );
    assert_eq!(stream.release_capacity_hold(), Err(Blocker::Protocol));
}

#[test]
fn side_effects_missing_evidence_or_a_question_make_the_hold_unclean() {
    for turn in [
        json!({"id":"turn-owned","status":"failed","error":{"class":"capacity"},"sideEffects":true}),
        json!({"id":"turn-owned","status":"failed","error":{"class":"capacity"}}),
    ] {
        let mut stream = active(4);
        fail(&mut stream, turn).unwrap();
        assert_eq!(stream.capacity_held(), Some(false));
        assert!(stream.fallback_retry(5).is_err());
    }
    let mut stream = active(4);
    stream.receive(&json!({"method":"item/completed","params":{"threadId":"thread-owned","turnId":"turn-owned",
        "item":{"id":"q","type":"agentMessage","text":"Which one?","phase":"commentary","delivery":"async"}}}).to_string()).unwrap();
    fail(
        &mut stream,
        json!({"id":"turn-owned","status":"failed",
        "error":{"class":"capacity"},"sideEffects":false}),
    )
    .unwrap();
    assert_eq!(stream.capacity_held(), Some(false));
}

#[test]
fn other_failures_are_unchanged_and_unknown_error_shapes_refuse() {
    let mut stream = active(4);
    fail(
        &mut stream,
        json!({"id":"turn-owned","status":"failed","sideEffects":false}),
    )
    .unwrap();
    assert_eq!(stream.capacity_held(), None);
    assert_eq!(
        drain(&mut stream),
        vec![ProviderEvent::Started, ProviderEvent::Failed]
    );
    for error in [
        json!({"class":"quota"}),
        json!("capacity"),
        json!({"class":"capacity","text":"x"}),
    ] {
        let mut stream = active(4);
        assert!(fail(
            &mut stream,
            json!({"id":"turn-owned","status":"failed","error":error})
        )
        .is_err());
    }
}

#[test]
fn fallback_stream_is_the_same_thread_and_never_repeats_started() {
    let mut stream = active(4);
    drain(&mut stream);
    fail(
        &mut stream,
        json!({"id":"turn-owned","status":"failed",
        "error":{"class":"capacity"},"sideEffects":false}),
    )
    .unwrap();
    assert!(stream.fallback_retry(4).is_err(), "request must advance");
    let mut retry = stream.fallback_retry(5).unwrap();
    assert_eq!(retry.request(), 5);
    retry
        .receive(
            &json!({"id":5,"result":{"turn":{"id":"turn-retry","status":"inProgress"}}})
                .to_string(),
        )
        .unwrap();
    retry.receive(&json!({"method":"turn/started","params":{"threadId":"thread-owned","turn":{"id":"turn-retry","status":"inProgress"}}}).to_string()).unwrap();
    retry.receive(&json!({"method":"item/completed","params":{"threadId":"thread-owned","turnId":"turn-retry",
        "item":{"id":"a","type":"agentMessage","text":"retried answer","phase":"final_answer"}}}).to_string()).unwrap();
    retry.receive(&json!({"method":"turn/completed","params":{"threadId":"thread-owned","turn":{"id":"turn-retry","status":"completed"}}}).to_string()).unwrap();
    assert_eq!(
        drain(&mut retry),
        vec![
            ProviderEvent::Progress("retried answer".into()),
            ProviderEvent::CompletedProposal { synthetic: false }
        ]
    );
    // A second capacity failure of the retry is held again; Runtime releases it.
    let mut again = stream.fallback_retry(5).unwrap();
    again
        .receive(
            &json!({"id":5,"result":{"turn":{"id":"turn-retry","status":"inProgress"}}})
                .to_string(),
        )
        .unwrap();
    fail(
        &mut again,
        json!({"id":"turn-retry","status":"failed",
        "error":{"class":"capacity"},"sideEffects":false}),
    )
    .unwrap();
    assert_eq!(again.capacity_held(), Some(true));
}

#[test]
fn stall_interrupt_only_for_a_silent_turn_and_its_interrupted_terminal_is_held() {
    let mut busy = active(4);
    busy.receive(&json!({"method":"turn/activity","params":{"threadId":"thread-owned","turnId":"turn-owned"}}).to_string()).unwrap();
    assert!(!busy.stalled_candidate());
    assert!(busy.claim_stall_interrupt(9).is_err());

    let mut stream = active(4);
    drain(&mut stream);
    assert!(stream.stalled_candidate());
    let frame = stream.claim_stall_interrupt(9).unwrap();
    assert_eq!(frame["method"], "turn/interrupt");
    assert!(stream.stall_reply_pending());
    stream
        .receive(&json!({"id":9,"result":{}}).to_string())
        .unwrap();
    assert!(!stream.stall_reply_pending());
    fail(
        &mut stream,
        json!({"id":"turn-owned","status":"interrupted","sideEffects":false}),
    )
    .unwrap();
    assert_eq!(stream.capacity_held(), Some(true));
    assert!(drain(&mut stream).is_empty(), "never a Core Stopped");
    assert!(stream.fallback_retry(5).is_ok());
    stream.release_capacity_hold().unwrap();
    assert_eq!(
        drain(&mut stream),
        vec![ProviderEvent::FailedWith(ExecutionFailureClass::Provider)]
    );
    // Without Runtime's stall interrupt, interrupted stays an ordinary Stop.
    let mut stopped = active(4);
    drain(&mut stopped);
    fail(
        &mut stopped,
        json!({"id":"turn-owned","status":"interrupted","sideEffects":false}),
    )
    .unwrap();
    assert_eq!(drain(&mut stopped), vec![ProviderEvent::Stopped]);
}

#[test]
fn a_committed_stop_releases_a_held_capacity_terminal_as_stopped() {
    let mut stream = active(4);
    drain(&mut stream);
    fail(
        &mut stream,
        json!({"id":"turn-owned","status":"failed",
        "error":{"class":"capacity"},"sideEffects":false}),
    )
    .unwrap();
    stream.adopt_stop().unwrap();
    assert_eq!(stream.capacity_held(), None);
    assert_eq!(drain(&mut stream), vec![ProviderEvent::Stopped]);
    // An adopted stall interrupt's `interrupted` terminal is Stopped, never held.
    let mut stream = active(4);
    drain(&mut stream);
    stream.claim_stall_interrupt(9).unwrap();
    stream.adopt_stop().unwrap();
    fail(
        &mut stream,
        json!({"id":"turn-owned","status":"interrupted","sideEffects":false}),
    )
    .unwrap();
    assert_eq!(stream.capacity_held(), None);
    assert_eq!(drain(&mut stream), vec![ProviderEvent::Stopped]);
}

#[test]
fn a_late_refused_stall_interrupt_is_harmless_when_a_terminal_follows() {
    let mut stream = active(4);
    drain(&mut stream);
    stream.claim_stall_interrupt(9).unwrap();
    // The native finished first: the terminal waits for the interrupt reply.
    stream.receive(&json!({"method":"item/completed","params":{"threadId":"thread-owned","turnId":"turn-owned",
        "item":{"id":"a","type":"agentMessage","text":"done","phase":"final_answer"}}}).to_string()).unwrap();
    stream.receive(&json!({"method":"turn/completed","params":{"threadId":"thread-owned","turn":{"id":"turn-owned","status":"completed"}}}).to_string()).unwrap();
    assert_eq!(
        drain(&mut stream),
        vec![ProviderEvent::Progress("done".into())]
    );
    assert!(
        stream.completed_continuation().is_err(),
        "reply still occupies the channel"
    );
    stream
        .receive(&json!({"id":9,"error":{"code":-32600}}).to_string())
        .unwrap();
    assert_eq!(
        drain(&mut stream),
        vec![ProviderEvent::CompletedProposal { synthetic: false }]
    );
    assert!(stream.completed_continuation().is_ok());
}
