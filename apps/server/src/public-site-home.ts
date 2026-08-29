import type { PublicPage } from "./public-site-config.js";
import { renderConsoleEvidence, renderProjectDeliveryDiagram } from "./public-site-components.js";

type Offer = {
  verb: string;
  title: string;
  request: string;
  examples: string[];
  path: string;
};

const offers: Offer[] = [
  { verb: "BUILD", title: "Websites & commerce", request: "We need a new website, customer portal, or online store.", examples: ["Business websites", "E-commerce", "Customer portals", "Internal tools"], path: "/websites-commerce" },
  { verb: "REPLACE", title: "Business systems", request: "Our current system is outdated or no longer fits how we work.", examples: ["Legacy modernization", "Internal applications", "System replacement", "Process redesign"], path: "/business-systems" },
  { verb: "FIND", title: "Opportunity intelligence", request: "Find opportunities relevant to us before we miss them.", examples: ["Tenders", "Grants", "RFPs", "Projects and suppliers"], path: "/opportunity-intelligence" },
  { verb: "COLLECT", title: "Web data & monitoring", request: "Continuously collect and structure information we currently find manually.", examples: ["Public or authorized sources", "Structured extraction", "Change monitoring", "Alerts and research"], path: "/web-data-monitoring" },
  { verb: "AUTOMATE", title: "Operational workflows", request: "Our people repeatedly move information between systems.", examples: ["Email and documents", "Business software", "Browser applications", "Approvals"], path: "/automation" },
];

function offerCard(offer: Offer) {
  return `<article class="offer-card"><span>${offer.verb}</span><h3>${offer.title}</h3><blockquote>“${offer.request}”</blockquote><ul>${offer.examples.map((example) => `<li>${example}</li>`).join("")}</ul><a href="${offer.path}" data-event="offer_${offer.verb.toLowerCase()}_click">Explore ${offer.verb.toLowerCase()} projects <span aria-hidden="true">→</span></a></article>`;
}

function exampleProject(index: string, label: string, quote: string, system: string, components: string[]) {
  return `<article class="example-project"><p class="section-index">${index} · ${label}</p><blockquote>“${quote}”</blockquote><strong>${system}</strong><ul>${components.map((component) => `<li>${component}</li>`).join("")}</ul></article>`;
}

export function commercialHomePage(): PublicPage {
  return {
    id: "home",
    title: "Business Systems, Data & AI Automation",
    summary: "Orkestr designs, builds, deploys and operates websites, business systems, data products and AI-powered automation around real company requirements.",
    canonicalPath: "/",
    body: `<main id="main-content">
  <section class="hero commercial-hero v3-hero">
    <div class="hero-copy">
      <p class="eyebrow">BUILT AND OPERATED BY ORKESTR</p>
      <h1>Tell us what your business needs to do. <em>We build the system that does it.</em></h1>
      <p class="lead">Come with an outcome, even if you do not have a technical specification.</p>
      <p class="hero-detail">Orkestr designs, builds, deploys, and operates business software, data systems, and AI-powered automation.</p>
      <div class="actions"><a class="button" href="/project" data-event="describe_project_hero">Describe your project</a><a class="button button-ghost" href="#what-we-build" data-event="see_what_we_build">See what we build</a></div>
      <p class="microcopy hero-trust">Websites &amp; commerce <span aria-hidden="true">·</span> Business systems <span aria-hidden="true">·</span> Data &amp; monitoring <span aria-hidden="true">·</span> AI automation</p>
    </div>
    ${renderProjectDeliveryDiagram()}
  </section>

  <section class="section offer-section" id="what-we-build" aria-labelledby="offer-title">
    <div class="section-heading"><p class="section-index">START WITH THE PROBLEM, NOT THE TECHNOLOGY</p><h2 id="offer-title">Tell us what needs to happen.</h2><p class="section-lead">You do not need to decide whether the answer is an AI agent, custom application, crawler, integration, or automation. We determine what should be built.</p></div>
    <div class="offer-grid">${offers.map(offerCard).join("")}</div>
  </section>

  <section class="ugly-problem" aria-labelledby="ugly-title">
    <div><p class="section-index">BRING US AN UGLY PROBLEM</p><h2 id="ugly-title">You do not need to know the solution.</h2><p class="section-lead">A concrete business problem is a better starting point than a list of fashionable technologies. Understanding the system is our job.</p><a class="button button-light" href="/project" data-event="describe_project_ugly">Describe the problem</a></div>
    <div class="problem-quotes" aria-label="Example project starting points"><blockquote>“We check 40 websites every morning.”</blockquote><blockquote>“Our internal system is 15 years old and nobody wants to touch it.”</blockquote><blockquote>“We need online ordering but do not know what stack to use.”</blockquote><blockquote>“Someone copies every customer email into three systems.”</blockquote><blockquote>“We keep missing tenders because nobody has time to search.”</blockquote></div>
  </section>

  <section class="section example-projects" aria-labelledby="examples-title">
    <div class="section-heading"><p class="section-index">ILLUSTRATIVE PROJECT BRIEFS</p><h2 id="examples-title">Different requirements. One accountable delivery model.</h2><p class="section-lead">These examples show the kinds of systems Orkestr can assess. They are not claims of completed customer projects or fixed packages.</p></div>
    <div class="example-project-grid">
      ${exampleProject("01", "BUILD", "We need a B2B website with customer ordering.", "A maintainable commerce system", ["Product and account experience", "Ordering workflow", "Administration", "Deployment and support"])}
      ${exampleProject("02", "REPLACE", "Our internal ordering tool needs replacing.", "A staged business-system replacement", ["Process and data discovery", "New application", "Migration plan", "Controlled cutover"])}
      ${exampleProject("03", "FIND", "Surface relevant public tenders every day.", "An opportunity intelligence system", ["Approved source collection", "Normalization", "Matching and review", "Alerts with provenance"])}
      ${exampleProject("04", "AUTOMATE", "Move requests through email and internal software.", "A supervised operational workflow", ["Trigger and context", "Rules and agent work", "Browser execution", "Approval and history"])}
    </div>
  </section>

  <section class="section project-delivery" id="how-we-work" aria-labelledby="delivery-title">
    <div><p class="section-index">FROM REQUIREMENT TO OPERATING SYSTEM</p><h2 id="delivery-title">We build the system—and define how it stays useful.</h2><p class="section-lead">The implementation may be conventional software, a data pipeline, integrations, an Orkestr-powered operating layer, or a careful combination. The requirement decides.</p></div>
    <ol class="phase-list five"><li><span>01</span><div><h3>Project Discovery</h3><p>Understand the outcome, existing systems, users, constraints, risks, and definition of success.</p></div></li><li><span>02</span><div><h3>Solution Design</h3><p>Determine the architecture, interfaces, data, integrations, automation, and AI where appropriate.</p></div></li><li><span>03</span><div><h3>Proposal</h3><p>Define scope, deliverables, milestones, responsibilities, boundaries, and operating model before implementation.</p></div></li><li><span>04</span><div><h3>Build &amp; Deploy</h3><p>Implement, test, release, and put the bounded system into a controlled production environment.</p></div></li><li><span>05</span><div><h3>Managed Operation</h3><p>Monitor, maintain, support, and improve the system under the agreed responsibility model.</p></div></li></ol>
    <a class="button" href="/project" data-event="describe_project_engagement">Start Project Discovery</a>
  </section>

  <section class="proof-section" id="platform" aria-labelledby="platform-title">
    <div class="section-heading inverse"><p class="section-index">BUILT ON ORKESTR</p><h2 id="platform-title">An operating layer when the system needs to keep working.</h2><p>Managed systems can use Orkestr to coordinate agents, schedules, browser execution, files, communication channels, approvals, persistent jobs, monitoring, and recovery.</p><p>Not every project needs this layer. Conventional websites and applications use standard software components first; Orkestr is added where ongoing operational work makes it useful.</p></div>
    ${renderConsoleEvidence()}
  </section>

  <section class="browser-section" aria-labelledby="browser-title">
    <div class="browser-copy"><p class="section-index">MESSY SYSTEMS ARE NORMAL</p><h2 id="browser-title">No API? That does not necessarily stop us.</h2><p>Important work still happens inside legacy systems, supplier portals, public websites, internal applications, logistics platforms, and administrative dashboards.</p><p>We use direct integrations where available and controlled browser execution where appropriate and authorized.</p><strong class="browser-statement">APIs when available.<br>The browser when they are not.</strong></div>
    <div class="system-map" role="img" aria-label="Orkestr can coordinate direct integrations, files, websites, browser-only software, and human decisions"><div class="map-core"><span>OPERATING LAYER</span><strong>Orkestr</strong></div><div class="map-node erp"><span>STANDARD SOFTWARE</span><strong>Applications</strong></div><div class="map-node crm"><span>DIRECT</span><strong>APIs</strong></div><div class="map-node email"><span>AUTHORIZED</span><strong>Web sources</strong></div><div class="map-node browser"><span>CONTROLLED BROWSER</span><strong>Legacy systems</strong></div><div class="map-node files"><span>APPROVED SOURCE</span><strong>Files &amp; data</strong></div><div class="map-node person"><span>DECISION GATE</span><strong>Human review</strong></div></div>
  </section>

  <section class="section approval-section" aria-labelledby="approval-title">
    <div><p class="section-index">HUMAN CONTROL WHERE IT MATTERS</p><h2 id="approval-title">Automate the work. Keep control of the decisions.</h2><p class="section-lead">Not every Orkestr project needs approval gates. When a managed workflow does, it can stop at a defined boundary and show the evidence before a person decides.</p><p class="history-note">Routine work can keep moving. High-consequence actions remain visible and reviewable.</p></div>
    <article class="approval-card" aria-label="Illustrative opportunity review"><div class="approval-card-head"><span>REVIEW REQUIRED</span><strong>Opportunity matched</strong></div><dl class="approval-values"><div><dt>Source</dt><dd>Public</dd></div><div><dt>Deadline</dt><dd>18 days</dd></div><div class="difference"><dt>Fit</dt><dd>Review</dd></div></dl><ul><li>Source link recorded <span>✓</span></li><li>Required criteria checked <span>✓</span></li><li>Matching reason attached <span>✓</span></li></ul><p class="approval-label">DECISION</p><div class="approval-actions"><button type="button" disabled>Add to shortlist</button><button type="button" disabled>Review evidence</button></div><small>Public-safe illustration. Controls are inactive.</small></article>
  </section>

  <section class="section deployment-summary" aria-labelledby="deployment-title">
    <div class="section-heading"><p class="section-index">DEPLOYMENT &amp; OPERATION</p><h2 id="deployment-title">Your requirement. A defined production boundary.</h2><p class="section-lead">Hosting, integrations, permissions, monitoring, support, data responsibilities, and release ownership are agreed for the system being built.</p></div>
    <div class="deployment-columns"><article><span>01</span><h3>Existing environment</h3><ul><li>Current software and data</li><li>Approved websites and services</li><li>Users and business owners</li><li>Constraints and dependencies</li></ul></article><article><span>02</span><h3>Controlled implementation</h3><ul><li>Defined project scope</li><li>Explicit access</li><li>Testing and failure paths</li><li>Release and rollback</li></ul></article><article><span>03</span><h3>Operating model</h3><ul><li>Private or customer-controlled environment</li><li>Monitoring and maintenance</li><li>Support responsibilities</li><li>Measured improvement</li></ul></article></div>
    <a class="text-link" href="/deployment" data-event="deployment_detail_click">Read about deployment <span aria-hidden="true">→</span></a>
  </section>

  <section class="section security-summary" aria-labelledby="security-title"><div><p class="section-index">SECURITY</p><h2 id="security-title">Access should be no broader than the system requires.</h2></div><div><p class="section-lead">A project begins with explicit users, data, sources, systems, permissions, stop conditions, and recording requirements.</p><p>Orkestr does not bypass access controls. Web-data projects use public or authorized sources, and agentic workflows are bounded around approved tasks.</p><a class="text-link" href="/security" data-event="security_approach_click">Read our security approach <span aria-hidden="true">→</span></a></div></section>

  <section class="why-section" aria-labelledby="why-title"><div><p class="section-index">WHY ORKESTR</p><h2 id="why-title">The difficult part is not writing a demo.</h2><p class="section-lead">The difficult part is turning a business requirement into a system that keeps working.</p></div><ul><li>Understanding the real process</li><li>Choosing the right architecture</li><li>Connecting imperfect systems</li><li>Handling data and exceptions</li><li>Controlling permissions</li><li>Testing failure paths</li><li>Deploying with rollback</li><li>Maintaining the live operation</li></ul><p class="why-close">Orkestr builds systems that do work.</p></section>

  <section class="section faq" aria-labelledby="faq-title">
    <div><p class="section-index">FAQ</p><h2 id="faq-title">Straight answers before Discovery.</h2></div>
    <div class="faq-list"><details><summary>Is Orkestr a general software agency?</summary><p>No. Orkestr focuses on bounded business systems and automation that can be designed, deployed, and operated with clear responsibility. We use an operating platform and engineering capability rather than selling open-ended development capacity.</p></details><details><summary>Do we need a technical specification?</summary><p>No. Start with the outcome, current situation, users, constraints, and definition of success. Project Discovery determines what should be built.</p></details><details><summary>Do you only build AI systems?</summary><p>No. Conventional software is often the right foundation. We add AI, agents, browser execution, and automation only where they create a defensible operational benefit.</p></details><details><summary>Can you work with old or browser-only software?</summary><p>Potentially. We assess direct integration, controlled browser execution, staged replacement, or a new interface around the existing system. Feasibility depends on access, risk, and the specific software.</p></details><details><summary>Do you offer web scraping?</summary><p>Web extraction can be one implementation technique inside a data system. Sources must be public or explicitly authorized, and source terms, privacy, rate limits, reliability, and maintenance are reviewed during Discovery.</p></details><details><summary>Is Orkestr self-service?</summary><p>Not currently. Projects are delivered as managed implementations with an agreed scope, deployment boundary, and operating model.</p></details></div>
  </section>

  <section class="final-cta" aria-labelledby="final-title"><p class="section-index">PROJECT DISCOVERY</p><h2 id="final-title">Show us what your business needs to do.</h2><p>Describe one requirement, broken system, repeated search, data problem, or manual process. We will determine what can realistically be built and how it should operate.</p><div class="actions"><a class="button button-light" href="/project" data-event="describe_project_final">Describe your project</a><a class="text-link inverse-link" href="/use-cases" data-event="see_what_we_build">See what we build <span aria-hidden="true">→</span></a></div><p class="final-note">No technical specification required. Start with a concrete outcome.</p></section>
</main>`,
  };
}
