use super::*;
use std::fs;

fn env(os: Os, home: &Path) -> DiscoveryEnv {
    DiscoveryEnv {
        os,
        home: Some(home.to_owned()),
        appdata: Some(home.join("AppData/Roaming")),
    }
}

#[test]
fn roots_differ_per_os() {
    let home = Path::new("/home/alex");
    assert_eq!(
        profile_roots(&env(Os::Linux, home))[0],
        home.join(".thunderbird")
    );
    assert!(profile_roots(&env(Os::Linux, home))
        .contains(&home.join(".var/app/org.mozilla.Thunderbird/.thunderbird")));
    assert_eq!(
        profile_roots(&env(Os::MacOs, home)),
        vec![home.join("Library/Thunderbird")]
    );
    assert_eq!(
        profile_roots(&env(Os::Windows, home)),
        vec![home.join("AppData/Roaming/Thunderbird")]
    );
}

#[test]
fn install_section_selects_the_default_profile() {
    let dir = crate::testdir::tempdir().unwrap();
    let root = dir.path().join(".thunderbird");
    fs::create_dir_all(root.join("aaaa.default")).unwrap();
    fs::create_dir_all(root.join("bbbb.default-esr")).unwrap();
    fs::write(
        root.join("profiles.ini"),
        "[Profile1]\nName=default\nIsRelative=1\nPath=aaaa.default\nDefault=1\n\n\
         [Profile0]\nName=default-esr\nIsRelative=1\nPath=bbbb.default-esr\n\n\
         [Install8216C80C92C4E828]\nDefault=bbbb.default-esr\nLocked=1\n\n\
         [Profile2]\nName=escape\nIsRelative=1\nPath=../outside\n",
    )
    .unwrap();
    let found = discover(&env(Os::Linux, dir.path()));
    assert_eq!(found.len(), 2);
    assert_eq!(found[0].name, "default-esr");
    assert!(found[0].default);
    assert!(!found[1].default);
}

#[test]
fn inbox_folders_find_maildir_and_mbox_and_extras() {
    let dir = crate::testdir::tempdir().unwrap();
    let p = dir.path();
    fs::create_dir_all(p.join("ImapMail/imap.gmail.com/INBOX/cur")).unwrap();
    fs::create_dir_all(p.join("ImapMail/imap.gmail.com/Jobs/cur")).unwrap();
    fs::create_dir_all(p.join("Mail/Local Folders")).unwrap();
    fs::write(p.join("Mail/Local Folders/Inbox"), b"").unwrap();
    fs::write(p.join("logins.json"), b"{}").unwrap();
    let folders = inbox_folders(p, &["Jobs".into(), "../x".into(), "logins.json".into()]);
    assert_eq!(
        folders,
        vec![
            MailFolder::Maildir(p.join("ImapMail/imap.gmail.com/INBOX")),
            MailFolder::Maildir(p.join("ImapMail/imap.gmail.com/Jobs")),
            MailFolder::Mbox(p.join("Mail/Local Folders/Inbox")),
        ]
    );
    assert!(is_secret_file("Key4.db"));
    assert!(!is_secret_file("INBOX"));
}

#[test]
fn sent_folders_cover_gmail_names() {
    let dir = crate::testdir::tempdir().unwrap();
    let p = dir.path();
    fs::create_dir_all(p.join("ImapMail/imap.gmail.com/[Gmail].sbd/Sent Mail/cur")).unwrap();
    fs::create_dir_all(p.join("ImapMail/imap.example.org")).unwrap();
    fs::write(p.join("ImapMail/imap.example.org/Sent"), b"").unwrap();
    assert_eq!(
        sent_folders(p),
        vec![
            MailFolder::Mbox(p.join("ImapMail/imap.example.org/Sent")),
            MailFolder::Maildir(p.join("ImapMail/imap.gmail.com/[Gmail].sbd/Sent Mail")),
        ]
    );
}
