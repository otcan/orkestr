use super::*;
use orkestr_v2_contracts::ExecutionModelSource;
use serde_json::json;

fn active(model: Option<&str>) -> TurnStream {
    let mut stream = TurnStream::new("thread-owned", 1).unwrap();
    stream.report_model(model);
    stream
        .receive(
            &json!({"id":1,"result":{"turn":{"id":"turn-owned","status":"inProgress"}}})
                .to_string(),
        )
        .unwrap();
    stream.receive(&json!({"method":"turn/started","params":{"threadId":"thread-owned","turn":{"id":"turn-owned","status":"inProgress"}}}).to_string()).unwrap();
    stream
}
fn answer(stream: &mut TurnStream, id: &str) {
    stream.receive(&json!({"method":"item/completed","params":{"threadId":"thread-owned","turnId":"turn-owned",
        "item":{"id":id,"type":"agentMessage","text":"synthetic answer","phase":"commentary"}}}).to_string()).unwrap();
}
#[test]
fn native_default_and_rerouted_answer_are_separate_from_execution_authority() {
    let mut stream = active(Some("native-reported-model"));
    let resolved = stream.take_model_observation().unwrap();
    assert_eq!(resolved.source, ExecutionModelSource::Resolved);
    assert!(stream.take_model_observation().is_none());
    answer(&mut stream, "first");
    assert_eq!(
        stream.take_model_observation().unwrap().model,
        "native-reported-model"
    );
    stream.receive(&json!({"method":"model/rerouted","params":{"threadId":"thread-owned","turnId":"turn-owned","toModel":"native-rerouted-model"}}).to_string()).unwrap();
    assert!(
        stream.take_model_observation().is_none(),
        "reroute is not an answer"
    );
    answer(&mut stream, "second");
    let actual = stream.take_model_observation().unwrap();
    assert_eq!(actual.source, ExecutionModelSource::Answer);
    assert_eq!(actual.model, "native-rerouted-model");
    assert!(
        stream.terminal().is_none(),
        "metadata cannot complete a run"
    );
}
#[test]
fn unreported_or_unconfirmed_override_is_not_inferred_as_an_answer() {
    let mut stream = active(None);
    answer(&mut stream, "first");
    assert!(stream.take_model_observation().is_none());
}
#[test]
fn foreign_or_late_reroute_cannot_change_this_run() {
    for (key, value) in [
        ("threadId", "foreign"),
        ("turnId", "foreign"),
        ("toModel", "model\nprivate"),
    ] {
        let mut stream = active(Some("native-reported-model"));
        let mut frame = json!({"method":"model/rerouted","params":{"threadId":"thread-owned","turnId":"turn-owned","toModel":"new-model"}});
        frame["params"][key] = json!(value);
        assert!(stream.receive(&frame.to_string()).is_err());
        assert!(stream.receive(&frame.to_string()).is_err());
    }
}
