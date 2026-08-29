import type { PublicPage } from "./public-site-config.js";

export function projectIntakePage(): PublicPage {
  return {
    id: "project",
    title: "Describe Your Business System Project",
    summary: "Start an Orkestr Project Discovery for a website, commerce system, legacy replacement, opportunity intelligence, web data system, or operational automation.",
    body: `<main id="main-content">
      <section class="page-hero workflow-hero project-hero">
        <p class="section-index">ORKESTR PROJECT DISCOVERY</p>
        <h1>Tell us what your business needs to do.</h1>
        <p class="lead">You do not need a technical specification. Describe the outcome, the situation today, the people involved, and what a useful result would change.</p>
        <div class="qualification-strip" aria-label="Project categories"><span>Build</span><span>Replace</span><span>Find</span><span>Collect</span><span>Automate</span></div>
      </section>
      <section class="workflow-intake" aria-labelledby="project-intake-title">
        <aside class="intake-context">
          <p class="section-index">START WITH THE REQUIREMENT</p>
          <h2 id="project-intake-title">A clear problem is enough to begin.</h2>
          <p>We review the requirement before proposing technology. If Orkestr is not a sensible fit, we will say so. If it is, Project Discovery defines the users, architecture, integrations, delivery boundary, and operating model.</p>
          <h3>Useful starting points</h3>
          <ul class="intake-fit"><li>A website, store, portal, or internal tool to build</li><li>An outdated system that needs replacing</li><li>Opportunities your team repeatedly searches for</li><li>Public or authorized sources that need monitoring</li><li>Manual work that should become a controlled workflow</li></ul>
          <p class="legal-note"><strong>Describe the problem without sharing confidential records.</strong> Do not include passwords, credentials, personal data, private documents, or production access details. Submitting is an inquiry, not a purchase commitment.</p>
          <a class="text-link" href="/workflow" data-event="automation_audit_click">Only need workflow automation? Book a Workflow Audit <span aria-hidden="true">→</span></a>
        </aside>
        <form class="workflow-form project-form" id="project-form" novalidate>
          <div class="form-error" id="project-form-error" role="alert" tabindex="-1" hidden></div>

          <fieldset class="form-section">
            <legend><span>01</span> About you</legend>
            <p>Enough context to respond to the right person.</p>
            <div class="field-grid two"><label><span>Name</span><input name="contactName" autocomplete="name" required maxlength="120"></label><label><span>Work email</span><input name="workEmail" type="email" autocomplete="email" required maxlength="160"></label></div>
            <div class="field-grid two"><label><span>Company</span><input name="company" autocomplete="organization" required maxlength="160"></label><label><span>Your role</span><input name="role" autocomplete="organization-title" required maxlength="160"></label></div>
          </fieldset>

          <fieldset class="form-section">
            <legend><span>02</span> The requirement</legend>
            <p>Start with the outcome. We will help determine the implementation.</p>
            <label><span>What kind of project is this?</span><select name="projectType" required><option value="">Select</option><option value="build">Build — website, commerce, portal, or application</option><option value="replace">Replace — modernize an outdated business system</option><option value="find">Find — opportunity intelligence and matching</option><option value="collect">Collect — web data and monitoring</option><option value="automate">Automate — recurring operational work</option><option value="not-sure">Not sure yet</option></select></label>
            <label><span>Project name</span><input name="projectName" required maxlength="160" placeholder="Public tender discovery system"></label>
            <label><span>What should the business be able to do?</span><textarea name="desiredOutcome" required rows="5" maxlength="2400" placeholder="Describe the outcome in plain language. What should become possible when the project works?"></textarea></label>
            <label><span>What happens today?</span><textarea name="currentSituation" required rows="4" maxlength="2000" placeholder="Current process, existing software, manual workaround, or why the capability does not exist yet."></textarea></label>
          </fieldset>

          <fieldset class="form-section">
            <legend><span>03</span> The operating context</legend>
            <p>Help us understand the boundary without sending sensitive information.</p>
            <label><span>Who will use it, and at what approximate scale?</span><textarea name="usersAndVolume" required rows="3" maxlength="1200" placeholder="Teams, customer types, approximate users, transactions, searches, pages, or records."></textarea></label>
            <label><span>Existing systems, websites, or data sources</span><textarea name="systemsOrSources" required rows="3" maxlength="1600" placeholder="Name public sources or system categories. Write ‘greenfield’ if nothing exists yet."></textarea><small>Do not paste credentials, private records, or access tokens.</small></label>
            <label><span>Who owns the decision and result?</span><input name="decisionOwner" required maxlength="200" placeholder="Managing Director, Operations Lead, Product Owner"></label>
            <label><span>Important constraints</span><textarea name="constraints" required rows="3" maxlength="1600" placeholder="Deadline, migration boundary, languages, regulatory concerns, required integrations, or things the system must never do."></textarea></label>
            <label><span>What would make the project successful?</span><textarea name="successCriteria" required rows="3" maxlength="1600" placeholder="A measurable business or user outcome, not a technology preference."></textarea></label>
            <label><span>Expected timeframe</span><select name="timeframe" required><option value="">Select</option><option value="as-soon-as-practical">As soon as practical</option><option value="1-3-months">1–3 months</option><option value="3-6-months">3–6 months</option><option value="6-plus-months">More than 6 months</option><option value="exploring">Still exploring</option></select></label>
          </fieldset>

          <label class="honeypot" aria-hidden="true"><span>Company website</span><input name="companyWebsite" tabindex="-1" autocomplete="off"></label>
          <input name="formStartedAt" type="hidden">
          <label class="check"><input name="consentToContact" type="checkbox" required><span>I agree that Orkestr may process this information to assess and contact me about Project Discovery and a possible implementation. I have read the <a href="/privacy">privacy notice</a>.</span></label>
          <button class="button submit-workflow" type="submit">Submit project for review</button>
          <p class="form-status" id="project-status" role="status" aria-live="polite"></p>
          <div class="scheduling-handoff" id="project-scheduling-handoff" hidden></div>
        </form>
      </section>
      <script>
        (() => {
          const form = document.getElementById("project-form");
          const status = document.getElementById("project-status");
          const error = document.getElementById("project-form-error");
          const scheduling = document.getElementById("project-scheduling-handoff");
          const submit = form && form.querySelector('button[type="submit"]');
          if (!form || !status || !error || !scheduling || !submit) return;
          const resetStart = () => { form.elements.formStartedAt.value = String(Date.now()); };
          resetStart();
          let started = false;
          form.addEventListener("input", () => {
            if (started) return;
            started = true;
            window.orkestrTrack && window.orkestrTrack("project_form_start");
          });
          form.addEventListener("submit", async (event) => {
            event.preventDefault();
            error.hidden = true;
            scheduling.hidden = true;
            if (!form.reportValidity()) {
              error.textContent = "Review the highlighted fields and complete the project description.";
              error.hidden = false;
              error.focus();
              window.orkestrTrack && window.orkestrTrack("project_validation_error");
              return;
            }
            status.textContent = "Sending your project description…";
            submit.disabled = true;
            const data = new FormData(form);
            const body = Object.fromEntries(data.entries());
            body.consentToContact = data.get("consentToContact") === "on";
            try {
              const response = await fetch("/api/public/project-inquiries", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
              });
              const payload = await response.json().catch(() => ({}));
              if (!response.ok || payload.ok === false) throw new Error(payload.error || "project_submit_failed");
              form.reset();
              resetStart();
              status.textContent = payload.message || "Your project was submitted for review.";
              if (payload.schedulingUrl) {
                const link = document.createElement("a");
                link.className = "button button-outline";
                link.href = payload.schedulingUrl;
                link.target = "_blank";
                link.rel = "noreferrer";
                link.textContent = "Schedule Project Discovery";
                link.dataset.event = "project_schedule_click";
                scheduling.replaceChildren(link);
                scheduling.hidden = false;
              }
              window.orkestrTrack && window.orkestrTrack("project_submit_success");
            } catch {
              error.textContent = "We could not submit this project. Your entries remain here; please try again or use the support contact.";
              error.hidden = false;
              error.focus();
              status.textContent = "";
              window.orkestrTrack && window.orkestrTrack("project_submit_error");
            } finally {
              submit.disabled = false;
            }
          });
        })();
      </script>
    </main>`,
  };
}
