import crypto from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import { once } from "node:events";

function clean(value = "") {
  return String(value || "").trim();
}

function boolEnv(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return value === true || value === "true" || value === "1" || value === 1;
}

function envValue(env = process.env, names = []) {
  for (const name of names) {
    const value = clean(env[name]);
    if (value) return value;
  }
  return "";
}

function envBoolValue(env = process.env, names = [], fallback = false) {
  for (const name of names) {
    if (env[name] !== undefined && env[name] !== null && env[name] !== "") return boolEnv(env[name], fallback);
  }
  return fallback;
}

function splitEmailList(value = "") {
  return String(value || "")
    .split(/[,\s]+/)
    .map((item) => clean(item))
    .filter(Boolean);
}

function smtpEmailConfig(env = process.env) {
  const secure = envBoolValue(env, ["ORKESTR_SMTP_SECURE", "ORKESTR_OUTLOOK_SMTP_SECURE", "OUTLOOK_SMTP_SECURE"], false);
  const user = envValue(env, ["ORKESTR_SMTP_USER", "ORKESTR_OUTLOOK_SMTP_USER", "OUTLOOK_SMTP_USER"]);
  const from = envValue(env, ["ORKESTR_SMTP_FROM", "ORKESTR_OUTLOOK_SMTP_FROM", "OUTLOOK_SMTP_FROM", "ORKESTR_MAIL_FROM"]) || user;
  const outlookConfigured = Boolean(
    envValue(env, [
      "ORKESTR_OUTLOOK_SMTP_HOST",
      "OUTLOOK_SMTP_HOST",
      "ORKESTR_OUTLOOK_SMTP_USER",
      "OUTLOOK_SMTP_USER",
      "ORKESTR_OUTLOOK_SMTP_FROM",
      "OUTLOOK_SMTP_FROM",
    ]),
  );
  const host = envValue(env, ["ORKESTR_SMTP_HOST", "ORKESTR_OUTLOOK_SMTP_HOST", "OUTLOOK_SMTP_HOST"]) || (outlookConfigured ? "smtp.office365.com" : "");
  const configuredPort = envValue(env, ["ORKESTR_SMTP_PORT", "ORKESTR_OUTLOOK_SMTP_PORT", "OUTLOOK_SMTP_PORT"]);
  const port = Number(configuredPort || (secure ? 465 : 587));
  return {
    host,
    port: Number.isFinite(port) && port > 0 ? port : secure ? 465 : 587,
    user,
    pass: envValue(env, [
      "ORKESTR_SMTP_PASS",
      "ORKESTR_OUTLOOK_SMTP_PASS",
      "ORKESTR_OUTLOOK_SMTP_PASSWORD",
      "OUTLOOK_SMTP_PASS",
      "OUTLOOK_SMTP_PASSWORD",
    ]),
    from,
    secure,
    startTls: envBoolValue(env, ["ORKESTR_SMTP_STARTTLS", "ORKESTR_OUTLOOK_SMTP_STARTTLS", "OUTLOOK_SMTP_STARTTLS"], !secure),
    rejectUnauthorized: !envBoolValue(env, ["ORKESTR_SMTP_ALLOW_INVALID_TLS", "ORKESTR_OUTLOOK_SMTP_ALLOW_INVALID_TLS", "OUTLOOK_SMTP_ALLOW_INVALID_TLS"], false),
    timeoutMs: Math.max(2_000, Math.min(60_000, Number(env.ORKESTR_SMTP_TIMEOUT_MS) || 10_000)),
    helloName: clean(env.ORKESTR_SMTP_HELO || "orkestr.local"),
  };
}

function waitlistAdminUrl(env = process.env) {
  const explicit = clean(env.ORKESTR_ADMIN_WAITLIST_URL);
  if (explicit) return explicit;
  const base = clean(env.ORKESTR_PUBLIC_APP_URL || env.ORKESTR_PUBLIC_URL || env.ORKESTR_PUBLIC_HTTPS_URL || env.ORKESTR_PUBLIC_SITE_URL);
  if (!base) return "/ops/waitlist";
  try {
    return new URL("/ops/waitlist", base).toString();
  } catch {
    return `${base.replace(/\/+$/, "")}/ops/waitlist`;
  }
}

function escapeHeader(value = "") {
  return clean(value).replace(/[\r\n]+/g, " ").slice(0, 500);
}

function envelopeAddress(value = "") {
  const text = escapeHeader(value);
  const match = text.match(/<([^>]+)>/);
  return clean(match ? match[1] : text);
}

function dotStuff(message = "") {
  const normalized = String(message || "").replace(/\r?\n/g, "\r\n");
  return normalized.replace(/(^|\r\n)\./g, "$1..");
}

function buildPlainTextMessage({ from = "", to = [], subject = "", text = "" } = {}) {
  const recipients = Array.isArray(to) ? to : splitEmailList(to);
  const domain = envelopeAddress(from).split("@")[1] || "orkestr.local";
  const messageId = `${Date.now().toString(36)}.${crypto.randomUUID()}@${domain}`;
  const headers = [
    `From: ${escapeHeader(from)}`,
    `To: ${recipients.map(escapeHeader).join(", ")}`,
    `Subject: ${escapeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${messageId}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
  ];
  return { message: `${headers.join("\r\n")}\r\n\r\n${dotStuff(text)}`, messageId };
}

function createSmtpReader(socket) {
  let buffer = "";
  const lines = [];
  const waiters = [];
  let failed = null;

  function flush() {
    while (lines.length && waiters.length) {
      const waiter = waiters.shift();
      waiter.resolve(lines.shift());
    }
    if (failed) {
      while (waiters.length) {
        const waiter = waiters.shift();
        waiter.reject(failed);
      }
    }
  }

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      lines.push(line);
      index = buffer.indexOf("\n");
    }
    flush();
  });
  socket.on("error", (error) => {
    failed = error;
    flush();
  });
  socket.on("timeout", () => {
    failed = new Error("smtp_timeout");
    socket.destroy(failed);
    flush();
  });

  return {
    readLine() {
      if (lines.length) return Promise.resolve(lines.shift());
      if (failed) return Promise.reject(failed);
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
  };
}

async function readSmtpResponse(reader) {
  const lines = [];
  for (;;) {
    const line = await reader.readLine();
    const match = String(line || "").match(/^(\d{3})([ -])(.*)$/);
    if (!match) continue;
    lines.push(line);
    if (match[2] === " ") {
      return {
        code: Number(match[1]),
        message: lines.join("\n"),
      };
    }
  }
}

async function smtpCommand(socket, reader, command, expectedCodes = []) {
  if (command) socket.write(`${command}\r\n`);
  const response = await readSmtpResponse(reader);
  if (expectedCodes.length && !expectedCodes.includes(response.code)) {
    const error = new Error(`smtp_${response.code}`);
    error.smtpResponse = response.message.slice(0, 500);
    throw error;
  }
  return response;
}

async function connectSocket(config) {
  const options = {
    host: config.host,
    port: config.port,
    servername: config.host,
    rejectUnauthorized: config.rejectUnauthorized,
  };
  const socket = config.secure ? tls.connect(options) : net.connect(options);
  socket.setTimeout(config.timeoutMs);
  await once(socket, config.secure ? "secureConnect" : "connect");
  return socket;
}

async function sendSmtpMessage({ from = "", to = [], subject = "", text = "" } = {}, config = {}) {
  const recipients = Array.isArray(to) ? to : splitEmailList(to);
  let socket = await connectSocket(config);
  let reader = createSmtpReader(socket);
  const envelopeFrom = envelopeAddress(from);
  const { message, messageId } = buildPlainTextMessage({ from, to: recipients, subject, text });
  try {
    await smtpCommand(socket, reader, "", [220]);
    let ehlo = await smtpCommand(socket, reader, `EHLO ${config.helloName}`, [250]);
    if (!config.secure && config.startTls && /STARTTLS/i.test(ehlo.message)) {
      await smtpCommand(socket, reader, "STARTTLS", [220]);
      socket = tls.connect({
        socket,
        servername: config.host,
        rejectUnauthorized: config.rejectUnauthorized,
      });
      socket.setTimeout(config.timeoutMs);
      await once(socket, "secureConnect");
      reader = createSmtpReader(socket);
      ehlo = await smtpCommand(socket, reader, `EHLO ${config.helloName}`, [250]);
    }
    if (config.user && config.pass) {
      const auth = Buffer.from(`\u0000${config.user}\u0000${config.pass}`, "utf8").toString("base64");
      await smtpCommand(socket, reader, `AUTH PLAIN ${auth}`, [235, 503]);
    }
    await smtpCommand(socket, reader, `MAIL FROM:<${envelopeFrom}>`, [250]);
    for (const recipient of recipients) {
      await smtpCommand(socket, reader, `RCPT TO:<${envelopeAddress(recipient)}>`, [250, 251]);
    }
    await smtpCommand(socket, reader, "DATA", [354]);
    socket.write(`${message}\r\n.\r\n`);
    await smtpCommand(socket, reader, "", [250]);
    await smtpCommand(socket, reader, "QUIT", [221]).catch(() => {});
    return { ok: true, messageId };
  } finally {
    socket.end();
  }
}

export async function sendEmail(message = {}, env = process.env) {
  const config = smtpEmailConfig(env);
  const recipients = Array.isArray(message.to) ? message.to : splitEmailList(message.to);
  const from = clean(message.from || config.from);
  if (!recipients.length) return { ok: false, configured: false, skippedReason: "email_recipient_missing" };
  if (!config.host || !from) return { ok: false, configured: false, skippedReason: "smtp_not_configured" };
  const result = await sendSmtpMessage({
    from,
    to: recipients,
    subject: message.subject,
    text: message.text,
  }, {
    ...config,
    from,
  });
  return {
    ...result,
    configured: true,
    recipients,
  };
}

export function waitlistNotificationConfig(env = process.env) {
  const recipients = splitEmailList(env.ORKESTR_WAITLIST_NOTIFY_EMAILS || env.ORKESTR_WAITLIST_NOTIFY_EMAIL);
  const smtp = smtpEmailConfig(env);
  return {
    configured: Boolean(recipients.length && smtp.host && smtp.from),
    recipients,
    from: smtp.from,
    adminUrl: waitlistAdminUrl(env),
  };
}

export async function sendWaitlistNotification(entry = {}, env = process.env) {
  const config = waitlistNotificationConfig(env);
  if (!config.configured) {
    return {
      ok: false,
      configured: false,
      skippedReason: "waitlist_email_not_configured",
      recipients: config.recipients,
    };
  }
  const subjectName = clean(entry.displayName || entry.phoneNumber || "new applicant");
  const lines = [
    "A new Orkestr waitlist application was submitted.",
    "",
    `Name: ${clean(entry.displayName) || "(missing)"}`,
    `WhatsApp: ${clean(entry.phoneNumber) || "(missing)"}`,
    `Email: ${clean(entry.email) || "(not provided)"}`,
    `Intended use: ${clean(entry.intendedUse) || "(not provided)"}`,
    `Submitted: ${clean(entry.createdAt || entry.updatedAt) || new Date().toISOString()}`,
    `Entry ID: ${clean(entry.id)}`,
    "",
    `Review pending users: ${config.adminUrl}`,
    "",
    "Only approve applicants you intend to onboard. Approval can create or attach a WhatsApp onboarding chat.",
  ];
  const sent = await sendEmail({
    to: config.recipients,
    from: config.from,
    subject: `New Orkestr waitlist application: ${subjectName}`,
    text: lines.join("\n"),
  }, env);
  return {
    ...sent,
    recipients: config.recipients,
  };
}
