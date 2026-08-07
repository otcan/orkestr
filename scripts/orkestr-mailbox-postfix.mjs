#!/usr/bin/env node
import fs from "node:fs/promises";
import net from "node:net";
import process from "node:process";
import {
  decodeSocketMapFrames,
  encodeSocketMapFrame,
  ingestPostfixMailboxMessage,
  postfixSocketMapLookup,
} from "../packages/connectors/src/postfix-mailbox-adapter.js";

function flagValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? String(argv[index + 1] || "") : "";
}

function positiveInteger(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(maximum, Math.floor(parsed));
}

async function readStdin(maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("mailbox_message_too_large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function ingest(argv) {
  const maxBytes = positiveInteger(
    process.env.ORKESTR_MAILBOX_POSTFIX_MAX_BYTES || process.env.ORKESTR_MAILBOX_MAX_MESSAGE_BYTES,
    25 * 1024 * 1024,
    100 * 1024 * 1024,
  );
  const result = await ingestPostfixMailboxMessage({
    rawMime: await readStdin(maxBytes),
    recipient: flagValue(argv, "--recipient"),
    originalRecipient: flagValue(argv, "--original-recipient"),
    sender: flagValue(argv, "--sender"),
  });
  process.stdout.write(`${JSON.stringify({
    ok: result.ok === true,
    action: result.action || "",
    mailboxId: result.mailbox?.id || "",
    idempotencyKey: result.idempotencyKey || "",
  })}\n`);
}

async function serve() {
  const socketPath = String(process.env.ORKESTR_MAILBOX_SOCKET || "/run/orkestr-mailbox/recipient.sock").trim();
  const socketHost = String(process.env.ORKESTR_MAILBOX_SOCKET_HOST || "127.0.0.1").trim();
  const socketPort = positiveInteger(process.env.ORKESTR_MAILBOX_SOCKET_PORT, 0, 65_535);
  if (!socketPort) {
    await fs.mkdir(new URL(".", `file://${socketPath}`).pathname, { recursive: true });
    await fs.rm(socketPath, { force: true });
  }

  const server = net.createServer((connection) => {
    let pending = Buffer.alloc(0);
    connection.on("data", async (chunk) => {
      connection.pause();
      try {
        pending = Buffer.concat([pending, chunk]);
        const decoded = decodeSocketMapFrames(pending);
        pending = decoded.remainder;
        for (const frame of decoded.frames) {
          let response;
          try {
            response = await postfixSocketMapLookup(frame);
          } catch {
            response = "TEMP mailbox_lookup_failed";
          }
          connection.write(encodeSocketMapFrame(response));
        }
      } catch {
        connection.write(encodeSocketMapFrame("PERM invalid_request"));
        connection.end();
      } finally {
        connection.resume();
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    if (socketPort) server.listen(socketPort, socketHost, resolve);
    else server.listen(socketPath, resolve);
  });
  if (!socketPort) {
    await fs.chmod(socketPath, 0o660);
    const gid = Number(process.env.ORKESTR_MAILBOX_SOCKET_GID || "");
    if (Number.isInteger(gid) && gid >= 0 && typeof process.getuid === "function") {
      await fs.chown(socketPath, process.getuid(), gid);
    }
  }
  process.stdout.write(`Orkestr mailbox socket map ready: ${socketPort ? `${socketHost}:${socketPort}` : socketPath}\n`);

  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

async function probe() {
  const socketPath = String(process.env.ORKESTR_MAILBOX_SOCKET || "/run/orkestr-mailbox/recipient.sock").trim();
  const socketHost = String(process.env.ORKESTR_MAILBOX_SOCKET_HOST || "127.0.0.1").trim();
  const socketPort = positiveInteger(process.env.ORKESTR_MAILBOX_SOCKET_PORT, 0, 65_535);
  const response = await new Promise((resolve, reject) => {
    const connection = socketPort ? net.createConnection(socketPort, socketHost) : net.createConnection(socketPath);
    const timer = setTimeout(() => connection.destroy(new Error("mailbox_socketmap_probe_timeout")), 3_000);
    let pending = Buffer.alloc(0);
    connection.once("connect", () => connection.write(encodeSocketMapFrame("mailboxes probe-missing@invalid.example")));
    connection.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      const decoded = decodeSocketMapFrames(pending);
      if (!decoded.frames.length) return;
      clearTimeout(timer);
      connection.end();
      resolve(decoded.frames[0]);
    });
    connection.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  if (response !== "NOTFOUND") throw new Error(`mailbox_socketmap_probe_failed:${response}`);
  process.stdout.write("Orkestr mailbox socket map probe passed.\n");
}

const command = process.argv[2] || "serve";
try {
  if (command === "serve") await serve();
  else if (command === "ingest") await ingest(process.argv.slice(3));
  else if (command === "probe") await probe();
  else throw new Error("Usage: orkestr-mailbox-postfix.mjs [serve|ingest|probe]");
} catch (error) {
  process.stderr.write(`${String(error?.message || error)}\n`);
  const status = Number(error?.statusCode || 0);
  process.exitCode = status >= 400 && status < 500 ? 67 : 75;
}
