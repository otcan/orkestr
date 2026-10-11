# Feasibility note: WhatsApp and AI-plan usage for Setups

Status: read-only investigation, 2026-10-11. Not legal advice. Each claim is
marked by source quality.

## WhatsApp

- **What Orkestr uses (verified in code):** `whatsapp-web.js` 1.34.7, which automates the consumer WhatsApp Web client. It is not the official WhatsApp Business Platform. There is no outbound rate limit and no terms or ban-risk document in the repo.
- **Terms (primary source):** the WhatsApp Terms of Service (EEA), section "Harm to WhatsApp or our users", prohibit accessing or using the Services "through automated or other means" in unauthorized ways, reverse engineering, and creating accounts through "unauthorized or automated means". The Acceptable Use section allows WhatsApp to disable or suspend accounts. Source: https://www.whatsapp.com/legal/terms-of-service-eea
- **Enforcement (secondary sources, several from vendors selling official-API services):** detection is behavioural, based on messaging non-contacts, block and report rates, bursts and automation signatures. Temporary bans are reported first, permanent ones on repeat. Users report bans even for low-volume, reply-only use of unofficial clients.
- **Consequence for Setups:**
  - WhatsApp stays optional and owner-only, and is never connected by install.
  - The binding step must show a plain ban-risk notice.
  - Add an outbound rate limit and owner-only recipients before any Setup sends proactive check-ins over WhatsApp.
  - Never call it "official WhatsApp".
- **Official route:** the WhatsApp Business Platform (Cloud API) needs a Meta business account, a dedicated number, approved templates for messages outside the 24-hour customer service window, and per-message charges (per-message pricing since 1 July 2025). Secondary sources disagree on whether in-window service messages are still free after October 2026; check Meta's pricing page before any cost claim. It is not suitable as a zero-setup default for this target user.

## AI plans

- **ChatGPT / Codex (primary help article):** Codex is included with ChatGPT plans, and usage limits and credits vary by plan. The help article gives no fixed numbers. Source: https://help.openai.com/en/articles/11369540
- **Claude Code (primary support article):** Claude and Claude Code share one usage limit on Pro and Max plans. When the limit is hit, you wait for the reset or buy extra usage. If `ANTHROPIC_API_KEY` is set, Claude Code bills the API instead of the plan. Source: https://support.claude.com/en/articles/11145838
- **Open question:** whether scheduled, unattended use of a consumer subscription is permitted. I did not find a primary statement either way. Review OpenAI's and Anthropic's consumer terms before marketing scheduled automations on personal plans.
- **Orkestr already detects limits:** Codex `rateLimits` and the Claude 5-hour and weekly windows (`/api/quota/providers`). A Setup must surface "limit reached, next check-in after reset" instead of failing silently.

## Claims

Allowed once verified:
- "Uses your own ChatGPT or Claude sign-in; usage counts against your plan's limits."
- "Optional WhatsApp, at your own risk."

Not allowed:
- "€0 extra". A host or VPS, a phone number and extra plan usage can cost money.
- "Covers API costs".
- "Official WhatsApp".
- "24/7" or "unlimited".
- "Automated LinkedIn". LinkedIn stays drafts only, and `LINKEDIN_VISIBLE_MANUAL_SEND_REQUIRED` is already enforced in code.
