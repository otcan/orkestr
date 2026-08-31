import type { PublicPage, PublicPageId } from "./public-site-config.js";
import { renderSolutionVisual } from "./public-site-visuals.js";

type SolutionDefinition = {
  id: PublicPageId;
  path: string;
  verb: string;
  title: string;
  summary: string;
  heading: string;
  lead: string;
  request: string;
  outcomes: string[];
  stages: Array<[string, string]>;
  proofTitle: string;
  proofText: string;
  boundaries: string[];
  automationAudit?: boolean;
};

export const solutionDefinitions: SolutionDefinition[] = [
  {
    id: "websites-commerce", path: "/websites-commerce", verb: "BUILD", title: "Websites, Commerce & Customer Portals",
    summary: "Orkestr designs, builds, deploys and operates business websites, B2B portals, online stores, and focused internal tools around a defined outcome.",
    heading: "Build the digital system your customers or team actually need.",
    lead: "Start with the audience, transaction, service, or internal task—not a predetermined stack. We turn the requirement into a usable, maintainable system and an operating plan.",
    request: "We need a new B2B website where approved customers can find products and place orders.",
    outcomes: ["Business and service websites", "B2B and B2C commerce", "Customer and partner portals", "Focused internal tools"],
    stages: [["Discover", "Define users, journeys, content, transactions, ownership, and success."], ["Design", "Plan the interface, data model, integrations, administration, and delivery boundary."], ["Build", "Implement the application using standard web technologies and only the automation the requirement needs."], ["Operate", "Deploy, monitor, maintain, and improve the live system under an agreed model."]],
    proofTitle: "Strong software, with AI where it creates value.",
    proofText: "Orkestr uses standard software components for the core website or application, adding its operating layer when ongoing agents, schedules, browser work, monitoring, or approvals create practical value.",
    boundaries: ["Hosting, content ownership, support, analytics, and release responsibility are agreed before launch.", "Payment, identity, tax, accessibility, and regulatory requirements depend on the project and selected providers.", "The proposal defines the exact project scope, integrations, and commercial model."],
  },
  {
    id: "business-systems", path: "/business-systems", verb: "REPLACE", title: "Legacy & Internal Business Systems",
    summary: "Replace or modernize outdated internal software through process discovery, staged migration, controlled integration, testing, and managed operation.",
    heading: "Replace the system everyone depends on—but nobody wants to touch.",
    lead: "An old system is not only old code. It contains data, exceptions, habits, responsibilities, and business rules. We map those realities before proposing a replacement.",
    request: "Our internal ordering system is fifteen years old and no longer fits how the business works.",
    outcomes: ["Legacy system replacement", "Internal applications", "Process and interface redesign", "Staged data migration"],
    stages: [["Discover", "Map users, workflows, data, integrations, hidden rules, and failure risks."], ["Design", "Choose what to preserve, replace, simplify, integrate, or retire."], ["Migrate", "Build and validate the new system with representative data and a staged cutover."], ["Operate", "Monitor the production system, support users, and improve it without losing the rollback path."]],
    proofTitle: "Staged modernization around a working business.",
    proofText: "The right modernization path may replace the application or preserve a stable core while adding a new interface, integration, or automated layer around it.",
    boundaries: ["Migration scope and data quality must be inspected before a fixed implementation promise.", "Production access, backups, retention, and cutover approval stay explicit.", "A discovery phase can recommend staged improvement instead of full replacement."],
  },
  {
    id: "opportunity-intelligence", path: "/opportunity-intelligence", verb: "FIND", title: "Opportunity Intelligence Systems",
    summary: "Continuously find, normalize, match, score and surface relevant tenders, grants, RFPs, suppliers, projects, partnerships, or market opportunities.",
    heading: "Never manually search for the same opportunity twice.",
    lead: "Orkestr can build a managed system that checks the approved sources that matter, structures new opportunities, matches them to your criteria, and routes the useful results to your team.",
    request: "We need to find relevant public tenders every day before our team misses them.",
    outcomes: ["Tenders and public procurement", "Grants and funding calls", "RFPs and project opportunities", "Suppliers and partnerships"],
    stages: [["Collect", "Check approved sources through APIs, feeds, browser automation, or permitted extraction."], ["Normalize", "Turn inconsistent source material into comparable records with provenance."], ["Match", "Apply deterministic criteria and AI-assisted classification or summarization where useful."], ["Deliver", "Send alerts, prepare review queues, track decisions, and improve matching from feedback."]],
    proofTitle: "More than monitoring.",
    proofText: "Opportunity intelligence can combine collection, normalization, matching, scoring, summarization, notification, and review. Every result should retain its source and the reason it was surfaced.",
    boundaries: ["Sources must be public or explicitly authorized for the deployment.", "Coverage, update frequency, access terms, and source stability are evaluated during Discovery.", "Automated matching supports human review; it does not guarantee eligibility or a successful proposal."],
  },
  {
    id: "web-data-monitoring", path: "/web-data-monitoring", verb: "COLLECT", title: "Web Data Collection & Monitoring",
    summary: "Collect, structure and monitor information from public or authorized web sources using APIs, feeds, browser automation, or permitted web extraction.",
    heading: "Turn repeated web research into a maintained data system.",
    lead: "If people repeatedly check the same sites, copy the same fields, compare changes, or assemble the same research file, we can assess a controlled collection and monitoring system.",
    request: "We check dozens of approved websites every morning and manually copy changes into a spreadsheet.",
    outcomes: ["Structured web collection", "Change and availability monitoring", "Alerts and exports", "Research and enrichment pipelines"],
    stages: [["Define", "Agree the permitted sources, fields, frequency, evidence, and downstream use."], ["Collect", "Use the most stable authorized method available: API, feed, browser, or extraction."], ["Validate", "Detect missing fields, layout changes, duplicates, and uncertain records."], ["Operate", "Monitor collection health, maintain source adapters, record provenance, and deliver updates."]],
    proofTitle: "Reliable, structured data is the product.",
    proofText: "The product is reliable, structured information with known provenance and an operating owner. The collection method depends on the source and can change over time without changing the business outcome.",
    boundaries: ["Orkestr does not bypass access controls or collect from sources the customer is not authorized to use.", "Terms, privacy, copyright, robots guidance, rate limits, and personal-data exposure require source-specific review.", "Source changes and anti-automation controls can affect feasibility and maintenance cost."],
  },
  {
    id: "automation", path: "/automation", verb: "AUTOMATE", title: "AI Operations & Workflow Automation",
    summary: "Build and operate controlled workflows across email, documents, business systems, browser-only applications, schedules, rules, agents, and human approvals.",
    heading: "Move recurring work forward across the software you already use.",
    lead: "Orkestr maps one bounded operational process, identifies the deterministic and agentic steps, connects only the required systems, and keeps people in control of important decisions.",
    request: "Our staff spend hours moving information between email, documents, and an internal browser application.",
    outcomes: ["Email and document workflows", "ERP, CRM, and internal tools", "Browser-only applications", "Approvals and exception handling"],
    stages: [["Audit", "Map triggers, systems, handoffs, decisions, exceptions, and the current baseline."], ["Bound", "Define allowed actions, deterministic rules, agent work, approvals, and stop conditions."], ["Pilot", "Implement one controlled workflow and test representative normal and failure cases."], ["Operate", "Monitor completion, interventions, errors, history, and measurable operating value." ]],
    proofTitle: "Persistent work across the systems your team uses.",
    proofText: "The Orkestr operating layer coordinates named threads, schedules, browser execution, files, communication channels, approvals, interruptions, history, and recovery around the defined process.",
    boundaries: ["Connections and actions are configured for each deployment.", "High-consequence or irreversible steps need an appropriate review policy.", "Each workflow has a defined process, permission scope, and review policy."],
    automationAudit: true,
  },
];

function projectCta(heading: string, event = "solution_describe_project") {
  return `<section class="final-cta compact"><div><p class="section-index">PROJECT DISCOVERY</p><h2>${heading}</h2></div><a class="button button-light" href="/project#book" data-event="${event}">Book a project call</a></section>`;
}

function solutionCard(solution: SolutionDefinition) {
  return `<article class="offer-card"><span>${solution.verb}</span><h3>${solution.title}</h3><blockquote>“${solution.request}”</blockquote><p>${solution.summary}</p><a href="${solution.path}" data-event="offer_${solution.verb.toLowerCase()}_click">Explore ${solution.verb.toLowerCase()} projects <span aria-hidden="true">→</span></a></article>`;
}

export function whatWeBuildPage(): PublicPage {
  return {
    id: "use-cases",
    title: "Business Systems & Automation Services",
    summary: "See what Orkestr builds and operates across websites and commerce, business-system replacement, opportunity intelligence, web data, and AI automation.",
    body: `<main id="main-content">
      <section class="page-hero"><p class="section-index">WHAT WE BUILD</p><h1>Five ways to turn a business requirement into a working system.</h1><p class="lead">Bring the outcome, the broken process, or the opportunity. Orkestr determines whether the answer is conventional software, data engineering, integrations, automation, AI—or a careful combination.</p></section>
      <section class="section solution-index" aria-labelledby="solution-index-title"><div class="section-heading"><p class="section-index">BUILD · REPLACE · FIND · COLLECT · AUTOMATE</p><h2 id="solution-index-title">Start with what needs to happen.</h2></div><div class="offer-grid">${solutionDefinitions.map(solutionCard).join("")}</div></section>
      <section class="section solution-principle"><div><p class="section-index">ONE PRINCIPLE</p><h2>Technology follows the work.</h2></div><div><p class="section-lead">Deterministic software handles clear rules. AI supports interpretation and judgment where it creates value. Orkestr combines both around the business outcome and keeps the operating boundary visible.</p><a class="text-link" href="/#platform">See the Orkestr operating layer <span aria-hidden="true">→</span></a></div></section>
      ${projectCta("What does your business need to do?")}
    </main>`,
  };
}

export function solutionPage(pageId: PublicPageId): PublicPage {
  const solution = solutionDefinitions.find((item) => item.id === pageId) || solutionDefinitions[0];
  return {
    id: solution.id,
    title: solution.title,
    summary: solution.summary,
    canonicalPath: solution.path,
    body: `<main id="main-content">
      <section class="page-hero solution-hero"><p class="section-index">${solution.verb} · BUSINESS SYSTEMS &amp; AUTOMATION</p><h1>${solution.heading}</h1><p class="lead">${solution.lead}</p><blockquote>“${solution.request}”</blockquote><div class="actions"><a class="button" href="/project#book" data-event="solution_describe_project">Book a project call</a>${solution.automationAudit ? '<a class="button button-ghost" href="/workflow" data-event="automation_audit_click">Book a Workflow Audit</a>' : ""}</div></section>
      ${renderSolutionVisual(solution.id)}
      <section class="section solution-outcomes" aria-labelledby="outcomes-title"><div><p class="section-index">POSSIBLE OUTCOMES</p><h2 id="outcomes-title">A bounded system—not an open-ended transformation.</h2></div><ul>${solution.outcomes.map((outcome) => `<li>${outcome}</li>`).join("")}</ul></section>
      <section class="section solution-delivery" aria-labelledby="delivery-title"><div><p class="section-index">FROM REQUIREMENT TO OPERATION</p><h2 id="delivery-title">What the work can include.</h2></div><ol class="phase-list">${solution.stages.map(([title, text], index) => `<li><span>${String(index + 1).padStart(2, "0")}</span><div><h3>${title}</h3><p>${text}</p></div></li>`).join("")}</ol></section>
      <section class="why-section solution-proof" aria-labelledby="proof-title"><div><p class="section-index">WHY ORKESTR</p><h2 id="proof-title">${solution.proofTitle}</h2></div><p class="section-lead">${solution.proofText}</p></section>
      <section class="section limitations"><div><p class="section-index">BOUNDARIES</p><h2>What Discovery must establish.</h2></div><ul>${solution.boundaries.map((boundary) => `<li>${boundary}</li>`).join("")}</ul></section>
      ${projectCta("Bring us the requirement, even if the solution is not yet clear.")}
    </main>`,
  };
}
