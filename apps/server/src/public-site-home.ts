import { escapeHtml, publicRepoUrl, type PublicPage } from "./public-site-config.js";
import { renderConsoleEvidence, renderCoordinationDiagram } from "./public-site-components.js";

export function commercialHomePage(env = process.env): PublicPage {
  const repo = publicRepoUrl(env);
  return {
    id: "home",
    title: "Reliable AI Workflow Automation",
    summary: "Orkestr helps teams run repetitive work across the tools they already use, with human approval before important actions and a visible history of what happened.",
    canonicalPath: "/",
    body: `<main id="main-content">
  <section class="hero commercial-hero">
    <div class="hero-copy">
      <p class="eyebrow">RELIABLE WORK, WITH PEOPLE IN CONTROL</p>
      <h1>Make repetitive work run reliably.</h1>
      <p class="lead">Orkestr connects the tools your team already uses, handles routine steps, and asks for approval before anything important happens.</p>
      <div class="actions"><a class="button" href="/workflow" data-event="book_call_hero">Book a 20-minute call</a><a class="button button-ghost" href="#proof" data-event="see_how_it_works">See how it works</a></div>
      <p class="microcopy">Start with one task your team repeats. No technical preparation required.</p>
    </div>
    ${renderCoordinationDiagram()}
  </section>

  <ul class="trust-strip" aria-label="Orkestr trust principles"><li>Private deployment options</li><li>Approved connections</li><li>Human approval</li><li>Visible history</li><li>Open-source core</li></ul>

  <section class="section statement" aria-labelledby="category-title">
    <p class="section-index">A CLEARER WAY TO RUN REPEATED WORK</p>
    <div><h2 id="category-title">When work moves between tools and people, small gaps become expensive.</h2><p class="section-lead">Requests get missed, information is copied by hand, and decisions wait in inboxes. Orkestr keeps the steps together and shows your team what is happening.</p></div>
    <dl class="definition-grid"><div><dt>Bring the steps together</dt><dd>Move approved information between the tools your team already uses.</dd></div><div><dt>Keep people in charge</dt><dd>Pause before important actions and ask the right person to decide.</dd></div><div><dt>See what happened</dt><dd>Review status, warnings, decisions, and recent activity in one place.</dd></div></dl>
  </section>

  <section class="section workflow-examples" aria-labelledby="examples-title">
    <div class="section-heading"><p class="section-index">COMMON STARTING POINTS</p><h2 id="examples-title">Start with work your team already repeats.</h2><p class="section-lead">The best first task is easy to recognize: it happens often, crosses a few tools, and sometimes needs a manager’s decision.</p></div>
    <div class="cards three"><article><span>FINANCE</span><h3>Check invoice exceptions</h3><p>Collect an invoice, compare the details, and ask for approval when something does not match.</p><a href="/use-cases#finance">See the example <span aria-hidden="true">→</span></a></article><article><span>CUSTOMER OPERATIONS</span><h3>Prepare account onboarding</h3><p>Check a request, gather missing information, and pause before access is granted.</p><a href="/use-cases#onboarding">See the example <span aria-hidden="true">→</span></a></article><article><span>REVENUE OPERATIONS</span><h3>Prepare renewals</h3><p>Bring account information together and give the owner a clear review before follow-up.</p><a href="/use-cases#revenue">See the example <span aria-hidden="true">→</span></a></article></div>
    <p class="disclaimer">Each deployment is configured for the approved tools, rules, and decisions involved.</p>
  </section>

  <section class="proof-section" id="proof" aria-labelledby="proof-title">
    <div class="section-heading inverse"><p class="section-index">SEE THE WORK</p><h2 id="proof-title">Know what is complete, what is waiting, and why.</h2><p>The product view below shows how a routine request can be checked and paused for a manager’s decision.</p></div>
    ${renderConsoleEvidence()}
  </section>

  <section class="section implementation" aria-labelledby="implementation-title">
    <div class="section-heading"><p class="section-index">A PRACTICAL START</p><h2 id="implementation-title">From first conversation to a reliable process.</h2></div>
    <ol class="phase-list"><li><span>01</span><div><h3>Understand</h3><p>Choose one repeated task and agree where people need to make decisions.</p></div></li><li><span>02</span><div><h3>Build</h3><p>Connect only the approved tools and configure the steps in a private environment.</p></div></li><li><span>03</span><div><h3>Test</h3><p>Run representative examples, check the results, and confirm the stop points.</p></div></li><li><span>04</span><div><h3>Operate</h3><p>Release carefully, watch the history, and improve the process as evidence grows.</p></div></li></ol>
  </section>

  <section class="section security-callout" aria-labelledby="security-title">
    <div><p class="section-index">BUILT AROUND CONTROL</p><h2 id="security-title">Your systems stay under your control.</h2><p>Orkestr can run in a dedicated managed environment or infrastructure you control. Your team approves the connections and chooses which actions require a person.</p><a class="text-link" href="/security" data-event="security_detail_click">See how access and approvals work <span aria-hidden="true">→</span></a></div>
    <ul class="plain-checks"><li><strong>Private environment</strong><span>Operational data and credentials stay outside the public repository.</span></li><li><strong>Approved connections</strong><span>Access is configured for the task and can be revoked.</span></li><li><strong>Human decisions</strong><span>Important work can pause before it continues.</span></li></ul>
  </section>

  <section class="section credibility" aria-labelledby="evidence-title">
    <div><p class="section-index">EVIDENCE YOU CAN REVIEW</p><h2 id="evidence-title">Credibility should be inspectable.</h2><p class="section-lead">We show the product behavior, state the limits, and publish the generic core for technical review.</p></div>
    <div class="evidence-grid"><article><h3>Open-source core</h3><p>Inspect the public code, tests, and documentation.</p><a href="${escapeHtml(repo)}" rel="noreferrer">View GitHub <span aria-hidden="true">→</span></a></article><article><h3>Visible decisions</h3><p>Work status, warnings, approvals, and history are designed to be reviewed.</p><a href="#proof">See the walkthrough <span aria-hidden="true">→</span></a></article><article><h3>Clear limitations</h3><p>Available tools, security controls, and operating responsibilities vary by deployment.</p><a href="/security">Review the boundaries <span aria-hidden="true">→</span></a></article></div>
  </section>

  <section class="section faq" aria-labelledby="faq-title">
    <div><p class="section-index">FREQUENT QUESTIONS</p><h2 id="faq-title">Straight answers before a call.</h2></div>
    <div class="faq-list"><details><summary>Does Orkestr replace our existing tools?</summary><p>No. It is designed to coordinate approved work across tools your team already uses.</p></details><details><summary>Where does it run?</summary><p>Orkestr can run in a dedicated managed environment or in infrastructure your organization controls.</p></details><details><summary>Can it act without approval?</summary><p>Routine steps can be configured to run automatically. Important actions can be configured to pause for a named person.</p></details><details><summary>What happens on the first call?</summary><p>We discuss one repetitive task, the tools involved, and the decisions that should stay human. No process map is required.</p></details></div>
  </section>

  <section class="final-cta" id="waitlist" aria-labelledby="final-title"><p class="section-index">START WITH A CONVERSATION</p><h2 id="final-title">Bring one repetitive task. We’ll help make the next step clear.</h2><a class="button button-light" href="/workflow" data-event="book_call_final">Book a 20-minute call</a><p>Looking for the invite-only personal experience? <a href="/beta#waitlist">Personal beta remains here.</a></p></section>
</main>`,
  };
}
