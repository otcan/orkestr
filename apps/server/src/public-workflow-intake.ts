import type { PublicPage } from "./public-site-config.js";

export function workflowIntakePage(): PublicPage {
  return {
    id: "workflow",
    title: "Book a Workflow Audit",
    summary: "Start an Orkestr Workflow Audit by mapping one repeated operational process, its systems, owner, approvals, volume, measurable pain, and success criteria.",
    body: `<main id="main-content">
      <section class="page-hero workflow-hero">
        <p class="section-index">ORKESTR WORKFLOW AUDIT</p>
        <h1>Show us one workflow worth fixing.</h1>
        <p class="lead">Map where repeated work crosses systems, who owns the result, where approval belongs, and what a successful pilot should improve.</p>
        <div class="qualification-strip" aria-label="Strong workflow signals"><span>Repeated volume</span><span>Named owner</span><span>System crossing</span><span>Measurable pain</span></div>
      </section>
      <section class="workflow-intake" aria-labelledby="intake-title">
        <aside class="intake-context">
          <p class="section-index">THE AUDIT STARTS HERE</p>
          <h2 id="intake-title">A useful workflow map beats a generic demo call.</h2>
          <p>We review the process before asking for a meeting. If Orkestr is not a sensible fit, we will say so. If the workflow has a viable pilot boundary, we respond with the open questions and next step.</p>
          <h3>What makes a strong first workflow</h3>
          <ul class="intake-fit"><li>It happens repeatedly</li><li>Work crosses two or more tools</li><li>A named person owns the result</li><li>Exceptions and approval points are recognizable</li><li>Delay, effort, errors, or rework can be measured</li></ul>
          <p class="legal-note"><strong>Keep this map operational, not confidential.</strong> Do not include passwords, credentials, personal records, customer data, or document contents. Submitting is an inquiry, not a purchase commitment.</p>
        </aside>
        <form class="workflow-form" id="workflow-form" novalidate>
          <div class="form-error" id="workflow-form-error" role="alert" tabindex="-1" hidden></div>

          <fieldset class="form-section">
            <legend><span>01</span> About you</legend>
            <p>Enough context to respond to the right person.</p>
            <div class="field-grid two"><label><span>Name</span><input name="contactName" autocomplete="name" required maxlength="120"></label><label><span>Work email</span><input name="workEmail" type="email" autocomplete="email" required maxlength="160"></label></div>
            <div class="field-grid two"><label><span>Company</span><input name="company" autocomplete="organization" required maxlength="160"></label><label><span>Your role</span><input name="role" autocomplete="organization-title" required maxlength="160"></label></div>
          </fieldset>

          <fieldset class="form-section">
            <legend><span>02</span> The workflow today</legend>
            <p>Describe the real process, including the handoffs and friction.</p>
            <label><span>Workflow name</span><input name="workflowName" required maxlength="160" placeholder="Invoice exception handling"></label>
            <label><span>What happens today?</span><textarea name="workflowDescription" required rows="5" maxlength="2400" placeholder="What starts the work? Which steps follow? Where does it slow down or fail?"></textarea></label>
            <div class="field-grid two"><label><span>How often?</span><select name="frequency" required><option value="">Select</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="event-driven">Event-driven</option><option value="one-time">One-time</option></select></label><label><span>Approximate monthly volume</span><input name="monthlyVolume" type="number" inputmode="numeric" min="1" max="1000000" required placeholder="250"></label></div>
            <label><span>Systems the workflow touches</span><textarea name="systems" required rows="3" maxlength="1200" placeholder="Shared mailbox, document store, purchase system"></textarea><small>Name systems or categories; do not paste credentials or records.</small></label>
            <label><span>Who owns the result?</span><input name="workflowOwner" required maxlength="200" placeholder="Finance Operations Manager"></label>
          </fieldset>

          <fieldset class="form-section">
            <legend><span>03</span> The pilot boundary</legend>
            <p>Define where humans stay in control and what improvement would matter.</p>
            <label><span>Approvals and exceptions</span><textarea name="approvals" required rows="4" maxlength="1600" placeholder="Which decisions must stay human? What should stop or escalate the workflow?"></textarea></label>
            <label><span>Current cost, delay, or error</span><textarea name="costOrDelay" required rows="4" maxlength="1600" placeholder="Hours per week, cycle time, missed cases, rework, or error rate"></textarea></label>
            <label><span>Success criteria</span><textarea name="successCriteria" required rows="4" maxlength="1600" placeholder="What measurable result would make a bounded pilot successful?"></textarea></label>
          </fieldset>

          <label class="honeypot" aria-hidden="true"><span>Company website</span><input name="companyWebsite" tabindex="-1" autocomplete="off"></label>
          <input name="formStartedAt" type="hidden">
          <label class="check"><input name="consentToContact" type="checkbox" required><span>I agree that Orkestr may process this information to assess and contact me about a Workflow Audit and possible pilot. I have read the <a href="/privacy">privacy notice</a>.</span></label>
          <button class="button submit-workflow" type="submit">Request workflow audit</button>
          <p class="form-status" id="workflow-status" role="status" aria-live="polite"></p>
          <div class="scheduling-handoff" id="scheduling-handoff" hidden></div>
        </form>
      </section>
      <script>
        (() => {
          const form = document.getElementById("workflow-form");
          const status = document.getElementById("workflow-status");
          const error = document.getElementById("workflow-form-error");
          const scheduling = document.getElementById("scheduling-handoff");
          const submit = form && form.querySelector('button[type="submit"]');
          if (!form || !status || !error || !scheduling || !submit) return;
          const resetStart = () => { form.elements.formStartedAt.value = String(Date.now()); };
          resetStart();
          let started = false;
          form.addEventListener("input", () => {
            if (started) return;
            started = true;
            window.orkestrTrack && window.orkestrTrack("workflow_form_start");
          });
          form.addEventListener("submit", async (event) => {
            event.preventDefault();
            error.hidden = true;
            scheduling.hidden = true;
            if (!form.reportValidity()) {
              error.textContent = "Review the highlighted fields and complete the workflow map.";
              error.hidden = false;
              error.focus();
              window.orkestrTrack && window.orkestrTrack("workflow_validation_error");
              return;
            }
            status.textContent = "Sending your workflow map…";
            submit.disabled = true;
            const data = new FormData(form);
            const body = Object.fromEntries(data.entries());
            body.consentToContact = data.get("consentToContact") === "on";
            try {
              const response = await fetch("/api/public/workflow-leads", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
              });
              const payload = await response.json().catch(() => ({}));
              if (!response.ok || payload.ok === false) throw new Error(payload.error || "workflow_submit_failed");
              form.reset();
              resetStart();
              status.textContent = payload.message || "Your workflow map was submitted for review.";
              if (payload.schedulingUrl) {
                const link = document.createElement("a");
                link.className = "button button-outline";
                link.href = payload.schedulingUrl;
                link.target = "_blank";
                link.rel = "noreferrer";
                link.textContent = "Schedule the qualification call";
                link.dataset.event = "qualified_schedule_click";
                scheduling.replaceChildren(link);
                scheduling.hidden = false;
              }
              window.orkestrTrack && window.orkestrTrack("workflow_submit_success");
            } catch {
              error.textContent = "We could not submit this workflow map. Your entries remain here; please try again or use the support contact.";
              error.hidden = false;
              error.focus();
              status.textContent = "";
              window.orkestrTrack && window.orkestrTrack("workflow_submit_error");
            } finally {
              submit.disabled = false;
            }
          });
        })();
      </script>
    </main>`,
  };
}
