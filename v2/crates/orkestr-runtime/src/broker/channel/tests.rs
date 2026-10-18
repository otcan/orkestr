use super::*;
fn channel() -> BrokerChannel {
    OwnedMetadataHandle {
        _handle: "synthetic_owned".into(),
        lineage: Some(std::sync::Arc::new(())),
    }
    .into_channel()
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
