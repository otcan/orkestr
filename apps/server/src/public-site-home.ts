import type { PublicPage } from "./public-site-config.js";
import { renderConsoleEvidence } from "./public-site-components.js";

const services = [
  {
    number: "01",
    title: "Build new systems",
    copy: "Launch a website, online store, portal, internal tool, or customer-facing application built around how the business actually works.",
    examples: "Websites · Commerce · Portals · Applications",
    path: "/websites-commerce",
  },
  {
    number: "02",
    title: "Modernize existing systems",
    copy: "Replace an outdated application, redesign a broken process, or create a safer path away from software that no longer fits.",
    examples: "Legacy systems · Internal software · Migration",
    path: "/business-systems",
  },
  {
    number: "03",
    title: "Automate work and data",
    copy: "Collect and monitor information, connect software, and turn repeated manual work into a controlled operating process.",
    examples: "Data monitoring · Integrations · AI workflows",
    path: "/automation",
  },
];

function serviceCard(service: typeof services[number]) {
  return `<article class="v4-service-card"><span>${service.number}</span><h3>${service.title}</h3><p>${service.copy}</p><small>${service.examples}</small><a href="${service.path}" data-event="service_group_click">Explore this work <span aria-hidden="true">→</span></a></article>`;
}

export function commercialHomePage(): PublicPage {
  return {
    id: "home",
    title: "Custom Business Software & Automation",
    summary: "Orkestr designs, builds, modernizes, and operates websites, business software, data systems, and automation around real business needs.",
    canonicalPath: "/",
    body: `<main id="main-content" class="v4-home">
  <section class="v4-section v4-hero" aria-labelledby="home-title">
    <div class="v4-hero-copy">
      <p class="eyebrow">CUSTOM BUSINESS SOFTWARE · BUILT &amp; OPERATED</p>
      <h1 id="home-title">Need a better system for your business?</h1>
      <p class="lead">Orkestr designs, builds, modernizes, and operates the software behind real business work.</p>
      <p class="hero-detail">From websites and internal tools to data systems and automation. Start with a short conversation—no technical specification required.</p>
      <div class="actions"><a class="button" href="/project#book" data-event="book_project_hero">Book a 20-minute project call</a><a class="button button-ghost" href="#services" data-event="see_services">See what we build</a></div>
      <ul class="v4-trust" aria-label="Engagement principles"><li>Start with the problem</li><li>Clear proposal before build</li><li>Managed after launch</li></ul>
    </div>
    <article class="v4-brief-card" aria-label="Example Orkestr project brief">
      <div class="v4-brief-head"><span>PROJECT BRIEF</span><strong>Internal ordering system</strong></div>
      <dl><div><dt>Problem</dt><dd>An old tool no longer supports how orders are handled.</dd></div><div><dt>Build</dt><dd>A staged replacement around users, data, and approvals.</dd></div><div><dt>Operate</dt><dd>Deploy, monitor, support, and improve the live system.</dd></div></dl>
      <p><span aria-hidden="true">●</span> Outcome first. Technology second.</p>
    </article>
  </section>

  <section class="v4-section v4-services" id="services" aria-labelledby="services-title">
    <div class="v4-section-head"><p class="section-index">WHAT WE BUILD</p><h2 id="services-title">Three ways we can help.</h2><p>Tell us what needs to change. We will determine what kind of system should be built.</p></div>
    <div class="v4-service-grid">${services.map(serviceCard).join("")}</div>
  </section>

  <section class="v4-section v4-examples" id="examples" aria-labelledby="examples-title">
    <div class="v4-section-head"><p class="section-index">START WITH A REAL PROBLEM</p><h2 id="examples-title">You do not need to arrive with a specification.</h2></div>
    <div class="v4-example-list">
      <article><span>BUILD</span><blockquote>“We need a new B2B website where customers can place orders.”</blockquote><p>Website, account experience, ordering, administration, and launch.</p></article>
      <article><span>MODERNIZE</span><blockquote>“Our internal system is old, fragile, and no longer fits the business.”</blockquote><p>Discovery, replacement design, migration plan, and controlled cutover.</p></article>
      <article><span>AUTOMATE</span><blockquote>“Our team repeatedly searches websites and moves the results by hand.”</blockquote><p>Authorized collection, structured data, review, alerts, and operation.</p></article>
    </div>
    <a class="text-link" href="/use-cases" data-event="see_examples">See more examples <span aria-hidden="true">→</span></a>
  </section>

  <section class="v4-section v4-process" id="how-we-work" aria-labelledby="process-title">
    <div class="v4-section-head"><p class="section-index">HOW IT WORKS</p><h2 id="process-title">From conversation to working system.</h2><p>Every engagement has a visible decision path. You know what is being built before implementation begins.</p></div>
    <ol class="v4-process-list"><li><span>01</span><div><h3>Talk</h3><p>Explain the outcome, the current problem, and who it affects.</p></div></li><li><span>02</span><div><h3>Define</h3><p>We map the users, scope, architecture, risks, and operating model.</p></div></li><li><span>03</span><div><h3>Build</h3><p>We implement, test, and deploy the agreed system.</p></div></li><li><span>04</span><div><h3>Operate</h3><p>We monitor, maintain, support, and improve it after launch.</p></div></li></ol>
  </section>

  <section class="v4-section v4-proof" id="platform" aria-labelledby="proof-title">
    <div class="v4-proof-copy"><p class="section-index">BUILT ON ORKESTR</p><h2 id="proof-title">More than a hand-off.</h2><p>When a system needs scheduled work, browser execution, persistent jobs, human decisions, or recovery, the Orkestr operating layer keeps that work visible and controlled.</p><p>Not every project needs every capability. We use the simplest architecture that fits the requirement.</p><ul><li>APIs when available</li><li>Controlled browser execution when appropriate</li><li>Explicit access and human review where needed</li></ul><a class="text-link inverse-link" href="/security" data-event="security_approach_click">See how access is controlled <span aria-hidden="true">→</span></a></div>
    ${renderConsoleEvidence()}
  </section>

  <section class="v4-section v4-final" aria-labelledby="final-title">
    <p class="section-index">START WITH 20 MINUTES</p><h2 id="final-title">Tell us what should work better.</h2><p>A short conversation is enough to decide whether there is a credible next step. No technical specification and no platform migration required.</p><div class="actions"><a class="button button-light" href="/project#book" data-event="book_project_final">Book a 20-minute project call</a><a class="text-link inverse-link" href="/project#quick-project-form" data-event="quick_project_final">Or describe it in 60 seconds <span aria-hidden="true">→</span></a></div>
  </section>
</main>`,
  };
}
