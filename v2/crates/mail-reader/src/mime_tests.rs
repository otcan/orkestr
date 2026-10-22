use super::*;

#[test]
fn headers_unfold_and_split_at_the_first_blank_line() {
    let raw = b"Subject: one\r\n two\r\nFrom: A <a@example.com>\r\n\r\nbody\r\n\r\nmore";
    let (h, body) = split(raw);
    assert_eq!(h.get("subject"), Some("one two"));
    assert_eq!(h.get("FROM"), Some("A <a@example.com>"));
    assert_eq!(body, b"body\r\n\r\nmore");
    let (h, body) = split(b"Subject: only headers");
    assert_eq!(h.get("Subject"), Some("only headers"));
    assert!(body.is_empty());
}

#[test]
fn encoded_words_decode_b_and_q_in_several_charsets() {
    assert_eq!(decode_words("=?UTF-8?B?SWhyZSBCZXdlcmJ1bmc=?= bei X"), "Ihre Bewerbung bei X");
    assert_eq!(
        decode_words("=?ISO-8859-1?Q?Vorstellungsgespr=E4ch_am_Montag?="),
        "Vorstellungsgespräch am Montag"
    );
    // Whitespace between adjacent encoded words is dropped.
    assert_eq!(decode_words("=?utf-8?q?Hallo?= =?utf-8?q?_Welt?="), "Hallo Welt");
    assert_eq!(decode_words("plain =?bogus"), "plain =?bogus");
}

#[test]
fn transfer_encodings_and_charsets() {
    assert_eq!(base64_decode(b"SGVs\r\nbG8="), b"Hello");
    assert_eq!(quoted_printable(b"f=C3=BCr=\r\n Sie", false), "für Sie".as_bytes());
    assert_eq!(decode_charset("windows-1252", &[0x93, b'x', 0x94, 0x80]), "“x”€");
    assert_eq!(decode_charset("iso-8859-1", &[0xFC]), "ü");
    assert_eq!(decode_charset("unknown-8", "ok ✓".as_bytes()), "ok ✓");
}

#[test]
fn multipart_alternative_keeps_plain_and_html_and_skips_attachments() {
    let raw = b"Content-Type: multipart/mixed; boundary=\"outer\"\r\n\r\n\
--outer\r\nContent-Type: multipart/alternative; boundary=inner\r\n\r\n\
--inner\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nGr=C3=BC=C3=9Fe\r\n\
--inner\r\nContent-Type: text/html\r\n\r\n<p>Hi <a href=\"https://jobs.lever.co/x/1?utm_source=a&amp;b=2\">job</a></p><style>p{}</style>\r\n\
--inner--\r\n\
--outer\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename=cv.txt\r\n\r\nSECRET CV\r\n\
--outer--\r\n";
    let (h, body) = split(raw);
    let c = content(&h, body);
    assert_eq!(c.plain.as_deref(), Some("Grüße"));
    assert_eq!(c.html.as_deref().map(str::trim), Some("Hi job"));
    assert_eq!(c.html_links, vec!["https://jobs.lever.co/x/1?utm_source=a&b=2"]);
}

#[test]
fn html_text_drops_scripts_and_decodes_entities() {
    let (text, links) = html_to_text(
        "<html><head><title>t</title></head><body><script>var x='<p>'</script>A&nbsp;&amp;&#x42;&#67;<br>D &bogus; E</body></html>",
    );
    assert_eq!(text, "A &BC\nD &bogus; E");
    assert!(links.is_empty());
}

#[test]
fn hostile_input_never_panics() {
    for raw in [
        &b"Content-Type: multipart/mixed; boundary=\r\n\r\n--\r\n"[..],
        b"Content-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\n--x\r\n--x",
        b"Content-Type: text/html\r\n\r\n<a href=\"unterminated",
        b"Subject: =?utf-8?B?",
        b"\xff\xfe\x00:\r\n\r\n=",
    ] {
        let (h, body) = split(raw);
        let _ = content(&h, body);
        let _ = decode_words(h.get("Subject").unwrap_or_default());
    }
}
