# WhatsApp Account Operations

WhatsApp support has two separate operating modes. Keep them separate:

- **Routed account**: participates in Orkestr chat routing, inbound delivery,
  assistant reply mirroring, release readiness gates, and broker policy.
- **Skill-only account**: used only by an explicit local skill or operator
  command. It must not be registered with the Orkestr router.

Use a routed account for the stable Orkestr bridge. Use a skill-only account
for occasional automation, account-specific checks, or attended actions that do
not need passive mirroring.

## Routed Account Configuration

Configure only the accounts that should route Orkestr traffic:

```bash
ORKESTR_WHATSAPP_ACCOUNT_IDS=sender
ORKESTR_WHATSAPP_STRICT_ACCOUNT_IDS=1
ORKESTR_WHATSAPP_AUTOSTART_ACCOUNT_IDS=sender
ORKESTR_WHATSAPP_DEFAULT_RESPONDER_ACCOUNT_ID=sender
ORKESTR_WHATSAPP_ACCOUNT_CLIENT_IDS=sender:codex-whatsapp
ORKESTR_WHATSAPP_ACCOUNT_SESSION_ROOTS=sender:/var/lib/orkestr/whatsapp/session-sender
```

`ORKESTR_WHATSAPP_STRICT_ACCOUNT_IDS=1` means persisted legacy connector
accounts and old role aliases are ignored unless they are also listed in
`ORKESTR_WHATSAPP_ACCOUNT_IDS`. This prevents retired accounts from being
restarted by account listing, recovery, or release checks.

Verify the router surface:

```bash
orkestr whatsapp accounts list --json
orkestr whatsapp accounts doctor --json
```

Release checks should require only routed accounts:

```bash
ORKESTR_RELEASE_REQUIRED_WHATSAPP_ACCOUNTS=sender \
orkestr update --release --ref <tag-or-sha> --channel <channel>
```

## Skill-Only Accounts

A skill-only WhatsApp account must use its own runtime:

- separate state directory
- separate WhatsApp Web LocalAuth/session directory
- separate local-only port
- separate token
- no public endpoint
- no Orkestr router binding
- no inbound forwarding
- no `ORKESTR_WHATSAPP_ACCOUNT_IDS` entry
- no `ORKESTR_WHATSAPP_AUTOSTART_ACCOUNT_IDS` entry

Example private skill runtime shape:

```bash
WA_STATE_DIR=/var/lib/orkestr/wa-skills/example/state
WA_SESSION_DIR=/var/lib/orkestr/wa-skills/example/session
WA_HTTP_HOST=127.0.0.1
WA_HTTP_PORT=18749
WA_HTTP_TOKEN=<local-secret>
```

The skill may expose explicit commands such as `status`, `pair-code`,
`send-text`, `chats`, and `history`, but it should only run when an operator or
agent intentionally invokes that skill.

## Phone Pairing Code Auth

Prefer phone-number pairing code auth for attended skill-only setup when QR
scanning is inconvenient. The bridge should request a code for a specific
international phone number and print the short-lived code. The operator then
uses WhatsApp's "Link with phone number" flow on the phone.

Public examples must use fake numbers:

```bash
wa-example pair-code --phone +4917600000000
```

Do not commit real phone numbers, session paths, tokens, pairing codes, QR
artifacts, or generated WhatsApp state to the OSS repo.

## Failure Modes

- If an old account appears in `orkestr whatsapp accounts list`, check for
  stale env files and persisted registry entries. With strict mode enabled, the
  process environment must contain only the routed account ids.
- If a skill-only account is shown by `orkestr whatsapp accounts list`, it has
  leaked into router configuration. Remove it from router env, autostart, and
  bindings.
- If two processes use the same LocalAuth directory, WhatsApp Web can disconnect
  or stall. Stop one owner before moving a session between embedded, external,
  and skill-only runtimes.
