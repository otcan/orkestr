import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import * as age from "age-encryption";
import { createInboundAttachmentPayloadStream } from "../packages/core/src/browser-inbound-attachment-payload.js";

const execFile = promisify(execFileCallback);
const token = "worker-sandbox-test-token-abcdefghijklmnopqrstuvwxyz-0123456789";

function runNodeAs(source, { uid, gid, env = {} } = {}) {
  return execFile(process.execPath, ["--input-type=module", "-e", source], {
    uid,
    gid,
    env: { ...process.env, ...env },
    timeout: 15_000,
  });
}

async function ownedDirectory(directory, { uid, gid, mode }) {
  await fs.mkdir(directory, { recursive: true, mode });
  await fs.chown(directory, uid, gid);
  await fs.chmod(directory, mode);
}

function ownerBucket(ownerUserId) {
  return createHash("sha256").update(ownerUserId).digest("hex").slice(0, 24);
}

function singleChunkStream(value) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from(value));
      controller.close();
    },
  });
}

async function encryptedWorkerPayload({ recipient, sessionId, keyId, keyVersion, content }) {
  const descriptor = {
    version: 1,
    sessionId,
    keyId,
    keyVersion,
    recipient,
    purpose: "inbound_attachment_upload",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    maxPlaintextBytes: 1024,
    signature: "test-only-descriptor-signature",
  };
  const encrypter = new age.Encrypter();
  encrypter.addRecipient(recipient);
  const encrypted = await encrypter.encrypt(createInboundAttachmentPayloadStream({
    name: "sandbox.txt",
    type: "text/plain",
    size: Buffer.byteLength(content),
    stream: () => singleChunkStream(content),
  }, { descriptor }));
  return Buffer.from(await new Response(encrypted).arrayBuffer());
}

test("non-root worker scan enforces its production bubblewrap mounts", async (t) => {
  if (process.platform !== "linux") return t.skip("requires Linux user namespaces");
  const bwrap = "/usr/bin/bwrap";
  const busybox = "/bin/busybox";
  if (!await fs.stat(bwrap).then((stat) => stat.isFile(), () => false)) return t.skip("bubblewrap is not installed");
  if (!await fs.stat(busybox).then((stat) => stat.isFile(), () => false)) return t.skip("a static scanner fixture is unavailable");

  const rootFixture = process.getuid?.() === 0;
  const workerUid = rootFixture ? 65_534 : process.getuid();
  const apiUid = rootFixture ? 1 : workerUid;
  const transferGid = rootFixture ? 65_534 : process.getgid();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-inbound-worker-e2e-"));
  const scannerRoot = path.join(home, "scanner-root");
  const ciphertextRoot = path.join(home, "ciphertext");
  const handoffRoot = path.join(home, "handoff");
  const scratchRoot = path.join(home, "scratch");
  const signingKey = path.join(home, "worker-private.pem");
  const keyRegistry = path.join(home, "keys.json");
  const hostMarker = path.join(home, "host-marker");
  await fs.chmod(home, 0o755);
  await ownedDirectory(ciphertextRoot, { uid: workerUid, gid: transferGid, mode: 0o2770 });
  await ownedDirectory(handoffRoot, { uid: workerUid, gid: transferGid, mode: 0o2770 });
  await ownedDirectory(scratchRoot, { uid: workerUid, gid: transferGid, mode: 0o700 });
  await fs.mkdir(scannerRoot, { mode: 0o755 });
  await fs.copyFile(busybox, path.join(scannerRoot, "busybox"));
  await fs.chmod(path.join(scannerRoot, "busybox"), 0o755);
  await fs.writeFile(path.join(scannerRoot, "verify-sandbox"), `#!/scanner/busybox sh
if [ "$1" = "--probe" ]; then
  [ -z "\${WORKER_E2E_SECRET-}" ]
  exit 0
fi
[ "$1" = "/input/payload" ] || exit 41
[ "$(/scanner/busybox cat "$1")" = "sandbox-e2e-content" ] || exit 42
[ -z "\${WORKER_E2E_SECRET-}" ] || exit 43
[ ! -e "$2" ] || exit 44
[ ! -e "$3" ] || exit 45
printf x > /tmp/scanner-write || exit 46
[ "$(/scanner/busybox cat /tmp/scanner-write)" = "x" ] || exit 47
if (printf x >> "$1") 2>/dev/null; then exit 48; fi
if (printf x >> /scanner/verify-sandbox) 2>/dev/null; then exit 49; fi
if /scanner/busybox nc -w 1 127.0.0.1 "$4"; then exit 50; fi
`, { mode: 0o755 });
  await fs.chmod(path.join(scannerRoot, "verify-sandbox"), 0o755);

  try {
    await execFile(bwrap, [
      "--die-with-parent", "--new-session", "--unshare-all", "--clearenv",
      "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
      "--ro-bind", scannerRoot, "/scanner", "--chdir", "/tmp", "--",
      "/scanner/busybox", "true",
    ], { ...(rootFixture ? { uid: workerUid, gid: transferGid } : {}), env: {} });
  } catch (error) {
    const detail = String(error?.stderr || error?.message || "");
    if (/Creating new namespace failed: Operation not permitted|unshare(?:\([^)]*\))?: Operation not permitted/i.test(detail)) {
      return t.skip("kernel namespace policy does not permit the non-root production worker sandbox");
    }
    throw error;
  }

  const { privateKey } = generateKeyPairSync("ed25519");
  await fs.writeFile(signingKey, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  await fs.chown(signingKey, workerUid, transferGid);
  await fs.writeFile(hostMarker, "host-only-marker", { mode: 0o600 });
  const ownerUserId = "sandbox-owner";
  const sessionId = "inbound-sandbox-e2e-123456";
  const keyId = "inbound-key-sandbox-e2e-123456";
  const processingToken = "sandbox-processing-token-123456";
  const identity = await age.generateIdentity();
  const recipient = await age.identityToRecipient(identity);
  await fs.writeFile(keyRegistry, `${JSON.stringify({
    version: 1,
    revision: 1,
    keys: [{ id: keyId, ownerUserId, version: 1, identity, recipient, status: "active", createdAt: new Date().toISOString(), retiredAt: "", revokedAt: "" }],
  })}\n`, { mode: 0o600 });
  await fs.chown(keyRegistry, workerUid, transferGid);
  const content = "sandbox-e2e-content";
  const ciphertext = await encryptedWorkerPayload({ recipient, sessionId, keyId, keyVersion: 1, content });
  const ciphertextOwner = path.join(ciphertextRoot, ownerBucket(ownerUserId));
  await ownedDirectory(ciphertextOwner, { uid: apiUid, gid: transferGid, mode: 0o770 });
  const ciphertextPath = path.join(ciphertextOwner, `${sessionId}.age`);
  await fs.writeFile(ciphertextPath, ciphertext, { mode: 0o640 });
  await fs.chown(ciphertextPath, apiUid, transferGid);
  const networkProbe = net.createServer((socket) => socket.end());
  await new Promise((resolve, reject) => {
    networkProbe.once("error", reject);
    networkProbe.listen(0, "127.0.0.1", () => {
      networkProbe.off("error", reject);
      resolve();
    });
  });
  t.after(() => new Promise((resolve) => networkProbe.close(resolve)));
  const networkPort = networkProbe.address().port;
  await execFile(busybox, ["nc", "-w", "1", "127.0.0.1", String(networkPort)]);
  const configEnv = {
    ORKESTR_INBOUND_UPLOAD_WORKER_SOCKET: path.join(home, "worker.sock"),
    ORKESTR_INBOUND_UPLOAD_WORKER_TOKEN: token,
    ORKESTR_INBOUND_UPLOAD_WORKER_KEY_REGISTRY: keyRegistry,
    ORKESTR_INBOUND_UPLOAD_WORKER_SIGNING_KEY_FILE: signingKey,
    ORKESTR_INBOUND_UPLOAD_WORKER_CIPHERTEXT_ROOT: ciphertextRoot,
    ORKESTR_INBOUND_UPLOAD_WORKER_HANDOFF_ROOT: handoffRoot,
    ORKESTR_INBOUND_UPLOAD_WORKER_SCRATCH_ROOT: scratchRoot,
    ORKESTR_INBOUND_UPLOAD_WORKER_SCANNER_ROOT: scannerRoot,
    ORKESTR_INBOUND_UPLOAD_WORKER_SCANNER_COMMAND: "/scanner/verify-sandbox",
    ORKESTR_INBOUND_UPLOAD_WORKER_SCANNER_ARGS: JSON.stringify(["{file}", signingKey, hostMarker, String(networkPort)]),
    ORKESTR_INBOUND_UPLOAD_WORKER_SCANNER_PROBE_ARGS: JSON.stringify(["--probe"]),
    ORKESTR_INBOUND_UPLOAD_WORKER_BWRAP: bwrap,
    ORKESTR_INBOUND_UPLOAD_WORKER_UID: String(workerUid),
    ORKESTR_INBOUND_UPLOAD_WORKER_TRANSFER_GID: String(transferGid),
    ORKESTR_INBOUND_UPLOAD_SCANNER_APPROVED: "1",
  };
  const scanPayload = {
    sessionId,
    ownerUserId,
    threadId: "sandbox-thread",
    keyId,
    keyVersion: 1,
    processingToken,
    ciphertextChecksum: createHash("sha256").update(ciphertext).digest("hex"),
    ciphertextSize: ciphertext.byteLength,
    plaintextSize: Buffer.byteLength(content),
    maxPlaintextBytes: 1024,
  };
  const runtimeUrl = new URL("../packages/core/src/inbound-attachment-worker-runtime.js", import.meta.url).href;
  const scanSource = `
    import fs from "node:fs/promises";
    import path from "node:path";
    import { createHash } from "node:crypto";
    import { inboundAttachmentWorkerRuntimeConfig, runInboundAttachmentWorkerScan } from ${JSON.stringify(runtimeUrl)};
    const bucket = (owner) => createHash("sha256").update(owner).digest("hex").slice(0, 24);
    if (process.getuid?.() === 0) {
      process.setgroups?.([Number(process.env.WORKER_GID)]);
      process.setgid(Number(process.env.WORKER_GID));
      process.setuid(Number(process.env.WORKER_UID));
    }
    if (process.getuid?.() !== Number(process.env.WORKER_UID)) throw new Error("non_root_worker_fixture_unavailable");
    const config = inboundAttachmentWorkerRuntimeConfig(JSON.parse(process.env.WORKER_CONFIG));
    if (config.testMode) throw new Error("production_scan_must_not_use_test_mode");
    const payload = JSON.parse(process.env.SCAN_PAYLOAD);
    const verdict = await runInboundAttachmentWorkerScan(payload, config);
    if (verdict?.verdict !== "clean") throw new Error("unexpected_scan_verdict:" + JSON.stringify(verdict));
    const handoff = path.join(config.handoffRoot, bucket(payload.ownerUserId), payload.sessionId + "-" + payload.processingToken);
    if (await fs.readFile(handoff, "utf8") !== "sandbox-e2e-content") throw new Error("sandbox_handoff_content_invalid");
    process.stdout.write(JSON.stringify({ verdict: verdict.verdict, handoff }) + "\\n");
  `;
  const scan = await runNodeAs(scanSource, {
    env: {
      WORKER_CONFIG: JSON.stringify(configEnv),
      WORKER_UID: String(workerUid),
      WORKER_GID: String(transferGid),
      SCAN_PAYLOAD: JSON.stringify(scanPayload),
      WORKER_E2E_SECRET: "must-not-reach-scanner",
      ORKESTR_INBOUND_UPLOAD_WORKER_TEST_MODE: "",
    },
  });
  const result = JSON.parse(scan.stdout);
  assert.equal(result.verdict, "clean");
  assert.equal(await fs.readFile(result.handoff, "utf8"), content);
  assert.equal(await fs.readFile(hostMarker, "utf8"), "host-only-marker");
  assert.match(await fs.readFile(signingKey, "utf8"), /BEGIN PRIVATE KEY/);
});
