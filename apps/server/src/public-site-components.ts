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

export function renderConsoleEvidence() {
  return `<figure class="console-proof" aria-labelledby="console-proof-title" data-view-event="workflow_console_view">
    <figcaption><span class="proof-label">ORKESTR CONSOLE · PUBLIC DEMO</span><strong id="console-proof-title">Customer Order Exception #10452</strong><small>Public-safe demo data. Available connections and controls depend on the deployment.</small></figcaption>
    <div class="console-grid">
      <section class="console-sidebar" aria-label="Workflow queue">
        <p class="console-kicker">WORKFLOWS · 4 ACTIVE</p>
        <div class="queue-item muted"><span>ORDER-10448</span><strong>Completed</strong></div>
        <div class="queue-item selected"><span>ORDER-10452</span><strong>Waiting for approval</strong></div>
        <div class="queue-item muted"><span>ORDER-10455</span><strong>Checking ERP</strong></div>
        <div class="queue-item muted"><span>ORDER-10457</span><strong>Queued</strong></div>
      </section>
      <section class="console-main" aria-label="Selected workflow state">
        <div class="console-header"><div><p>Customer Order Exception #10452</p><h3>Delivery date conflicts with available inventory</h3></div><span class="status status-approval">Waiting for approval</span></div>
        <ol class="timeline">
          <li class="complete"><span>10:16</span><div><strong>Email parsed</strong><p>Request and attached order reference matched the intake rule.</p></div></li>
          <li class="complete"><span>10:17</span><div><strong>Customer identified</strong><p>Account and current service terms found in CRM.</p></div></li>
          <li class="complete"><span>10:17</span><div><strong>ERP and order history checked</strong><p>Requested delivery date exceeds confirmed inventory availability.</p></div></li>
          <li class="current"><span>10:18</span><div><strong>Approval requested</strong><p>Operations owner must choose the next action.</p><div class="proof-actions"><button type="button" disabled>Approve next action</button><button type="button" disabled>Review case</button><small>Demo controls are inactive.</small></div></div></li>
          <li><span>Next</span><div><strong>Update ERP</strong><p>The approved plan will be written to the order record.</p></div></li>
          <li><span>Next</span><div><strong>Send response</strong><p>The customer reply will use the recorded decision.</p></div></li>
        </ol>
      </section>
      <aside class="console-context" aria-label="Workflow context">
        <p class="console-kicker">CONNECTED SYSTEMS</p><ul><li>Email <span>Read + reply</span></li><li>CRM <span>Read</span></li><li>ERP <span>Scoped update</span></li><li>Browser portal <span>Controlled</span></li></ul>
        <p class="console-kicker">BOUNDARY</p><ul><li>Owner <span>Customer Ops</span></li><li>Approval <span>Required</span></li><li>Exception <span>Inventory</span></li><li>History <span>Recorded</span></li></ul>
      </aside>
    </div>
    <ol class="walkthrough" aria-label="Execution state summary">
      <li><span>✓</span><strong>Email parsed</strong></li>
      <li><span>✓</span><strong>Customer identified</strong></li>
      <li><span>✓</span><strong>ERP checked</strong></li>
      <li class="waiting"><span>●</span><strong>Approval requested</strong></li>
      <li><span>○</span><strong>Update ERP</strong></li>
      <li><span>○</span><strong>Send response</strong></li>
    </ol>
  </figure>`;
}
