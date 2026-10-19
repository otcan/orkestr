# Fast reply presentation

The Fast reply panel shares the existing conversation and composer. It uses a separate App-owned execution cache, retained across navigation and cleared with Deep/Worker caches on authentication changes. There is no new chat, configuration authority or Worker discovery assumption.

The selected interface is authenticated `GET /api/v2/conversations/{id}/fast/execution` (204 absent/unconfigured; optional exact `run_id`) and `POST /api/v2/conversations/{id}/fast/stop`. Both reuse canonical execution DTOs. The existing bounded serial cookie polling channel has one active Fast read for the selected conversation, owned abort/cleanup and session/selection generation fences. Stop retains the original complete request across uncertainty, with CSRF and no retry loop. Progress uses the canonical owner-scoped payload read/removal lifecycle.

Owner acceptance remains `POST /api/v2/conversations/{id}/accept`, bound to the Fast status candidate/run/revision. The panel labels it “Accept Fast reply” and explains that this accepts neither Deep work nor a Worker task. Native proposals remain awaiting review; acknowledgement and Stop requests do not imply completion or cancellation. No steering or task creation is mounted in the Fast panel.

Local locked offline WASM compilation and focused bridge/state checks validate this consumer only. Matching ordinary server registration/composition, immutable artifact pairing and fresh mounted browser scenarios remain separate gates. Controls retain the existing candidate-only execution-controls feature gate. Earlier missing run-02 scenario provenance remains disclosed; no historical browser result qualifies this successor.
