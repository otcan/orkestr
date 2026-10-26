//! Native thread model evidence for explicit Codex turn overrides.
use super::pump::native_model_evidence;

#[test]
fn default_turn_uses_the_native_reported_thread_model() {
    assert_eq!(
        native_model_evidence(Some("native-model"), None),
        Some("native-model")
    );
    assert_eq!(native_model_evidence(None, None), None);
}

#[test]
fn override_equal_to_the_native_thread_model_is_native_confirmed() {
    assert_eq!(
        native_model_evidence(Some("native-model"), Some("native-model")),
        Some("native-model")
    );
}

#[test]
fn different_or_unreported_override_is_never_inferred() {
    assert_eq!(
        native_model_evidence(Some("native-default"), Some("requested-other")),
        None
    );
    assert_eq!(native_model_evidence(None, Some("requested-other")), None);
}

#[test]
fn fast_default_model_is_recorded_only_when_the_thread_started_with_it() {
    // A Fast native started with the Fast default and a turn asking for it.
    assert_eq!(
        native_model_evidence(Some("gpt-6-luna"), Some("gpt-6-luna")),
        Some("gpt-6-luna")
    );
    // A thread on another (e.g. global default) model is never relabelled.
    assert_eq!(
        native_model_evidence(Some("gpt-6.1-sol"), Some("gpt-6-luna")),
        None
    );
}
