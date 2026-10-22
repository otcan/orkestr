# Recipes

A recipe is data, not code: a manifest (`recipe.json`), the instructions the
conversation's scheduled runs receive (`instructions.md`) and, for the job
tracker, the mail classification rule pack (`rules.json`). The server embeds
the recipes in this directory at build time and lists them at
`GET /api/v2/recipes`; `POST /api/v2/recipes/{id}/install` creates the
preconfigured conversation (tracker, calendar timer, mail source).

Schema `orkestr.recipe.v1` (`recipe.json`):

| Field | Meaning |
| --- | --- |
| `id`, `version`, `title`, `summary` | Identity and gallery text. |
| `conversation.name` | Name of the created chat. |
| `tracker.notify_on` | Event kinds that are flagged for an immediate message. |
| `tracker.rules` | Rule pack file for mail classification (`orkestr.jobmail-rules.v1`). |
| `mail` | Local mail store reader: `kind: thunderbird`, extra `folders` besides the inbox, `since_days`, `max_messages_per_scan`. |
| `timers[]` | Calendar timers: `label`, `schedule` (weekdays 1=Mon..7=Sun, minutes of day, hours step, minute offsets; the zone comes from the installer), `silent_mode`, `instructions` file. |

Instruction files may use `{conversation_id}` and `{origin}`; nothing else is
substituted. Recipes and rule packs ship in this public repository with
synthetic test mail only (`v2/crates/mail-reader/tests/fixtures`).
