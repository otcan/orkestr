const connectorsEl = document.querySelector("#connectors");
const browsersEl = document.querySelector("#browsers");
const timersEl = document.querySelector("#timers");
const agentTemplatesEl = document.querySelector("#agent-templates");
const agentsEl = document.querySelector("#agents");
const eventsEl = document.querySelector("#events");
const homeEl = document.querySelector("#home");
const refreshButton = document.querySelector("#refresh");
const timerForm = document.querySelector("#timer-form");

const connectorFields = {
  openai: [{ name: "openaiApiKey", label: "API key", type: "password", placeholder: "sk-..." }],
  gmail: [
    { name: "clientId", label: "OAuth client ID", placeholder: "123.apps.googleusercontent.com" },
    { name: "clientSecret", label: "OAuth client secret", type: "password", placeholder: "GOCSPX-..." },
    { name: "redirectUri", label: "Redirect URI", placeholder: "http://localhost:19812/oauth/gmail/callback" },
  ],
  whatsapp: [{ name: "bridgeUrl", label: "Bridge URL", placeholder: "http://127.0.0.1:8787" }],
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function stateLabel(state) {
  return String(state || "unknown").replace(/_/g, " ");
}

function connectorForm(connector, config = {}) {
  const fields = connectorFields[connector.id] || [];
  if (!fields.length) return "";
  return `
    <form class="connector-form" data-config-form="${escapeHtml(connector.id)}">
      ${fields
        .map(
          (field) => `
            <label>
              <small>${escapeHtml(field.label)}</small>
              <input
                name="${escapeHtml(field.name)}"
                type="${escapeHtml(field.type || "text")}"
                placeholder="${escapeHtml(config[field.name] || field.placeholder || "")}"
              />
            </label>
          `,
        )
        .join("")}
      <button type="submit" class="secondary">Save config</button>
    </form>
  `;
}

function renderConnectors(status) {
  const overlay = status.overlay?.configured ? ` · overlay ${status.overlay.valid ? "loaded" : "invalid"}` : "";
  homeEl.textContent = `Setup: ${stateLabel(status.setupState)} · Local data: ${status.home}${overlay}`;
  connectorsEl.innerHTML = status.connectors
    .map((connector) => {
      const config = status.config?.[connector.id] || {};
      return `
        <article class="card">
          <span class="state ${escapeHtml(connector.state)}">${escapeHtml(stateLabel(connector.state))}</span>
          <h3>${escapeHtml(connector.label)}</h3>
          <p>${escapeHtml(connector.summary)}</p>
          ${connector.details?.bridgeUrl ? `<p><small>${escapeHtml(connector.details.bridgeUrl)}</small></p>` : ""}
          <div class="actions">
            <button data-test="${escapeHtml(connector.id)}">Test</button>
            ${connector.id === "gmail" ? `<button class="secondary" data-gmail-oauth>Start OAuth</button>` : ""}
          </div>
          ${connectorForm(connector, config)}
        </article>
      `;
    })
    .join("");

  connectorsEl.querySelectorAll("[data-test]").forEach((button) => {
    button.addEventListener("click", async () => {
      button.textContent = "Testing...";
      await api(`/api/connectors/${button.dataset.test}/test`, { method: "POST" });
      await refresh();
    });
  });

  connectorsEl.querySelectorAll("[data-config-form]").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const body = Object.fromEntries([...new FormData(form).entries()].filter(([, value]) => String(value).trim()));
      if (!Object.keys(body).length) return;
      await api(`/api/connectors/${form.dataset.configForm}/config`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      form.reset();
      await refresh();
    });
  });

  connectorsEl.querySelectorAll("[data-gmail-oauth]").forEach((button) => {
    button.addEventListener("click", async () => {
      button.textContent = "Starting...";
      const payload = await api("/api/connectors/gmail/oauth/start");
      window.open(payload.authorizeUrl, "_blank", "noopener,noreferrer");
      await refresh();
    });
  });
}

function renderBrowsers(payload) {
  browsersEl.innerHTML = payload.browsers
    .map(
      (browser) => `
        <article class="card">
          <span class="state ${browser.configured ? "partial" : "not_connected"}">${escapeHtml(browser.state)}</span>
          <h3>${escapeHtml(browser.label)}</h3>
          <p>${escapeHtml(browser.purpose)}</p>
          <p><small>${escapeHtml(browser.profileDir)}</small></p>
          <div class="actions">
            <button data-browser-prepare="${escapeHtml(browser.slug)}">
              ${browser.configured ? "Prepare again" : "Prepare browser"}
            </button>
            <button class="secondary" data-browser-open="${escapeHtml(browser.slug)}">Open</button>
          </div>
        </article>
      `,
    )
    .join("");

  browsersEl.querySelectorAll("[data-browser-prepare]").forEach((button) => {
    button.addEventListener("click", async () => {
      button.textContent = "Preparing...";
      await api(`/api/browsers/${button.dataset.browserPrepare}/prepare`, { method: "POST" });
      await refresh();
    });
  });

  browsersEl.querySelectorAll("[data-browser-open]").forEach((button) => {
    button.addEventListener("click", async () => {
      button.textContent = "Opening...";
      await api(`/api/browsers/${button.dataset.browserOpen}/open`, { method: "POST" });
      await refresh();
    });
  });
}

function renderAgentTemplates(payload) {
  agentTemplatesEl.innerHTML = payload.templates
    .map(
      (template) => `
        <article class="card">
          <span class="state partial">${escapeHtml(template.connectors.join(" + "))}</span>
          <h3>${escapeHtml(template.name)}</h3>
          <p>${escapeHtml(template.tagline)}</p>
          <p><small>${escapeHtml(template.defaultTimer.label)} · ${escapeHtml(template.defaultTimer.cadence)} at ${escapeHtml(template.defaultTimer.time)}</small></p>
          <div class="actions">
            <button data-agent-template="${escapeHtml(template.id)}">Create</button>
          </div>
        </article>
      `,
    )
    .join("");

  agentTemplatesEl.querySelectorAll("[data-agent-template]").forEach((button) => {
    button.addEventListener("click", async () => {
      button.textContent = "Creating...";
      await api(`/api/agents/templates/${button.dataset.agentTemplate}`, { method: "POST" });
      await refresh();
    });
  });
}

function renderAgents(payload) {
  agentsEl.innerHTML = payload.agents.length
    ? payload.agents
        .map(
          (agent) => `
            <article class="card">
              <span class="state partial">${escapeHtml(agent.state)}</span>
              <h3>${escapeHtml(agent.name)}</h3>
              <p>${escapeHtml(agent.connectors.join(", "))}</p>
              <p><small>${escapeHtml(agent.id)}</small></p>
              <div class="message-list">
                ${(agent.messages || [])
                  .slice(-4)
                  .map(
                    (message) => `
                      <div class="message-row ${escapeHtml(message.role)}">
                        <strong>${escapeHtml(message.role)} · ${escapeHtml(message.state)}</strong>
                        <p>${escapeHtml(message.text || message.promptFile || "")}</p>
                      </div>
                    `,
                  )
                  .join("")}
              </div>
              <form class="connector-form" data-agent-message="${escapeHtml(agent.id)}">
                <textarea name="text" rows="3" placeholder="Send a test message to this agent"></textarea>
                <button type="submit" class="secondary">Queue message</button>
              </form>
              <div class="actions">
                <button data-agent-run="${escapeHtml(agent.id)}">Run next</button>
              </div>
            </article>
          `,
        )
        .join("")
    : `<p>No agents created yet.</p>`;

  agentsEl.querySelectorAll("[data-agent-message]").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const body = Object.fromEntries(new FormData(form).entries());
      await api(`/api/agents/${form.dataset.agentMessage}/messages`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      form.reset();
      await refresh();
    });
  });

  agentsEl.querySelectorAll("[data-agent-run]").forEach((button) => {
    button.addEventListener("click", async () => {
      button.textContent = "Running...";
      await api(`/api/agents/${button.dataset.agentRun}/run-next`, {
        method: "POST",
        body: JSON.stringify({ executorId: "noop" }),
      });
      await refresh();
    });
  });
}

function renderTimers(payload) {
  timersEl.innerHTML = payload.timers.length
    ? payload.timers
        .map(
          (timer) => `
            <article class="card">
              <span class="state connected">${escapeHtml(timer.cadence)}</span>
              <h3>${escapeHtml(timer.label)}</h3>
              <p>${escapeHtml(timer.target)} · next ${escapeHtml(new Date(timer.nextRunAt).toLocaleString())}</p>
              ${timer.promptFile ? `<p><small>${escapeHtml(timer.promptFile)}</small></p>` : ""}
              <div class="actions">
                <button class="secondary" data-run="${escapeHtml(timer.id)}">Run now</button>
                <button class="danger" data-delete="${escapeHtml(timer.id)}">Delete</button>
              </div>
            </article>
          `,
        )
        .join("")
    : `<p>No timers yet.</p>`;

  timersEl.querySelectorAll("[data-run]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api(`/api/timers/${button.dataset.run}/run`, { method: "POST" });
      await refresh();
    });
  });

  timersEl.querySelectorAll("[data-delete]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api(`/api/timers/${button.dataset.delete}`, { method: "DELETE" });
      await refresh();
    });
  });
}

function renderEvents(payload) {
  eventsEl.innerHTML = payload.events.length
    ? payload.events
        .slice()
        .reverse()
        .map((event) => {
          const { ts, type, ...rest } = event;
          return `
            <article class="event">
              <time>${escapeHtml(ts ? new Date(ts).toLocaleString() : "unknown")}</time>
              <div>
                <strong>${escapeHtml(type)}</strong>
                <pre>${escapeHtml(JSON.stringify(rest, null, 2))}</pre>
              </div>
            </article>
          `;
        })
        .join("")
    : `<p>No events yet.</p>`;
}

async function refresh() {
  const [status, browsers, timers, templates, agents, events] = await Promise.all([
    api("/api/setup/status"),
    api("/api/browsers"),
    api("/api/timers"),
    api("/api/agents/templates"),
    api("/api/agents"),
    api("/api/events?limit=40"),
  ]);
  const agentsWithMessages = await Promise.all(
    agents.agents.map(async (agent) => ({
      ...agent,
      messages: (await api(`/api/agents/${encodeURIComponent(agent.id)}/messages`)).messages,
    })),
  );
  renderConnectors(status);
  renderBrowsers(browsers);
  renderTimers(timers);
  renderAgentTemplates(templates);
  renderAgents({ agents: agentsWithMessages });
  renderEvents(events);
}

timerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(timerForm);
  await api("/api/timers", {
    method: "POST",
    body: JSON.stringify(Object.fromEntries(form.entries())),
  });
  timerForm.reset();
  timerForm.elements.cadence.value = "daily";
  timerForm.elements.time.value = "09:00";
  await refresh();
});

refreshButton.addEventListener("click", refresh);
refresh().catch((error) => {
  connectorsEl.innerHTML = `<article class="card"><h3>Setup failed</h3><p>${escapeHtml(error.message)}</p></article>`;
});
