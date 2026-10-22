use orkestr_v2_ui::decode_stream;
use orkestr_v2_ui::live_stream::{backoff_ms, classify, Connection, Next};
use serde_json::json;

fn item(value: serde_json::Value) -> orkestr_v2_ui::StreamItem {
    decode_stream(value)
}

#[test]
fn backoff_doubles_to_a_ceiling() {
    let delays: Vec<u32> = (0..8).map(backoff_ms).collect();
    assert_eq!(delays, [0, 1000, 2000, 4000, 8000, 15000, 15000, 15000]);
    assert_eq!(backoff_ms(u32::MAX), 15000);
}

#[test]
fn idle_and_wake_catch_up_instead_of_failing() {
    assert_eq!(
        classify(&item(json!({"status":200,"event":"idle"}))),
        Next::CatchUp
    );
    assert_eq!(
        classify(&item(json!({"status":200,"event":"wake"}))),
        Next::CatchUp
    );
}

#[test]
fn expiry_resync_and_failures_are_distinct() {
    assert_eq!(
        classify(&item(json!({"status":401,"event":"http_error"}))),
        Next::Expired
    );
    assert_eq!(
        classify(&item(json!({"status":200,"event":"session_expired"}))),
        Next::Expired
    );
    assert_eq!(
        classify(&item(json!({"status":409,"event":"http_error"}))),
        Next::Resync
    );
    assert_eq!(
        classify(&item(json!({"status":200,"event":"resync_required"}))),
        Next::Resync
    );
    assert_eq!(
        classify(&item(json!({"status":502,"event":"http_error"}))),
        Next::Failure
    );
    assert_eq!(
        classify(&item(json!({"status":200,"event":"disconnected"}))),
        Next::Failure
    );
    // A bridge result that does not decode asks for a resync, never a silent stall.
    assert_eq!(classify(&item(json!("garbage"))), Next::Resync);
}

#[test]
fn connection_bar_shows_only_while_reconnecting() {
    let live = Connection::Live;
    assert_eq!(live.bar(), None);
    assert_eq!(Connection::default().bar(), None);
    let once = live.failed();
    assert_eq!(once, Connection::Reconnecting { failures: 1 });
    assert_eq!(once.bar(), Some("Reconnecting…"));
    assert_eq!(once.failed().failures(), 2);
    assert_eq!(Connection::Live.failures(), 0);
}
