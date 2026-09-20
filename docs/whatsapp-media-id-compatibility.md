# WhatsApp media message identity compatibility

The September 2026 WhatsApp Web MediaData change exposed an enumerable private
`__x_id`. whatsapp-web.js 1.34.7 spreads that model into its outgoing Msg. The
private ID shadows the valid MsgKey, so the sender getter rejects every media
message before dispatch. Text messages do not carry that media model.

Production operator diagnostics reproduced the getter/memoization exception.
Upstream analysis: https://github.com/wwebjs/whatsapp-web.js/issues/201922
Upstream repair: https://github.com/wwebjs/whatsapp-web.js/pull/201923

`scripts/patch-whatsapp-media-id.mjs` removes only the private ID from the outgoing
message after object construction. It preserves the public message key, media
upload fields, captions and existing send/ack behavior. This is an install-time
compatibility patch, not a live browser injection or alternate transport.

- The dependency is pinned to 1.34.7 and the original source SHA-256 is checked.
- npm postinstall applies it for normal, CI and standalone connector installs.
- Runtime dependency installation re-verifies it after its script-disabled compiler install.
- Repeated application is idempotent; an unknown version/source stops installation.
- Regression tests execute the real dependency's injected message builder inside
  an offline VM fixture. The unpatched builder reproduces the private-ID collision;
  patched document/image/CSV/text paths retain the correct ID and media fields.
- Partial/uncertain historical deliveries remain quarantined. Do not bulk-replay
  them after deployment. Verify a new, explicitly authorized attachment once.

Remove this shim and update the pinned dependency only after a released upstream
fix passes the same regression and real-delivery checks. Do not loosen the source
hash guard merely to accommodate an unreviewed dependency update.
