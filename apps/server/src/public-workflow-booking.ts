import {
  escapeHtml,
  publicContact,
  publicContactEmail,
  publicSchedulingUrl,
  type PublicPage,
} from "./public-site-config.js";

function emailBookingFallback(env = process.env) {
  const email = publicContactEmail(env);
  if (!email) return `<p class="booking-contact">${escapeHtml(publicContact(env))}</p>`;
  const subject = encodeURIComponent("Orkestr 20-minute call");
  return `<a class="text-link" href="mailto:${escapeHtml(email)}?subject=${subject}" data-event="booking_email_click">Email ${escapeHtml(email)} <span aria-hidden="true">→</span></a>`;
}

export function workflowBookingPage(env = process.env): PublicPage {
  const schedulingUrl = publicSchedulingUrl(env);
  const bookingAction = schedulingUrl
    ? `<a class="button booking-button" href="${escapeHtml(schedulingUrl)}" target="_blank" rel="noreferrer" data-event="booking_calendar_click" aria-describedby="booking-note">Book a 20-minute call</a>
       <p class="microcopy" id="booking-note">Choose a time in the secure scheduling page. It opens in a new tab.</p>`
    : `<div class="booking-unavailable" role="status"><strong>Online scheduling is being connected.</strong><p>You can still arrange the same 20-minute call by email.</p>${emailBookingFallback(env)}</div>`;

  return {
    id: "workflow",
    title: "Book a 20-Minute Workflow Call",
    summary: "Book a short conversation about repetitive work your team wants to simplify. No detailed form or preparation is required.",
    body: `<main id="main-content">
      <section class="page-hero booking-hero">
        <p class="section-index">A SHORT FIRST CONVERSATION</p>
        <h1>Let’s talk about the work you want to simplify.</h1>
        <p class="lead">Book a 20-minute conversation. No preparation, process map, or long qualification form required.</p>
      </section>
      <section class="booking-section" aria-labelledby="booking-title">
        <div class="booking-expectations">
          <p class="section-index">WHAT TO EXPECT</p>
          <h2 id="booking-title">Bring one repetitive task. We’ll take it from there.</h2>
          <ul class="plain-checks">
            <li><strong>Explain it in your own words.</strong><span>No technical language needed.</span></li>
            <li><strong>See whether Orkestr is a useful fit.</strong><span>We will be direct if it is not.</span></li>
            <li><strong>Leave with a clear next step.</strong><span>No purchase commitment.</span></li>
          </ul>
        </div>
        <aside class="booking-card" aria-label="Book an Orkestr call" data-booking-configured="${schedulingUrl ? "true" : "false"}">
          <span class="booking-duration">20 minutes</span>
          <h2>Choose a time that works for you.</h2>
          <p>We’ll discuss the task, the tools involved, and where a person should stay in control.</p>
          ${bookingAction}
          ${schedulingUrl ? `<div class="booking-fallback"><span>Prefer email?</span>${emailBookingFallback(env)}</div>` : ""}
        </aside>
      </section>
      <section class="section booking-prep" aria-labelledby="prep-title">
        <div><p class="section-index">OPTIONAL PREPARATION</p><h2 id="prep-title">One example is enough.</h2></div>
        <div><p>If useful, bring a recent example of the task and the point where it slowed down or needed a decision. Do not send passwords, credentials, confidential files, or personal records before we agree a secure way to review them.</p><a class="text-link" href="/security">See how access and approvals work <span aria-hidden="true">→</span></a></div>
      </section>
    </main>`,
  };
}
