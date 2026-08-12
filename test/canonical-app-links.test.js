import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalAppLinksEnabled,
  canonicalThreadAppUrl,
  canonicalThreadLinkData,
} from "../packages/core/src/canonical-app-links.js";
import { threadRuntimeSummary } from "../dist/server/apps/server/src/thread-summary.js";

const instanceRef = "ins_AQEBAQEBAQEBAQEBAQEBAQ";
const threadRef = "thr_AgICAgICAgICAgICAgICAg";
const enabledEnv = {
  ORKESTR_CANONICAL_INSTANCE_URLS: "1",
  ORKESTR_CANONICAL_APP_GATEWAY: "1",
  ORKESTR_CANONICAL_APP_LINKS: "1",
  ORKESTR_APP_HOST: "app.example.test",
};

test("canonical app links are explicitly gated and preserve legacy output when disabled", () => {
  assert.equal(canonicalAppLinksEnabled({}), false);
  assert.equal(canonicalAppLinksEnabled({ ...enabledEnv, ORKESTR_CANONICAL_APP_LINKS: "0" }), false);
  assert.equal(canonicalThreadAppUrl({ instancePublicRef: instanceRef, threadPublicRef: threadRef }, {
    ...enabledEnv,
    ORKESTR_CANONICAL_APP_LINKS: "0",
  }), "");
});

test("canonical links use only immutable refs and preserve route query and fragment", () => {
  const result = canonicalThreadAppUrl({
    instancePublicRef: instanceRef,
    threadPublicRef: threadRef,
    sourceUrl: "/thread/hostile%20name/settings?tab=people%2Fall#owner",
  }, enabledEnv);
  assert.equal(
    result,
    `https://app.example.test/instance/${instanceRef}/thread/${threadRef}/settings?tab=people%2Fall#owner`,
  );
  assert.doesNotMatch(result, /hostile|name|internal|uuid/i);
});

test("thread link data is stable across rename and never leaks internal identity", async () => {
  const identity = { internalInstanceId: "private-instance-uuid", publicRef: instanceRef };
  const before = await canonicalThreadLinkData({
    id: "private-thread-uuid",
    name: "../../hostile thread name?secret=1",
    publicRef: threadRef,
  }, enabledEnv, { instanceIdentity: identity });
  const after = await canonicalThreadLinkData({
    id: "private-thread-uuid",
    name: "Renamed thread",
    publicRef: threadRef,
  }, enabledEnv, { instanceIdentity: identity });
  assert.deepEqual(after, before);
  assert.equal(before.canonicalPath, `/instance/${instanceRef}/thread/${threadRef}`);
  assert.doesNotMatch(before.canonicalUrl, /private|hostile|secret|renamed/i);
});

test("thread summaries emit canonical fields from the supplied env and omit them when disabled", async () => {
  const thread = {
    id: "private-thread-id",
    name: "Hostile thread name",
    publicRef: threadRef,
    state: "sleeping",
  };
  const options = {
    sampleRuntime: false,
    refreshMetadata: false,
    instanceIdentity: { internalInstanceId: "private-instance-id", publicRef: instanceRef },
  };
  const enabled = await threadRuntimeSummary(thread, [], { ...options, env: enabledEnv });
  const disabled = await threadRuntimeSummary(thread, [], {
    ...options,
    env: { ...enabledEnv, ORKESTR_CANONICAL_APP_LINKS: "0" },
  });

  assert.equal(enabled.canonicalUrl, `https://app.example.test/instance/${instanceRef}/thread/${threadRef}`);
  assert.equal(enabled.canonicalPath, `/instance/${instanceRef}/thread/${threadRef}`);
  assert.equal(Object.hasOwn(disabled, "canonicalUrl"), false);
  assert.equal(Object.hasOwn(disabled, "canonicalPath"), false);
});
