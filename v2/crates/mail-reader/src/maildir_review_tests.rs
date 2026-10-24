//! Live Maildir churn, unsafe entries and seen-before-open regressions.
use super::*;

#[test]
fn deleted_listed_entry_is_skipped_before_following_mail_is_read() {
    let dir = crate::testdir::tempdir().unwrap();
    let root = dir.path().join("maildir");
    fs::create_dir_all(root.join("cur")).unwrap();
    let removed = root.join("cur/removed");
    fs::write(&removed, "synthetic mail").unwrap();
    let scope = Scope::new(dir.path()).unwrap();
    let listed = root.join("cur").join(
        scope
            .entries(&root.join("cur"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap(),
    );
    fs::remove_file(&removed).unwrap();
    let mut stats = ScanStats::default();
    assert!(maildir::open_entry(&scope, &listed, &mut stats)
        .unwrap()
        .is_none());
    assert_eq!(stats.skipped_missing, 1);
    fs::write(root.join("cur/following"),b"Message-ID: <following@example.test>\nFrom: person@example.test\nSubject: Following\n\nbody\n").unwrap();
    let out = scan(
        dir.path(),
        &[MailFolder::Maildir(root)],
        &Cursor::default(),
        &ScanLimits::default(),
        SystemTime::now() + Duration::from_secs(60),
    )
    .unwrap();
    assert_eq!(out.envelopes.len(), 1);
    assert_eq!(out.envelopes[0].subject, "Following");
}

#[cfg(unix)]
#[test]
fn seen_entries_are_filtered_without_opening_even_if_they_became_aliases() {
    use std::os::unix::fs::symlink;
    let dir = crate::testdir::tempdir().unwrap();
    let root = dir.path().join("maildir");
    fs::create_dir_all(root.join("cur")).unwrap();
    let mut seen = BTreeSet::new();
    for n in 0..128 {
        let name = format!("seen-{n:03}");
        symlink("/does-not-exist", root.join("cur").join(&name)).unwrap();
        seen.insert(name);
    }
    fs::write(
        root.join("cur/fresh"),
        b"Message-ID: <fresh@example.test>\nFrom: person@example.test\nSubject: Fresh\n\nbody\n",
    )
    .unwrap();
    let folder = MailFolder::Maildir(root);
    let cursor = Cursor {
        folders: BTreeMap::from([(folder.key(), FolderCursor::Maildir { seen, after: None })]),
    };
    let out = scan(
        dir.path(),
        &[folder],
        &cursor,
        &ScanLimits::default(),
        SystemTime::now() + Duration::from_secs(60),
    )
    .unwrap();
    assert_eq!(out.envelopes.len(), 1);
    assert_eq!(
        out.stats.skipped_unsafe, 0,
        "opening seen aliases would count128 refusals"
    );
    assert_eq!(out.stats.skipped_missing, 0);
}

#[cfg(unix)]
#[test]
fn selected_profile_with_symlinked_parent_is_refused() {
    use std::os::unix::fs::symlink;
    let dir = crate::testdir::tempdir().unwrap();
    let parent = dir.path().join("real");
    let profile = parent.join("profile");
    fs::create_dir_all(&profile).unwrap();
    symlink(&parent, dir.path().join("alias")).unwrap();
    assert!(Scope::new(&profile).is_ok());
    assert!(Scope::new(&dir.path().join("alias/profile")).is_err());
}
