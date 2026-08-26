import type { PublicPage } from "./public-site-config.js";
import { renderConsoleEvidence, renderCoordinationDiagram } from "./public-site-components.js";

export function commercialHomePage(): PublicPage {
  return {
    id: "home",
    title: "AI Operations Layer",
    summary: "Orkestr is a managed private AI operations layer that coordinates bounded workflows across systems, with human approval and operational visibility.",
    canonicalPath: "/",
    body: `<main id="main-content">
  <section class="hero commercial-hero">
    <div class="hero-copy">
      <p class="eyebrow">AI OPERATIONS LAYER</p>
      <h1>AI operations,<br><em>under human control.</em></h1>
      <p class="lead">Orkestr coordinates repeatable work across your systems, keeps state visible, and stops at the approval points you define—delivered as a managed private deployment.</p>
      <div class="actions"><a class="button" href="/workflow" data-event="map_workflow_hero">Map one workflow</a><a class="button button-ghost" href="#proof" data-event="see_live_workflow">See a live workflow</a></div>
      <p class="microcopy">Start with one bounded workflow. No open-ended SaaS rollout required.</p>
    </div>
    ${renderCoordinationDiagram()}
  </section>

  <section class="section statement" aria-labelledby="category-title">
    <p class="section-index">01 · THE CONTROL LAYER</p>
    <div><h2 id="category-title">The work between systems is where operations break.</h2><p class="section-lead">A ticket arrives in one tool. Evidence lives in another. A decision waits in chat. The final action belongs in a third system. Orkestr gives that chain a named workflow, a durable state, an owner, and explicit control points.</p></div>
    <dl class="definition-grid"><div><dt>Coordinate</dt><dd>Run bounded steps across approved connectors and managed browser surfaces.</dd></div><div><dt>Control</dt><dd>Pause, interrupt, revoke, or require a human decision before consequential actions.</dd></div><div><dt>Observe</dt><dd>See workflow state, exceptions, recent activity, and the history behind an outcome.</dd></div></dl>
  </section>

  <section class="section workflow-examples" aria-labelledby="examples-title">
    <div class="section-heading"><p class="section-index">02 · CONCRETE WORK</p><h2 id="examples-title">Begin where repeated volume meets system crossing.</h2></div>
    <div class="cards three"><article><span>FINANCE OPS</span><h3>Invoice exception handling</h3><p>Collect a document, validate it against records, route exceptions for approval, then continue or return it.</p><a href="/use-cases#finance">Trace the chain <span aria-hidden="true">→</span></a></article><article><span>CUSTOMER OPS</span><h3>Account onboarding</h3><p>Check a request, gather missing evidence, open the required records, and stop before access is granted.</p><a href="/use-cases#onboarding">Trace the chain <span aria-hidden="true">→</span></a></article><article><span>REVENUE OPS</span><h3>Renewal preparation</h3><p>Bring account signals together, prepare a review packet, and wait for the owner before outreach.</p><a href="/use-cases#revenue">Trace the chain <span aria-hidden="true">→</span></a></article></div>
    <p class="disclaimer">Examples require deployment-specific connector, policy, and approval configuration.</p>
  </section>

  <section class="proof-section" id="proof" aria-labelledby="proof-title">
    <div class="section-heading inverse"><p class="section-index">03 · PRODUCT PROOF</p><h2 id="proof-title">Operational state should be visible before action becomes irreversible.</h2><p>Here is a truthful synthetic workflow—not a customer screenshot or a promise that every adapter is preconfigured.</p></div>
    ${renderConsoleEvidence()}
  </section>

  <section class="section implementation" aria-labelledby="implementation-title">
    <div class="section-heading"><p class="section-index">04 · MANAGED IMPLEMENTATION</p><h2 id="implementation-title">One workflow. Four bounded phases.</h2></div>
    <ol class="phase-list"><li><span>01</span><div><h3>Map</h3><p>Define the trigger, systems, owner, approvals, volume, exceptions, and success measure.</p></div></li><li><span>02</span><div><h3>Build</h3><p>Configure the private runtime, scoped connections, workflow logic, and observable checkpoints.</p></div></li><li><span>03</span><div><h3>Prove</h3><p>Run representative cases with synthetic or approved test data and verify the human-control model.</p></div></li><li><span>04</span><div><h3>Operate</h3><p>Release the bounded workflow, monitor failures, and change scope deliberately as evidence grows.</p></div></li></ol>
  </section>

  <section class="section security-callout" aria-labelledby="security-title">
    <div><p class="section-index">05 · PRIVATE BY DESIGN</p><h2 id="security-title">Deployment boundaries before automation breadth.</h2><p>Orkestr can run in an isolated managed environment or a customer-controlled environment. Connections are scoped, approvals are explicit, and revocation remains part of normal operations. Public alpha means limitations are stated—not hidden behind enterprise language.</p></div>
    <ul class="check-list"><li>Private deployment boundary</li><li>Explicit connector grants</li><li>Human approval gates</li><li>Pause and revocation paths</li><li>Visible workflow history</li><li>No certification claims</li></ul>
    <a class="text-link" href="/security" data-event="security_detail_click">Review the security model <span aria-hidden="true">→</span></a>
  </section>

  <section class="section pilot" aria-labelledby="pilot-title">
    <div><p class="eyebrow">ORKESTR WORKFLOW PILOT</p><h2 id="pilot-title">Map one workflow worth proving.</h2><p class="section-lead">Bring one repeated operational chain with a clear owner, measurable delay or cost, and at least one system handoff. We will assess whether it is bounded enough for a private pilot.</p></div>
    <div class="pilot-fit"><h3>A strong first workflow has:</h3><ul><li>Repeated volume</li><li>A named operational owner</li><li>Two or more system touchpoints</li><li>A measurable delay, cost, or error rate</li><li>Clear approval and exception rules</li></ul><a class="button" href="/workflow" data-event="map_workflow_pilot">Map one workflow</a><small>Qualification comes before scheduling. Submitting is not a purchase commitment.</small></div>
  </section>

  <section class="final-cta" id="waitlist" aria-labelledby="final-title"><p class="section-index">START BOUNDED</p><h2 id="final-title">Turn one fragile process chain into a controlled workflow.</h2><a class="button button-light" href="/workflow" data-event="map_workflow_final">Map one workflow</a><p>Looking for the invite-only personal experience? <a href="/beta#waitlist">Personal beta remains here.</a></p></section>
</main>`,
  };
}
