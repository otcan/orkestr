import type { PublicPage } from "./public-site-config.js";
import { renderConsoleEvidence, renderCoordinationDiagram } from "./public-site-components.js";

function miniWorkflow(
  id: string,
  useCaseId: string,
  eyebrow: string,
  heading: string,
  description: string,
  steps: string[],
  systems: string[],
) {
  return `<article class="workflow-card" id="${id}">
    <p class="section-index">${eyebrow}</p>
    <h3>${heading}</h3>
    <p>${description}</p>
    <ol class="mini-flow">${steps.map((step, index) => `<li><span>${String(index + 1).padStart(2, "0")}</span>${step}</li>`).join("")}</ol>
    <div class="system-tags" aria-label="Systems touched">${systems.map((system) => `<span>${system}</span>`).join("")}</div>
    <a href="/use-cases#${useCaseId}">Explore ${eyebrow.toLowerCase()} workflows <span aria-hidden="true">→</span></a>
  </article>`;
}

export function commercialHomePage(): PublicPage {
  return {
    id: "home",
    title: "Managed AI Workflow Automation & AI Agents",
    summary: "Orkestr builds and operates AI workflows across your ERP, CRM, email, browser applications and internal systems. Automate repetitive operations while keeping human approval where it matters.",
    canonicalPath: "/",
    body: `<main id="main-content">
  <section class="hero commercial-hero">
    <div class="hero-copy">
      <p class="eyebrow">AI OPERATIONS LAYER</p>
      <h1>Your software stores the work. <em>Orkestr moves it forward.</em></h1>
      <p class="lead">Show us a repetitive process across your ERP, CRM, email, internal software, or browser tools.</p>
      <p class="hero-detail">We map it, build the AI workflow, deploy it in a controlled environment, and operate it with your team.</p>
      <div class="actions"><a class="button" href="/workflow" data-event="book_audit_hero">Book a workflow audit</a><a class="button button-ghost" href="#how-it-works" data-event="see_how_it_works">See how it works</a></div>
      <p class="microcopy hero-trust">Private deployment <span aria-hidden="true">·</span> Human approval where needed <span aria-hidden="true">·</span> Works with browser-only systems</p>
    </div>
    ${renderCoordinationDiagram()}
  </section>

  <section class="section problem-section" id="how-it-works" aria-labelledby="problem-title">
    <div class="problem-copy"><p class="section-index">THE WORK BETWEEN THE SYSTEMS</p><h2 id="problem-title">You don’t need another AI tool.</h2><p class="section-lead">You already have the software. The problem is everything your people still have to do between those systems.</p><ul class="manual-work"><li>Open emails</li><li>Look up information</li><li>Copy data between applications</li><li>Check documents</li><li>Chase approvals</li><li>Update records and follow up</li></ul><p class="section-lead compact-lead">Orkestr turns those repetitive steps into one controlled workflow.</p></div>
    <div class="before-after" aria-label="Process before and with Orkestr">
      <article><p class="comparison-label">BEFORE ORKESTR</p><h3>Nine manual handoffs</h3><ol><li>Customer request arrives</li><li>Employee opens email</li><li>Searches ERP</li><li>Checks CRM</li><li>Opens supplier portal</li><li>Copies information</li><li>Asks manager and waits</li><li>Updates ERP</li><li>Replies to customer</li></ol></article>
      <article class="after"><p class="comparison-label">WITH ORKESTR</p><h3>One controlled workflow</h3><ol><li>Request arrives</li><li>Orkestr gathers and checks the information</li><li>Human approves the decision if required</li><li>Orkestr completes the work and records what happened</li></ol></article>
    </div>
  </section>

  <section class="section managed-offer" aria-labelledby="offer-title">
    <div><p class="section-index">MANAGED IMPLEMENTATION</p><h2 id="offer-title">We build the automation for you.</h2><p class="section-lead">Orkestr is not another automation platform your team has to learn. You show us the workflow. We map, build, deploy, and operate it with you.</p></div>
    <div class="offer-decisions"><p>We identify:</p><ul><li>what can be automated</li><li>which systems are involved</li><li>where AI is useful</li><li>where deterministic rules are safer</li><li>where human approval should remain</li><li>what exceptions must be handled</li></ul></div>
    <aside class="offer-contract"><span>You provide the process.</span><strong>We provide the operating layer.</strong><a class="button" href="/workflow" data-event="discuss_workflow_offer">Discuss a workflow</a></aside>
  </section>

  <section class="browser-section" aria-labelledby="browser-title">
    <div class="browser-copy"><p class="section-index">THE BROWSER IS AN INTEGRATION SURFACE</p><h2 id="browser-title">No API? That doesn’t necessarily stop us.</h2><p>Important work still happens inside legacy ERP systems, supplier portals, internal web applications, logistics platforms, custom software, and administrative dashboards.</p><p>Orkestr can use direct integrations where available and controlled browser execution where they are not.</p><strong class="browser-statement">APIs when available.<br>The browser when they’re not.</strong></div>
    <div class="system-map" role="img" aria-label="Orkestr connects ERP, CRM, email, files, browser-only systems, and human approval">
      <div class="map-core"><span>OPERATING LAYER</span><strong>Orkestr</strong></div>
      <div class="map-node erp"><span>DIRECT OR BROWSER</span><strong>ERP</strong></div>
      <div class="map-node crm"><span>DIRECT</span><strong>CRM</strong></div>
      <div class="map-node email"><span>DIRECT</span><strong>Email</strong></div>
      <div class="map-node browser"><span>CONTROLLED BROWSER</span><strong>Internal application</strong></div>
      <div class="map-node files"><span>APPROVED SOURCE</span><strong>Files</strong></div>
      <div class="map-node person"><span>DECISION GATE</span><strong>Human approval</strong></div>
    </div>
  </section>

  <section class="section use-case-showcase" id="use-cases" aria-labelledby="use-cases-title">
    <div class="section-heading"><p class="section-index">CONCRETE OPERATIONS</p><h2 id="use-cases-title">What does an AI operations layer actually do?</h2><p class="section-lead">It moves one bounded process through the systems and decisions already involved.</p></div>
    <div class="workflow-card-grid">
      ${miniWorkflow("sales", "revenue", "Sales operations", "From enquiry to prepared follow-up", "Orkestr researches the company, checks CRM history, gathers the relevant context, and prepares the next action.", ["New enquiry", "Research and history check", "Prepare next action", "Sales review", "CRM update and follow-up"], ["Email", "Browser", "CRM", "Approval"])}
      ${miniWorkflow("service", "service", "Customer operations", "From customer request to resolution", "Orkestr identifies the account, retrieves order or service information, checks the relevant systems, and prepares the resolution.", ["Customer request", "Account identified", "Systems checked", "Exception or routine path", "Resolution recorded"], ["Email", "CRM", "ERP", "Service portal"])}
      ${miniWorkflow("finance", "finance", "Finance", "From invoice to approved action", "Orkestr extracts the information, checks it against available records, identifies discrepancies, and routes the case appropriately.", ["Invoice received", "Data extracted", "Records compared", "Approval if needed", "Workflow continues"], ["Documents", "ERP", "Purchase records", "Approval"])}
      ${miniWorkflow("operations", "onboarding", "Internal operations", "From request to completed internal process", "Orkestr gathers information across internal systems, detects missing data, coordinates approvals, and updates the relevant records.", ["Request submitted", "Required data gathered", "Missing input chased", "Approvals coordinated", "Records updated"], ["Form", "Internal app", "Files", "Email"])}
    </div>
  </section>

  <section class="section approval-section" aria-labelledby="approval-title">
    <div><p class="section-index">THE HUMAN ROLE</p><h2 id="approval-title">Automate the work. Keep control of the decisions.</h2><p class="section-lead">Routine work keeps moving. High-consequence decisions stay with people.</p><p>Orkestr workflows can stop at predefined approval points. Your team sees what happened, what information was found, what the workflow recommends, and what happens after approval.</p><p class="history-note">Every action remains visible in the execution history.</p></div>
    <article class="approval-card" aria-label="Illustrative approval case">
      <div class="approval-card-head"><span>APPROVAL REQUIRED</span><strong>Invoice discrepancy detected</strong></div>
      <dl class="approval-values"><div><dt>Invoice</dt><dd>€48,420</dd></div><div><dt>PO value</dt><dd>€43,900</dd></div><div class="difference"><dt>Difference</dt><dd>€4,520</dd></div></dl>
      <ul><li>Supplier history checked <span>✓</span></li><li>Purchase order checked <span>✓</span></li><li>Relevant documents attached <span>✓</span></li></ul>
      <p class="approval-label">DECISION</p><div class="approval-actions"><button type="button" disabled>Approve next action</button><button type="button" disabled>Review case</button></div><small>Public-safe demonstration. Controls are intentionally inactive.</small>
    </article>
  </section>

  <section class="section engagement" aria-labelledby="engagement-title">
    <div><p class="section-index">HOW ENGAGEMENT STARTS</p><h2 id="engagement-title">Start with one workflow.</h2><p class="section-lead">You do not need an enterprise-wide AI transformation project. Start with one process already costing time, causing delays, or creating unnecessary manual work.</p><a class="button" href="/workflow" data-event="book_audit_engagement">Book a workflow audit</a></div>
    <ol class="phase-list five"><li><span>01</span><div><h3>Workflow Audit</h3><p>Map the process, systems, decisions, exceptions, and current bottlenecks.</p></div></li><li><span>02</span><div><h3>Workflow Design</h3><p>Define what Orkestr should do, what stays deterministic, and where people approve.</p></div></li><li><span>03</span><div><h3>Pilot Deployment</h3><p>Connect the necessary systems and implement the workflow in a controlled environment.</p></div></li><li><span>04</span><div><h3>Measure</h3><p>Compare the implemented workflow with the existing process before expanding.</p></div></li><li><span>05</span><div><h3>Operate and Expand</h3><p>Keep proven work running and add the next process only after value is visible.</p></div></li></ol>
  </section>

  <section class="measurement-section" aria-labelledby="measurement-title">
    <div><p class="section-index">MEASUREMENT BEFORE SCALE</p><h2 id="measurement-title">Automation should produce a measurable result.</h2><p>We do not evaluate a workflow by asking whether the AI looks impressive. Before implementation, we define the operational baseline.</p></div>
    <ul class="metric-list"><li>Minutes of human work per case</li><li>Number of manual touches</li><li>Response time</li><li>Backlog</li><li>Error rate</li><li>Exception rate</li><li>Cases processed per employee</li><li>Cost per completed process</li></ul>
    <blockquote>If the workflow does not improve the operation, it should not scale.</blockquote>
  </section>

  <section class="proof-section" id="proof" aria-labelledby="proof-title">
    <div class="section-heading inverse"><p class="section-index">PRODUCT EVIDENCE</p><h2 id="proof-title">Built to run real workflows.</h2><p>Orkestr coordinates agents, APIs, controlled browser execution, files, communication channels, deterministic rules, human approvals, and persistent workflow state around a bounded operational process.</p></div>
    ${renderConsoleEvidence()}
  </section>

  <section class="section deployment-summary" aria-labelledby="deployment-title">
    <div class="section-heading"><p class="section-index">DEPLOYMENT</p><h2 id="deployment-title">Your workflow. Your systems. Controlled access.</h2><p class="section-lead">Orkestr is deployed around the systems involved in the workflow rather than requiring the company to replace them.</p></div>
    <div class="deployment-columns"><article><span>01</span><h3>Existing systems</h3><ul><li>ERP and CRM</li><li>Email and databases</li><li>Internal applications</li><li>Files and web portals</li></ul></article><article><span>02</span><h3>Controlled execution</h3><ul><li>Defined workflow scope</li><li>Explicit permissions</li><li>Human approval</li><li>History and exceptions</li></ul></article><article><span>03</span><h3>Private deployment</h3><ul><li>Customer-specific configuration</li><li>Controlled connections</li><li>Workflow-level boundaries</li><li>Managed operation</li></ul></article></div>
    <a class="text-link" href="/deployment" data-event="deployment_detail_click">Read about deployment <span aria-hidden="true">→</span></a>
  </section>

  <section class="section security-summary" aria-labelledby="security-title">
    <div><p class="section-index">SECURITY</p><h2 id="security-title">AI access should be limited to what the workflow requires.</h2></div>
    <div><p class="section-lead">Giving a general-purpose AI unrestricted access to company systems is a bad architecture. Orkestr workflows are designed around explicit tasks, systems, and permissions.</p><p>The workflow should know what it may access, what it may change, when it must stop, when it needs approval, and what must be recorded.</p><a class="text-link" href="/security" data-event="security_approach_click">Read our security approach <span aria-hidden="true">→</span></a></div>
  </section>

  <section class="why-section" aria-labelledby="why-title">
    <div><p class="section-index">WHY ORKESTR</p><h2 id="why-title">The difference is not the model.</h2><p class="section-lead">The model is one component. The difficult part is making AI reliably participate in an actual business process.</p></div>
    <ul><li>Connecting systems</li><li>Maintaining context</li><li>Handling exceptions</li><li>Controlling permissions</li><li>Waiting for approvals</li><li>Resuming work</li><li>Recording what happened</li><li>Keeping the workflow running after the demo</li></ul>
    <p class="why-close">That is the layer Orkestr provides.</p>
  </section>

  <section class="section faq" aria-labelledby="faq-title">
    <div><p class="section-index">FAQ</p><h2 id="faq-title">Straight answers before the audit.</h2></div>
    <div class="faq-list"><details><summary>Is Orkestr another SaaS automation platform?</summary><p>No. Orkestr implementations are currently delivered as managed workflow deployments. We work with your team to map, build, deploy, and operate the workflow.</p></details><details><summary>Do we need to replace our existing software?</summary><p>No. The purpose of Orkestr is to work across the systems you already use.</p></details><details><summary>What if our software does not have an API?</summary><p>Depending on the system and workflow, Orkestr can use controlled browser execution in addition to direct integrations.</p></details><details><summary>Does AI make decisions automatically?</summary><p>Not necessarily. Workflows can include rules, confidence thresholds, and explicit human approval points. The level of autonomy depends on the process.</p></details><details><summary>Where should we start?</summary><p>Choose a repetitive, frequent process expensive enough to matter. Good candidates usually involve employees repeatedly moving information between several systems.</p></details><details><summary>Is Orkestr self-service?</summary><p>Not currently. We begin by understanding the workflow and designing the implementation with you.</p></details></div>
  </section>

  <section class="final-cta" aria-labelledby="final-title"><p class="section-index">SHOW US THE WORK</p><h2 id="final-title">Show us the work your team should not be doing manually.</h2><p>Pick one repetitive workflow. We’ll map the systems, handoffs, approvals, and exceptions and determine what can realistically be automated.</p><div class="actions"><a class="button button-light" href="/workflow" data-event="book_audit_final">Book a workflow audit</a><a class="text-link inverse-link" href="/workflow#workflow-form" data-event="map_workflow_final">Or map the workflow in writing <span aria-hidden="true">→</span></a></div><p class="final-note">No platform migration required. Start with one workflow.</p></section>
</main>`,
  };
}
