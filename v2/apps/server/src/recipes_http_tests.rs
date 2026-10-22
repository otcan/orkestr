use super::*;
use crate::conversation_resources_http::tests::{case, send};
use serde_json::{json, Value};

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../crates/mail-reader/tests/fixtures/mail");

/// A Thunderbird-like profile with synthetic job mail: received fixtures in
/// the Maildir inbox, the user's own ones in Gmail's Sent folder.
fn seed_profile(root: &std::path::Path, take: impl IntoIterator<Item = usize>) -> std::path::PathBuf {
    let profile = root.join("thunderbird-profile");
    let inbox = profile.join("ImapMail/imap.gmail.com/INBOX/cur");
    let sent = profile.join("ImapMail/imap.gmail.com/[Gmail].sbd/Sent Mail/cur");
    std::fs::create_dir_all(&inbox).unwrap();
    std::fs::create_dir_all(&sent).unwrap();
    let expected: Value = serde_json::from_str(&std::fs::read_to_string(format!("{FIXTURES}/../expected.json")).unwrap()).unwrap();
    let mut files: Vec<_> = std::fs::read_dir(FIXTURES).unwrap().map(|e| e.unwrap().path()).collect();
    files.sort();
    for file in take.into_iter().map(|i| &files[i]) {
        let name = file.file_name().unwrap().to_string_lossy().into_owned();
        let dir = if expected[&name]["outgoing"] == true { &sent } else { &inbox };
        std::fs::copy(file, dir.join(format!("{name}:2,S"))).unwrap();
    }
    // Make the copies "settled" for the reader (older than its 2 s window).
    std::thread::sleep(std::time::Duration::from_millis(2100));
    profile
}

#[tokio::test]
async fn install_creates_a_tracked_conversation_with_a_silent_weekday_timer_and_scans_mail() {
    let case = case().await;
    let auth = case.auth();
    let (status, catalog) = send(&case.state, "GET", "/api/v2/recipes", &[&auth], "").await;
    assert_eq!(status, 200);
    assert_eq!(catalog["recipes"][0]["id"], "job-tracker");
    // The inbox's first 20 mails plus the user's own application they answer.
    let profile = seed_profile(&case.root, (0..20).chain([30]));
    let cookie = format!("Cookie: orkestr_v2_session={}", case.cookie);
    let csrf = format!(
        "x-orkestr-csrf: {:x}",
        Sha256::digest(format!("orkestr-v2-browser-csrf-v1:{}", case.cookie).as_bytes())
    );
    let origin = "Origin: http://127.0.0.1:19882";
    let body = json!({"request_key":"first","timezone":"Europe/Berlin","mail_profile":profile.display().to_string()}).to_string();
    // Machine credentials cannot install; browser writes need CSRF.
    let (status, _) = send(&case.state, "POST", "/api/v2/recipes/job-tracker/install", &[&auth], &body).await;
    assert_eq!(status, 401);
    let (status, _) = send(&case.state, "POST", "/api/v2/recipes/job-tracker/install", &[&cookie, origin], &body).await;
    assert_eq!(status, 403);
    let (status, installed) = send(&case.state, "POST", "/api/v2/recipes/job-tracker/install", &[&cookie, origin, &csrf], &body).await;
    assert_eq!(status, 201, "{installed}");
    assert_eq!(installed["conversation_name"], "Job tracker");
    assert_eq!(installed["mail"]["status"], "ready");
    let grant = installed["tracker_grant"].as_str().unwrap().to_owned();
    let chat = installed["conversation_id"].as_str().unwrap().to_owned();
    let timer = installed["timers"][0].as_str().unwrap().to_owned();
    // Replay: same conversation, no second grant.
    let (status, replay) = send(&case.state, "POST", "/api/v2/recipes/job-tracker/install", &[&cookie, origin, &csrf], &body).await;
    assert_eq!(status, 200);
    assert_eq!(replay["conversation_id"], installed["conversation_id"]);
    assert_eq!(replay["tracker_grant"], Value::Null);
    let bad = json!({"request_key":"tz","timezone":"Mars/Olympus"}).to_string();
    let (status, value) = send(&case.state, "POST", "/api/v2/recipes/job-tracker/install", &[&cookie, origin, &csrf], &bad).await;
    assert_eq!((status, value["code"].as_str()), (400, Some("invalid_timezone")));
    // The timer: enabled, weekday calendar 09:00-20:00 hourly, silent unless changed.
    let (status, detail) = send(&case.state, "GET", &format!("/api/v2/timers/{timer}"), &[&auth], "").await;
    assert_eq!(status, 200, "{detail}");
    assert_eq!(detail["state"], "enabled", "{detail}");
    let (_, policy) = send(&case.state, "GET", &format!("/api/v2/timers/{timer}/policy"), &[&auth], "").await;
    assert_eq!(policy["silent_mode"], "unless_changed", "{policy}");
    // First scan through the assistant's grant: rows from the inbox.
    let grant_header = format!("{TRACKER_GRANT_HEADER}: {grant}");
    let scan_path = format!("/api/v2/conversations/{chat}/tracker/mail-scan");
    let (status, report) = send(&case.state, "POST", &scan_path, &[&grant_header], "").await;
    assert_eq!(status, 200, "{report}");
    assert_eq!(report["news"], true);
    assert_eq!(report["stats"]["new_messages"], 21);
    assert_eq!(report["stats"]["labelled"], 18);
    assert_eq!(report["stats"]["dropped"], 3);
    assert!(report["summary"][0].as_str().unwrap().contains("Acme Robotics GmbH"), "offer first: {report}");
    // Nothing new: silent.
    let (_, quiet) = send(&case.state, "POST", &scan_path, &[&grant_header], "").await;
    assert_eq!((quiet["news"].as_bool(), quiet["stats"]["new_messages"].as_u64()), (Some(false), Some(0)));
    // New mail arrives (the rest of the fixtures): incremental.
    seed_profile(&case.root, 20..30);
    let (_, more) = send(&case.state, "POST", &scan_path, &[&grant_header], "").await;
    assert_eq!(more["stats"]["new_messages"], 10, "{more}");
    let (_, page) = send(&case.state, "GET", &format!("/api/v2/conversations/{chat}/tracker"), &[&auth], "").await;
    let rows = page["rows"].as_array().unwrap();
    let find = |company: &str, role: &str| rows.iter().find(|r| r["company"] == company && r["role"] == role).cloned();
    // Application and assessment for Litware SE: one row; the spoofed
    // rejection (no DKIM, not in a known thread) changed nothing.
    let litware = find("Litware", "Software Engineer").unwrap();
    assert_eq!(litware["status"], "assessment");
    // Workday confirmation then rejection (role with requisition id): one row.
    assert_eq!(find("Fabrikam AG", "Senior Frontend Developer (R-10442)").unwrap()["status"], "rejected");
    assert_eq!(find("Acme Robotics GmbH", "Backend Engineer (Rust)").unwrap()["status"], "offer");
    assert_eq!(find("Northwind Labs", "Platform Engineer").unwrap()["status"], "interview");
    // Alert leads are rows too (status saved), deduplicated by job link.
    assert_eq!(find("Tailspin Toys", "Rust Developer").unwrap()["status"], "saved");
    // The user's own applications from the Sent folder, and the replies in
    // their threads (ORK-605 real-mail findings, as synthetic mail).
    seed_profile(&case.root, 31..43);
    let (_, last) = send(&case.state, "POST", &scan_path, &[&grant_header], "").await;
    assert_eq!(last["stats"]["new_messages"], 12, "{last}");
    let (_, page) = send(&case.state, "GET", &format!("/api/v2/conversations/{chat}/tracker"), &[&auth], "").await;
    let rows = page["rows"].as_array().unwrap();
    let find = |company: &str, role: &str| rows.iter().find(|r| r["company"] == company && r["role"] == role).cloned();
    assert_eq!(find("Hays", "Senior Java Entwickler (Projekt 4711)").unwrap()["status"], "rejected");
    assert_eq!(find("SThree", "DevOps Engineer (Remote)").unwrap()["status"], "offer", "positive reply is not a rejection");
    assert_eq!(find("emagine", "Data Engineer (Remote, 6 Monate)").unwrap()["status"], "applied", "lead answered from Sent");
    assert_eq!(find("Acme Robotics GmbH", "Backend Engineer (Rust)").unwrap()["events_count"], 3);
    for noise in ["Deals", "Shop Deals", "Growth Tools", "Sam Sales", "Hackathon Weekly", "freelance.de", "Synthetic Friend", "Pat Growth"] {
        assert!(rows.iter().all(|r| r["company"] != noise), "{noise} must not become a row");
    }
    let mut keys: Vec<(String, String)> = rows.iter().map(|r| (r["company_key"].as_str().unwrap().into(), r["role_key"].as_str().unwrap().into())).collect();
    let before = keys.len();
    keys.sort();
    keys.dedup();
    assert_eq!(keys.len(), before, "no duplicate company+role rows");
    case.finish().await;
}
