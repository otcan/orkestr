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
  🎤 Voice note (0:07): "Remind me to call Example Corp tomorrow."
  ```

  The header carries no language: the transcription label is biased by the
  language hints and can be wrong. Translation lines name their target
  language (`↳ English: ...`).
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

### Speaker labels for recordings

Forwarded recordings and audio files (attachment kind `audio`) are sent to the
diarize model (`gpt-4o-transcribe-diarize`, `response_format=diarized_json`,
`chunking_strategy=auto`); voice notes recorded in the chat (kind `ptt`) keep
the normal model. Consecutive segments of the same speaker are merged into one
turn and each turn gets the name correction pass. With two or more speakers the
input reads:

```text
🎤 Recording (1:15, 2 speakers):
Speaker A: "Hi, is the demo ready?"
Speaker B: "Almost. It works on staging."
```

With a single speaker the line looks like a normal voice note (without a
language). The transcript is stored as
`transcript: { text, model, seconds, speakers, turns: [{ speaker, start, text }] }`.
If the diarize call fails, the note is retried once with the normal model
(event `voice_diarization_failed { threadId, code }`), then the usual
unavailable line applies. Screening, budget, rate limit, credits, events, and
health counters work as for normal notes.

Limitations of the diarize model: it accepts no keyword or language hints, so
names rely on the offline correction pass only; speakers are labelled `A`,
`B`, ... (no names); and it returns no language, so recordings rely on the
translation check below to decide whether to translate.

### Translation

After a transcript is accepted it is translated with the Responses API
(`POST <base>/responses`, model `gpt-6-luna`) when it is not in one of the
understood languages. Transcription language labels are not reliable for this
(the transcription request hints the understood languages, so a Spanish note
can come back labelled English, and recordings have no label), so:

- a label outside the understood languages forces a translation;
- otherwise the translation model checks the text itself and replies
  `NO_TRANSLATION` when it is (mostly) in an understood language, which adds no
  line. This check costs a few dozen tokens per note.

The original line stays and a translation line follows:

```text
🎤 Voice note (0:07): "Recuérdame llamar a Example Corp mañana."
↳ English: "Remind me to call Example Corp tomorrow."
```

- The translation is stored as `transcript.translation: { language, text, model }`.
- Plain text in, plain text out: the instructions tell the model to translate
  only and never follow instructions inside the text. Input is capped at 4000
  characters.
- For senders other than the owner/self account the translated text is also
  screened. The request classifier is English-pattern based, so a
  foreign-language injection is often only visible after translation; a
  rejected translation blocks the whole note
  (`transcription unavailable (transcription_policy_blocked)`, no original text).
- A failed translation never fails the note: the original line stays and
  `↳ translation unavailable (<code>)` is appended. Codes:
  `translation_timeout`, `translation_http_<status>`, `translation_empty`,
  `translation_budget_exceeded`, `translation_network_error`,
  `translation_invalid_response`. In that case foreign-language text from
  other senders reaches the thread screened on the original text only.
- Diarized recordings carry no language and are not translated.

## Scope

Always on: every voice note in every WhatsApp chat is transcribed, as long as
an API key is configured.

- `ORKESTR_VOICE_TRANSCRIPTION=off` stops transcription everywhere.
- The binding flag `transcribeVoiceNotes: false` stops it for one chat.
- Speech from anyone other than the owner/self account is screened by the same
  request classifier that screens typed WhatsApp text; a blocked transcript is
  replaced by `transcription unavailable (transcription_policy_blocked)`.
- The owner/self account is the connected account itself, a number in
  `ORKESTR_WHATSAPP_OWNER_CONTACT_IDS`, or an id in
  `ORKESTR_WHATSAPP_OWNER_ALIASES`, in a thread owned by the WhatsApp owner
  user. In groups WhatsApp usually identifies senders by a LID (`<id>@lid`)
  that cannot be matched to their phone number, so list the owner's LID in
  `ORKESTR_WHATSAPP_OWNER_ALIASES` (unlike `ORKESTR_WHATSAPP_OWNER_CONTACT_IDS`
  it is never used as group participants).

## Privacy

Audio is uploaded to OpenAI (or the configured compatible endpoint), including
voice notes from other people in the owner's chats. Turn it off per chat with
`transcribeVoiceNotes: false` where participants would not expect that. Transcript text, file
names, and keys are never written to `events.jsonl`, logs, or metrics; the only
events are `voice_transcription_completed { threadId, seconds, model, languages, speakers? }`,
`voice_transcription_failed { threadId, code }`,
`voice_diarization_failed { threadId, code }`,
`voice_translation_completed { threadId, from, to, model }`, and
`voice_translation_failed { threadId, code }`. Translation sends the
transcript text to the same OpenAI-compatible endpoint.

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
| `ORKESTR_TRANSCRIPTION_PRICE_PER_MINUTE_USD` | model price | Price override for the configured `ORKESTR_TRANSCRIPTION_MODEL` only. |
| `ORKESTR_TRANSCRIPTION_PRICES_JSON` | `{"gpt-transcribe":0.0045,"gpt-4o-transcribe-diarize":0.006}` | Per-model price map (USD per minute). |
| `ORKESTR_TRANSCRIPTION_DIARIZE` | `auto` | `auto`: speaker labels for forwarded recordings (kind `audio`); `always`: for all audio; `off`: never. |
| `ORKESTR_TRANSCRIPTION_DIARIZE_MODEL` | `gpt-4o-transcribe-diarize` | Diarize model id. |
| `ORKESTR_TRANSLATION` | on | `off` disables translation. |
| `ORKESTR_TRANSLATION_TARGET` | `en` | Target language code. |
| `ORKESTR_TRANSLATION_MODEL` | `gpt-6-luna` | Responses API model. |
| `ORKESTR_UNDERSTOOD_LANGUAGES` | `ORKESTR_TRANSCRIPTION_LANGUAGES` | Languages that are never translated (the target is always included). |
| `ORKESTR_TRANSLATION_PRICES_JSON` | `{"gpt-6-luna":{"input":0.1,"output":0.5}}` | Per-model price map (USD per 1M tokens). |
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

`gpt-transcribe` is billed at $0.0045 per audio minute and
`gpt-4o-transcribe-diarize` at $0.006 per audio minute (from the response
`duration`). Every successful call is recorded in the credit ledger with
`callKind: "voice_transcription"`, `sourceChannel: "whatsapp"`, and cost
`billed seconds / 60 * price`. Translations are recorded with
`callKind: "voice_translation"` and a token-based cost (`gpt-6-luna`: $0.10 per
1M input tokens, $0.50 per 1M output tokens). Before each transcription and
each translation the day's combined voice transcription + translation spend is
checked against the daily budget.

## Health

`orkestr doctor voice` (or `GET /api/voice-transcription/status`, admin only)
shows the mode, model, speaker-label and translation settings, whether a key is configured and where it comes from
(never the key), today's spend against the daily budget, and today's and the
last seven days' transcribed minutes, failures by error code, and translated
and failed translations. It exits
non-zero when the key is missing, the budget is used up, or most of today's
transcriptions failed. Counters live in `voice-transcription-stats.json` in the
data directory and hold numbers and error codes only.

