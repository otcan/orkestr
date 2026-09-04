(() => {
  "use strict";

  const by = (selector) => document.querySelector(selector);
  const loading = by("[data-loading]");
  const errorView = by("[data-error]");
  const directoryView = by("[data-directory]");
  const detailView = by("[data-app-detail]");
  const workspaceError = by("[data-workspace-error]");
  let directory = null;
  let openingWorkspace = false;

  function show(target) {
    for (const view of [loading, errorView, directoryView, detailView]) view.hidden = view !== target;
  }

  function safeUrl(value, base = globalThis.location.origin) {
    try {
      const parsed = new URL(String(value || ""), base);
      return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.toString() : "";
    } catch {
      return "";
    }
  }

  function element(tag, className = "", text = "") {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function icon(label, workspace = false) {
    return element("span", `card-icon${workspace ? " workspace-icon" : ""}`, String(label || "O").trim().slice(0, 1).toUpperCase());
  }

  async function json(path, options = {}) {
    const response = await fetch(path, {
      credentials: "same-origin",
      headers: { accept: "application/json", ...(options.headers || {}) },
      ...options,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function openWorkspace(workspace, button) {
    if (openingWorkspace) return;
    const direct = safeUrl(workspace.url);
    if (!workspace.publicRef) {
      if (direct) globalThis.location.assign(direct);
      return;
    }
    openingWorkspace = true;
    workspaceError.hidden = true;
    button.classList.add("busy");
    button.disabled = true;
    button.querySelector(".open-arrow").textContent = "…";
    try {
      const result = await json(`/api/instance/accounts/${encodeURIComponent(workspace.publicRef)}/session`, { method: "POST" });
      const target = safeUrl(result.url || workspace.url, directory?.appUrl || globalThis.location.origin);
      if (!target) throw new Error("workspace_url_invalid");
      globalThis.location.assign(target);
    } catch {
      openingWorkspace = false;
      button.classList.remove("busy");
      button.disabled = false;
      button.querySelector(".open-arrow").textContent = "→";
      workspaceError.textContent = "That Orkestr workspace is not available right now.";
      workspaceError.hidden = false;
    }
  }

  function workspaceCard(workspace) {
    const button = element("button", "workspace-card");
    button.type = "button";
    button.append(icon(workspace.displayName, true));
    const copy = element("span", "card-copy");
    copy.append(element("strong", "", workspace.displayName || "Orkestr"));
    copy.append(element("small", "", workspace.current ? "Primary workspace" : "Orkestr workspace"));
    button.append(copy, element("span", "open-arrow", "→"));
    button.addEventListener("click", () => void openWorkspace(workspace, button));
    return button;
  }

  function appCard(app) {
    const anchor = element("a", "app-card");
    const href = safeUrl(app.url);
    if (href) anchor.href = href;
    else anchor.setAttribute("aria-disabled", "true");
    anchor.target = app.external || app.target === "_blank" ? "_blank" : "_self";
    anchor.rel = "noreferrer";
    anchor.append(icon(app.label));
    const copy = element("span", "card-copy");
    copy.append(element("small", "", app.category || app.type || "Application"));
    copy.append(element("strong", "", app.label || "Application"));
    if (app.description) copy.append(element("span", "description", app.description));
    const footer = element("span", "card-footer");
    const unhealthy = app.health?.status === "error";
    footer.append(element("span", `health${unhealthy ? " warning" : ""}`, unhealthy ? "Needs attention" : app.health?.status === "ok" ? "Available" : "Ready"));
    footer.append(element("span", "open-arrow", "↗"));
    anchor.append(copy, footer);
    return anchor;
  }

  function renderDirectory(payload) {
    directory = payload;
    const mainLink = by("[data-main-link]");
    const mainUrl = safeUrl(payload.appUrl);
    if (mainUrl) {
      mainLink.href = mainUrl;
      mainLink.hidden = false;
    }
    const workspaces = Array.isArray(payload.workspaces) ? payload.workspaces : [];
    const apps = Array.isArray(payload.apps) ? payload.apps : [];
    const workspaceSection = by("[data-workspaces-section]");
    workspaceSection.hidden = workspaces.length === 0;
    by("[data-workspace-count]").textContent = String(workspaces.length);
    by("[data-app-count]").textContent = String(apps.length);
    const workspaceGrid = by("[data-workspaces]");
    const appGrid = by("[data-apps]");
    workspaceGrid.replaceChildren(...workspaces.map(workspaceCard));
    if (apps.length) appGrid.replaceChildren(...apps.map(appCard));
    else {
      const empty = element("div", "empty-state");
      empty.append(element("strong", "", "No applications yet"));
      empty.append(element("p", "muted", "Applications assigned to your account will appear here."));
      appGrid.replaceChildren(empty);
    }
    show(directoryView);
  }

  function appSlug() {
    const parts = globalThis.location.pathname.split("/").filter(Boolean);
    if (parts[0] !== "apps" || !parts[1]) return "";
    try { return decodeURIComponent(parts[1]); } catch { return ""; }
  }

  async function load() {
    try {
      const slug = appSlug();
      if (slug) {
        const payload = await json(`/api/apps/${encodeURIComponent(slug)}`);
        const app = payload.app || {};
        by("[data-app-type]").textContent = app.type || "Application";
        by("[data-app-title]").textContent = app.title || "Application";
        by("[data-app-description]").textContent = app.description || "";
        by("[data-app-role]").textContent = app.role ? `Authorized as ${app.role}. Workspace routing stays server-side.` : "";
        show(detailView);
        return;
      }
      renderDirectory(await json("/api/me/launcher"));
    } catch {
      by("[data-error-message]").textContent = "This launcher is not available to your account right now.";
      show(errorView);
    }
  }

  void load();
})();
