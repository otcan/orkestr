# Connect Codex to Orkestr and check your first conversation

For new self-hosters who can open Orkestr but have not yet received a model
answer. This tutorial follows **v2.0.0-beta.6**, public source commit
`114a49fbefc97449e74b3cf74be27c3deebfa135`. Sources checked: **19 November 2026**.
It covers browser model connection and a small, repeatable conversation check.

**Review draft:** the released setup code and offline tests were checked for
this tutorial. A fresh browser sign-in and the example conversation have not
been rerun with a real provider account for this draft. The expected answers
below are calculated examples, not captured model responses.

## Start with the same release

Use the [pinned release quick start][release] to install beta.6 and create your
local Orkestr account. This is the product entry point for this tutorial; it
includes the image name and complete Docker command. Continue here once you can
sign in at **http://127.0.0.1:19822**. Keep that exact origin, including the IP
address and port, throughout setup.

In beta.6, **First-time setup** asks for the local bootstrap token and an
Orkestr username/password. That account opens your local installation; it is
separate from your ChatGPT account. A development checkout may instead show
**Create your account** without a token. Do not combine that newer source flow
with beta.6 instructions or reinstall just to make the screens match.

You need your own ChatGPT sign-in for Codex. Claude is optional. This release
requires the ChatGPT device sign-in; an OpenAI API key does not replace it.
Keep setup tokens, provider codes and credentials out of conversations and
issue reports. Enter account information only in the corresponding private
setup form or provider sign-in page.

## Connect the model in the browser

1. Sign in to your local Orkestr account, then choose **Connect models**.
   If the setup page says **Not signed in**, return to Orkestr and sign in
   before reopening it.
2. Choose **Sign in to Codex**. Orkestr shows an official OpenAI link and a
   one-time device code. Open that link, sign in to ChatGPT yourself, and enter
   the code on the provider page. Only approve a sign-in you started.
3. Return to the Orkestr setup page. Wait for the Codex badge to say
   **signed in**. Seeing a link or a code alone does not complete the login.
4. Optionally choose **Sign in to Claude** before activating. Open the displayed
   Claude link, approve on Claude's site, then paste the returned code into
   the setup page's **Claude code** field and choose **Submit code**. Wait for
   its **signed in** badge. Skip this step for a Codex-only check.
5. In **Finish**, confirm the same local Orkestr username/password you used to
   sign in. Choose **Activate models** and let the page reload into Orkestr.
   Activation is designed to finish without a container restart. The setup UI
   describes about a minute; treat that as guidance, not a deadline guarantee.

Beta.6 records whether Claude is connected during activation. Connect it before
activating if you want Fast to use Claude. With Codex alone, Fast also uses
Codex. The configured setup service closes; its disappearance afterward does
not, by itself, mean a provider login failed.

## Run a small conversation check

Open the global conversation or create a new one. Use only the fictional task
rows below. A [downloadable CSV](examples/first-conversation-tasks.csv) contains
the same rows, but the prompt includes them so no file tool or upload is needed.

Copy this message into the conversation:

```text
Only analyze these fictional rows. Do not modify files, connect accounts,
send messages elsewhere or start background tasks.
Count tasks in each status (done, queued, blocked), and list the blocked IDs.

id,task,status
T01,Write a sample welcome note,done
T02,Check a fictional checklist,queued
T03,Label sample folders,queued
T04,Review an example diagram,blocked
T05,Read a sample paragraph,done
```

The answer should mean:

| Status | Count |
| --- | ---: |
| done | 2 |
| queued | 2 |
| blocked | 1 |

The blocked ID is **T04**. Wording and formatting can differ. Beta.6 exposes
Fast and Deep separately and can show two replies; do not interpret a second
reply as a second setup attempt. Check each substantive answer for correctness.
An **Available** badge alone does not prove either role answered.

After the turn finishes, send this follow-up in the **same conversation**:

```text
Using the same fictional table, pretend T03 is now done. What are the three
status counts, and which ID remains blocked? This is hypothetical; do not
update files or start any task.
```

The expected counts are **done: 3, queued: 1, blocked: 1**, with **T04** still
blocked. This checks whether the reply uses the preceding table. It does not
prove filesystem access, browser control, scheduled work or an external
connector. A correct hypothetical answer changes no task system.

## Record what actually worked

Use this checklist for your own installation. Leave a row unverified until you
observe it; the source review and offline tests do not fill it in for you.

| Check | What counts as evidence |
| --- | --- |
| Local account | You can sign in at the exact loopback URL. |
| Provider login | The provider approval completes and Codex shows **signed in**. |
| Activation | **Activate models** returns you to the conversation. |
| First answer | A real reply has counts 2 / 2 / 1 and blocked ID T04. |
| Continuity | The follow-up has counts 3 / 1 / 1 and still names T04. |
| Role coverage | Record which of Fast and Deep actually replied; do not infer the other. |

For a review report, record the image tag, operating system/architecture, which
steps passed, the role observed and a sanitized error name. These synthetic
rows are safe to quote. Do not attach raw logs, provider approval URLs/codes,
account identifiers, cookies or credentials.

## If you get stuck

| Observation | Next useful check |
| --- | --- |
| Cannot reach the local page | Return to installation diagnostics; model sign-in cannot repair a stopped Docker engine. |
| Setup says **Not signed in** | Sign in to the local Orkestr account at the same origin, then reopen setup. |
| Codex is **waiting for you** | Finish the device approval on the provider page; a displayed code is not a completed sign-in. |
| Sign-in expired or failed | Start a fresh sign-in from setup. Keep any new code private. |
| Setup asks you to wait 30 seconds | Respect the displayed rate limit rather than starting repeated login attempts. |
| Activation says **Sign in to Codex first** | Confirm Codex itself shows **signed in**; Claude alone is insufficient. |
| Activation rejects the local account | Use the same Orkestr account currently signed in, in the private Finish form. |
| Models appear available but no answer arrives | Record setup as complete and the conversation check as unverified; availability is not answer evidence. |
| The answer loses the table | Check that the follow-up stayed in the same conversation and followed a finished turn. Record the mismatch. |

Do not delete volumes, reset provider logins or rerun an installer as a first
response to a failed example. Report the failed layer separately from the
layers that worked. The [install issue template](../../../.github/ISSUE_TEMPLATE/install_problem.md)
lists useful environment details for a sanitized report.

## Public source references

These links pin the behavior described above, rather than following a moving
development branch:

- [Released V2 quick start and conversation checks][quickstart].
- [Setup form labels, required Codex and optional Claude][form].
- [Browser sign-in states, errors and activation reload][browser].
- [Setup service tests: parsing, sessions, rate limits and owner checks][tests].

This repository draft creates no website route. GitHub controls the page's
canonical and robots behavior; search indexing is unknown. It is not in the
product website sitemap. Repository Markdown has no project-controlled CTA
click event, so no analytics event or conversion is claimed.

[release]: https://github.com/otcan/orkestr/releases/tag/v2.0.0-beta.6#quick-start
[quickstart]: https://github.com/otcan/orkestr/blob/114a49fbefc97449e74b3cf74be27c3deebfa135/v2/README.md
[form]: https://github.com/otcan/orkestr/blob/114a49fbefc97449e74b3cf74be27c3deebfa135/v2/packaging/oss/setup/index.html
[browser]: https://github.com/otcan/orkestr/blob/114a49fbefc97449e74b3cf74be27c3deebfa135/v2/packaging/oss/setup/setup.js
[tests]: https://github.com/otcan/orkestr/blob/114a49fbefc97449e74b3cf74be27c3deebfa135/v2/packaging/oss/tests/test_setup_service.py
