# Durable Claude worker authentication

Unattended Claude Code workers can use an account-scoped subscription token.
This remains subscription authentication, not an Anthropic API billing switch.
The normal attended browser-login path remains available for profiles without
a configured worker token.

## Setup and rotation

1. On a trusted computer with Claude Code installed, run `claude setup-token`
   and authorize the intended subscription in Claude's browser flow.
2. In Orkestr's **Coding agent accounts**, select **Set up long-lived login**
   for the exact profile and paste the token into the password field.
   Never paste the token in chat, issue trackers, logs, or shell arguments.
3. Select **Save and verify**. This performs a small model request using the
   subscription. A saved token is not ready until that request succeeds.
4. For renewal, use **Rotate worker token** on the same profile. Threads keep
   their existing opaque profile binding. Provider revocation or expiry can
   still require attended authorization; this is not an infinite login.

Claude documents a one-year lifetime for newly generated setup tokens. An
imported token's issuance/expiry cannot be established from its opaque value;
Orkestr displays its configuration date, not a fabricated expiry guarantee.
See [Claude authentication](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token).

## Security and operational behavior

- The authenticated owner-scoped `POST /api/llm-accounts/:profileId/subscription-token`
  accepts `{ "token": "<subscription-token>" }`. Ownership is resolved on the
  server; credential paths are never client inputs.
- Tokens are persisted in the existing private account registry, mode `0600`
  under the user's protected secrets directory. Normal profile resolution,
  list/get responses, audit events and CLI arguments never include the token.
  Host-global provider credentials remain excluded from child environments.
- Only the selected profile's token is injected into its Claude process via
  `CLAUDE_CODE_OAUTH_TOKEN`. Deployment/restart does not replace the registry.
  Treat backups of that registry as credentials. Provider revocation is still
  necessary if a backup or credential is exposed.
- Save/rotation marks the account unverified, increments a credential revision,
  and fences stale verification results and stale runtime failure updates.
  In-flight work is not replayed or forcibly interrupted on rotation. Revoking
  the Orkestr profile deletes its local token and uses the existing thread
  interruption path; it does not revoke the credential at Anthropic.
- Verification does not trust `claude auth status`. It makes a bounded,
  tool-free model request with hooks, skills and MCP disabled, no thread
  resumption and no session persistence. Concurrent verification of the same
  credential revision is coalesced. Raw stdout/stderr are never returned.
- Rate limits, authentication rejection, and timeout/unavailable states remain
  distinct. A successful probe proves that one model request worked, not the
  subscription tier or remaining capacity. Failed user tasks are never replayed.
- Browser login is refused for a token-backed profile to avoid a misleading
  successful login while the higher-priority token remains invalid. Rotate the
  token, or revoke that profile and explicitly create a browser-login profile.

## Validation before production activation

Run the Claude subscription-token, login-safety, runtime, MCP-policy and UI test
suites; build server/web and verify the static bundle. After release, the owner
must configure a real token through the protected UI and obtain a successful
model-request verification. Then explicitly submit one worker delivery probe.
Synthetic tests alone do not establish live provider or WhatsApp delivery.
