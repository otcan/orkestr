use orkestr_v2_ui::build_identity::{identity, parse, RECORD};
#[test]
fn exact_web_record_matches_package_version_and_full_source() {
    let sha = "a".repeat(40);
    let record = format!("ORKESTR_V2_BUILD_IDENTITY_V1|web|2.0.0-dev|{sha}|END");
    let build = parse(&record, "2.0.0-dev");
    assert_eq!(build.component, "web");
    assert_eq!(build.source_commit, Some(sha.as_str()));
    assert!(build.error.is_none());
    for invalid in [
        record.replace("|web|", "|server|"),
        record.replace("2.0.0-dev", "2.0.0-rc.1"),
        record.replace(&sha, &"A".repeat(40)),
        record.replace("|END", "|END|extra"),
    ] {
        let build = parse(&invalid, "2.0.0-dev");
        assert!(build.error.is_some());
        assert!(build.source_commit.is_none());
    }
}
#[test]
fn unpinned_is_explicit_not_a_fabricated_source() {
    let build = parse(
        "ORKESTR_V2_BUILD_IDENTITY_V1|web|2.0.0-dev|unknown|END",
        "2.0.0-dev",
    );
    assert!(build.error.is_none());
    assert!(build.source_commit.is_none());
    assert_eq!(identity(), parse(RECORD, env!("CARGO_PKG_VERSION")));
    let json = serde_json::to_value(build).unwrap();
    assert!(json["source_commit"].is_null());
}
