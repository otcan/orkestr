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
    <div class="requirement-quote"><small>YOUR REQUIREMENT</small><blockquote id="requirement-example">“Our internal ordering system needs replacing.”</blockquote></div>
    <div class="project-scenario-tabs" aria-label="Example project requirements">
      <button type="button" class="active" aria-pressed="true" data-requirement="Our internal ordering system needs replacing.">Replace a system</button>
      <button type="button" aria-pressed="false" data-requirement="We need a new B2B website with customer ordering.">Build commerce</button>
      <button type="button" aria-pressed="false" data-requirement="Our staff spend hours moving information between email and internal software.">Automate work</button>
      <button type="button" aria-pressed="false" data-requirement="We need to automatically find relevant public tenders every day.">Find opportunities</button>
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
    <figcaption><span class="proof-label">ORKESTR CONSOLE · PUBLIC DEMO</span><strong id="console-proof-title">Internal Ordering Renewal · Migration Run #042</strong><small>Public-safe illustrative data. Available systems, connections, and controls depend on the deployment.</small></figcaption>
    <div class="console-grid">
      <section class="console-sidebar" aria-label="Managed system queue">
        <p class="console-kicker">MIGRATION RUNS · 4</p>
        <div class="queue-item muted"><span>RUN-039</span><strong>Completed</strong></div>
        <div class="queue-item selected"><span>RUN-042</span><strong>Reviewing exceptions</strong></div>
        <div class="queue-item muted"><span>RUN-043</span><strong>Staged</strong></div>
        <div class="queue-item muted"><span>CUTOVER</span><strong>Awaiting approval</strong></div>
      </section>
      <section class="console-main" aria-label="Selected managed-system run">
        <div class="console-header"><div><p>Internal Ordering Renewal · Migration Run #042</p><h3>Twelve legacy records need an owner decision</h3></div><span class="status status-approval">Human review</span></div>
        <ol class="timeline">
          <li class="complete"><span>08:00</span><div><strong>Legacy snapshot read</strong><p>The approved export was loaded without changing the existing system.</p></div></li>
          <li class="complete"><span>08:05</span><div><strong>Migration rules applied</strong><p>Fields, relationships, and known business rules were mapped into the new model.</p></div></li>
          <li class="complete"><span>08:11</span><div><strong>Validation completed</strong><p>2,486 records passed the configured structural and reconciliation checks.</p></div></li>
          <li class="current"><span>08:12</span><div><strong>Exception queue prepared</strong><p>An owner reviews twelve records whose legacy ownership is missing or ambiguous.</p><div class="proof-actions"><button type="button" disabled>Approve mapping</button><button type="button" disabled>Review record</button><small>Demo controls are inactive.</small></div></div></li>
          <li><span>Next</span><div><strong>Record decisions</strong><p>Every approved correction remains attached to its source record and rule.</p></div></li>
          <li><span>Next</span><div><strong>Release migration batch</strong><p>The validated batch advances only after the agreed cutover approval.</p></div></li>
        </ol>
      </section>
      <aside class="console-context" aria-label="Managed system context">
        <p class="console-kicker">SYSTEM COMPONENTS</p><ul><li>Legacy database <span>Read only</span></li><li>Migration service <span>Staged</span></li><li>New application <span>Ready</span></li><li>Rollback <span>Available</span></li></ul>
        <p class="console-kicker">BOUNDARY</p><ul><li>Owner <span>Operations lead</span></li><li>Legacy access <span>Read only</span></li><li>Changes <span>Staged</span></li><li>Cutover <span>Human</span></li></ul>
      </aside>
    </div>
    <ol class="walkthrough" aria-label="Execution state summary">
      <li><span>✓</span><strong>Snapshot read</strong></li>
      <li><span>✓</span><strong>Rules applied</strong></li>
      <li><span>✓</span><strong>Validation passed</strong></li>
      <li class="waiting"><span>●</span><strong>Human review</strong></li>
      <li><span>○</span><strong>Record decisions</strong></li>
      <li><span>○</span><strong>Release batch</strong></li>
    </ol>
  </figure>`;
}
