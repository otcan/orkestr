export function renderWaitlistSection() {
  return `<section class="band waitlist-band" id="waitlist" aria-labelledby="waitlist-title">
    <div>
      <p class="eyebrow">Request access</p>
      <h2 id="waitlist-title">Join the Orkestr waitlist.</h2>
      <p>Leave your WhatsApp number. If you are invited, Orkestr creates a private onboarding chat where you enter personal setup details, connect tools, open desktops, and manage timers.</p>
    </div>
    <form class="waitlist-form" id="waitlist-form">
      <label>
        <span>Name</span>
        <input name="displayName" autocomplete="name" required maxlength="120">
      </label>
      <label>
        <span>WhatsApp number</span>
        <input name="phoneNumber" autocomplete="tel" inputmode="tel" required maxlength="40" placeholder="+49...">
      </label>
      <label>
        <span>Email</span>
        <input name="email" autocomplete="email" inputmode="email" maxlength="160">
      </label>
      <label>
        <span>Timezone</span>
        <input name="timezone" autocomplete="off" maxlength="80" placeholder="Europe/Berlin">
      </label>
      <label>
        <span>What should Orkestr help with?</span>
        <textarea name="intendedUse" rows="4" maxlength="1000" placeholder="Job applications, leads, fitness check-ins, inbox help..."></textarea>
      </label>
      <label class="check">
        <input name="acceptedTerms" type="checkbox" required>
        <span>I accept the beta <a href="/terms">terms</a> and <a href="/privacy">privacy notice</a>.</span>
      </label>
      <label class="check">
        <input name="consentToContact" type="checkbox" required>
        <span>You may contact me on WhatsApp about Orkestr beta access.</span>
      </label>
      <button class="button" type="submit">Request invite</button>
      <p class="form-status" id="waitlist-status" role="status"></p>
    </form>
    <script>
      (() => {
        const form = document.getElementById("waitlist-form");
        const status = document.getElementById("waitlist-status");
        if (!form || !status) return;
        const timezone = form.querySelector('[name="timezone"]');
        try {
          const detected = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
          if (timezone && detected && !timezone.value) timezone.value = detected;
        } catch {}
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          status.textContent = "Sending request...";
          const data = new FormData(form);
          const body = Object.fromEntries(data.entries());
          body.acceptedTerms = data.get("acceptedTerms") === "on";
          body.consentToContact = data.get("consentToContact") === "on";
          try {
            const response = await fetch("/api/public/waitlist", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok || payload.ok === false) throw new Error(payload.error || "waitlist_submit_failed");
            form.reset();
            status.textContent = payload.message || "Thanks. You are on the Orkestr waitlist.";
          } catch {
            status.textContent = "Could not submit this request. Check the fields and try again.";
          }
        });
      })();
    </script>
  </section>`;
}

export function waitlistCss() {
  return `
.waitlist-band { background: #fdfdfb; }
.waitlist-form {
  display: grid;
  gap: 14px;
  align-content: start;
  padding: 22px;
  border: 1px solid rgba(23, 32, 42, 0.14);
  border-radius: 8px;
  background: #fff;
  box-shadow: 0 18px 50px rgba(15, 23, 42, 0.08);
}
.waitlist-form label { display: grid; gap: 7px; color: #17202a; font-weight: 800; }
.waitlist-form label span { font-size: 14px; }
.waitlist-form input,
.waitlist-form textarea {
  width: 100%;
  min-height: 44px;
  border: 1px solid rgba(23, 32, 42, 0.22);
  border-radius: 6px;
  padding: 10px 12px;
  color: #17202a;
  background: #f8fafc;
  font: inherit;
}
.waitlist-form textarea { resize: vertical; line-height: 1.45; }
.waitlist-form .check {
  grid-template-columns: 18px minmax(0, 1fr);
  align-items: start;
  gap: 10px;
  color: #475569;
  font-weight: 600;
}
.waitlist-form .check input { width: 18px; min-height: 18px; margin: 2px 0 0; }
.waitlist-form .check a { color: #111827; font-weight: 900; }
.waitlist-form button { width: fit-content; cursor: pointer; }
.form-status { min-height: 24px; font-size: 15px !important; color: #2563eb !important; }
`;
}
