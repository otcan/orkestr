use super::*;
use std::io::Read;

fn message(id: &str, subject: &str) -> String {
    format!("From - Tue Oct 20 10:00:00 2026\nFrom: Applicant <person@example.test>\nMessage-ID: <{id}@example.test>\nSubject: {subject}\n\nbody\n")
}
fn later() -> SystemTime {
    SystemTime::now() + Duration::from_secs(60)
}

#[test]
fn bounded_scans_rotate_inbox_and_sent_and_keep_rotation_after_serializing_cursor() {
    let dir = crate::testdir::tempdir().unwrap();
    let mut folders = Vec::new();
    for (name, outgoing) in [("INBOX", false), ("Sent", true)] {
        let path = dir.path().join(name);
        let messages: String = (0..4)
            .map(|n| message(&format!("{name}-{n}"), "synthetic mail"))
            .collect();
        fs::write(&path, messages).unwrap();
        folders.push(ScanFolder {
            folder: MailFolder::Mbox(path),
            outgoing,
        });
    }
    let mut cursor = Cursor::default();
    for outgoing in [false, true, false, true] {
        let limits = ScanLimits {
            max_messages: 1,
            ..ScanLimits::default()
        };
        let out = scan_folders(dir.path(), &folders, &cursor, &limits, later()).unwrap();
        assert_eq!(out.envelopes.len(), 1);
        assert_eq!(out.envelopes[0].outgoing, outgoing);
        cursor = serde_json::from_str(&serde_json::to_string(&out.cursor).unwrap()).unwrap();
    }
    let legacy: Cursor = serde_json::from_str(r#"{"folders":{}}"#).unwrap();
    assert!(legacy.next_folder.is_none());
}

#[cfg(unix)]
#[test]
fn selected_profile_identity_is_checked_on_the_open_directory_before_read() {
    use std::os::unix::fs::MetadataExt;
    let dir = crate::testdir::tempdir().unwrap();
    let profile = dir.path().join("profile");
    fs::create_dir(&profile).unwrap();
    let inbox = profile.join("INBOX");
    fs::write(&inbox, message("pin", "synthetic mail")).unwrap();
    let meta = fs::metadata(&profile).unwrap();
    let folders = [ScanFolder {
        folder: MailFolder::Mbox(inbox),
        outgoing: false,
    }];
    assert!(scan_folders_with_identity(
        &profile,
        Some((meta.dev(), meta.ino().wrapping_add(1))),
        &folders,
        &Cursor::default(),
        &ScanLimits::default(),
        later()
    )
    .is_err());
    let output = scan_folders_with_identity(
        &profile,
        Some((meta.dev(), meta.ino())),
        &folders,
        &Cursor::default(),
        &ScanLimits::default(),
        later(),
    )
    .unwrap();
    assert_eq!(output.envelopes.len(), 1);
}

#[cfg(unix)]
#[test]
fn a_mailbox_alias_cannot_read_profile_credentials_or_an_outside_file() {
    use std::os::unix::fs::symlink;
    let dir = crate::testdir::tempdir().unwrap();
    let profile = dir.path().join("profile");
    let account = profile.join("ImapMail/mail.example");
    fs::create_dir_all(&account).unwrap();
    let secret = profile.join("key4.db");
    fs::write(&secret, message("secret", "must never be read")).unwrap();
    let inbox = account.join("INBOX");
    symlink(&secret, &inbox).unwrap();
    assert!(crate::profile::inbox_folders(&profile, &[]).is_empty());
    assert!(scan(
        &profile,
        &[MailFolder::Mbox(inbox.clone())],
        &Cursor::default(),
        &ScanLimits::default(),
        later()
    )
    .is_err());
    fs::remove_file(&inbox).unwrap();
    fs::hard_link(&secret, &inbox).unwrap();
    assert!(crate::profile::inbox_folders(&profile, &[]).is_empty());
    assert!(scan(
        &profile,
        &[MailFolder::Mbox(inbox)],
        &Cursor::default(),
        &ScanLimits::default(),
        later()
    )
    .is_err());
    let outside = dir.path().join("outside");
    fs::write(&outside, message("outside", "outside")).unwrap();
    assert!(scan(
        &profile,
        &[MailFolder::Mbox(outside)],
        &Cursor::default(),
        &ScanLimits::default(),
        later()
    )
    .is_err());
    assert_eq!(
        fs::read_to_string(&secret).unwrap(),
        message("secret", "must never be read")
    );
}

#[cfg(unix)]
#[test]
fn linked_account_directories_and_maildir_entries_are_refused() {
    use std::os::unix::fs::symlink;
    let dir = crate::testdir::tempdir().unwrap();
    let profile = dir.path().join("profile");
    fs::create_dir_all(profile.join("ImapMail")).unwrap();
    let outside = dir.path().join("outside");
    fs::create_dir_all(&outside).unwrap();
    fs::write(
        outside.join("INBOX"),
        message("outside", "must never be read"),
    )
    .unwrap();
    symlink(&outside, profile.join("ImapMail/mail.example")).unwrap();
    assert!(crate::profile::inbox_folders(&profile, &[]).is_empty());
    assert!(crate::profile::sent_folders(&profile).is_empty());
    let maildir = profile.join("maildir");
    fs::create_dir_all(maildir.join("cur")).unwrap();
    symlink(outside.join("INBOX"), maildir.join("cur/looks-like-mail")).unwrap();
    fs::hard_link(outside.join("INBOX"), maildir.join("cur/hardlink-alias")).unwrap();
    fs::write(
        maildir.join("cur/safe"),
        b"Message-ID: <safe@example.test>\nFrom: person@example.test\nSubject: Safe mail\n\nbody\n",
    )
    .unwrap();
    let out = scan(
        &profile,
        &[MailFolder::Maildir(maildir)],
        &Cursor::default(),
        &ScanLimits::default(),
        later(),
    )
    .unwrap();
    assert_eq!(out.stats.skipped_unsafe, 2);
    assert_eq!(out.envelopes.len(), 1);
    assert_eq!(out.envelopes[0].subject, "Safe mail");
}

#[cfg(unix)]
#[test]
fn a_replaced_profile_name_does_not_redirect_an_already_open_scope() {
    use std::os::unix::fs::symlink;
    let dir = crate::testdir::tempdir().unwrap();
    let profile = dir.path().join("profile");
    fs::create_dir(&profile).unwrap();
    fs::write(profile.join("INBOX"), "selected mailbox").unwrap();
    let scope = Scope::new(&profile).unwrap();
    fs::rename(&profile, dir.path().join("original")).unwrap();
    let other = dir.path().join("other");
    fs::create_dir(&other).unwrap();
    fs::write(other.join("INBOX"), "unselected data").unwrap();
    symlink(&other, &profile).unwrap();
    let mut value = String::new();
    scope
        .file(&profile.join("INBOX"))
        .unwrap()
        .read_to_string(&mut value)
        .unwrap();
    assert_eq!(value, "selected mailbox");
    assert!(Scope::new(&profile).is_err());
}

#[test]
fn deadline_preserves_existing_cursors_and_does_not_read_another_message() {
    let dir = crate::testdir::tempdir().unwrap();
    let path = dir.path().join("INBOX");
    fs::write(&path, message("one", "one")).unwrap();
    let folders = [MailFolder::Mbox(path.clone())];
    let first = scan(
        dir.path(),
        &folders,
        &Cursor::default(),
        &ScanLimits::default(),
        later(),
    )
    .unwrap();
    fs::write(
        path,
        format!("{}{}", message("one", "one"), message("two", "new")),
    )
    .unwrap();
    let limits = ScanLimits {
        deadline: Instant::now() - Duration::from_secs(1),
        ..Default::default()
    };
    let stopped = scan(dir.path(), &folders, &first.cursor, &limits, later()).unwrap();
    assert!(stopped.stats.deadline_reached);
    assert_eq!(stopped.stats.files_seen, 0);
    assert!(stopped.envelopes.is_empty());
    assert_eq!(stopped.cursor, first.cursor);
}

#[test]
fn a_read_crossing_its_deadline_returns_no_partial_message() {
    struct Slow;
    impl Read for Slow {
        fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
            std::thread::sleep(Duration::from_millis(5));
            bytes[0] = b'x';
            Ok(1)
        }
    }
    let limits = ScanLimits {
        deadline: Instant::now() + Duration::from_millis(2),
        ..Default::default()
    };
    let mut out = ScanOutput {
        envelopes: Vec::new(),
        cursor: Cursor::default(),
        stats: ScanStats::default(),
    };
    assert!(read_bounded(&mut Slow, 100, &limits, &mut out)
        .unwrap()
        .is_none());
    assert!(out.stats.deadline_reached);
    assert!(out.envelopes.is_empty());
}

#[test]
fn oversized_message_tails_never_discard_the_following_partial_message() {
    let dir = crate::testdir::tempdir().unwrap();
    let path = dir.path().join("INBOX");
    for padding in 0..64 {
        let source = format!(
            "{}{}\n{}{}\n{}",
            message("large", "oversized"),
            "x".repeat(4096 + padding),
            message("next", "next"),
            "y".repeat(250),
            message("last", "last")
        );
        fs::write(&path, source).unwrap();
        let mut cursor = Cursor::default();
        let mut subjects = Vec::new();
        for _ in 0..40 {
            let out = scan(
                dir.path(),
                &[MailFolder::Mbox(path.clone())],
                &cursor,
                &ScanLimits {
                    max_mbox_bytes: 512,
                    ..Default::default()
                },
                later(),
            )
            .unwrap();
            subjects.extend(out.envelopes.iter().map(|e| e.subject.clone()));
            cursor = out.cursor;
            if !out.stats.truncated {
                break;
            }
        }
        assert_eq!(subjects, ["next", "last"], "padding {padding}");
    }
}

#[test]
fn compaction_followed_by_growth_with_the_same_head_restarts_safely() {
    let dir = crate::testdir::tempdir().unwrap();
    let path = dir.path().join("INBOX");
    let prefix = format!("{}{}\n", message("prefix", "prefix"), "p".repeat(6000));
    let old = format!(
        "{}{}{}",
        prefix,
        message("removed", "removed"),
        message("old-tail", "old tail")
    );
    fs::write(&path, &old).unwrap();
    let folders = [MailFolder::Mbox(path.clone())];
    let first = scan(
        dir.path(),
        &folders,
        &Cursor::default(),
        &ScanLimits::default(),
        later(),
    )
    .unwrap();
    let changed = format!(
        "{}{}{}{}",
        prefix,
        message("inserted", "new before old cursor"),
        message("growth", "growth"),
        "g".repeat(3000)
    );
    assert_eq!(&old.as_bytes()[..4096], &changed.as_bytes()[..4096]);
    assert!(changed.len() > old.len());
    fs::write(path, changed).unwrap();
    let next = scan(
        dir.path(),
        &folders,
        &first.cursor,
        &ScanLimits::default(),
        later(),
    )
    .unwrap();
    assert!(next
        .envelopes
        .iter()
        .any(|e| e.subject == "new before old cursor"));
}

#[test]
fn legacy_mbox_cursor_without_checkpoint_rescans_instead_of_trusting_a_head_only() {
    let dir = crate::testdir::tempdir().unwrap();
    let path = dir.path().join("INBOX");
    fs::write(&path, message("one", "one")).unwrap();
    let folders = [MailFolder::Mbox(path)];
    let first = scan(
        dir.path(),
        &folders,
        &Cursor::default(),
        &ScanLimits::default(),
        later(),
    )
    .unwrap();
    let mut value = serde_json::to_value(&first.cursor).unwrap();
    for folder in value["folders"].as_object_mut().unwrap().values_mut() {
        folder.as_object_mut().unwrap().remove("checkpoint");
    }
    let legacy: Cursor = serde_json::from_value(value).unwrap();
    let next = scan(
        dir.path(),
        &folders,
        &legacy,
        &ScanLimits::default(),
        later(),
    )
    .unwrap();
    assert_eq!(next.envelopes.len(), 1);
    assert_eq!(
        next.envelopes[0].message_ref,
        first.envelopes[0].message_ref
    );
}
