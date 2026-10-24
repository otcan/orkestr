//! The shipped job-tracker rule pack against synthetic fixture mail
//! (`tests/fixtures/generate.py`; fictional companies and people only).
use orkestr_v2_contracts::{TrackerEventInput, TrackerEventKind};
use orkestr_v2_mail_reader::{
    classify, envelope,
    profile::{discover, inbox_folders, DiscoveryEnv, Os},
    scan, Cursor, Outcome, RulePack, ScanLimits,
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

#[path = "../src/testdir.rs"]
mod testdir;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).to_owned()
}

fn pack() -> RulePack {
    let text = fs::read_to_string(root().join("../../recipes/job-tracker/rules.json")).unwrap();
    let mut pack = RulePack::from_json(&text).unwrap();
    // Exercise agency rules with reserved synthetic mail identities. Production
    // configuration keeps its real service-domain vocabulary, never fixture people.
    for (original, alias, name) in [
        ("agency:hays", "agency-a", "Agency A"),
        ("agency:sthree", "agency-b", "Agency B"),
        ("agency:emagine", "agency-c", "Agency C"),
    ] {
        let source = pack.sources.iter_mut().find(|s| s.id == original).unwrap();
        source.id = format!("agency:{alias}");
        source.name = Some(name.into());
        source.sender_domains = vec![format!("{alias}.example")];
        source.link_domains.clear();
    }
    pack.freemail_domains.push("personal-mail.example".into());
    pack
}

fn fixtures() -> Vec<(String, Vec<u8>, Value)> {
    let expected: BTreeMap<String, Value> = serde_json::from_str(
        &fs::read_to_string(root().join("tests/fixtures/expected.json")).unwrap(),
    )
    .unwrap();
    expected
        .into_iter()
        .map(|(file, want)| {
            let bytes = fs::read(root().join("tests/fixtures/mail").join(&file)).unwrap();
            (file, bytes, want)
        })
        .collect()
}

fn check(file: &str, outcome: &Outcome, want: &Value) {
    if let Some(reason) = want.get("drop").and_then(Value::as_str) {
        assert_eq!(
            outcome,
            &Outcome::Dropped {
                reason: reason.into()
            },
            "{file}"
        );
        return;
    }
    let Outcome::Events { events, .. } = outcome else {
        panic!("{file}: expected an event, got {outcome:?}");
    };
    let kind = TrackerEventKind::parse(want["kind"].as_str().unwrap()).unwrap();
    if let Some(items) = want.get("items").and_then(Value::as_array) {
        let got: Vec<(String, Option<String>, Option<String>)> = events
            .iter()
            .map(|e| (e.company.clone(), e.role.clone(), e.link.clone()))
            .collect();
        let wanted: Vec<(String, Option<String>, Option<String>)> = items
            .iter()
            .map(|i| {
                (
                    i[0].as_str().unwrap().into(),
                    Some(i[1].as_str().unwrap().into()),
                    Some(i[2].as_str().unwrap().into()),
                )
            })
            .collect();
        assert_eq!(got, wanted, "{file}");
        assert!(events.iter().all(|e| e.kind == kind), "{file}");
        return;
    }
    assert_eq!(events.len(), 1, "{file}");
    let e: &TrackerEventInput = &events[0];
    assert_eq!(e.kind, kind, "{file}: {e:?}");
    assert_eq!(e.company, want["company"].as_str().unwrap(), "{file}");
    assert_eq!(e.role.as_deref(), want["role"].as_str(), "{file}");
    assert_eq!(e.source, want["source"].as_str().unwrap(), "{file}");
    if let Some(link) = want.get("link").and_then(Value::as_str) {
        assert_eq!(e.link.as_deref(), Some(link), "{file}");
    }
    match want.get("max_confidence").and_then(Value::as_u64) {
        Some(max) => assert!(u64::from(e.confidence) <= max, "{file}"),
        None => assert!(e.confidence >= 70, "{file}: {}", e.confidence),
    }
    assert!(e.is_valid(), "{file}");
    assert!(
        e.evidence
            .as_deref()
            .is_some_and(|v| v.chars().count() <= 200),
        "{file}"
    );
    assert_eq!(
        e.requires_thread,
        want.get("requires_thread") == Some(&Value::Bool(true)),
        "{file}"
    );
    assert_eq!(
        e.requires_thread,
        !e.thread_refs.is_empty() && e.requires_thread,
        "{file}"
    );
}

/// Parse a fixture; Sent-folder fixtures are outgoing.
fn envelope_of(bytes: &[u8], want: &Value) -> envelope::Envelope {
    let mut env = envelope::parse(bytes);
    env.outgoing = want.get("outgoing") == Some(&Value::Bool(true));
    env
}

#[test]
fn every_fixture_is_labelled_as_expected() {
    let pack = pack();
    let cases = fixtures();
    assert!(cases.len() >= 43);
    for (file, bytes, want) in &cases {
        let env = envelope_of(bytes, want);
        check(file, &classify(&env, &pack, 1), want);
    }
}

#[test]
fn fixtures_hold_only_fictional_or_vendor_addresses() {
    let vendors = [
        "linkedin.com",
        "greenhouse-mail.io",
        "myworkday.com",
        "personio.com",
        "ashbyhq.com",
        "lever.co",
        "teamtailor.com",
        "smartrecruiters.com",
        "codility.com",
        "freelance.de",
    ];
    for (file, bytes, _) in fixtures() {
        let env = envelope::parse(&bytes);
        let domains = std::iter::once(env.sender_domain.as_str()).chain(
            env.to
                .iter()
                .map(|(_, address)| address.rsplit('@').next().unwrap_or("")),
        );
        for d in domains {
            let fictional =
                d.ends_with(".example") || d.starts_with("example.") || d.ends_with(".example.org");
            assert!(
                fictional
                    || vendors
                        .iter()
                        .any(|v| d == *v || d.ends_with(&format!(".{v}"))),
                "{file}: unexpected mail domain {d}"
            );
        }
        let text = String::from_utf8_lossy(&bytes);
        assert!(!text.contains("gmail.com"), "{file}");
    }
}

#[test]
fn a_thunderbird_profile_is_found_scanned_and_classified_incrementally() {
    let home = testdir::tempdir().unwrap();
    let profile_dir = home.path().join(".thunderbird/x1y2z3.default-esr");
    let inbox = profile_dir.join("ImapMail/imap.gmail.com/INBOX");
    fs::create_dir_all(inbox.join("cur")).unwrap();
    fs::create_dir_all(inbox.join("new")).unwrap();
    fs::write(
        home.path().join(".thunderbird/profiles.ini"),
        "[Profile0]\nName=default-esr\nIsRelative=1\nPath=x1y2z3.default-esr\nDefault=1\n",
    )
    .unwrap();
    // Thunderbird's credential store sits next to the mail; it is never read.
    fs::write(profile_dir.join("logins.json"), b"{\"never\":\"read\"}").unwrap();
    let cases = fixtures();
    let (first, second) = (&cases[..20], &cases[20..30]);
    for (file, bytes, _) in first {
        fs::write(inbox.join("cur").join(format!("{file}:2,S")), bytes).unwrap();
    }
    let env = DiscoveryEnv {
        os: Os::Linux,
        home: Some(home.path().to_owned()),
        appdata: None,
    };
    let profiles = discover(&env);
    assert_eq!(profiles.len(), 1);
    let folders = inbox_folders(&profiles[0].path, &[]);
    assert_eq!(folders.len(), 1);
    let later = SystemTime::now() + Duration::from_secs(60);
    let pack = pack();
    let run = |cursor: &Cursor| {
        scan(
            &profiles[0].path,
            &folders,
            cursor,
            &ScanLimits::default(),
            later,
        )
        .unwrap()
    };
    let one = run(&Cursor::default());
    assert_eq!(one.envelopes.len(), 20);
    let dates: Vec<i64> = one.envelopes.iter().map(|e| e.date_ms.unwrap()).collect();
    assert!(dates.windows(2).all(|w| w[0] <= w[1]), "oldest first");
    let labelled = one
        .envelopes
        .iter()
        .filter(|e| matches!(classify(e, &pack, 1), Outcome::Events { .. }))
        .count();
    assert_eq!(labelled, 17);
    // Nothing new: nothing returned.
    assert!(run(&one.cursor).envelopes.is_empty());
    for (file, bytes, _) in second {
        fs::write(inbox.join("new").join(file), bytes).unwrap();
    }
    // The same message delivered twice (another label) keeps one reference.
    fs::write(inbox.join("new").join("dup"), &first[0].1).unwrap();
    let two = run(&one.cursor);
    assert_eq!(two.envelopes.len(), second.len() + 1);
    let refs: BTreeSet<&str> = one
        .envelopes
        .iter()
        .chain(&two.envelopes)
        .map(|e| e.message_ref.as_str())
        .collect();
    assert_eq!(refs.len(), 30);
    // The reader never changed the store.
    assert!(inbox
        .join("cur")
        .join(format!("{}:2,S", first[0].0))
        .exists());
    assert_eq!(
        fs::read(profile_dir.join("logins.json")).unwrap(),
        b"{\"never\":\"read\"}"
    );
}

#[test]
fn the_rule_pack_refuses_malformed_data() {
    let text = fs::read_to_string(root().join("../../recipes/job-tracker/rules.json")).unwrap();
    let mut value: Value = serde_json::from_str(&text).unwrap();
    value["schema"] = "other".into();
    assert!(RulePack::from_json(&value.to_string()).is_err());
    let mut value: Value = serde_json::from_str(&text).unwrap();
    value["rules"][0]["when"] = serde_json::json!({});
    assert!(RulePack::from_json(&value.to_string()).is_err());
    let mut value: Value = serde_json::from_str(&text).unwrap();
    value["extract"]["subject"][0] = "{nope}".into();
    assert!(RulePack::from_json(&value.to_string()).is_err());
    let mut value: Value = serde_json::from_str(&text).unwrap();
    value["unknown_field"] = 1.into();
    assert!(RulePack::from_json(&value.to_string()).is_err());
}

#[test]
fn keyword_mail_from_untrusted_senders_never_moves_a_row_without_a_thread() {
    // The reported real-mail failures, as synthetic cases: marketing "offers",
    // sales "interviews", newsletter "assessments", a positive reply that a
    // keyword rule would read as a rejection.
    let pack = pack();
    let by_name: BTreeMap<String, (Vec<u8>, Value)> = fixtures()
        .into_iter()
        .map(|(f, b, w)| (f, (b, w)))
        .collect();
    let outcome = |name: &str| {
        let (bytes, want) = by_name
            .iter()
            .find(|(f, _)| f.contains(name))
            .map(|(_, v)| v.clone())
            .unwrap();
        classify(&envelope_of(&bytes, &want), &pack, 1)
    };
    for (name, reason) in [
        ("marketing-offer-bulk", "drop:marketing"),
        ("calendly-sales-pitch", "not_in_thread"),
        ("hackathon-newsletter", "drop:marketing"),
        ("platform-digest-bulk", "drop:marketing"),
        ("linkedin-sales-inmail", "lead_without_role"),
        ("greenhouse-spoofed-rejection", "not_in_thread"),
    ] {
        assert_eq!(
            outcome(name),
            Outcome::Dropped {
                reason: reason.into()
            },
            "{name}"
        );
    }
    let Outcome::Events { events, .. } = outcome("agency-b-onboarding-in-thread") else {
        panic!()
    };
    assert_eq!(
        events[0].kind,
        TrackerEventKind::Offer,
        "a positive reply is never a rejection"
    );
    assert_eq!(
        events[0].thread_refs,
        vec![envelope::message_ref(
            "<jt15fixture.sent-agency-b@example.com>"
        )]
    );
}
