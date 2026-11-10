use orkestr_v2_contracts::{ExecutionPhase, ExecutionStatus, RunId};
use orkestr_v2_ui::live_answer::LiveAnswer;
use serde_json::json;

const PAYLOAD: &str = "00000000-0000-4000-8000-000000000010";

fn run(n: u8) -> RunId {
    serde_json::from_value(json!(format!("00000000-0000-4000-8000-0000000000{n:02}"))).unwrap()
}

fn status(run_number: u8, phase: ExecutionPhase, progress: bool) -> ExecutionStatus {
    serde_json::from_value(json!({
        "schema_version": 1,
        "conversation_id": "00000000-0000-4000-8000-000000000020",
        "run_id": run(run_number),
        "revision": 7,
        "observed_at_ms": 2000,
        "phase": phase,
        "queue_age_ms": null,
        "progress": progress.then(|| json!({"payload_id": PAYLOAD, "observed_at_ms": 1000})),
        "resources": null,
        "capabilities": {"stop": false, "steer": false},
    }))
    .unwrap()
}

#[test]
fn a_new_update_keeps_the_previous_text_until_its_own_arrives() {
    let mut answer = LiveAnswer::default();
    answer.observed(&run(1), Some("First update".into()));
    // The next payload of the same run has not been read yet.
    assert_eq!(answer.text(&run(1)), Some("First update"));
    answer.observed(&run(1), Some("Second update".into()));
    assert_eq!(answer.text(&run(1)), Some("Second update"));
    let rows = answer.rows(Some(&status(1, ExecutionPhase::Running, true)));
    assert!(rows.writing.is_some());
    assert_eq!(rows.finishing, None, "one bubble per answer");
}

#[test]
fn a_shown_answer_stays_after_completion_until_its_reply_is_ready() {
    let mut answer = LiveAnswer::default();
    answer.observed(&run(1), Some("Final".into()));
    let completed = status(1, ExecutionPhase::Completed, true);
    let rows = answer.rows(Some(&completed));
    assert!(
        rows.writing.is_some(),
        "completion alone must not remove it"
    );
    assert!(rows.covers(&run(1)), "the accepted row waits behind it");
    answer.settle(&run(1));
    let rows = answer.rows(Some(&completed));
    assert_eq!(rows.writing, None);
    assert!(!rows.covers(&run(1)), "the accepted row takes over");
}

#[test]
fn a_reply_that_is_ready_beats_a_status_poll_that_lags_behind() {
    let mut answer = LiveAnswer::default();
    answer.observed(&run(1), Some("Final".into()));
    answer.settle(&run(1));
    let lagging = status(1, ExecutionPhase::AwaitingAcceptance, true);
    assert_eq!(
        answer.rows(Some(&lagging)).writing,
        None,
        "never both at once"
    );
}

#[test]
fn a_reopened_chat_never_replays_a_finished_answer_as_live() {
    let answer = LiveAnswer::default();
    let rows = answer.rows(Some(&status(1, ExecutionPhase::Completed, true)));
    assert_eq!(rows.writing, None);
    assert_eq!(rows.finishing, None);
}

#[test]
fn an_unfinished_answer_is_still_followed_on_a_reopened_chat() {
    let answer = LiveAnswer::default();
    let rows = answer.rows(Some(&status(1, ExecutionPhase::Running, true)));
    assert!(rows.writing.is_some());
    let failed = status(1, ExecutionPhase::Failed, true);
    assert!(
        answer.rows(Some(&failed)).writing.is_some(),
        "partial text of a failed run stays"
    );
}

#[test]
fn the_next_run_does_not_remove_the_previous_answer_before_its_reply_is_ready() {
    let mut answer = LiveAnswer::default();
    answer.observed(&run(1), Some("Previous answer".into()));
    // The next run started before any poll reported the first as completed.
    let next = status(2, ExecutionPhase::Starting, false);
    assert_eq!(
        answer.rows(Some(&next)).finishing.unwrap().text,
        "Previous answer"
    );
    // Its first text does not push the previous answer out either.
    answer.observed(&run(2), Some("Next answer".into()));
    let writing = status(2, ExecutionPhase::Running, true);
    let rows = answer.rows(Some(&writing));
    assert_eq!(rows.finishing.as_ref().unwrap().text, "Previous answer");
    assert!(rows.covers(&run(1)) && rows.covers(&run(2)));
    answer.settle(&run(1));
    assert_eq!(answer.rows(Some(&writing)).finishing, None);
}

#[test]
fn a_settled_answer_is_not_kept_as_finishing_when_the_next_run_writes() {
    let mut answer = LiveAnswer::default();
    answer.observed(&run(1), Some("Answer".into()));
    answer.settle(&run(1));
    answer.observed(&run(2), Some("Next".into()));
    let rows = answer.rows(Some(&status(2, ExecutionPhase::Running, true)));
    assert_eq!(rows.finishing, None);
}

#[test]
fn removed_text_is_forgotten_and_never_shown_again() {
    let mut answer = LiveAnswer::default();
    answer.observed(&run(1), Some("Removed later".into()));
    answer.observed(&run(1), None);
    assert_eq!(answer.text(&run(1)), None);
    let rows = answer.rows(Some(&status(2, ExecutionPhase::Starting, false)));
    assert_eq!(rows.finishing, None);
}

#[test]
fn a_stopped_answer_stays_until_the_next_run_and_is_not_kept_after_it() {
    let mut answer = LiveAnswer::default();
    answer.observed(&run(1), Some("Partial answer".into()));
    let stopped = status(1, ExecutionPhase::Cancelled, true);
    assert!(answer.rows(Some(&stopped)).writing.is_some());
    assert_eq!(answer.newly_unanswered(&stopped), Some(run(1)));
    answer.unanswered(&run(1));
    assert_eq!(answer.newly_unanswered(&stopped), None, "recorded once");
    assert!(answer.rows(Some(&stopped)).writing.is_some(), "still shown");

    let next = status(2, ExecutionPhase::Starting, false);
    assert_eq!(
        answer.rows(Some(&next)).finishing,
        None,
        "no reply will come"
    );
    answer.observed(&run(2), Some("Next".into()));
    let writing = status(2, ExecutionPhase::Running, true);
    assert_eq!(answer.rows(Some(&writing)).finishing, None);
}

#[test]
fn a_reply_that_never_comes_does_not_keep_an_old_answer_forever() {
    let mut answer = LiveAnswer::default();
    answer.observed(&run(1), Some("Old".into()));
    answer.observed(&run(2), Some("New".into()));
    let writing = status(2, ExecutionPhase::Running, true);
    assert!(answer.rows(Some(&writing)).finishing.is_some());
    answer.settle(&run(2));
    assert_eq!(answer.rows(Some(&writing)).finishing, None);
}
