use orkestr_v2_ui::payload::Output;
#[test]
fn external_tombstone_clears_same_reference_and_late_get_cannot_restore_text() {
    let mut output = Output::default();
    output.observed(Some("synthetic output".into()));
    output.observed(None);
    output.observed(Some("delayed pre-removal response".into()));
    assert!(output.removed());
    assert!(output.text.is_none());
}
#[test]
fn successful_delete_wins_in_flight_get_and_failure_hides_unverified_text() {
    let mut output = Output::default();
    output.observed(Some("synthetic output".into()));
    output.observed(None); // DELETE 204, before an older GET completes.
    output.unavailable();
    output.observed(Some("old response".into()));
    assert!(output.text.is_none());
    let mut other_selection = Output::default();
    other_selection.observed(Some("different payload".into()));
    assert!(other_selection.text.is_some());
}
