use orkestr_runtime::{
    codex_rpc::TurnStream,
    ports::{Blocker, ProviderEvent},
};
use serde_json::json;
fn response() -> String {
    json!({"id":4,"result":{"turn":{"id":"turn-a","status":"inProgress"}}}).to_string()
}
fn notification(method: &str, status: &str) -> String {
    json!({"method":method,"params":{"threadId":"thread-a","turn":{"id":"turn-a","status":status}}})
        .to_string()
}
#[test]
fn notifications_before_response_are_held_and_completion_is_only_a_proposal() {
    let mut stream = TurnStream::new("thread-a", 4).unwrap();
    stream
        .receive(&notification("turn/started", "inProgress"))
        .unwrap();
    stream
        .receive(&notification("turn/completed", "completed"))
        .unwrap();
    assert_eq!(stream.next_event(), None);
    stream.receive(&response()).unwrap();
    assert_eq!(stream.next_event(), Some(ProviderEvent::Started));
    assert_eq!(
        stream.next_event(),
        Some(ProviderEvent::CompletedProposal { synthetic: false })
    );
    assert_eq!(stream.next_event(), None);
    stream.finish().unwrap();
    stream
        .receive(&notification("turn/completed", "completed"))
        .unwrap();
    assert_eq!(stream.next_event(), None);
    assert_eq!(
        stream.receive(&notification("turn/completed", "interrupted")),
        Err(Blocker::Protocol)
    );
    assert_eq!(
        stream.terminal(),
        Some(&ProviderEvent::CompletedProposal { synthetic: false })
    );
}
#[test]
fn response_is_not_started_and_eof_is_not_success() {
    let mut stream = TurnStream::new("thread-a", 4).unwrap();
    stream.receive(&response()).unwrap();
    assert_eq!(stream.next_event(), None);
    assert_eq!(stream.finish(), Err(Blocker::Protocol));
    assert_eq!(
        stream.receive(&notification("turn/started", "inProgress")),
        Err(Blocker::Protocol)
    );
}
#[test]
fn foreign_request_thread_turn_and_server_requests_fail_closed() {
    for bad in [
        json!({"id":5,"result":{"turn":{"id":"turn-a","status":"inProgress"}}}),
        json!({"id":4,"method":"item/commandExecution/requestApproval","params":{}}),
        json!({"method":"turn/started","params":{"threadId":"foreign","turn":{"id":"turn-a","status":"inProgress"}}}),
    ] {
        let mut stream = TurnStream::new("thread-a", 4).unwrap();
        assert!(stream.receive(&bad.to_string()).is_err());
        assert_eq!(stream.receive(&response()), Err(Blocker::Protocol));
    }
    let mut stream = TurnStream::new("thread-a", 4).unwrap();
    stream
        .receive(&notification("turn/started", "inProgress"))
        .unwrap();
    assert_eq!(
        stream.receive(r#"{"id":4,"result":{"turn":{"id":"foreign","status":"inProgress"}}}"#),
        Err(Blocker::StaleLease)
    );
}
#[test]
fn progress_and_pre_ack_buffer_are_bounded() {
    let mut stream = TurnStream::new("thread-a", 4).unwrap();
    stream.receive(&response()).unwrap();
    let delta = |text: &str| {
        json!({"method":"item/agentMessage/delta","params":{"threadId":"thread-a","turnId":"turn-a","delta":text}}).to_string()
    };
    stream.receive(&delta("bounded output")).unwrap();
    assert_eq!(
        stream.next_event(),
        Some(ProviderEvent::Progress("bounded output".into()))
    );
    assert_eq!(
        stream.receive(&delta(&"x".repeat(8193))),
        Err(Blocker::Protocol)
    );
    let mut stream = TurnStream::new("thread-a", 4).unwrap();
    for _ in 0..4 {
        stream.receive(&delta("x")).unwrap();
    }
    assert_eq!(stream.receive(&delta("x")), Err(Blocker::QueueFull));
    assert_eq!(stream.receive(&response()), Err(Blocker::Protocol));
}
#[test]
fn failed_correlated_request_is_failed_without_fabricated_started() {
    let mut stream = TurnStream::new("thread-a", 4).unwrap();
    stream
        .receive(r#"{"id":4,"error":{"code":-32000,"message":"synthetic refusal"}}"#)
        .unwrap();
    assert_eq!(stream.next_event(), Some(ProviderEvent::Failed));
    assert_eq!(stream.next_event(), None);
    stream.finish().unwrap();
}

#[test]
fn malformed_error_is_not_terminal_evidence() {
    for error in [
        serde_json::json!(null),
        serde_json::json!({"code":"bad","message":"x"}),
        serde_json::json!({"code":-1}),
        serde_json::json!({"code":-1,"message":false}),
    ] {
        let mut stream = TurnStream::new("thread-a", 4).unwrap();
        assert_eq!(
            stream.receive(&serde_json::json!({"id":4,"error":error}).to_string()),
            Err(Blocker::Protocol)
        );
        assert!(stream.next_event().is_none());
        assert!(stream.terminal().is_none());
    }
}
