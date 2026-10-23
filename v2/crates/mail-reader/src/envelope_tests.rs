use super::*;

const RAW: &[u8] = b"Authentication-Results: mx.google.com; dkim=pass header.i=@linkedin.com header.s=s1; spf=pass smtp.mailfrom=bounce.linkedin.com\r\n\
Authentication-Results: forged.example; dkim=pass header.i=@evil.example\r\n\
From: \"LinkedIn\" <Jobs-NoReply@LinkedIn.com>\r\n\
Subject: =?UTF-8?Q?Alex,_your_application_was_sent_to_Acme?=\r\n\
Date: Tue, 20 Oct 2026 09:00:00 +0000\r\n\
Message-ID: <a1@linkedin.com>\r\n\
List-Unsubscribe: <https://www.linkedin.com/unsub>\r\n\r\n\
View: https://www.linkedin.com/comm/jobs/view/4012345678/?trk=x.\r\n";

#[test]
fn envelope_fields_are_normalised() {
    let e = parse(RAW);
    assert_eq!(e.message_ref, message_ref("<a1@linkedin.com>"));
    assert_eq!(e.message_ref.len(), 24);
    assert_eq!(e.date_ms, Some(1_792_486_800_000));
    assert_eq!(e.from_name, "LinkedIn");
    assert_eq!(e.from_addr, "jobs-noreply@linkedin.com");
    assert_eq!(e.sender_domain, "linkedin.com");
    assert_eq!(e.subject, "Alex, your application was sent to Acme");
    assert_eq!(
        e.links,
        vec!["https://www.linkedin.com/comm/jobs/view/4012345678/?trk=x"]
    );
    assert_eq!(e.authserv.as_deref(), Some("mx.google.com"));
    assert!(e.list_unsubscribe);
    assert!(!e.expunged);
    assert!(e.dkim_aligned(&["mx.google.com".into()]));
    // Only the topmost (receiving server's) header counts.
    assert_eq!(e.auth.len(), 2);
    assert!(!e.dkim_aligned(&["forged.example".into()]));
}

#[test]
fn missing_message_id_distinguishes_body_and_recipient_but_ignores_local_flags() {
    let a = parse(b"From: a@example.com\r\nSubject: s\r\nDate: x\r\n\r\nbody");
    let b = parse(b"From: a@example.com\r\nSubject: s\r\nDate: x\r\n\r\nother body");
    assert_ne!(a.message_ref, b.message_ref);
    assert_eq!(a.date_ms, None);
    let to_a =
        parse(b"From: a@example.com\r\nTo: one@example.org\r\nSubject: s\r\nDate: x\r\n\r\nbody");
    let to_b =
        parse(b"From: a@example.com\r\nTo: two@example.org\r\nSubject: s\r\nDate: x\r\n\r\nbody");
    assert_ne!(to_a.message_ref, to_b.message_ref);
    let flagged = parse(b"X-Mozilla-Status: 0001\r\nFrom: a@example.com\r\nTo: one@example.org\r\nSubject: s\r\nDate: x\r\n\r\nbody");
    assert_eq!(to_a.message_ref, flagged.message_ref);
}

#[test]
fn alignment_uses_the_organisational_domain() {
    assert_eq!(org_domain("us.greenhouse-mail.io"), "greenhouse-mail.io");
    assert_eq!(org_domain("mail.example.co.uk"), "example.co.uk");
    let mut e = parse(b"From: x@us.greenhouse-mail.io\r\nAuthentication-Results: mx.google.com; dkim=pass header.d=greenhouse-mail.io\r\n\r\n");
    assert!(e.dkim_aligned(&["mx.google.com".into()]));
    assert!(!e.dkim_aligned(&[]));
    e.auth[0].result = "fail".into();
    assert!(!e.dkim_aligned(&["mx.google.com".into()]));
}

#[test]
fn shared_hosting_siblings_are_not_treated_as_one_signing_domain() {
    let e = parse(b"From: x@victim.github.io\r\nAuthentication-Results: mx.google.com; dkim=pass header.d=attacker.github.io\r\n\r\n");
    assert!(!e.dkim_aligned(&["mx.google.com".into()]));
}

#[test]
fn addresses_parse_with_and_without_names() {
    assert_eq!(
        parse_address("Riley Recruiter via LinkedIn <inmail-hit-reply@linkedin.com>"),
        (
            "Riley Recruiter via LinkedIn".into(),
            "inmail-hit-reply@linkedin.com".into()
        )
    );
    assert_eq!(
        parse_address("plain@Example.com"),
        (String::new(), "plain@example.com".into())
    );
}

#[test]
fn thunderbird_expunged_flag_is_detected() {
    let e = parse(b"X-Mozilla-Status: 0009\r\nFrom: a@example.com\r\n\r\n");
    assert!(e.expunged);
}

#[test]
fn recipients_reply_references_and_bulk_markers() {
    let e = parse(b"From: Alex <alex@example.com>\r\nTo: \"Hays, Recruiting\" <Projekte@hays.de>, b@example.org\r\n\
In-Reply-To: <r2@hays.de>\r\nReferences: <r1@hays.de> <r2@hays.de>\r\n\r\n");
    assert_eq!(
        e.to,
        vec![
            ("Hays, Recruiting".into(), "projekte@hays.de".into()),
            (String::new(), "b@example.org".into())
        ]
    );
    assert_eq!(
        e.reply_refs,
        vec![message_ref("<r2@hays.de>"), message_ref("<r1@hays.de>")]
    );
    assert!(!e.bulk);
    assert!(parse(b"Precedence: bulk\r\n\r\n").bulk);
    assert!(parse(b"List-Id: <news.example.org>\r\n\r\n").bulk);
    assert!(parse(b"X-Campaign-Id: 42\r\n\r\n").bulk);
}
