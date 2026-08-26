export function renderCoordinationDiagram() {
  return `<figure class="coordination" aria-labelledby="coordination-title">
    <figcaption id="coordination-title"><span>LIVE CONTROL MODEL</span> One workflow, coordinated end to end</figcaption>
    <div class="coordination-grid">
      <div class="system-node"><small>SOURCE</small><strong>Inbox</strong><span>New invoice</span></div>
      <div class="flow-arrow" aria-hidden="true">→</div>
      <div class="system-node active"><small>ORKESTR</small><strong>Validate</strong><span>Policy + records</span></div>
      <div class="flow-arrow" aria-hidden="true">→</div>
      <div class="system-node approval"><small>HUMAN GATE</small><strong>Approve</strong><span>Exception held</span></div>
      <div class="flow-arrow" aria-hidden="true">→</div>
      <div class="system-node"><small>DESTINATION</small><strong>ERP</strong><span>Continue after approval</span></div>
    </div>
    <p class="diagram-note">Orkestr coordinates work across connected systems. A configured approval gate stops the chain before consequential action.</p>
  </figure>`;
}

export function renderConsoleEvidence() {
  return `<figure class="console-proof" aria-labelledby="console-proof-title" data-view-event="live_workflow_view">
    <figcaption><span class="proof-label">SYNTHETIC CONSOLE WALKTHROUGH</span><strong id="console-proof-title">Vendor invoice exception · WF-1042</strong><small>Illustrative data. Connector availability and workflow configuration are deployment-specific.</small></figcaption>
    <div class="console-grid">
      <section class="console-sidebar" aria-label="Workflow queue">
        <p class="console-kicker">QUEUE · 3 ITEMS</p>
        <div class="queue-item muted"><span>WF-1040</span><strong>Completed</strong></div>
        <div class="queue-item selected"><span>WF-1042</span><strong>Needs approval</strong></div>
        <div class="queue-item muted"><span>WF-1044</span><strong>Validating</strong></div>
      </section>
      <section class="console-main" aria-label="Selected workflow state">
        <div class="console-header"><div><p>Northwind Parts · INV-2048</p><h3>Amount differs from purchase order</h3></div><span class="status status-approval">Approval required</span></div>
        <ol class="timeline">
          <li class="complete"><span>09:41</span><div><strong>Invoice received</strong><p>Document and sender matched to the configured intake rule.</p></div></li>
          <li class="complete"><span>09:42</span><div><strong>Records checked</strong><p>ERP purchase order found; total differs by 8.4%.</p></div></li>
          <li class="current"><span>09:42</span><div><strong>Workflow paused</strong><p>Finance owner must approve or reject the exception.</p><div class="proof-actions"><button type="button" disabled>Approve</button><button type="button" disabled>Reject</button><small>Demo controls are intentionally inactive.</small></div></div></li>
          <li><span>Next</span><div><strong>Post or return</strong><p>The deployment continues only after the recorded decision.</p></div></li>
        </ol>
      </section>
      <aside class="console-context" aria-label="Workflow context">
        <p class="console-kicker">CONNECTED SYSTEMS</p><ul><li>Email intake <span>Scoped</span></li><li>Document store <span>Scoped</span></li><li>ERP adapter <span>Configured</span></li></ul>
        <p class="console-kicker">CONTROL</p><ul><li>Owner <span>Finance Ops</span></li><li>Approval <span>Required</span></li><li>History <span>Recorded</span></li></ul>
      </aside>
    </div>
    <ol class="walkthrough" aria-label="Captioned walkthrough">
      <li><span>01</span><strong>Detect</strong><p>A bounded trigger starts a named workflow.</p></li>
      <li><span>02</span><strong>Coordinate</strong><p>Steps run against explicitly connected systems.</p></li>
      <li><span>03</span><strong>Stop</strong><p>An exception pauses at its human approval gate.</p></li>
      <li><span>04</span><strong>Resume</strong><p>The decision and subsequent action remain visible in history.</p></li>
    </ol>
  </figure>`;
}
