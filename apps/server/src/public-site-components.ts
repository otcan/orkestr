export function renderCoordinationDiagram() {
  return `<figure class="coordination" aria-labelledby="coordination-title">
    <figcaption id="coordination-title"><span>LIVE PROCESS MAP</span> One request moving across the existing stack</figcaption>
    <ol class="operation-trace">
      <li><span class="trace-icon">IN</span><div><small>TRIGGER</small><strong>Incoming customer request</strong><p>A request arrives from an approved source.</p></div></li>
      <li><span class="trace-icon">@</span><div><small>EMAIL</small><strong>Message and attachments read</strong><p>The workflow identifies the request and required records.</p></div></li>
      <li><span class="trace-icon">E</span><div><small>ERP</small><strong>Order and account checked</strong><p>Orkestr retrieves the operational record.</p></div></li>
      <li><span class="trace-icon">C</span><div><small>CRM</small><strong>Customer history gathered</strong><p>Relevant context is added to the case.</p></div></li>
      <li class="trace-orkestr"><span class="trace-icon">O</span><div><small>ORKESTR</small><strong>Information reconciled</strong><p>Rules, agent work, and exception handling run in one stateful process.</p></div></li>
      <li class="trace-approval"><span class="trace-icon">✓</span><div><small>MANAGER APPROVAL</small><strong>Decision requested</strong><p>The workflow pauses because the case exceeds its approved boundary.</p></div></li>
      <li><span class="trace-icon">OUT</span><div><small>COMPLETION</small><strong>ERP updated and reply sent</strong><p>The decision and every subsequent action remain in history.</p></div></li>
    </ol>
    <p class="diagram-note">Illustrative workflow using public-safe records. The systems, permissions, and approval points are configured per deployment.</p>
  </figure>`;
}

export function renderProjectDeliveryDiagram() {
  return `<figure class="coordination requirement-delivery" aria-labelledby="requirement-delivery-title">
    <figcaption id="requirement-delivery-title"><span>FROM REQUIREMENT TO OPERATION</span> The same delivery system underneath different outcomes</figcaption>
    <div class="requirement-quote"><small>YOUR REQUIREMENT</small><blockquote id="requirement-example">“We need to automatically find relevant public tenders every day.”</blockquote></div>
    <div class="project-scenario-tabs" aria-label="Example project requirements">
      <button type="button" class="active" aria-pressed="true" data-requirement="We need to automatically find relevant public tenders every day.">Find opportunities</button>
      <button type="button" aria-pressed="false" data-requirement="Our internal ordering system needs replacing.">Replace a system</button>
      <button type="button" aria-pressed="false" data-requirement="We need a new B2B website with customer ordering.">Build commerce</button>
      <button type="button" aria-pressed="false" data-requirement="Our staff spend hours moving information between email and internal software.">Automate work</button>
    </div>
    <ol class="operation-trace delivery-trace">
      <li><span class="trace-icon">01</span><div><small>DISCOVER</small><strong>Outcome, users, constraints, and success</strong><p>We understand what the business needs before choosing technology.</p></div></li>
      <li><span class="trace-icon">02</span><div><small>DESIGN</small><strong>Architecture, interfaces, data, and operation</strong><p>The proposed system has an explicit scope and responsibility model.</p></div></li>
      <li class="trace-orkestr"><span class="trace-icon">03</span><div><small>BUILD</small><strong>Application, data, integrations, and automation</strong><p>Standard software and the Orkestr layer are used where each is appropriate.</p></div></li>
      <li><span class="trace-icon">04</span><div><small>TEST</small><strong>Representative cases and failure paths</strong><p>Normal behavior, edge cases, permissions, and recovery are exercised.</p></div></li>
      <li><span class="trace-icon">05</span><div><small>DEPLOY</small><strong>A controlled production environment</strong><p>The release, ownership, monitoring, and rollback path are defined.</p></div></li>
      <li class="trace-approval"><span class="trace-icon">06</span><div><small>OPERATE</small><strong>Monitor, maintain, and improve</strong><p>We keep the agreed system working after the launch or demo.</p></div></li>
    </ol>
    <p class="diagram-note">Illustrative project requirements. Scope, feasibility, delivery model, and Orkestr platform use are determined during Project Discovery.</p>
    <script>(() => { const output = document.getElementById("requirement-example"); const buttons = document.querySelectorAll("[data-requirement]"); buttons.forEach((button) => button.addEventListener("click", () => { buttons.forEach((item) => { item.classList.remove("active"); item.setAttribute("aria-pressed", "false"); }); button.classList.add("active"); button.setAttribute("aria-pressed", "true"); if (output) output.textContent = "“" + button.dataset.requirement + "”"; })); })();</script>
  </figure>`;
}

export function renderConsoleEvidence() {
  return `<figure class="console-proof" aria-labelledby="console-proof-title" data-view-event="platform_console_view">
    <figcaption><span class="proof-label">ORKESTR CONSOLE · PUBLIC DEMO</span><strong id="console-proof-title">Public Opportunity Monitor · Daily Run #042</strong><small>Public-safe illustrative data. Available sources, connections, and controls depend on the deployment.</small></figcaption>
    <div class="console-grid">
      <section class="console-sidebar" aria-label="Managed system queue">
        <p class="console-kicker">JOBS · 4 TODAY</p>
        <div class="queue-item muted"><span>RUN-039</span><strong>Completed</strong></div>
        <div class="queue-item selected"><span>RUN-042</span><strong>Reviewing matches</strong></div>
        <div class="queue-item muted"><span>RUN-043</span><strong>Scheduled</strong></div>
        <div class="queue-item muted"><span>WEEKLY</span><strong>Coverage report</strong></div>
      </section>
      <section class="console-main" aria-label="Selected managed-system run">
        <div class="console-header"><div><p>Public Opportunity Monitor · Daily Run #042</p><h3>Six opportunities match the current review criteria</h3></div><span class="status status-approval">Human review</span></div>
        <ol class="timeline">
          <li class="complete"><span>06:00</span><div><strong>Approved sources checked</strong><p>Four public sources completed within the configured collection window.</p></div></li>
          <li class="complete"><span>06:08</span><div><strong>Records normalized</strong><p>134 new notices were structured with source links and collection timestamps.</p></div></li>
          <li class="complete"><span>06:11</span><div><strong>Criteria applied</strong><p>Deterministic filters and assisted classification produced six candidates.</p></div></li>
          <li class="current"><span>06:12</span><div><strong>Review queue prepared</strong><p>An owner decides which opportunities should enter the tracking system.</p><div class="proof-actions"><button type="button" disabled>Accept match</button><button type="button" disabled>Review evidence</button><small>Demo controls are inactive.</small></div></div></li>
          <li><span>Next</span><div><strong>Record decisions</strong><p>Accepted and rejected matches will retain their reason and source.</p></div></li>
          <li><span>Next</span><div><strong>Deliver digest</strong><p>The team receives the approved shortlist through the agreed channel.</p></div></li>
        </ol>
      </section>
      <aside class="console-context" aria-label="Managed system context">
        <p class="console-kicker">SYSTEM COMPONENTS</p><ul><li>Public sources <span>Approved</span></li><li>Collector <span>Scheduled</span></li><li>Database <span>Structured</span></li><li>Digest <span>After review</span></li></ul>
        <p class="console-kicker">BOUNDARY</p><ul><li>Owner <span>Bid team</span></li><li>Sources <span>Public only</span></li><li>Decision <span>Human</span></li><li>Provenance <span>Recorded</span></li></ul>
      </aside>
    </div>
    <ol class="walkthrough" aria-label="Execution state summary">
      <li><span>✓</span><strong>Sources checked</strong></li>
      <li><span>✓</span><strong>Records normalized</strong></li>
      <li><span>✓</span><strong>Criteria applied</strong></li>
      <li class="waiting"><span>●</span><strong>Human review</strong></li>
      <li><span>○</span><strong>Record decisions</strong></li>
      <li><span>○</span><strong>Deliver digest</strong></li>
    </ol>
  </figure>`;
}
