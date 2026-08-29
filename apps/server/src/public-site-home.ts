import { escapeHtml, publicRepoUrl, type PublicPage } from "./public-site-config.js";
import { renderConsoleEvidence, renderCoordinationDiagram } from "./public-site-components.js";

export function commercialHomePage(env = process.env): PublicPage {
  const repo = publicRepoUrl(env);
  return {
    id: "home",
    title: "Managed AI Operations Layer",
    summary: "Orkestr is a privately deployed AI operations layer that moves repeated work across existing tools, with human approval where mistakes matter.",
    canonicalPath: "/",
    body: `<main id="main-content">
  <section class="hero commercial-hero">
    <div class="hero-copy">
      <p class="eyebrow">AI OPERATIONS LAYER</p>
      <h1>Your software stores the work. <em>Orkestr moves it forward.</em></h1>
      <p class="lead">Orkestr coordinates persistent AI agents across your existing tools, browser workflows, files, and communication channels—with human approval where mistakes matter.</p>
      <div class="actions"><a class="button" href="/workflow" data-event="map_workflow_hero">Map one workflow</a><a class="button button-ghost" href="#proof" data-event="see_live_workflow">See a live workflow</a></div>
      <p class="microcopy">Start with one bounded process. Measure the result. Expand only after it works.</p>
    </div>
    ${renderCoordinationDiagram()}
  </section>

  <ul class="trust-strip" aria-label="Orkestr trust principles"><li>Managed private deployment</li><li>Existing tools</li><li>Human approval</li><li>Visible history</li><li>Open-source core</li></ul>

  <section class="section statement" aria-labelledby="category-title">
    <p class="section-index">MORE THAN A CHATBOT</p>
    <div><h2 id="category-title">Most companies do not need another chatbot.</h2><p class="section-lead">Operational work needs context, timing, tool access, approvals, exception handling, and the ability to continue later. Orkestr provides the operating layer around the agents, so work does not disappear into a chat window.</p></div>
    <dl class="definition-grid"><div><dt>Keep the state</dt><dd>Named workflows retain their context, files, status, and next action instead of starting over with every prompt.</dd></div><div><dt>Operate approved tools</dt><dd>Move bounded work through connected systems and browser-only software using the permissions defined for the deployment.</dd></div><div><dt>Wait, escalate, resume</dt><dd>Stop for approval, surface an exception, continue after a decision, and preserve the history behind the outcome.</dd></div></dl>
  </section>

  <section class="section workflow-examples" aria-labelledby="examples-title">
    <div class="section-heading"><p class="section-index">REAL PROCESS CHAINS</p><h2 id="examples-title">Begin where repeated volume meets system crossing.</h2><p class="section-lead">The best first workflow already costs time every week, crosses more than one tool, and has a person who owns the result.</p></div>
    <div class="cards three"><article><span>FINANCE OPERATIONS</span><h3>Invoice exception handling</h3><p>Collect an invoice, validate it against records, route mismatches for approval, then post or return it.</p><a href="/use-cases#finance">Trace the workflow <span aria-hidden="true">→</span></a></article><article><span>CUSTOMER OPERATIONS</span><h3>Account onboarding</h3><p>Check a request, gather missing evidence, prepare the required records, and stop before access is granted.</p><a href="/use-cases#onboarding">Trace the workflow <span aria-hidden="true">→</span></a></article><article><span>REVENUE OPERATIONS</span><h3>Renewal preparation</h3><p>Bring account signals together, flag missing information, prepare a review, and wait for the owner before outreach.</p><a href="/use-cases#revenue">Trace the workflow <span aria-hidden="true">→</span></a></article></div>
    <p class="disclaimer">Workflows are configured per deployment. Orkestr is not a catalogue of one-click automations.</p>
  </section>

  <section class="proof-section" id="proof" aria-labelledby="proof-title">
    <div class="section-heading inverse"><p class="section-index">ORKESTR CONSOLE</p><h2 id="proof-title">See what is running, what is waiting, and where a human is needed.</h2><p>The product view below shows one illustrative workflow moving through checks, stopping at an approval gate, and retaining the decision history.</p></div>
    ${renderConsoleEvidence()}
  </section>

  <section class="section pilot-offer" aria-labelledby="pilot-title">
    <div class="pilot-intro"><p class="eyebrow">ORKESTR WORKFLOW PILOT</p><h2 id="pilot-title">Deploy one workflow worth proving.</h2><p class="section-lead">Bring one expensive, repetitive process. We map the boundary, implement it in a private environment, test the exceptions, and measure whether it deserves production rollout.</p><p class="offer-note">This is a working implementation—not an AI strategy workshop or a catalogue of generic automations.</p></div>
    <div class="pilot-package">
      <p class="section-index">WHAT THE PILOT INCLUDES</p>
      <ol class="pilot-deliverables"><li><span>01</span><strong>Workflow and systems map</strong></li><li><span>02</span><strong>Permission and approval design</strong></li><li><span>03</span><strong>Isolated Orkestr deployment</strong></li><li><span>04</span><strong>One implemented workflow</strong></li><li><span>05</span><strong>Operator view and exception testing</strong></li><li><span>06</span><strong>Measurement and rollout recommendation</strong></li></ol>
      <div class="pilot-fit-line"><strong>Strong first workflow:</strong><span>repeated volume</span><span>named owner</span><span>2+ system touchpoints</span><span>measurable pain</span></div>
      <a class="button" href="/workflow" data-event="map_workflow_pilot">Map your workflow</a>
      <small>We review fit before scheduling. Submitting a map is not a purchase commitment.</small>
    </div>
  </section>

  <section class="section implementation" aria-labelledby="implementation-title">
    <div class="section-heading"><p class="section-index">FROM PAIN TO PROOF</p><h2 id="implementation-title">One workflow. Four bounded phases.</h2></div>
    <ol class="phase-list"><li><span>01</span><div><h3>Map</h3><p>Define the trigger, systems, owner, approvals, volume, exceptions, and success measure.</p></div></li><li><span>02</span><div><h3>Build</h3><p>Configure the private runtime, scoped connections, workflow logic, and observable checkpoints.</p></div></li><li><span>03</span><div><h3>Prove</h3><p>Run representative cases and verify normal work, exceptions, human decisions, and recovery.</p></div></li><li><span>04</span><div><h3>Operate</h3><p>Release the bounded workflow, monitor failures, and expand scope only as evidence grows.</p></div></li></ol>
  </section>

  <section class="section security-callout" aria-labelledby="security-title">
    <div><p class="section-index">HUMAN CONTROL IS ARCHITECTURE</p><h2 id="security-title">Private deployment before automation breadth.</h2><p>Run Orkestr in a dedicated managed environment or infrastructure your organization controls. Connect only what the workflow requires and keep sensitive or irreversible actions behind explicit approval.</p><a class="text-link" href="/security" data-event="security_detail_click">Read the security and deployment model <span aria-hidden="true">→</span></a></div>
    <ul class="plain-checks"><li><strong>Private environment</strong><span>Operational data and credentials stay outside the public repository.</span></li><li><strong>Scoped connections</strong><span>Access is configured for the workflow and can be reviewed or revoked.</span></li><li><strong>Approval gates</strong><span>Sensitive actions can stop until a named person decides.</span></li><li><strong>Operational visibility</strong><span>Review active work, waiting tasks, exceptions, interruptions, and history.</span></li></ul>
  </section>

  <section class="section credibility" aria-labelledby="evidence-title">
    <div><p class="section-index">EVIDENCE YOU CAN REVIEW</p><h2 id="evidence-title">Credibility should be inspectable.</h2><p class="section-lead">See the product behavior, review the operating boundaries, and inspect the generic core before trusting a deployment.</p></div>
    <div class="evidence-grid"><article><h3>Open-source core</h3><p>Inspect the public code, tests, and technical documentation.</p><a href="${escapeHtml(repo)}" rel="noreferrer">View GitHub <span aria-hidden="true">→</span></a></article><article><h3>Visible decisions</h3><p>Workflow status, exceptions, approvals, and history are designed to be reviewed.</p><a href="#proof">See the workflow <span aria-hidden="true">→</span></a></article><article><h3>Clear limitations</h3><p>Connections, controls, and operating responsibilities vary by deployment.</p><a href="/security">Review the boundaries <span aria-hidden="true">→</span></a></article></div>
  </section>

  <section class="section faq" aria-labelledby="faq-title">
    <div><p class="section-index">STRAIGHT ANSWERS</p><h2 id="faq-title">Know what you are buying.</h2></div>
    <div class="faq-list"><details><summary>What exactly is the Workflow Pilot?</summary><p>A managed implementation of one bounded workflow: its systems and approval map, a private Orkestr deployment, the configured workflow, exception testing, and a measurement-based rollout recommendation.</p></details><details><summary>Is Orkestr a self-service SaaS subscription?</summary><p>No. The current offer is a managed private deployment around a defined workflow. It is not presented as hosted multi-user SaaS or general team RBAC.</p></details><details><summary>Does Orkestr replace our existing tools?</summary><p>No. It coordinates approved work across the tools and browser systems your team already uses.</p></details><details><summary>Can it act without approval?</summary><p>Routine steps can run within the agreed boundary. Sensitive, external, or irreversible actions can be configured to pause for a named person.</p></details><details><summary>What happens after we submit a workflow?</summary><p>We review its volume, systems, owner, approval points, and measurable pain. If the boundary is viable, the next step is a focused qualification call—not a generic product demo.</p></details></div>
  </section>

  <section class="final-cta" id="waitlist" aria-labelledby="final-title"><p class="section-index">START BOUNDED</p><h2 id="final-title">Bring us one workflow that wastes time every week.</h2><p>Map the systems, actors, approvals, exceptions, and success measure. We will tell you whether Orkestr should operate it.</p><a class="button button-light" href="/workflow" data-event="map_workflow_final">Map the workflow</a><p>Looking for the invite-only personal experience? <a href="/beta#waitlist">Personal beta remains here.</a></p></section>
</main>`,
  };
}
