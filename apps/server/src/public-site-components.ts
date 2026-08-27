export function renderCoordinationDiagram() {
  return `<figure class="coordination" aria-labelledby="coordination-title">
    <figcaption id="coordination-title"><span>HOW IT WORKS</span> A clear path from request to result</figcaption>
    <div class="coordination-grid">
      <div class="system-node"><small>STEP 1</small><strong>Request arrives</strong><span>From an approved source</span></div>
      <div class="flow-arrow" aria-hidden="true">→</div>
      <div class="system-node active"><small>STEP 2</small><strong>Information is checked</strong><span>Using approved tools</span></div>
      <div class="flow-arrow" aria-hidden="true">→</div>
      <div class="system-node approval"><small>STEP 3</small><strong>Manager approves</strong><span>Important work pauses here</span></div>
      <div class="flow-arrow" aria-hidden="true">→</div>
      <div class="system-node"><small>STEP 4</small><strong>Work is completed</strong><span>The decision is recorded</span></div>
    </div>
    <p class="diagram-note">Your team chooses the tools, the rules, and the decisions that must stay human.</p>
  </figure>`;
}

export function renderConsoleEvidence() {
  return `<figure class="console-proof" aria-labelledby="console-proof-title" data-view-event="live_workflow_view">
    <figcaption><span class="proof-label">PRODUCT WALKTHROUGH</span><strong id="console-proof-title">Invoice needs a manager decision · WF-1042</strong><small>This walkthrough uses illustrative data. Available connections and rules depend on the deployment.</small></figcaption>
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
          <li class="complete"><span>09:42</span><div><strong>Records checked</strong><p>Purchase order found; total differs by 8.4%.</p></div></li>
          <li class="current"><span>09:42</span><div><strong>Workflow paused</strong><p>Finance owner must approve or reject the exception.</p><div class="proof-actions"><button type="button" disabled>Approve</button><button type="button" disabled>Reject</button><small>Demo controls are intentionally inactive.</small></div></div></li>
          <li><span>Next</span><div><strong>Post or return</strong><p>The deployment continues only after the recorded decision.</p></div></li>
        </ol>
      </section>
      <aside class="console-context" aria-label="Workflow context">
        <p class="console-kicker">CONNECTED TOOLS</p><ul><li>Email intake <span>Approved</span></li><li>Document store <span>Approved</span></li><li>Purchase system <span>Approved</span></li></ul>
        <p class="console-kicker">CONTROL</p><ul><li>Owner <span>Finance Ops</span></li><li>Approval <span>Required</span></li><li>History <span>Recorded</span></li></ul>
      </aside>
    </div>
    <ol class="walkthrough" aria-label="Captioned walkthrough">
      <li><span>01</span><strong>Start</strong><p>An approved request begins the process.</p></li>
      <li><span>02</span><strong>Check</strong><p>Orkestr gathers and checks the needed information.</p></li>
      <li><span>03</span><strong>Decide</strong><p>An exception pauses for the right person.</p></li>
      <li><span>04</span><strong>Continue</strong><p>The decision and next action stay visible in history.</p></li>
    </ol>
  </figure>`;
}
