import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

function urlParts(value) {
  const parsed = new URL(value);
  return {
    shareId: parsed.pathname.split("/").filter(Boolean).at(-1),
    key: parsed.searchParams.get("key"),
  };
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail("timed out waiting for desktop share socket state");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("superseding and revoking shares fence established noVNC sockets while the latest share stays live", async () => {
  const previousHome = process.env.ORKESTR_HOME;
  const previousPublicUrl = process.env.ORKESTR_PUBLIC_HTTPS_URL;
  process.env.ORKESTR_HOME = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-desktop-proxy-lifecycle-"));
  process.env.ORKESTR_PUBLIC_HTTPS_URL = "https://app.example.test";
  try {
    const { createDesktopShare, openDesktopShare, approveDesktopShareChallenge, revokeDesktopShare } = await import("../dist/server/packages/core/src/desktop-shares.js");
    const { registerDesktopShareSocket } = await import("../dist/server/apps/server/src/desktop-proxy.js");
    const principal = { kind: "user", userId: "alice", role: "user", source: "test" };
    const first = await createDesktopShare({ desktopSlug: "linkedin", principal });
    const firstParts = urlParts(first.url);
    const opened = await openDesktopShare({ shareId: firstParts.shareId, key: firstParts.key, subdomain: first.subdomain });
    const approved = await approveDesktopShareChallenge(opened.attempt.challenge, { approvedBy: "test" });
    const socket = new PassThrough();
    const upstream = new PassThrough();
    registerDesktopShareSocket(socket, upstream, approved.share, approved.attempt);

    const second = await createDesktopShare({ desktopSlug: "linkedin", principal });
    await waitFor(() => socket.destroyed && upstream.destroyed);

    assert.equal(socket.destroyed, true);
    assert.equal(upstream.destroyed, true);

    const secondParts = urlParts(second.url);
    const secondOpened = await openDesktopShare({ shareId: secondParts.shareId, key: secondParts.key, subdomain: second.subdomain });
    const secondApproved = await approveDesktopShareChallenge(secondOpened.attempt.challenge, { approvedBy: "test" });
    const latestSocket = new PassThrough();
    const latestUpstream = new PassThrough();
    registerDesktopShareSocket(latestSocket, latestUpstream, secondApproved.share, secondApproved.attempt);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(latestSocket.destroyed, false);
    assert.equal(latestUpstream.destroyed, false);

    await revokeDesktopShare(secondApproved.share.id, { reason: "test_revoked" });
    await waitFor(() => latestSocket.destroyed && latestUpstream.destroyed);
  } finally {
    if (previousHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = previousHome;
    if (previousPublicUrl === undefined) delete process.env.ORKESTR_PUBLIC_HTTPS_URL;
    else process.env.ORKESTR_PUBLIC_HTTPS_URL = previousPublicUrl;
  }
});
