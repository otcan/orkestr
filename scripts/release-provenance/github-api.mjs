// Small GitHub REST helper for release provenance checks. Every network call
// goes through an injectable fetch, tokens are only ever placed in the
// Authorization header, and error messages never include them.

export const DEFAULT_GITHUB_API = "https://api.github.com";

export class GithubApiError extends Error {
  constructor(code, { status = 0, path = "" } = {}) {
    super(`${code}${status ? ` (HTTP ${status})` : ""}${path ? ` ${path}` : ""}`);
    this.name = "GithubApiError";
    this.code = code;
    this.status = status;
  }
}

// owner/repo from git@github.com:o/r.git, ssh://git@github.com/o/r.git,
// https://github.com/o/r(.git) or a bare "o/r". Returns null for other hosts.
export function parseGithubRepository(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const patterns = [
    /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
    /^ssh:\/\/git@github\.com(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
    /^(?:https?|git):\/\/(?:[^@/\s]+@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
    /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/,
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match && /^[A-Za-z0-9_.-]+$/.test(match[1]) && /^[A-Za-z0-9_.-]+$/.test(match[2])) return { owner: match[1], repo: match[2] };
  }
  return null;
}

export function githubTokenFromEnv(env = process.env) {
  for (const key of ["ORKESTR_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) {
    const value = String(env[key] || "").trim();
    if (value) return value;
  }
  return "";
}

export function createGithubClient({ fetchImpl = globalThis.fetch, token = "", apiBase = DEFAULT_GITHUB_API, timeoutMs = 20000 } = {}) {
  const base = String(apiBase || DEFAULT_GITHUB_API).replace(/\/+$/, "");
  const headers = (accept = "application/vnd.github+json") => ({
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "orkestr-release-provenance",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  });

  async function request(path, { accept, redirect = "follow" } = {}) {
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, { headers: headers(accept), redirect, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new GithubApiError("github_api_unreachable", { path });
    }
    return response;
  }

  async function json(path) {
    const response = await request(path);
    if (!response.ok) throw new GithubApiError(response.status === 404 ? "github_api_not_found" : "github_api_error", { status: response.status, path });
    try {
      return await response.json();
    } catch {
      throw new GithubApiError("github_api_invalid_json", { path });
    }
  }

  // Paginates list endpoints that wrap rows in `key` (check_runs, artifacts).
  async function list(path, key, { perPage = 100, maxPages = 10 } = {}) {
    const rows = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const separator = path.includes("?") ? "&" : "?";
      const payload = await json(`${path}${separator}per_page=${perPage}&page=${page}`);
      const batch = Array.isArray(payload?.[key]) ? payload[key] : null;
      if (!batch) throw new GithubApiError("github_api_invalid_shape", { path });
      rows.push(...batch);
      const total = Number(payload.total_count);
      if (!batch.length) return rows;
      if (Number.isFinite(total) ? rows.length >= total : batch.length < perPage) return rows;
    }
    throw new GithubApiError("github_api_pagination_incomplete", { path });
  }

  // Artifact archives redirect to blob storage. Follow the redirect manually
  // so the GitHub token is never sent to the storage host.
  async function download(path, { maxBytes = 1024 * 1024 * 1024 } = {}) {
    if (!token) throw new GithubApiError("github_token_required_for_download", { path });
    let response = await request(path, { redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers?.get?.("location");
      if (!location) throw new GithubApiError("github_download_redirect_missing", { path });
      try {
        response = await fetchImpl(location, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs * 6) });
      } catch {
        throw new GithubApiError("github_download_unreachable", { path });
      }
    }
    if (!response.ok) throw new GithubApiError(response.status === 410 ? "github_artifact_expired" : "github_download_failed", { status: response.status, path });
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new GithubApiError("github_download_too_large", { path });
    return buffer;
  }

  return { json, list, download, authenticated: Boolean(token) };
}
