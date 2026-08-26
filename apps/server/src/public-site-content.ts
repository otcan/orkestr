import { escapeHtml, publicConnectUrl, publicRepoUrl, type PublicPage } from "./public-site-config.js";

const configurationDisclaimer = "Connector availability, policies, approval rules, and system actions are configured for each deployment.";

function pageIntro(index: string, eyebrow: string, heading: string, summary: string) {
  return `<section class="page-hero"><p class="section-index">${index} · ${eyebrow}</p><h1>${heading}</h1><p class="lead">${summary}</p></section>`;
}

export function securityPage(): PublicPage {
  return {
    id: "security",
    title: "Security",
    summary: "Review Orkestr's private deployment boundaries, scoped connections, human approvals, visibility, revocation paths, and current public-alpha limitations.",
    body: `<main id="main-content">${pageIntro("01", "SECURITY", "Control starts with the deployment boundary.", "Orkestr is designed to coordinate bounded work without turning every connected system into an open-ended agent capability.")}
      <section class="section detail-grid"><article><span>ISOLATION</span><h2>Private runtime boundary</h2><p>Managed deployments keep runtime state, credentials, browser profiles, and customer-specific configuration outside the public repository. Customer-controlled deployments place that boundary in infrastructure the customer operates.</p></article><article><span>CONNECTIONS</span><h2>Scoped access</h2><p>Connectors are granted for a user or workflow context and can be revoked. A connection does not automatically authorize every action the provider supports.</p></article><article><span>CONTROL</span><h2>Approval and interruption</h2><p>Consequential workflow steps can stop for human approval. Operators can pause work, revoke access, or interrupt managed resources when a workflow or runtime should not continue.</p></article><article><span>VISIBILITY</span><h2>State and history</h2><p>Named threads, workflow status, recent activity, connector state, and control warnings give operators evidence to review rather than a hidden chain of autonomous actions.</p></article></section>
      <section class="section boundary-table" aria-labelledby="boundary-title"><div><p class="section-index">DATA BOUNDARIES</p><h2 id="boundary-title">What stays where</h2></div><dl><div><dt>Public OSS core</dt><dd>Generic product code, documentation, synthetic examples, tests, and public assets.</dd></div><div><dt>Private deployment</dt><dd>Credentials, real overlays, browser and messaging sessions, customer configuration, operational evidence, and internal runbooks.</dd></div><div><dt>Connected providers</dt><dd>Only data required for the user-requested, provider-authorized workflow; provider terms and controls still apply.</dd></div></dl></section>
      <section class="section limitations"><div><p class="section-index">CURRENT LIMITATIONS</p><h2>Public alpha, stated plainly.</h2></div><ul><li>Orkestr does not claim security certification or universal regulatory compliance.</li><li>It is not a hosted multi-user SaaS product and does not claim general team RBAC.</li><li>Deployment hardening, identity, retention, connector scope, and recovery must be reviewed for the target environment.</li><li>Generated output and consequential actions require an appropriate human review policy.</li></ul></section>
      <section class="final-cta compact"><h2>Assess one workflow against this control model.</h2><a class="button button-light" href="/workflow" data-event="map_workflow_security">Map one workflow</a></section>
    </main>`,
  };
}

export function deploymentPage(env = process.env): PublicPage {
  const connectUrl = publicConnectUrl(env);
  return {
    id: "deployment",
    title: "Deployment",
    summary: "Compare Orkestr managed isolated and customer-controlled private deployment models, responsibilities, prerequisites, updates, and support boundaries.",
    body: `<main id="main-content">${pageIntro("02", "DEPLOYMENT", "Private deployment is the product boundary.", "Choose where Orkestr runs, which systems it can reach, who controls identity and secrets, and how operational changes are released.")}
      <section class="section deployment-models"><article><p class="eyebrow">MANAGED ISOLATED</p><h2>Dedicated environment, operated with you.</h2><p>Orkestr provisions and maintains an isolated runtime for the agreed workflow. You provide authorized system access, workflow ownership, approval rules, and test cases.</p><ul><li>Dedicated runtime boundary</li><li>Managed updates and operational support</li><li>Customer-approved connector grants</li><li>Private configuration outside the OSS core</li></ul></article><article><p class="eyebrow">CUSTOMER CONTROLLED</p><h2>Your infrastructure, shared implementation plan.</h2><p>Orkestr is installed in infrastructure you control. Your team owns the environment, identity perimeter, network policy, backup, and access reviews; implementation responsibilities are agreed before pilot work.</p><ul><li>Customer-owned infrastructure</li><li>Documented prerequisites and handoff</li><li>Controlled update and rollback process</li><li>Support boundary defined per deployment</li></ul></article></section>
      <section class="section responsibility"><div><p class="section-index">RESPONSIBILITY MODEL</p><h2>Deployment does not remove operational ownership.</h2></div><div class="table-wrap"><table><thead><tr><th>Area</th><th>Orkestr implementation</th><th>Customer owner</th></tr></thead><tbody><tr><td>Workflow definition</td><td>Map steps, exceptions, controls</td><td>Approve intent and success measure</td></tr><tr><td>Infrastructure</td><td>Operate managed boundary or document install</td><td>Approve location, identity, network, retention</td></tr><tr><td>Connections</td><td>Configure scoped integration</td><td>Authorize account and provider access</td></tr><tr><td>Release</td><td>Test, version, monitor, document rollback</td><td>Approve production window and consequences</td></tr></tbody></table></div></section>
      <section class="section prerequisites"><div><p class="section-index">PILOT PREREQUISITES</p><h2>What we need before build starts.</h2></div><ol><li>A named workflow owner and representative cases.</li><li>Explicit system access and data-boundary decisions.</li><li>Defined approval, exception, and rollback rules.</li><li>A measurable outcome and production release owner.</li></ol><p>${configurationDisclaimer}</p></section>
      <section class="section pairing-note"><div><h2>Connection approvals use the secure pairing surface.</h2><p>Application sign-in and connector pairing remain separate host responsibilities. Connection links should resolve through the configured secure pairing host.</p></div><a class="text-link" href="${escapeHtml(connectUrl)}" rel="noreferrer">Open configured pairing surface <span aria-hidden="true">→</span></a></section>
      <section class="final-cta compact"><h2>Choose the boundary after mapping the workflow.</h2><a class="button button-light" href="/workflow" data-event="map_workflow_deployment">Map one workflow</a></section>
    </main>`,
  };
}

export function developersPage(env = process.env): PublicPage {
  const repo = publicRepoUrl(env);
  return {
    id: "developers",
    title: "Developers",
    summary: "Explore Orkestr's public-alpha architecture, open-source core, local quick start, connector boundaries, and managed-delivery relationship.",
    body: `<main id="main-content">${pageIntro("03", "DEVELOPERS", "An open core for observable agent operations.", "Orkestr wraps persistent agent runtimes with threads, managed resources, connectors, controls, and a server-rendered public surface. The repository is MIT licensed and currently public alpha.")}
      <section class="section architecture"><div><p class="section-index">ARCHITECTURE</p><h2>Runtime, control plane, and scoped edges.</h2><p>Codex or another configured runtime performs work. Orkestr maintains the durable thread and resource state around it. Connectors and managed browsers form explicit edges to external systems.</p></div><ol class="architecture-flow"><li><span>01</span><strong>Instruction</strong><p>A user or bounded trigger enters a named thread.</p></li><li><span>02</span><strong>Runtime</strong><p>The configured agent works inside its assigned workspace and grants.</p></li><li><span>03</span><strong>Control</strong><p>Orkestr tracks state, resources, warnings, approvals, and delivery.</p></li><li><span>04</span><strong>Edge</strong><p>A scoped connector or managed desktop performs the authorized system action.</p></li></ol></section>
      <section class="code-section"><div><p class="section-index">PUBLIC-ALPHA QUICK START</p><h2>Run the OSS core locally.</h2><p>Use synthetic data and keep private overlays, secrets, and live session state outside the repository.</p></div><pre aria-label="Orkestr quick start"><code>git clone https://github.com/otcan/orkestr.git
cd orkestr
npm ci
npm run build
npm run demo:coding-agent</code></pre><div class="actions"><a class="button" href="${escapeHtml(repo)}" rel="noreferrer" data-event="github_click">View GitHub</a><a class="button button-outline" href="${escapeHtml(repo)}/tree/main/docs" rel="noreferrer" data-event="docs_click">Read the docs</a></div></section>
      <section class="section oss-boundary"><div><p class="section-index">OSS + MANAGED DELIVERY</p><h2>The differentiation is implementation, not hidden claims.</h2></div><dl><div><dt>Public</dt><dd>Generic runtime, UI, connector contracts, deployment scaffolding, tests, and synthetic examples.</dd></div><div><dt>Private</dt><dd>Customer configuration, credentials, infrastructure, specialized adapters, operational evidence, and internal runbooks.</dd></div><div><dt>Managed</dt><dd>Workflow mapping, implementation, hardening, release, monitoring, and support within an agreed boundary.</dd></div></dl></section>
      <section class="section limitations"><div><p class="section-index">MATURITY</p><h2>Build against public-alpha reality.</h2></div><ul><li>Interfaces and configuration can change.</li><li>Not every connector is available or production-ready in every deployment.</li><li>Self-hosting transfers operational, security, retention, and recovery responsibility to the operator.</li><li>Commercial pilots add managed implementation; they do not turn the core into hosted multi-user SaaS.</li></ul></section>
    </main>`,
  };
}

function useCase(id: string, label: string, title: string, trigger: string, chain: string[], approval: string, outcome: string) {
  return `<article class="use-case" id="${id}"><p class="eyebrow">${label}</p><h2>${title}</h2><dl><div><dt>Trigger</dt><dd>${trigger}</dd></div><div><dt>Workflow chain</dt><dd><ol>${chain.map((step) => `<li>${step}</li>`).join("")}</ol></dd></div><div><dt>Human control</dt><dd>${approval}</dd></div><div><dt>Measure</dt><dd>${outcome}</dd></div></dl><p class="disclaimer">${configurationDisclaimer}</p></article>`;
}

export function useCasesPage(): PublicPage {
  return {
    id: "use-cases",
    title: "Use Cases",
    summary: "Evaluate concrete Orkestr workflow chains for finance, customer, revenue, and service operations, including triggers, systems, approvals, and measurable outcomes.",
    body: `<main id="main-content">${pageIntro("04", "USE CASES", "Map process chains, not vague AI roles.", "A useful first pilot has repeated volume, multiple system touchpoints, a named owner, explicit exceptions, and an outcome that can be measured.")}
      <section class="use-case-list">${useCase("finance", "FINANCE OPS", "Invoice exception handling", "An invoice reaches an approved intake mailbox.", ["Extract bounded document fields", "Match vendor and purchase-order records", "Flag a configured mismatch", "Pause for finance-owner decision", "Post or return after the recorded decision"], "Amount, vendor, or policy exceptions stop before posting.", "Time-to-decision, manual touches, exception error rate")}${useCase("onboarding", "CUSTOMER OPS", "Account onboarding evidence", "A qualified account request enters the onboarding queue.", ["Check required request fields", "Gather approved evidence from connected systems", "Create or update the onboarding record", "Pause before access or contract activation", "Notify the owner and retain the decision history"], "Access or activation remains a human-approved action.", "Cycle time, missing-evidence loops, incomplete handoffs")}${useCase("revenue", "REVENUE OPS", "Renewal preparation", "A configured renewal window opens.", ["Collect account and product signals", "Identify missing or conflicting data", "Prepare a bounded review packet", "Pause for account-owner review", "Create the approved follow-up task"], "No external outreach occurs without the configured owner decision.", "Preparation time, missed renewals, stale-data rate")}${useCase("service", "SERVICE OPS", "Escalation evidence packet", "A case meets an explicit severity or aging rule.", ["Collect the relevant case history", "Check runbooks and recent system status", "Build an evidence packet", "Route it to the incident owner", "Record the chosen escalation path"], "The incident owner chooses the consequential response.", "Time-to-triage, missing evidence, reassignment loops")}</section>
      <section class="final-cta compact"><h2>Have a chain with a clear owner and measurable pain?</h2><a class="button button-light" href="/workflow" data-event="map_workflow_use_cases">Map one workflow</a></section>
    </main>`,
  };
}
