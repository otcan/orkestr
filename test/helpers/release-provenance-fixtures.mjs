// Offline fixtures for release provenance tests: a tiny zip writer, a fake
// GitHub REST fetch, and check-run builders. Nothing here touches the network.
import crypto from "node:crypto";
import zlib from "node:zlib";

export const SHA = "a".repeat(40);
export const OTHER_SHA = "b".repeat(40);
export const REPO_URL = "git@github.com:example-org/example-repo.git";
export const API = "https://api.github.invalid";

export function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const compressed = zlib.deflateRawSync(data);
    const nameBuffer = Buffer.from(name);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuffer, compressed);
    centrals.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + compressed.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  const count = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
  end.writeUInt32LE(centralBuffer.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
}

export const digestOf = (buffer) => `sha256:${crypto.createHash("sha256").update(buffer).digest("hex")}`;

export const REQUIRED = ["syntax", "secret-scan", "secret-policy", "dependency-advisories", "dependency-policy", "build", "smoke", "test (1)", "test (2)", "test (3)", "test (4)"];

export function checkRun(name, { runId = 900, status = "completed", conclusion = "success", headSha = SHA, id } = {}) {
  return {
    id: id ?? Math.floor(Math.random() * 1e9),
    name,
    status,
    conclusion: status === "completed" ? conclusion : null,
    head_sha: headSha,
    details_url: `https://github.com/example-org/example-repo/actions/runs/${runId}/job/1`,
    started_at: "2026-01-01T00:00:00Z",
    completed_at: status === "completed" ? "2026-01-01T00:05:00Z" : null,
  };
}

export function passingRuns(overrides = {}) {
  return REQUIRED.map((name) => checkRun(name, overrides[name] || {}));
}

// routes: { "/path": body | (url, init) => Response }. Records every request.
export function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    calls.push({ url: String(url), path: parsed.pathname, headers: init.headers || {}, redirect: init.redirect });
    const route = routes[parsed.pathname];
    if (route === undefined) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    if (typeof route === "function") return route(parsed, init);
    if (route instanceof Error) throw route;
    if (Buffer.isBuffer(route)) return new Response(route, { status: 200 });
    return new Response(JSON.stringify(route), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, calls };
}

export function githubRoutes({ checkRuns = passingRuns(), artifacts, attestations = [{ bundle: {} }], archives = {} } = {}) {
  const base = "/repos/example-org/example-repo";
  const routes = {
    [`${base}/commits/${SHA}/check-runs`]: { total_count: checkRuns.length, check_runs: checkRuns },
  };
  if (artifacts) routes[`${base}/actions/runs/900/artifacts`] = { total_count: artifacts.length, artifacts };
  for (const artifact of artifacts || []) {
    if (artifact.digest && attestations !== null) routes[`${base}/attestations/${artifact.digest}`] = { attestations };
  }
  for (const [id, buffer] of Object.entries(archives)) {
    routes[`${base}/actions/artifacts/${id}/zip`] = () => new Response(null, { status: 302, headers: { location: `https://blob.invalid/artifact-${id}` } });
    routes[`/artifact-${id}`] = buffer;
  }
  return routes;
}

export function artifact(name, { id, digest, expired = false, headSha = SHA } = {}) {
  return { id, name, digest, expired, size_in_bytes: 10, workflow_run: { id: 900, head_sha: headSha } };
}
