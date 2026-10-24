# Require scanner coverage evidence

A successful scanner exit and empty findings file are insufficient coverage
evidence. Gitleaks 8.30.1 can return both after Git writes a diagnostic to stderr
and its patch reader scans zero commits. A fresh repository reproduced this with
Git's deprecation advice for the scanner's fixed graft-disabling setting.

The trusted child environment still disables system/global Git configuration,
replacement objects and graft files. It suppresses only that specific advice
through fixed command configuration, which overrides candidate-local advice.

The wrapper reduces bounded scanner diagnostics in memory to commit/byte counts
and an error flag. It never publishes raw diagnostics, paths, matches or source
content. Errors, missing or duplicate summaries, and zero coverage when the
same immutable Git range contains text additions fail closed. Empty and
deletion-only histories may legitimately report zero scanned content.

This detects the demonstrated empty-scan failure; counts alone are not proof of
every detector's correctness or exact per-file coverage. The pinned scanner,
history scope, separate merge diffs, secret redaction and existing evidence
publication checks remain required.

History statistics stream through a bounded numeric-column counter. The helper
retains at most 64 characters of row metadata and discards filenames instead of
buffering all Git numstat output. Histories whose metadata exceeds one MiB keep
their full immutable scope. Git errors, deadlines, malformed rows and integer
overflow still refuse coverage; no history is truncated to fit a buffer.

Actual scanner regressions cover a fresh nonempty repository, a known
credential-shaped fixture hidden behind candidate grafts/replacement refs, and
the exact reviewed inventory exception. Injected zero-summary and subprocess
output/error tests verify failure and bounded metadata handling independently.
