import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

function element({ hidden = false, attributes = {} } = {}) {
  const values = new Map(Object.entries(attributes));
  return {
    hidden,
    textContent: "",
    className: "",
    addEventListener() {},
    getAttribute(name) {
      return values.get(name) || null;
    },
    removeAttribute(name) {
      values.delete(name);
    },
    setAttribute(name, value) {
      values.set(name, String(value));
    },
  };
}

test("expired desktop-share shell replaces an established desktop view with the renewal state", async () => {
  const source = await fs.readFile("apps/server/src/desktop-share-page.ts", "utf8");
  const desktopShareStart = source.indexOf("function serveDesktopSharePage");
  const scriptStart = source.indexOf("<script>", desktopShareStart) + "<script>".length;
  const scriptEnd = source.indexOf("</script>", scriptStart);
  assert.ok(desktopShareStart >= 0 && scriptStart > desktopShareStart && scriptEnd > scriptStart);
  const script = source.slice(scriptStart, scriptEnd);
  const nodes = {
    challenge: element(),
    status: element(),
    lifecycle: element(),
    summary: element(),
    open: element({ attributes: { href: "/desktop/fixture/vnc.html" } }),
    mobile: element({ attributes: { href: "/desktop/fixture/mobile" } }),
    copy: element(),
    owner: element({ hidden: true }),
    "chat-approval": element(),
    "share-panel": element({ hidden: true }),
    viewer: element(),
    "desktop-frame": element({ attributes: { src: "/desktop/fixture/vnc.html" } }),
  };
  const context = {
    URL,
    URLSearchParams,
    Date,
    Number,
    location: {
      pathname: "/desktop-share/fixture/share-fixture",
      search: "",
      origin: "https://app.example.test",
    },
    document: { getElementById: (id) => nodes[id] },
    navigator: { clipboard: { writeText: async () => undefined } },
    fetch: async () => ({
      ok: false,
      json: async () => ({
        ok: false,
        renewal: {
          renewCommand: "orkestr desktop share fixture",
          message: "This desktop link expired.",
        },
      }),
    }),
    setTimeout: () => 0,
  };

  vm.runInNewContext(script, context);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(nodes.viewer.hidden, true);
  assert.equal(nodes["share-panel"].hidden, false);
  assert.equal(nodes["desktop-frame"].getAttribute("src"), null);
  assert.equal(nodes.open.getAttribute("href"), null);
  assert.equal(nodes.mobile.getAttribute("href"), null);
  assert.match(nodes.summary.textContent, /expired/i);
  assert.match(nodes.status.textContent, /expired/i);
});

test("approved desktop shares navigate the top-level tab instead of framing noVNC", async () => {
  const source = await fs.readFile("apps/server/src/desktop-share-page.ts", "utf8");
  const desktopShareStart = source.indexOf("function serveDesktopSharePage");
  const scriptStart = source.indexOf("<script>", desktopShareStart) + "<script>".length;
  const scriptEnd = source.indexOf("</script>", scriptStart);
  const script = source.slice(scriptStart, scriptEnd);
  const nodes = {
    challenge: element(),
    status: element(),
    lifecycle: element(),
    summary: element(),
    open: element(),
    mobile: element(),
    copy: element(),
    owner: element({ hidden: true }),
    "chat-approval": element(),
    "share-panel": element(),
    viewer: element({ hidden: true }),
    "desktop-frame": element(),
  };
  let navigation = "";
  let calls = 0;
  const location = {
    pathname: "/desktop-share/fixture/share-fixture",
    search: "?key=sample",
    origin: "https://app.example.test",
    replace(value) { navigation = String(value); },
  };
  const context = {
    URL,
    URLSearchParams,
    Date,
    Number,
    location,
    document: { getElementById: (id) => nodes[id] },
    navigator: { clipboard: { writeText: async () => undefined } },
    fetch: async () => {
      calls += 1;
      return {
        ok: true,
        json: async () => calls === 1
          ? { ok: true, share: {}, attempt: { challenge: "desk-fixture" } }
          : { ok: true, approved: true, desktopUrl: "/desktop/linkedin/vnc.html", share: {}, attempt: {} },
      };
    },
    setTimeout: () => 0,
  };

  vm.runInNewContext(script, context);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(navigation, "https://app.example.test/desktop/linkedin/vnc.html");
  assert.equal(nodes["desktop-frame"].getAttribute("src"), null);
});

// ownerSession: the app host's answer to the link host's owner-session check
// (a status code, or "unreachable" when CORS or the network blocks it).
// openFailure: the open endpoint's error payload (revoked/expired link).
async function ownerFlow({ origin, appOrigin, approveStatus = 200, ownerSession = 200, openFailure = null }) {
  const source = await fs.readFile("apps/server/src/desktop-share-page.ts", "utf8");
  const scriptStart = source.indexOf("<script>", source.indexOf("function serveDesktopSharePage")) + "<script>".length;
  const script = source.slice(scriptStart, source.indexOf("</script>", scriptStart));
  const nodes = {
    challenge: element(), status: element(), lifecycle: element(), summary: element(), open: element(), mobile: element(),
    copy: element(), owner: element({ hidden: true }), "chat-approval": element(), viewer: element({ hidden: true }),
    "desktop-frame": element(), "share-panel": { ...element(), dataset: { appOrigin } },
  };
  const requests = [];
  const checks = [];
  const navigations = [];
  const context = {
    URL, URLSearchParams, Date, Number,
    location: { pathname: "/desktop-share/fixture/share-fixture", search: "?key=sample", origin, replace(value) { navigations.push(String(value)); } },
    document: { getElementById: (id) => nodes[id] },
    navigator: { clipboard: { writeText: async () => undefined } },
    fetch: async (url, options = {}) => {
      requests.push(`${options.method || "GET"} ${String(url).split("?")[0]}`);
      if (String(url).includes("approve-as-owner")) return { ok: approveStatus === 200, status: approveStatus, json: async () => ({ ok: approveStatus === 200 }) };
      if (String(url).includes("owner-session")) {
        checks.push({ url: String(url), credentials: options.credentials, method: options.method || "GET" });
        if (ownerSession === "unreachable") throw new TypeError("Failed to fetch");
        return { ok: ownerSession === 200, status: ownerSession, json: async () => (ownerSession === 200 ? { ok: true, owner: true } : { ok: false, error: "denied" }) };
      }
      if (openFailure) return { ok: false, status: 401, json: async () => openFailure };
      return { ok: true, status: 200, json: async () => ({ ok: true, share: {}, attempt: { challenge: "desk-fixture" } }) };
    },
    setTimeout: () => 0,
  };
  vm.runInNewContext(script, context);
  await new Promise((resolve) => setImmediate(resolve));
  return { nodes, requests, checks, navigations };
}

test("the share page lets the signed-in owner open the desktop without a chat challenge", async () => {
  const signedIn = await ownerFlow({ origin: "https://app.example.test", appOrigin: "https://app.example.test", approveStatus: 200 });
  assert.ok(signedIn.requests.includes("POST /api/desktop-shares/share-fixture/approve-as-owner"));
  assert.equal(signedIn.nodes.owner.hidden, true);
  assert.notEqual(signedIn.nodes["chat-approval"].open, true);
  assert.equal(signedIn.checks.length, 0, "the app host needs no cross-host check");

  const signedOut = await ownerFlow({ origin: "https://app.example.test", appOrigin: "https://app.example.test", approveStatus: 401 });
  assert.equal(signedOut.nodes.owner.hidden, false);
  assert.equal(signedOut.nodes.owner.textContent, "Sign in to open");
  assert.equal(signedOut.nodes.owner.href, "/auth/login?return=" + encodeURIComponent("/desktop-share/fixture/share-fixture?key=sample"));

  const notOwner = await ownerFlow({ origin: "https://app.example.test", appOrigin: "https://app.example.test", approveStatus: 403 });
  assert.equal(notOwner.nodes["chat-approval"].open, true);
  assert.equal(notOwner.nodes.owner.hidden, true);
});

// ORK-793: links point at a host of their own (e.g. connect.<domain>), which
// never receives the app host's session cookie.
test("on the link host a signed-in owner continues to the app host without a click", async () => {
  const signedIn = await ownerFlow({ origin: "https://connect.example.test", appOrigin: "https://app.example.test", ownerSession: 200 });
  assert.deepEqual(signedIn.checks, [{
    url: "https://app.example.test/api/desktop-shares/share-fixture/owner-session?key=sample&subdomain=fixture",
    credentials: "include",
    method: "GET",
  }], "one read-only credentialed check on the app host");
  assert.deepEqual(signedIn.navigations, ["https://app.example.test/desktop-share/fixture/share-fixture?key=sample"]);
  assert.equal(signedIn.nodes.owner.hidden, true, "no button to click");
  assert.ok(!signedIn.requests.some((request) => request.includes("approve-as-owner")), "the link host approves nothing");
  assert.ok(!signedIn.requests.some((request) => request.includes("/status")), "no polling once the page moves on");
});

test("on the link host anyone without a verified owner session keeps the button", async () => {
  for (const ownerSession of [401, 403, 500, "unreachable"]) {
    const visitor = await ownerFlow({ origin: "https://connect.example.test", appOrigin: "https://app.example.test", ownerSession });
    assert.equal(visitor.checks.length, 1, String(ownerSession));
    assert.deepEqual(visitor.navigations, [], `${ownerSession}: no automatic navigation`);
    assert.equal(visitor.nodes.owner.hidden, false, `${ownerSession}: the button stays`);
    assert.equal(visitor.nodes.owner.href, "https://app.example.test/desktop-share/fixture/share-fixture?key=sample");
    assert.ok(!visitor.requests.some((request) => request.includes("approve-as-owner")), "no approval from the link host");
  }
});

test("revoked or expired links never check the owner session or open", async () => {
  const revoked = { ok: false, error: "desktop_share_revoked", lifecycle: { status: "revoked" } };
  const expired = { ok: false, error: "desktop_share_expired", renewal: { renewCommand: "orkestr desktop share fixture", message: "This desktop link expired." } };
  for (const [name, openFailure] of [["revoked", revoked], ["expired", expired]]) {
    for (const origin of ["https://connect.example.test", "https://app.example.test"]) {
      const flow = await ownerFlow({ origin, appOrigin: "https://app.example.test", ownerSession: 200, approveStatus: 200, openFailure });
      assert.equal(flow.checks.length, 0, `${name} on ${origin}: no owner-session check`);
      assert.deepEqual(flow.navigations, [], `${name} on ${origin}: no navigation`);
      assert.ok(!flow.requests.some((request) => request.includes("approve-as-owner")), `${name} on ${origin}: no approval`);
      assert.equal(flow.nodes.owner.hidden, true, `${name} on ${origin}: no open button`);
      assert.match(flow.nodes.summary.textContent, new RegExp(name), `${name} on ${origin}: the page says so`);
    }
  }
});
