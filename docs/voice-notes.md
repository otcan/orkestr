# WhatsApp Voice Notes

WhatsApp voice notes (attachment kind `ptt` or `audio`, or any `audio/*`
mimetype) are transcribed with OpenAI speech-to-text before the inbound message
is enqueued, so the thread's agent receives the spoken words instead of only a
file path.

## Behaviour

- The router transcribes after duplicate/echo filtering, target resolution, and
  inbound sender security, right before the thread input is built.
- Up to 3 voice notes per message are transcribed, one after another.
- The thread input text becomes the caption (if any) followed by one line per
  note:

  ```text
  🎤 Voice note (0:07, English): "Remind me to call Example Corp tomorrow."
  ```

  Language names are shown for `en`, `tr`, and `de`; other languages show the
  ISO code.
- The audio attachment is kept. A successful transcript is also stored on the
  attachment as `transcript: { text, model, languages, seconds }` so the WebUI
  and history keep it.
- On failure the attachment is kept and the line reads
  `🎤 Voice note: transcription unavailable (<code>)`, so the agent can still
  use the file. Codes: `transcription_timeout`, `transcription_http_<status>`,
  `transcription_too_large`, `transcription_no_key`,
  `transcription_budget_exceeded`, `transcription_rate_limited`,
  `transcription_empty`, `transcription_policy_blocked`.
- The total wait per message is bounded by the timeout; the message is always
  enqueued, never dropped.
- Nothing is sent back to WhatsApp. The transcript lives in the thread input
  only.

### Name correction

Keyword hints (`keywords[]`) are sent with every request: `Orkestr`, the
thread name, the binding name, the owner's display name, and
`ORKESTR_TRANSCRIPTION_KEYWORDS` (deduplicated, at most 40 entries of at most
40 characters). Afterwards a deterministic, offline pass replaces capitalized
words that sound like a single-word glossary entry (for example `Modex` ->
`Modeks` when `Modeks` is a keyword). Ordinary words are left alone.

## Scope

Owner decision: own chats only.

- Binding flag `transcribeVoiceNotes: true` enables transcription for the chat.
- `transcribeVoiceNotes: false` always disables it.
- When the flag is unset, a note is transcribed only when the sender is the
  owner/self account (the connected account itself, or a number listed in
  `ORKESTR_WHATSAPP_OWNER_CONTACT_IDS`) and the thread belongs to the WhatsApp
  owner user (`ORKESTR_WHATSAPP_OWNER_USER_ID`, else the admin user).
  Friend/client chats are therefore off by default.
- For non-owner senders (flag set to `true`), the transcript is screened by the
  same request classifier that screens typed WhatsApp text.

## Privacy

Audio is uploaded to OpenAI (or the configured compatible endpoint). Only
enable the flag for chats whose participants expect that. Transcript text, file
names, and keys are never written to `events.jsonl`, logs, or metrics; the only
events are `voice_transcription_completed { threadId, seconds, model, languages }`
and `voice_transcription_failed { threadId, code }`.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `ORKESTR_VOICE_TRANSCRIPTION` | auto | `0`/`off` disables; `1`/`on` forces on (missing key then shows `transcription_no_key`); unset means on when a key is available. |
| `ORKESTR_TRANSCRIPTION_MODEL` | `gpt-transcribe` | Model id. |
| `ORKESTR_TRANSCRIPTION_LANGUAGES` | `en,tr,de` | `languages[]` hints. |
| `ORKESTR_TRANSCRIPTION_KEYWORDS` | empty | Extra comma-separated keywords (use a private overlay for real names). |
| `ORKESTR_TRANSCRIPTION_TIMEOUT_MS` | `30000` | Total wait per message. |
| `ORKESTR_TRANSCRIPTION_DAILY_BUDGET_USD` | `5` | Daily spend cap across all voice notes. |
| `ORKESTR_TRANSCRIPTION_CHAT_HOURLY_LIMIT` | `60` | Notes per chat per hour. |
| `ORKESTR_TRANSCRIPTION_PRICE_PER_MINUTE_USD` | model price | Price override for the configured model. |
| `ORKESTR_TRANSCRIPTION_PRICES_JSON` | `{"gpt-transcribe":0.0045}` | Per-model price map (USD per minute). |
| `ORKESTR_TRANSCRIPTION_BASE_URL` | `OPENAI_BASE_URL` or `https://api.openai.com/v1` | Requests go to `<base>/audio/transcriptions`. |

## API key

Resolution order:

1. Secure secret `openai_api_key` (user, admin-managed, then global scope). Store
   it once as a global secret:

   ```bash
   orkestr secret set openai_api_key --global --stdin
   ```

2. `ORKESTR_OPENAI_API_KEY`
3. `OPENAI_API_KEY`
4. The `openai` connector config (`openaiApiKey`).

## Costs

`gpt-transcribe` is billed at $0.0045 per audio minute. Every successful call is
recorded in the credit ledger with `callKind: "voice_transcription"`,
`sourceChannel: "whatsapp"`, and cost `billed seconds / 60 * price`. Before each
call the day's voice-transcription spend is checked against the daily budget.
