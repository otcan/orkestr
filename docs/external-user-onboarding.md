# External User Onboarding

This is the public-safe beta flow for inviting a non-admin user into Orkestr.
Keep real phone numbers, WhatsApp chat IDs, OAuth secrets, browser profiles, and
private overlays outside the OSS repo.

## Public Site

Use `https://orkestr.example.test` as the public information site:

- no login required
- clear "invite-only private beta" positioning
- links to the OSS repository
- links to Terms, Privacy, Acceptable Use, Data Deletion, Support, and Beta pages
- app entry link for invited users

Plain HTTP should redirect to HTTPS at the deployment/proxy layer.

## Invite Message

Generate the current invite copy from the admin API:

```bash
curl "$ORKESTR_URL/api/users/onboarding/invite-template?channel=whatsapp&name=Can"
```

Default WhatsApp copy:

```text
Hi Can, I invited you to try Orkestr.
Orkestr is an invite-only beta assistant you can use from WhatsApp. It can help with your own files, timers, managed browser work, and accounts you choose to connect.
Before I create your private Orkestr chat, please read: https://orkestr.example.test/terms and https://orkestr.example.test/privacy
If you agree, reply exactly: I agree to use Orkestr beta with my own accounts
After that I will create your private chat and send the first message there. App entry for invited users: https://orkestr.example.test/app
```

Only continue after the user explicitly accepts the beta terms.

## Operator Flow

1. Send the invite message.
2. Wait for explicit consent.
3. Create or update the user with role `user` and a one-thread limit.
4. Create the WhatsApp group using the configured connection name.
5. Bind the WhatsApp sender/chat identity to that user.
6. Create the first isolated thread owned by that user.
7. Prepare the user-scoped managed desktop if desktop work is expected.
8. Let the user connect requested services through chat using parent-managed
   OAuth apps.
9. Send a real WhatsApp `hi` and verify the assistant gives a useful reply.

Use only routed WhatsApp accounts for this flow. Operator or test phones that
exist as skill-only accounts must not be added to the user's router binding.

Generate the provisioning checklist:

```bash
curl "$ORKESTR_URL/api/users/onboarding/provisioning-checklist?userId=can&connectionName=can-test&consented=true"
```

## User Flow

1. The user reads the public Terms and Privacy pages.
2. The user replies with the consent phrase.
3. The user joins or receives the private WhatsApp chat.
4. The user sends a normal first message, such as `Hi`.
5. Orkestr answers in chat and explains what it can do for that user.
6. If the user asks to connect Gmail, Outlook, Jira, Shopify, or another
   supported connector, Orkestr starts a parent-managed OAuth flow for that
   user. The user does not create OAuth apps.
7. If the user needs browser work, Orkestr uses the user-scoped managed desktop.
8. Skills are created and managed through chat and API only. There is no skill
   creation UI.

## Support And Offboarding

Users can request support from chat or through the user API:

```bash
curl -X POST "$ORKESTR_URL/api/users/me/support" \
  -H "Content-Type: application/json" \
  -d '{"type":"pause","message":"Please pause my account while this is checked."}'
```

Admin pause/offboarding:

```bash
curl -X POST "$ORKESTR_URL/api/users/can/offboard" \
  -H "Content-Type: application/json" \
  -d '{"action":"pause","revokeConnectors":true,"stopTimers":true}'
```

Pause disables the user and can revoke connector identities and user timers. It
preserves files and workspaces unless an operator deletes them separately after
export and review.
