
### Discovery-only CI branch

The headless fixture consumes the authenticated discovery contract published in
Runtime commit `20bfef64af113fb728cc7216611bd7fd22a4569f`. Only HTTP 404 with
the explicit `beta_unconfigured` envelope selects blocked-shell checks. Missing
routes, authentication failures, malformed configured discovery and transport
uncertainty fail the fixture. The configured branch retains Send receipt and
canonical history checks against the discovery conversation. The unconfigured
branch checks the blocked gate, cookie resume, visible sign-out and fresh login;
it provides no durable-intake, history, provider or model-chat qualification.
The existing sign-out action is available while discovery is blocked.

Author validation: 15 focused Node cases, script syntax, pinned Rust formatting,
diff check and locked/offline UI binary check passed. No local browser, provider,
paired build or hosted CI execution was performed for this leaf.
