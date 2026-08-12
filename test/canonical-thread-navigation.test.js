import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalThreadPanelUrl,
  navigateCanonicalThreadTarget,
} from "../apps/web/src/app/canonical-thread-navigation.js";
import { buildThreadLinkIndex, resolveThreadLink } from "../apps/web/src/app/thread-link-index.js";

const canonical = "https://app.example.test/instance/ins_AQEBAQEBAQEBAQEBAQEBAQ/thread/thr_AgICAgICAgICAgICAgICAg";

function navigationSpies() {
  const calls = [];
  return {
    calls,
    history: {
      pushState: (_state, _title, url) => calls.push(["push", url]),
      replaceState: (_state, _title, url) => calls.push(["replaceState", url]),
    },
    location: {
      assign: (url) => calls.push(["assign", url]),
      replace: (url) => calls.push(["replace", url]),
    },
  };
}

test("ordinary thread click crosses from a connect host with location.assign", () => {
  const spies = navigationSpies();
  const result = navigateCanonicalThreadTarget(canonical, {
    currentUrl: "https://connect.example.test/thread/legacy-name",
    mode: "push",
    ...spies,
  });
  assert.equal(result.crossOrigin, true);
  assert.deepEqual(spies.calls, [["assign", canonical]]);
});

test("panel navigation uses history on the app origin and assign across origins", () => {
  const panel = canonicalThreadPanelUrl(canonical, "settings", "https://app.example.test/thread/legacy", false);
  const sameOrigin = navigationSpies();
  const sameResult = navigateCanonicalThreadTarget(panel, {
    currentUrl: "https://app.example.test/instance/ins_AQEBAQEBAQEBAQEBAQEBAQ/thread/thr_AgICAgICAgICAgICAgICAg",
    mode: "push",
    ...sameOrigin,
  });
  assert.equal(sameResult.crossOrigin, false);
  assert.deepEqual(sameOrigin.calls, [["push", "/instance/ins_AQEBAQEBAQEBAQEBAQEBAQ/thread/thr_AgICAgICAgICAgICAgICAg/settings"]]);

  const crossOrigin = navigationSpies();
  navigateCanonicalThreadTarget(panel, {
    currentUrl: "http://localhost:18892/thread/legacy",
    mode: "push",
    ...crossOrigin,
  });
  assert.deepEqual(crossOrigin.calls, [["assign", `${canonical}/settings`]]);
});

test("initial route conversion crosses origins with replace and preserves query and fragment", () => {
  const source = "https://connect.example.test/thread/legacy/history?before=a%2Fb#cursor";
  const target = canonicalThreadPanelUrl(canonical, "history", source, true);
  const spies = navigationSpies();
  const result = navigateCanonicalThreadTarget(target, {
    currentUrl: source,
    mode: "replace",
    ...spies,
  });
  assert.equal(result.crossOrigin, true);
  assert.deepEqual(spies.calls, [["replace", `${canonical}/history?before=a%2Fb#cursor`]]);
});

test("Gmail thread link aliases resolve only when unique and exact identifiers win", () => {
  const one = `${canonical}-one`;
  const two = `${canonical}-two`;
  const index = buildThreadLinkIndex([
    { id: "thread-one", publicRef: "thr_one", name: "duplicate", title: "Shared title", canonicalUrl: one },
    { id: "duplicate", publicRef: "thr_two", name: "thread-one", title: "Shared title", canonicalUrl: two },
  ]);

  assert.equal(resolveThreadLink(index, "thread-one"), one);
  assert.equal(resolveThreadLink(index, "duplicate"), two);
  assert.equal(resolveThreadLink(index, "thr_one"), one);
  assert.equal(resolveThreadLink(index, "Shared title"), "");
  assert.equal(index.aliases.has("Shared title"), false);
});
