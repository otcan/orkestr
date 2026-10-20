use orkestr_v2_ui::intelligence::IntelligenceCapabilities;
use serde_json::{json, Value};
const ID: &str = "00000000-0000-4000-8000-000000000001";
fn value() -> Value {
    json!({"schema_version":1,"conversation_id":ID,"deep":{"configured":true,"available":true,"stop":true,"steer":true,"accept":true,"max_parallel":1},"fast":{"configured":true,"available":false,"stop":true,"steer":false,"accept":true,"max_parallel":1},"worker":{"configured":true,"available":false,"stop":true,"steer":false,"accept":true,"max_parallel":4}})
}
#[test]
fn configured_roles_can_be_temporarily_unavailable_without_gaining_authority() {
    let caps: IntelligenceCapabilities = serde_json::from_value(value()).unwrap();
    assert!(caps.valid(ID));
    assert_eq!(caps.fast.label(), "Not currently available");
    assert!(!caps.valid("foreign"));
}
#[test]
fn forged_role_semantics_or_unknown_fields_refuse() {
    for (role, key, wrong) in [
        ("worker", "steer", json!(true)),
        ("worker", "max_parallel", json!(5)),
        ("fast", "accept", json!(false)),
        ("deep", "configured", json!(false)),
    ] {
        let mut v = value();
        v[role][key] = wrong;
        assert!(!serde_json::from_value::<IntelligenceCapabilities>(v)
            .unwrap()
            .valid(ID));
    }
    let mut v = value();
    v["fast"]["launch_path"] = json!("untrusted");
    assert!(serde_json::from_value::<IntelligenceCapabilities>(v).is_err());
}
#[test]
fn unconfigured_roles_are_explicitly_unavailable() {
    let mut v = value();
    v["worker"] = json!({"configured":false,"available":false,"stop":false,"steer":false,"accept":false,"max_parallel":0});
    let caps: IntelligenceCapabilities = serde_json::from_value(v.clone()).unwrap();
    assert!(caps.valid(ID));
    assert_eq!(caps.worker.label(), "Not configured");
    v["worker"]["available"] = json!(true);
    assert!(!serde_json::from_value::<IntelligenceCapabilities>(v)
        .unwrap()
        .valid(ID));
}
