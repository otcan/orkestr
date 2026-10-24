use super::*;
use std::time::Duration;

fn message(id: &str, date: &str, subject: &str) -> String {
    format!("From: Jobs <jobs@example.com>\nMessage-ID: <{id}@example.com>\nDate: {date}\nSubject: {subject}\n\nbody {id}\n")
}

fn later() -> SystemTime {
    SystemTime::now() + Duration::from_secs(60)
}

#[test]
fn maildir_scans_are_incremental_ordered_bounded_and_read_only() {
    let dir = crate::testdir::tempdir().unwrap();
    let md = dir.path().join("INBOX");
    fs::create_dir_all(md.join("cur")).unwrap();
    fs::create_dir_all(md.join("new")).unwrap();
    fs::write(
        md.join("cur/2.host:2,S"),
        message("b", "Tue, 20 Oct 2026 10:00:00 +0000", "second"),
    )
    .unwrap();
    fs::write(
        md.join("new/1.host"),
        message("a", "Tue, 20 Oct 2026 09:00:00 +0000", "first"),
    )
    .unwrap();
    fs::write(
        md.join("cur/3.host"),
        message("c", "Tue, 20 Oct 2026 08:00:00 +0000", "third"),
    )
    .unwrap();
    let before: Vec<_> = fs::read_dir(md.join("cur"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    let folders = [MailFolder::Maildir(md.clone())];
    let limits = ScanLimits {
        max_messages: 2,
        ..Default::default()
    };
    let first = scan(dir.path(), &folders, &Cursor::default(), &limits, later()).unwrap();
    assert_eq!(first.envelopes.len(), 2);
    assert!(first.stats.truncated);
    let second = scan(dir.path(), &folders, &first.cursor, &limits, later()).unwrap();
    assert_eq!(second.envelopes.len(), 1);
    assert!(!second.stats.truncated);
    let all: Vec<String> = first
        .envelopes
        .iter()
        .chain(&second.envelopes)
        .map(|e| e.subject.clone())
        .collect();
    assert_eq!(all.len(), 3);
    // A flag change (read mail) renames the file; it is not new.
    fs::rename(md.join("new/1.host"), md.join("cur/1.host:2,S")).unwrap();
    let third = scan(dir.path(), &folders, &second.cursor, &limits, later()).unwrap();
    assert!(third.envelopes.is_empty());
    // Within one scan, oldest first.
    let fresh = scan(
        dir.path(),
        &folders,
        &Cursor::default(),
        &ScanLimits::default(),
        later(),
    )
    .unwrap();
    let subjects: Vec<&str> = fresh.envelopes.iter().map(|e| e.subject.as_str()).collect();
    assert_eq!(subjects, ["third", "first", "second"]);
    let after: Vec<_> = fs::read_dir(md.join("cur"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    assert_eq!(before.len() + 1, after.len());
    // Deleted mail leaves the cursor.
    fs::remove_file(md.join("cur/3.host")).unwrap();
    let pruned = scan(
        dir.path(),
        &folders,
        &fresh.cursor,
        &ScanLimits::default(),
        later(),
    )
    .unwrap();
    match &pruned.cursor.folders[&folders[0].key()] {
        FolderCursor::Maildir { seen, .. } => assert_eq!(seen.len(), 2),
        other => panic!("{other:?}"),
    }
}

#[test]
fn unsettled_old_and_large_messages_are_handled() {
    let dir = crate::testdir::tempdir().unwrap();
    let md = dir.path().join("INBOX");
    fs::create_dir_all(md.join("cur")).unwrap();
    fs::write(
        md.join("cur/old"),
        message("old", "Mon, 01 Jan 2024 09:00:00 +0000", "old"),
    )
    .unwrap();
    fs::write(md.join("cur/big"), "x".repeat(2048)).unwrap();
    let folders = [MailFolder::Maildir(md.clone())];
    let now_unsettled = SystemTime::now();
    let unsettled = scan(
        dir.path(),
        &folders,
        &Cursor::default(),
        &ScanLimits {
            settle_ms: 60_000,
            ..Default::default()
        },
        now_unsettled,
    )
    .unwrap();
    assert_eq!(unsettled.stats.skipped_unsettled, 2);
    let limits = ScanLimits {
        max_message_bytes: 1024,
        not_before_ms: Some(1_750_000_000_000),
        ..Default::default()
    };
    let out = scan(dir.path(), &folders, &unsettled.cursor, &limits, later()).unwrap();
    assert!(out.envelopes.is_empty());
    assert_eq!(out.stats.skipped_old, 1);
    assert_eq!(out.stats.skipped_large, 1);
    let again = scan(dir.path(), &folders, &out.cursor, &limits, later()).unwrap();
    assert_eq!(again.stats.skipped_old + again.stats.skipped_large, 0);
}

#[test]
fn mbox_appends_resume_from_the_offset_and_compaction_restarts() {
    let dir = crate::testdir::tempdir().unwrap();
    let path = dir.path().join("INBOX");
    let one = format!(
        "From - Tue Oct 20 09:00:00 2026\n{}",
        message("a", "Tue, 20 Oct 2026 09:00:00 +0000", "one")
    );
    let two = format!(
        "From - Tue Oct 20 10:00:00 2026\nX-Mozilla-Status: 0001\n{}",
        message("b", "Tue, 20 Oct 2026 10:00:00 +0000", "two")
    );
    let gone = format!(
        "From - Tue Oct 20 11:00:00 2026\nX-Mozilla-Status: 0009\n{}",
        message("c", "Tue, 20 Oct 2026 11:00:00 +0000", "gone")
    );
    fs::write(&path, format!("{one}\n{two}")).unwrap();
    let folders = [MailFolder::Mbox(path.clone())];
    let limits = ScanLimits::default();
    let first = scan(dir.path(), &folders, &Cursor::default(), &limits, later()).unwrap();
    assert_eq!(
        first
            .envelopes
            .iter()
            .map(|e| e.subject.as_str())
            .collect::<Vec<_>>(),
        ["one", "two"]
    );
    let unchanged = scan(dir.path(), &folders, &first.cursor, &limits, later()).unwrap();
    assert!(unchanged.envelopes.is_empty());
    let three = format!(
        "From - Tue Oct 20 12:00:00 2026\n{}",
        message("d", "Tue, 20 Oct 2026 12:00:00 +0000", "three")
    );
    fs::write(&path, format!("{one}\n{two}\n{gone}\n{three}")).unwrap();
    let appended = scan(dir.path(), &folders, &first.cursor, &limits, later()).unwrap();
    assert_eq!(
        appended
            .envelopes
            .iter()
            .map(|e| e.subject.as_str())
            .collect::<Vec<_>>(),
        ["three"]
    );
    assert_eq!(appended.stats.skipped_expunged, 1);
    // Compaction rewrites the file: start over (the ledger drops repeats).
    fs::write(&path, format!("{two}\n{three}")).unwrap();
    let compacted = scan(dir.path(), &folders, &appended.cursor, &limits, later()).unwrap();
    assert_eq!(compacted.envelopes.len(), 2);
}

#[test]
fn mbox_reads_in_bounded_chunks() {
    let dir = crate::testdir::tempdir().unwrap();
    let path = dir.path().join("INBOX");
    let mut text = String::new();
    for i in 0..20 {
        text.push_str(&format!(
            "From - x\n{}\n",
            message(
                &format!("m{i}"),
                "Tue, 20 Oct 2026 09:00:00 +0000",
                &format!("s{i}")
            )
        ));
    }
    fs::write(&path, &text).unwrap();
    let folders = [MailFolder::Mbox(path)];
    let limits = ScanLimits {
        max_mbox_bytes: 600,
        ..Default::default()
    };
    let mut cursor = Cursor::default();
    let mut total = 0;
    for _ in 0..40 {
        let out = scan(dir.path(), &folders, &cursor, &limits, later()).unwrap();
        total += out.envelopes.len();
        cursor = out.cursor;
        if !out.stats.truncated {
            break;
        }
    }
    assert_eq!(total, 20);
}

#[test]
fn mbox_skips_a_giant_message_without_stalling_later_mail() {
    let dir = crate::testdir::tempdir().unwrap();
    let path = dir.path().join("INBOX");
    let giant = format!(
        "From - x\n{}{}\n",
        message("giant", "Tue, 20 Oct 2026 09:00:00 +0000", "giant"),
        "x".repeat(4096)
    );
    let following = format!(
        "From - x\n{}",
        message("after", "Tue, 20 Oct 2026 10:00:00 +0000", "after giant")
    );
    fs::write(&path, format!("{giant}{following}")).unwrap();
    let folders = [MailFolder::Mbox(path)];
    let limits = ScanLimits {
        max_mbox_bytes: 512,
        ..Default::default()
    };
    let mut cursor = Cursor::default();
    let mut subjects = Vec::new();
    for _ in 0..20 {
        let out = scan(dir.path(), &folders, &cursor, &limits, later()).unwrap();
        subjects.extend(out.envelopes.iter().map(|e| e.subject.clone()));
        if out.stats.truncated {
            assert_ne!(out.cursor, cursor, "truncated scans must advance");
        }
        cursor = out.cursor;
        if !out.stats.truncated {
            break;
        }
    }
    assert_eq!(subjects, ["after giant"]);
}

#[test]
fn bounded_maildir_cursor_does_not_starve_later_names() {
    let dir = crate::testdir::tempdir().unwrap();
    let path = dir.path().join("INBOX");
    fs::create_dir_all(path.join("cur")).unwrap();
    for i in 0..7 {
        fs::write(
            path.join(format!("cur/{i:02}")),
            message(
                &format!("m{i}"),
                "Tue, 20 Oct 2026 09:00:00 +0000",
                &format!("s{i}"),
            ),
        )
        .unwrap();
    }
    let folders = [MailFolder::Maildir(path)];
    let limits = ScanLimits {
        max_messages: 2,
        max_seen: 2,
        ..Default::default()
    };
    let mut cursor = Cursor::default();
    let mut subjects = BTreeSet::new();
    for _ in 0..7 {
        let out = scan(dir.path(), &folders, &cursor, &limits, later()).unwrap();
        subjects.extend(out.envelopes.iter().map(|e| e.subject.clone()));
        cursor = out.cursor;
        match cursor.folders.values().next().unwrap() {
            FolderCursor::Maildir { seen, .. } => assert!(seen.len() <= 2),
            other => panic!("{other:?}"),
        }
    }
    assert_eq!(
        subjects.len(),
        7,
        "every message must eventually be visited even after cursor eviction"
    );
}

#[test]
fn old_mail_also_consumes_the_per_scan_message_budget() {
    let dir = crate::testdir::tempdir().unwrap();
    let path = dir.path().join("INBOX");
    fs::create_dir_all(path.join("cur")).unwrap();
    for i in 0..5 {
        fs::write(
            path.join(format!("cur/{i}")),
            message(&format!("m{i}"), "Mon, 01 Jan 2024 09:00:00 +0000", "old"),
        )
        .unwrap();
    }
    let limits = ScanLimits {
        max_messages: 2,
        not_before_ms: Some(1_750_000_000_000),
        ..Default::default()
    };
    let folders = [MailFolder::Maildir(path)];
    let out = scan(dir.path(), &folders, &Cursor::default(), &limits, later()).unwrap();
    assert_eq!(out.stats.skipped_old, 2);
    assert!(out.stats.truncated);
    let next = scan(dir.path(), &folders, &out.cursor, &limits, later()).unwrap();
    assert_eq!(next.stats.skipped_old, 2);
    assert!(next.stats.truncated);
}

#[test]
fn missing_folders_keep_their_cursor() {
    let dir = crate::testdir::tempdir().unwrap();
    let folders = [
        MailFolder::Maildir(dir.path().join("INBOX")),
        MailFolder::Mbox(dir.path().join("mbox")),
    ];
    let out = scan(
        dir.path(),
        &folders,
        &Cursor::default(),
        &ScanLimits::default(),
        later(),
    )
    .unwrap();
    assert_eq!(out.stats.missing_folders, 2);
    assert!(out.envelopes.is_empty());
}
