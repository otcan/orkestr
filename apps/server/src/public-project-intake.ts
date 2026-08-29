import { escapeHtml, publicProjectSchedulingUrl, type PublicPage } from "./public-site-config.js";

function bookingAction(env = process.env) {
  const schedulingUrl = publicProjectSchedulingUrl(env);
  if (schedulingUrl) {
    return `<a class="button button-light booking-primary" href="${escapeHtml(schedulingUrl)}" target="_blank" rel="noreferrer" data-event="project_booking_click">Choose a time</a><p class="booking-note">Opens the secure booking calendar in a new tab.</p>`;
  }
  return `<a class="button button-light booking-primary" href="#quick-project-form" data-event="project_call_request_click">Request a project call</a><p class="booking-note">Send the short request below and we will reply by work email.</p>`;
}

export function projectIntakePage(env = process.env): PublicPage {
  return {
    id: "project",
    title: "Book a Project Call",
    summary: "Book a short Orkestr project call or describe a business system, modernization, data, or automation need in about 60 seconds.",
    body: `<main id="main-content" class="project-v4">
      <section class="project-booking-hero" aria-labelledby="project-title">
        <div class="project-booking-copy">
          <p class="section-index">PROJECT DISCOVERY</p>
          <h1 id="project-title">Let’s talk about what should work better.</h1>
          <p class="lead">A 20-minute conversation is enough to understand the problem and decide whether there is a credible next step.</p>
          <ul><li>No technical specification required</li><li>No sales presentation to prepare</li><li>No commitment after the call</li></ul>
        </div>
        <aside class="booking-panel" id="book" aria-labelledby="booking-title">
          <p>20-MINUTE PROJECT CALL</p>
          <h2 id="booking-title">Start with a conversation.</h2>
          <p>Tell us what the business needs to launch, replace, or make easier. We will ask the technical questions.</p>
          ${bookingAction(env)}
          <a class="booking-secondary" href="#quick-project-form" data-event="project_quick_start">Prefer writing? Describe it in 60 seconds <span aria-hidden="true">↓</span></a>
        </aside>
      </section>

      <section class="quick-intake-section" aria-labelledby="quick-intake-title">
        <div class="quick-intake-copy">
          <p class="section-index">SHORT PROJECT BRIEF</p>
          <h2 id="quick-intake-title">Give us the useful part.</h2>
          <p>Four answers are enough to begin. Add context only if it is easy to share.</p>
          <p class="legal-note"><strong>Do not send confidential records.</strong> Leave out passwords, credentials, personal data, private documents, and production access details.</p>
        </div>
        <form class="workflow-form quick-project-form" id="quick-project-form" novalidate>
          <div class="form-error" id="project-form-error" role="alert" tabindex="-1" hidden></div>
          <input name="intakeMode" type="hidden" value="quick">
          <fieldset class="project-type-fieldset">
            <legend><span>1</span> What needs to change?</legend>
            <div class="project-type-options">
              <label><input name="projectType" type="radio" value="build" required><span><strong>Build</strong><small>A new website, store, portal, or application</small></span></label>
              <label><input name="projectType" type="radio" value="replace" required><span><strong>Modernize</strong><small>An old or unsuitable business system</small></span></label>
              <label><input name="projectType" type="radio" value="automate" required><span><strong>Automate</strong><small>Repeated work, data collection, or monitoring</small></span></label>
              <label><input name="projectType" type="radio" value="not-sure" required><span><strong>Not sure</strong><small>Start with the business problem</small></span></label>
            </div>
          </fieldset>

          <label class="quick-outcome"><span><b>2</b> What should the business be able to do?</span><textarea name="desiredOutcome" required rows="5" maxlength="2400" placeholder="For example: Customers should be able to place B2B orders online without emailing our team."></textarea></label>
          <label class="adaptive-context"><span id="context-label">Optional: What happens today?</span><textarea name="currentSituation" rows="3" maxlength="2000" placeholder="A few sentences are enough."></textarea></label>
          <div class="field-grid two quick-contact"><label><span><b>3</b> Your name</span><input name="contactName" autocomplete="name" required maxlength="120"></label><label><span><b>4</b> Work email</span><input name="workEmail" type="email" autocomplete="email" required maxlength="160"></label></div>

          <details class="project-more-details" data-event="project_detail_expand">
            <summary>Add useful context <span>Optional</span></summary>
            <div class="project-more-fields">
              <div class="field-grid two"><label><span>Company</span><input name="company" autocomplete="organization" maxlength="160"></label><label><span>Your role</span><input name="role" autocomplete="organization-title" maxlength="160"></label></div>
              <label><span>Users, volume, or scale</span><textarea name="usersAndVolume" rows="2" maxlength="1200"></textarea></label>
              <label><span>Existing systems or approved sources</span><textarea name="systemsOrSources" rows="2" maxlength="1600"></textarea></label>
              <label><span>Important constraints or success criteria</span><textarea name="constraints" rows="2" maxlength="1600"></textarea></label>
              <label><span>Expected timeframe</span><select name="timeframe"><option value="exploring">Still exploring</option><option value="as-soon-as-practical">As soon as practical</option><option value="1-3-months">1–3 months</option><option value="3-6-months">3–6 months</option><option value="6-plus-months">More than 6 months</option></select></label>
            </div>
          </details>

          <label class="honeypot" aria-hidden="true"><span>Company website</span><input name="companyWebsite" tabindex="-1" autocomplete="off"></label>
          <input name="formStartedAt" type="hidden">
          <label class="check"><input name="consentToContact" type="checkbox" required><span>I agree that Orkestr may process this information and contact me about this project. I have read the <a href="/privacy">privacy notice</a>.</span></label>
          <button class="button submit-workflow" type="submit">Send my project brief</button>
          <p class="form-status" id="project-status" role="status" aria-live="polite"></p>
          <div class="scheduling-handoff" id="project-scheduling-handoff" hidden></div>
        </form>
      </section>

      <section class="project-expectations" aria-label="What happens next"><p class="section-index">WHAT HAPPENS NEXT</p><ol><li><span>01</span><p><strong>We review the need.</strong> We look for a concrete outcome and a sensible project boundary.</p></li><li><span>02</span><p><strong>We talk.</strong> We ask about users, systems, constraints, and what success means.</p></li><li><span>03</span><p><strong>You get a clear next step.</strong> That may be discovery, a scoped proposal, or an honest no-fit answer.</p></li></ol></section>

      <script>
        (() => {
          const form = document.getElementById("quick-project-form");
          const status = document.getElementById("project-status");
          const error = document.getElementById("project-form-error");
          const scheduling = document.getElementById("project-scheduling-handoff");
          const contextLabel = document.getElementById("context-label");
          const context = form && form.elements.currentSituation;
          const submit = form && form.querySelector('button[type="submit"]');
          if (!form || !status || !error || !scheduling || !contextLabel || !context || !submit) return;
          const prompts = {
            build: ["Optional: What are you trying to launch?", "What exists today, if anything?"],
            replace: ["Optional: What needs replacing?", "What is old, fragile, or no longer working for the business?"],
            automate: ["Optional: What happens repeatedly today?", "Who does the work, where does the information come from, and where should it go?"],
            "not-sure": ["Optional: What is currently frustrating?", "Describe the situation in plain language."],
          };
          const resetStart = () => { form.elements.formStartedAt.value = String(Date.now()); };
          resetStart();
          form.addEventListener("change", (event) => {
            if (event.target.name !== "projectType") return;
            const prompt = prompts[event.target.value] || prompts["not-sure"];
            contextLabel.textContent = prompt[0]; context.placeholder = prompt[1];
            window.orkestrTrack && window.orkestrTrack("project_type_selected");
          });
          let started = false;
          form.addEventListener("input", () => {
            if (started) return; started = true;
            window.orkestrTrack && window.orkestrTrack("project_quick_form_start");
          });
          form.addEventListener("submit", async (event) => {
            event.preventDefault(); error.hidden = true; scheduling.hidden = true;
            if (!form.reportValidity()) {
              error.textContent = "Complete the four short fields and contact consent.";
              error.hidden = false; error.focus();
              window.orkestrTrack && window.orkestrTrack("project_quick_validation_error");
              return;
            }
            status.textContent = "Sending your project brief…"; submit.disabled = true;
            const data = new FormData(form); const body = Object.fromEntries(data.entries());
            body.consentToContact = data.get("consentToContact") === "on";
            try {
              const response = await fetch("/api/public/project-inquiries", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
              const payload = await response.json().catch(() => ({}));
              if (!response.ok || payload.ok === false) throw new Error(payload.error || "project_submit_failed");
              form.reset(); resetStart(); started = false;
              status.textContent = payload.message || "Your project brief is queued. We will reply using your work email.";
              if (payload.schedulingUrl) {
                const link = document.createElement("a"); link.className = "button button-outline";
                link.href = payload.schedulingUrl; link.target = "_blank"; link.rel = "noreferrer";
                link.textContent = "Choose a time"; link.dataset.event = "project_schedule_click";
                scheduling.replaceChildren(link); scheduling.hidden = false;
              }
              window.orkestrTrack && window.orkestrTrack("project_quick_submit_success");
            } catch {
              error.textContent = "We could not send this brief. Your entries remain here; please try again or use the support contact.";
              error.hidden = false; error.focus(); status.textContent = "";
              window.orkestrTrack && window.orkestrTrack("project_quick_submit_error");
            } finally { submit.disabled = false; }
          });
        })();
      </script>
    </main>`,
  };
}
