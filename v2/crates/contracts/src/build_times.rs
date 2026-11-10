//! Public release timestamps contain no runtime paths, credentials or uptime.
/// Bound seconds to the supported Gregorian display range (1970 through 2099).
pub fn timestamp(value: &str) -> Option<u64> {
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) { return None; }
    value.parse::<u64>().ok().filter(|v| *v <= 4_102_444_799)
}
/// UTC, independent of browser timezone and clock. No inferred "now" value.
pub fn display_timestamp(seconds: u64) -> Option<String> {
    if seconds > 4_102_444_799 { return None; }
    let days = seconds / 86400;
    let mut year = 1970_u64;
    let mut remaining = days;
    loop {
        let length = if leap(year) {366} else {365};
        if remaining < length {break;} remaining -= length; year += 1;
    }
    let months = [31, if leap(year) {29} else {28},31,30,31,30,31,31,30,31,30,31];
    let mut month = 0;
    while remaining >= months[month] {remaining -= months[month];month += 1;}
    Some(format!("{year:04}-{:02}-{:02} {:02}:{:02}:{:02} UTC",month+1,remaining+1,
        seconds/3600%24,seconds/60%60,seconds%60))
}
fn leap(year:u64)->bool { year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400)) }
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn utc_calendar_boundaries() {
        assert_eq!(display_timestamp(0).as_deref(),Some("1970-01-01 00:00:00 UTC"));
        assert_eq!(display_timestamp(951782400).as_deref(),Some("2000-02-29 00:00:00 UTC"));
        assert_eq!(display_timestamp(4102444799).as_deref(),Some("2099-12-31 23:59:59 UTC"));
        assert!(display_timestamp(4102444800).is_none());
        for value in ["", "-1", "1.1", " 1", "4102444800", "18446744073709551616"] {assert!(timestamp(value).is_none());}
    }
}
