import type { PublicPage } from "./public-site-config.js";

const limitations = [
  "It does not create, send, or store real orders, invoices, or payments.",
  "It does not connect to an ERP, inventory, CRM, email, or any other external system.",
  "It has no accounts, logins, or real permissions: the role switcher is demonstration behaviour in your browser, not server-enforced authorization.",
  "It sends nothing to a server. State lives only in this browser's localStorage until you reset it or clear site data.",
  "Prices, stock, credit limits, and company names are invented sample data.",
  "To keep the demo simple, repeating an account's latest open or approved order with identical lines is treated as a duplicate; change a quantity to order again.",
  "It is not a client project or case study, and it makes no claim about production performance.",
];

const steps = [
  "As the customer, pick a sample account and enter quantities from the catalogue.",
  "Rules check stock, credit limit, and order value before anything is accepted.",
  "Orders that pass every rule are auto-approved and stock is reserved.",
  "Exceptions pause the order for an approver instead of failing silently.",
  "As the approver, approve or reject with a note; rejection requires a reason.",
  "Invalid quantities get a validation message, and submitting the same order twice never creates a duplicate.",
  "Every step lands on the order timeline and in an append-only audit log.",
];

export function customerPortalBuildPage(): PublicPage {
  return {
    id: "builds",
    title: "Live build: B2B customer portal",
    summary: "Synthetic interactive demo: a buyer submits an order, stock and credit rules check it, exceptions pause for an approver, and status, timeline and audit log update in your browser.",
    canonicalPath: "/builds/customer-portal",
    stylesheets: ["/builds/customer-portal/portal.css"],
    scripts: ["/builds/customer-portal/app.js"],
    body: `<main id="main-content" class="build-page">
    <section class="build-hero">
      <p class="eyebrow"><a href="/builds">Live builds</a> · <span class="evidence-tag">Simulation · runs in your browser</span></p>
      <h1>B2B customer portal with approval rules</h1>
      <p class="lead">Submit an order as a buyer, watch the rules check stock and credit, then switch to the approver to resolve the exceptions. The status, timeline and audit log update as you go.</p>
    </section>
    <div class="build-notice" role="note">
      <strong>Synthetic demo - not a client project, no real orders.</strong>
      <p>All companies, products and numbers are invented. Everything runs in your browser; nothing is sent to a server.</p>
    </div>
    <section id="portal-app" class="portal-demo" aria-label="Interactive customer portal demo">
      <div class="portal-toolbar">
        <fieldset class="portal-roles">
          <legend>View the portal as</legend>
          <label><input type="radio" name="portal-role" value="customer" checked> Customer (buyer)</label>
          <label><input type="radio" name="portal-role" value="approver"> Approver<span id="portal-pending-count"></span></label>
        </fieldset>
        <button type="button" class="button button-outline" data-action="reset">Reset demo</button>
      </div>
      <p class="portal-role-note" id="portal-role-note"><strong>Demonstration behaviour:</strong> switching between customer and approver happens only in your browser. It is not server-enforced authorization; a real portal would authenticate each user and check every action on the server.</p>
      <p class="portal-storage" id="portal-storage-note">State is saved only in this browser.</p>
      <p id="portal-status" role="status" aria-live="polite" tabindex="-1"></p>
      <div id="portal-view"><noscript><p>This demo needs JavaScript. It runs entirely in your browser and makes no network calls.</p></noscript></div>
    </section>
    <div class="build-explainer">
      <section aria-labelledby="build-does">
        <h2 id="build-does">What this demo does</h2>
        <ol>${steps.map((step) => `<li>${step}</li>`).join("")}</ol>
      </section>
      <section aria-labelledby="build-does-not">
        <h2 id="build-does-not">What this demo does not do</h2>
        <ul>${limitations.map((item) => `<li>${item}</li>`).join("")}</ul>
      </section>
    </div>
    <div class="build-ctas">
      <a class="button" href="/builds">Explore live builds</a>
      <a class="button button-outline" href="/studio">Discuss a project</a>
    </div>
  </main>`,
  };
}
