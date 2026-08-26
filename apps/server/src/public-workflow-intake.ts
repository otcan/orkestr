import type { PublicPage } from "./public-site-config.js";

export function workflowIntakePage(): PublicPage {
  return {
    id: "workflow",
    title: "Workflow Pilot",
    summary: "Map one repeated workflow for an Orkestr managed private pilot, including volume, systems, ownership, approvals, measurable pain, and success criteria.",
    body: `<main id="main-content">
      <section class="page-hero workflow-hero"><p class="section-index">ORKESTR WORKFLOW PILOT</p><h1>Map one workflow.</h1><p class="lead">Tell us where repeated work crosses systems, who owns the outcome, where approval belongs, and what improvement would make a pilot worthwhile.</p><div class="qualification-strip"><span>Repeated volume</span><span>Named owner</span><span>System crossing</span><span>Measurable pain</span></div></section>
      <section class="workflow-intake" aria-labelledby="intake-title">
        <div class="intake-context"><p class="section-index">QUALIFICATION BEFORE SCHEDULING</p><h2 id="intake-title">A bounded map is more useful than a generic demo call.</h2><p>We review the workflow first. If it has a viable pilot boundary and scheduling is configured, the confirmation step offers a scheduling handoff.</p><h3>What happens next</h3><ol><li>We check whether the work is repeated and measurable.</li><li>We identify the systems, owner, approval, and exception boundary.</li><li>We respond with fit, open questions, and a pilot-mapping next step.</li></ol><p class="legal-note">Do not include passwords, credentials, personal records, customer data, or confidential document contents. A submission is an inquiry, not a purchase commitment.</p></div>
        <form class="workflow-form" id="workflow-form" novalidate>
          <div class="form-error" id="workflow-form-error" role="alert" tabindex="-1" hidden></div>
          <div class="field-grid two"><label><span>Name</span><input name="contactName" autocomplete="name" required maxlength="120"></label><label><span>Work email</span><input name="workEmail" type="email" autocomplete="email" required maxlength="160"></label></div>
          <div class="field-grid two"><label><span>Company</span><input name="company" autocomplete="organization" required maxlength="160"></label><label><span>Your role</span><input name="role" autocomplete="organization-title" required maxlength="160"></label></div>
          <label><span>Workflow name</span><input name="workflowName" required maxlength="160" placeholder="Invoice exception handling"></label>
          <label><span>What happens today?</span><textarea name="workflowDescription" required rows="5" maxlength="2400" placeholder="Describe the trigger, steps, handoffs, and where work gets stuck."></textarea></label>
          <div class="field-grid two"><label><span>Frequency</span><select name="frequency" required><option value="">Select</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="event-driven">Event-driven</option><option value="one-time">One-time</option></select></label><label><span>Approximate monthly volume</span><input name="monthlyVolume" type="number" inputmode="numeric" min="1" max="1000000" required placeholder="250"></label></div>
          <label><span>Systems the workflow touches</span><textarea name="systems" required rows="3" maxlength="1200" placeholder="Shared mailbox, document store, ERP"></textarea><small>Name systems or categories; do not paste credentials or records.</small></label>
          <label><span>Workflow owner</span><input name="workflowOwner" required maxlength="200" placeholder="Finance Operations Manager"></label>
          <label><span>Approvals and exceptions</span><textarea name="approvals" required rows="4" maxlength="1600" placeholder="Which decisions must stay human? What should stop the workflow?"></textarea></label>
          <label><span>Current cost, delay, or error</span><textarea name="costOrDelay" required rows="4" maxlength="1600" placeholder="Hours per week, cycle time, missed cases, rework, or error rate"></textarea></label>
          <label><span>Success criteria</span><textarea name="successCriteria" required rows="4" maxlength="1600" placeholder="What measurable result would make a bounded pilot successful?"></textarea></label>
          <label class="honeypot" aria-hidden="true"><span>Company website</span><input name="companyWebsite" tabindex="-1" autocomplete="off"></label>
          <input name="formStartedAt" type="hidden">
          <label class="check"><input name="consentToContact" type="checkbox" required><span>I agree that Orkestr may process this information to assess and contact me about a Workflow Pilot. I have read the <a href="/privacy">privacy notice</a>.</span></label>
          <button class="button" type="submit">Submit workflow map</button>
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
          if (!form || !status || !error || !scheduling) return;
          form.elements.formStartedAt.value = String(Date.now());
          let started = false;
          form.addEventListener("input", () => { if (!started) { started = true; window.orkestrTrack && window.orkestrTrack("workflow_form_start"); } });
          form.addEventListener("submit", async (event) => {
            event.preventDefault(); error.hidden = true; scheduling.hidden = true;
            if (!form.reportValidity()) { error.textContent = "Review the highlighted fields and complete the workflow map."; error.hidden = false; error.focus(); window.orkestrTrack && window.orkestrTrack("workflow_validation_error"); return; }
            status.textContent = "Submitting workflow map…"; form.querySelector('button[type="submit"]').disabled = true;
            const data = new FormData(form); const body = Object.fromEntries(data.entries()); body.consentToContact = data.get("consentToContact") === "on";
            try {
              const response = await fetch("/api/public/workflow-leads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
              const payload = await response.json().catch(() => ({}));
              if (!response.ok || payload.ok === false) throw new Error(payload.error || "workflow_submit_failed");
              form.reset(); status.textContent = payload.message || "Your workflow map was submitted for review.";
              if (payload.schedulingUrl) { const link = document.createElement("a"); link.className = "button button-outline"; link.href = payload.schedulingUrl; link.rel = "noreferrer"; link.textContent = "Schedule the qualification call"; link.dataset.event = "qualified_schedule_click"; scheduling.replaceChildren(link); scheduling.hidden = false; }
              window.orkestrTrack && window.orkestrTrack("workflow_submit_success");
            } catch {
              error.textContent = "We could not submit this workflow map. Your entries remain on this page; please try again or use the support contact."; error.hidden = false; error.focus(); status.textContent = ""; window.orkestrTrack && window.orkestrTrack("workflow_submit_error");
            } finally { form.querySelector('button[type="submit"]').disabled = false; }
          });
        })();
      </script>
    </main>`,
  };
}
