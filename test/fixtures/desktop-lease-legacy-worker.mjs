import { desktopLeaseStore } from "../../packages/browsers/src/desktop-lease-store.js";

try {
  const store = desktopLeaseStore(process.env);
  await store.init();
  const result = await store.acquire({ desktopSlug: "new-process-desk", ownerUserId: "synthetic-owner",
    threadId: "new-process-thread", expiresAt: new Date(Date.now() + 60_000).toISOString() });
  process.stdout.write(`${JSON.stringify({ version: result.lease.fencingVersion,
    retired: (await store.readAll({ includeReleased: true })).filter((row) => row.releasedAt).length })}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
