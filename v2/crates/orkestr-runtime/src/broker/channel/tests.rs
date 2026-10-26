use super::*;
fn channel() -> BrokerChannel {
    OwnedMetadataHandle {
        _handle: "synthetic_owned".into(),
        lineage: Some(std::sync::Arc::new(())),
    }
    .into_channel()
}
#[test]
fn native_model_metadata_crosses_owned_channel_without_claiming_a_turn() {
    for acknowledged in [false, true] {
        let mut c = channel();
        c.bind_tool_native(Some("native".into()));
        c.reserve_execution(7).unwrap();
        if acknowledged {
            c.receive(
                json!({"id":2,"result":{"owned_handle":"synthetic_owned","frame":{
                "id":7,"result":{"turn":{"id":"turn","status":"inProgress"}}}}})
                .to_string()
                .as_bytes(),
            )
            .unwrap();
        }
        let old_pending = c.pending;
        let frame = json!({"method":"model/observed","params":{
            "threadId":"native","requestId":7,"model":"native-confirmed"}});
        let envelope = json!({"method":"BrokerOutput","params":{
            "owned_handle":"synthetic_owned","frame":frame}});
        assert_eq!(
            c.receive(envelope.to_string().as_bytes()).unwrap(),
            Some(frame)
        );
        assert_eq!(c.pending, old_pending);
        assert_eq!(c.active_turn.as_deref(), acknowledged.then_some("turn"));
        assert!(!c.terminal_observed);
        assert!(c.reserve_continuation(8).is_err());
    }
}
#[test]
fn foreign_request_or_late_model_metadata_cannot_change_channel_state() {
    for (key, value) in [("threadId", json!("foreign")), ("requestId", json!(8))] {
        let mut c = channel();
        c.bind_tool_native(Some("native".into()));
        c.reserve_execution(7).unwrap();
        let mut frame = json!({"method":"model/observed","params":{
            "threadId":"native","requestId":7,"model":"native-confirmed"}});
        frame["params"][key] = value;
        let envelope = json!({"method":"BrokerOutput","params":{
            "owned_handle":"synthetic_owned","frame":frame}});
        assert!(c
            .receive(envelope.to_string().as_bytes())
            .unwrap()
            .is_none());
        assert!(c.active_turn.is_none() && !c.terminal_observed);
    }
    for cancelled in [false, true] {
        let mut c = channel();
        c.bind_tool_native(Some("native".into()));
        c.reserve_execution(7).unwrap();
        c.cancellation_pending = cancelled;
        c.terminal_observed = !cancelled;
        let frame = json!({"method":"BrokerOutput","params":{"owned_handle":"synthetic_owned",
            "frame":{"method":"model/observed","params":{"threadId":"native",
                "requestId":7,"model":"native-confirmed"}}}});
        assert!(c.receive(frame.to_string().as_bytes()).unwrap().is_none());
        assert!(c.active_turn.is_none());
    }
}
#[test]
fn rerouted_model_preserves_owned_turn_fences_without_terminal_authority() {
    let mut c = channel();
    c.reserve_execution(7).unwrap();
    c.receive(
        json!({"id":2,"result":{"owned_handle":"synthetic_owned","frame":{
        "id":7,"result":{"turn":{"id":"turn","status":"inProgress"}}}}})
        .to_string()
        .as_bytes(),
    )
    .unwrap();
    let mut envelope = json!({"method":"BrokerOutput","params":{"owned_handle":"synthetic_owned",
        "frame":{"method":"model/rerouted","params":{"threadId":"native","turnId":"turn",
            "toModel":"native-rerouted"}}}});
    assert!(c
        .receive(envelope.to_string().as_bytes())
        .unwrap()
        .is_some());
    assert!(!c.terminal_observed);
    envelope["params"]["frame"]["params"]["turnId"] = json!("foreign");
    assert!(c.receive(envelope.to_string().as_bytes()).is_err());
}
#[test]
fn agent_item_boundaries_preserve_original_handle_and_turn_fences() {
    for method in ["item/started", "item/completed"] {
        let mut c = channel();
        c.reserve_execution(7).unwrap();
        c.receive(json!({"id":2,"result":{"owned_handle":"synthetic_owned","frame":{"id":7,"result":{"turn":{"id":"turn","status":"inProgress"}}}}}).to_string().as_bytes()).unwrap();
        let frame = json!({"method":method,"params":{"threadId":"native","turnId":"turn",
            "item":{"type":"agentMessage","id":"item","text":"Full answer.","phase":"final_answer"}}});
        let mut envelope = json!({"method":"BrokerOutput","params":{"owned_handle":"synthetic_owned","frame":frame}});
        assert_eq!(
            c.receive(envelope.to_string().as_bytes()).unwrap(),
            Some(frame)
        );
        assert!(!c.terminal_observed);
        assert!(c.reserve_continuation(8).is_err());
        envelope["params"]["frame"]["params"]["turnId"] = json!("foreign");
        assert!(c.receive(envelope.to_string().as_bytes()).is_err());
    }
}
#[test]
fn execution_correlation_is_once_only_without_becoming_authority() {
    let mut c = channel();
    let envelope = c.reserve_execution(7).unwrap();
    assert!(c.reserve_execution(8).is_err());
    assert!(c.metadata(json!({"method":"initialized"})).is_err());
    let frame: Value =
        serde_json::from_slice(&envelope.wrap(json!({"id":7,"method":"turn/start","params":{}})))
            .unwrap();
    assert_eq!(frame["method"], "CommitExecution");
    assert_eq!(frame["params"]["owned_handle"], "synthetic_owned");
    assert_eq!(c.receive(json!({"id":2,"result":{"owned_handle":"synthetic_owned","frame":{"id":7,"result":{"turn":{"id":"synthetic-turn","status":"inProgress"}}}}}).to_string().as_bytes()).unwrap().unwrap()["id"],7);
    assert!(c.reserve_execution(9).is_err());
    assert!(c.receive(json!({"method":"BrokerOutput","params":{"owned_handle":"synthetic_owned","frame":{"method":"turn/completed","params":{"turn":{"id":"synthetic-turn","status":"completed"}}}}}).to_string().as_bytes()).unwrap().is_some());
}
#[test]
fn correlated_setup_and_initialized_null_reply() {
    let mut c = channel();
    let request: Value = serde_json::from_slice(
        &c.metadata(json!({"id":7,"method":"initialize","params":{}}))
            .unwrap()
            .into_submission()
            .1,
    )
    .unwrap();
    assert_eq!(request["id"], 2);
    let response =
        json!({"id":2,"result":{"owned_handle":"synthetic_owned","frame":{"id":7,"result":{}}}});
    assert_eq!(
        c.receive(response.to_string().as_bytes()).unwrap().unwrap()["id"],
        7
    );
    c.metadata(json!({"method":"initialized"})).unwrap();
    assert_eq!(
        c.receive(
            json!({"id":3,"result":{"owned_handle":"synthetic_owned","frame":null}})
                .to_string()
                .as_bytes()
        )
        .unwrap(),
        None
    );
}
#[test]
fn foreign_handle_and_wrong_inner_correlation_poison() {
    for (handle, id) in [("foreign", 7), ("synthetic_owned", 8)] {
        let mut c = channel();
        c.metadata(json!({"id":7,"method":"initialize"})).unwrap();
        assert!(c
            .receive(
                json!({"id":2,"result":{"owned_handle":handle,"frame":{"id":id,"result":{}}}})
                    .to_string()
                    .as_bytes()
            )
            .is_err());
        assert!(c.metadata(json!({"method":"initialized"})).is_err());
    }
}
#[test]
fn metadata_never_serializes_turn_and_unrelated_output_refused() {
    let mut c = channel();
    assert!(c.metadata(json!({"id":4,"method":"turn/start"})).is_err());
    let mut c = channel();
    assert!(c.receive(json!({"method":"BrokerOutput","params":{"owned_handle":"foreign","frame":{"method":"turn/started"}}}).to_string().as_bytes()).is_err());
}
#[test]
fn actual_fd_preparation_is_correlated_once_and_write_precedes_reply() {
    let mut c = channel();
    c.require_prepared().unwrap();
    c.metadata(json!({"method":"initialized"})).unwrap();
    assert!(c.take_prepared().is_err());
    let prepared = json!({"method":"BrokerPrepared","params":{"owned_handle":"synthetic_owned","request_id":2}});
    assert_eq!(c.receive(prepared.to_string().as_bytes()).unwrap(), None);
    let proof = c.take_prepared().unwrap();
    assert!(c.take_prepared().is_err());
    c.finish_provider_write(proof).unwrap();
    assert_eq!(
        c.receive(
            json!({"id":2,"result":{"owned_handle":"synthetic_owned","frame":null}})
                .to_string()
                .as_bytes()
        )
        .unwrap(),
        None
    );
    c.metadata(json!({"id":3,"method":"account/read","params":{"refreshToken":false}}))
        .unwrap();
    assert!(c.take_prepared().is_err());
}
#[test]
fn actual_fd_foreign_duplicate_or_early_completion_poisons() {
    for bad in [
        json!({"method":"BrokerPrepared","params":{"owned_handle":"foreign","request_id":2}}),
        json!({"method":"BrokerPrepared","params":{"owned_handle":"synthetic_owned","request_id":3}}),
        json!({"method":"BrokerPrepared","params":{"owned_handle":"synthetic_owned","request_id":2,"extra":true}}),
        json!({"id":2,"result":{"owned_handle":"synthetic_owned","frame":null}}),
    ] {
        let mut c = channel();
        c.require_prepared().unwrap();
        c.metadata(json!({"method":"initialized"})).unwrap();
        assert!(c.receive(bad.to_string().as_bytes()).is_err());
        assert!(c.take_prepared().is_err());
    }
    let mut c = channel();
    c.require_prepared().unwrap();
    c.metadata(json!({"method":"initialized"})).unwrap();
    let prepared = json!({"method":"BrokerPrepared","params":{"owned_handle":"synthetic_owned","request_id":2}}).to_string();
    c.receive(prepared.as_bytes()).unwrap();
    assert!(c.receive(prepared.as_bytes()).is_err());
}
#[test]
fn actual_fd_write_proof_cannot_cross_child_lineage() {
    let mut a = channel();
    let mut b = channel();
    for c in [&mut a, &mut b] {
        c.require_prepared().unwrap();
        c.metadata(json!({"method":"initialized"})).unwrap();
        c.receive(json!({"method":"BrokerPrepared","params":{"owned_handle":"synthetic_owned","request_id":2}}).to_string().as_bytes()).unwrap();
    }
    let foreign = a.take_prepared().unwrap();
    let _own = b.take_prepared().unwrap();
    assert!(b.finish_provider_write(foreign).is_err());
}

#[test]
fn continuation_requires_terminal_and_rejects_late_previous_turn() {
    fn complete(c: &mut BrokerChannel) {
        c.reserve_execution(7).unwrap();
        c.receive(json!({"id":2,"result":{"owned_handle":"synthetic_owned","frame":{"id":7,"result":{"turn":{"id":"old-turn","status":"inProgress"}}}}}).to_string().as_bytes()).unwrap();
        c.receive(json!({"method":"BrokerOutput","params":{"owned_handle":"synthetic_owned","frame":{"method":"turn/completed","params":{"turn":{"id":"old-turn","status":"completed"}}}}}).to_string().as_bytes()).unwrap();
    }
    let mut c = channel();
    complete(&mut c);
    let next = c.reserve_continuation(8).unwrap();
    let outer: Value = serde_json::from_slice(&next.wrap(json!({"id":8}))).unwrap();
    assert_eq!(outer["id"], 3);
    assert!(c.receive(json!({"method":"BrokerOutput","params":{"owned_handle":"synthetic_owned","frame":{"method":"item/agentMessage/delta","params":{"turnId":"old-turn","delta":"late"}}}}).to_string().as_bytes()).is_err());
    assert!(c.reserve_continuation(9).is_err());
    let mut c = channel();
    c.reserve_execution(7).unwrap();
    assert!(c.reserve_continuation(8).is_err());
    let mut c = channel();
    complete(&mut c);
    assert!(c.reserve_continuation(7).is_err());
}

#[test]
fn continuation_refuses_prepared_or_writing_without_terminal() {
    for writing in [false, true] {
        let mut c = channel();
        c.require_prepared().unwrap();
        c.reserve_execution(7).unwrap();
        c.receive(json!({"method":"BrokerPrepared","params":{"owned_handle":"synthetic_owned","request_id":2}}).to_string().as_bytes()).unwrap();
        if writing {
            let _proof = c.take_prepared().unwrap();
        }
        assert!(c.reserve_continuation(8).is_err());
    }
}

fn cancelling_channel() -> BrokerChannel {
    let mut c = channel();
    c.require_prepared().unwrap();
    c.reserve_execution(7).unwrap();
    c.receive(json!({"method":"BrokerPrepared","params":{"owned_handle":"synthetic_owned","request_id":2}}).to_string().as_bytes()).unwrap();
    let proof = c.take_prepared().unwrap();
    c.finish_provider_write(proof).unwrap();
    c.receive(json!({"id":2,"result":{"owned_handle":"synthetic_owned","frame":{"id":7,"result":{"turn":{"id":"active-turn","status":"inProgress"}}}}}).to_string().as_bytes()).unwrap();
    c.cancellation(json!({"id":8,"method":"turn/interrupt","params":{"threadId":"native","turnId":"active-turn"}})).unwrap();
    c
}
fn queued_delta(turn: &str) -> Vec<u8> {
    json!({"method":"BrokerOutput","params":{"owned_handle":"synthetic_owned","frame":{"method":"item/agentMessage/delta","params":{"threadId":"native","turnId":turn,"delta":"queued progress"}}}}).to_string().into_bytes()
}
#[test]
fn cancellation_preparation_preserves_existing_turn_output_until_actual_write() {
    let mut c = cancelling_channel();
    assert!(c.receive(&queued_delta("active-turn")).unwrap().is_some());
    assert!(c.take_prepared().is_err());
    c.receive(json!({"method":"BrokerPrepared","params":{"owned_handle":"synthetic_owned","request_id":3}}).to_string().as_bytes()).unwrap();
    assert!(c.receive(&queued_delta("active-turn")).unwrap().is_some());
    let proof = c.take_prepared().unwrap();
    assert!(c.receive(&queued_delta("active-turn")).unwrap().is_some());
    c.finish_provider_write(proof).unwrap();
    c.receive(
        json!({"id":3,"result":{"owned_handle":"synthetic_owned","frame":{"id":8,"result":{}}}})
            .to_string()
            .as_bytes(),
    )
    .unwrap();
    assert!(!c.terminal_observed);
    assert!(c.receive(json!({"method":"BrokerOutput","params":{"owned_handle":"synthetic_owned","frame":{"method":"turn/completed","params":{"threadId":"native","turn":{"id":"active-turn","status":"interrupted"}}}}}).to_string().as_bytes()).unwrap().is_some());
    assert!(c.terminal_observed);
}
#[test]
fn cancellation_early_ack_and_foreign_turn_still_poison() {
    for phase in 0..3 {
        let mut c = cancelling_channel();
        if phase > 0 {
            c.receive(json!({"method":"BrokerPrepared","params":{"owned_handle":"synthetic_owned","request_id":3}}).to_string().as_bytes()).unwrap();
        }
        if phase == 2 {
            let _proof = c.take_prepared().unwrap();
        }
        assert!(c.receive(json!({"id":3,"result":{"owned_handle":"synthetic_owned","frame":{"id":8,"result":{}}}}).to_string().as_bytes()).is_err());
        assert!(c.receive(&queued_delta("active-turn")).is_err());
    }
    let mut c = cancelling_channel();
    assert!(c.receive(&queued_delta("foreign-turn")).is_err());
}

#[test]
fn cancellation_pending_does_not_authorize_first_turn_output_or_wrong_preparation() {
    let mut c = channel();
    c.require_prepared().unwrap();
    c.reserve_execution(7).unwrap();
    assert!(c.receive(&queued_delta("active-turn")).is_err());
    for bad in [
        json!({"method":"BrokerPrepared","params":{"owned_handle":"foreign","request_id":3}}),
        json!({"method":"BrokerPrepared","params":{"owned_handle":"synthetic_owned","request_id":2}}),
        json!({"method":"BrokerOutput","params":{"owned_handle":"foreign","frame":{"method":"item/agentMessage/delta","params":{"turnId":"active-turn","delta":"foreign"}}}}),
    ] {
        let mut c = cancelling_channel();
        assert!(c.receive(bad.to_string().as_bytes()).is_err());
        assert!(c.take_prepared().is_err());
    }
}
#[test]
fn active_terminal_before_cancel_preparation_remains_terminal_evidence_only() {
    let mut c = cancelling_channel();
    assert!(c.receive(json!({"method":"BrokerOutput","params":{"owned_handle":"synthetic_owned","frame":{"method":"turn/completed","params":{"threadId":"native","turn":{"id":"active-turn","status":"completed"}}}}}).to_string().as_bytes()).unwrap().is_some());
    assert!(c.terminal_observed);
    assert!(c.take_prepared().is_err());
    assert!(c.receive(&queued_delta("active-turn")).is_err());
}
