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

test("expired desktop-share shell replaces an established noVNC iframe with the renewal state", async () => {
  const source = await fs.readFile("apps/server/src/static-fallback.ts", "utf8");
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
