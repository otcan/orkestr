//! Bounded locators reported in accepted answers, never file-read receipts.
const MAX_SCAN_BYTES: usize = 32_768;
const MAX_REFERENCES: usize = 4;
const MAX_LOCATOR_BYTES: usize = 512;

fn locator(candidate: &str) -> Option<&str> {
    let candidate = candidate.trim();
    let candidate = candidate
        .strip_prefix('<')
        .and_then(|s| s.strip_suffix('>'))
        .unwrap_or(candidate);
    if candidate.len() > MAX_LOCATOR_BYTES
        || candidate.chars().any(char::is_control)
        || !(candidate.starts_with('/') && !candidate.starts_with("//")
            || candidate.starts_with("https://"))
    {
        return None;
    }
    Some(candidate)
}

pub(super) fn references(text: &str) -> Vec<String> {
    let mut end = text.len().min(MAX_SCAN_BYTES);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    let text = &text[..end];
    let mut references = Vec::new();
    // Only explicit Markdown link targets and inline-code absolute paths.
    // We do not interpret instructions, resolve paths or access their contents.
    let candidates = text
        .match_indices("](")
        .filter_map(|(start, _)| {
            let rest = &text[start + 2..];
            rest.find(')').map(|end| &rest[..end])
        })
        .chain(
            text.split('`')
                .enumerate()
                .filter_map(|(i, part)| (i % 2 == 1).then_some(part)),
        );
    for candidate in candidates {
        if let Some(path) = locator(candidate) {
            if !references.iter().any(|existing| existing == path) {
                references.push(path.to_owned());
                if references.len() == MAX_REFERENCES {
                    break;
                }
            }
        }
    }
    references
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_late_references_without_claiming_contents() {
        let text = format!("{} [report](/workspace/reports/result.json) `/workspace/results.csv` [again](/workspace/reports/result.json)", "summary ".repeat(100));
        assert_eq!(
            references(&text),
            ["/workspace/reports/result.json", "/workspace/results.csv"]
        );
    }

    #[test]
    fn rejects_unbounded_unsafe_or_implicit_locators() {
        let text = format!("[bad](javascript:run) [relative](../report) [network](//host/report) [control](/bad\npath) [long](/{} ) /implicit/path [ok](</workspace/report.csv>)", "x".repeat(513));
        assert_eq!(references(&text), ["/workspace/report.csv"]);
        assert!(references(&format!("{}[late](/ignored)", "é".repeat(MAX_SCAN_BYTES))).is_empty());
        assert_eq!(
            references("[/a](/a) [/b](/b) [/c](/c) [/d](/d) [/e](/e)").len(),
            MAX_REFERENCES
        );
    }
}
