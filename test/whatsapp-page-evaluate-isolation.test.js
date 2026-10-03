// WhatsApp Web store reads run inside the browser: Puppeteer serializes the
// callback passed to page.evaluate, so it cannot use this module's helpers.
// These tests run callbacks the same way (source text in an isolated VM) and
// guard the bridge source against page callbacks that close over module scope.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { sendWhatsAppTextWithConfirmation } from "../packages/connectors/src/whatsapp-local-bridge.js";

const CONNECTORS = new URL("../packages/connectors/src/", import.meta.url);
const CHAT = "120363000000000000@g.us";
const OWN_LID = "100000000000001@lid";
const LOCAL_ID = "3EB0TESTLOCAL0001";

// A page whose evaluate behaves like Puppeteer's: the callback runs from its
// source text with only `window` in scope, and the result is serialized.
function isolatedPage(window) {
  return {
    async evaluate(fn, ...args) {
      const result = await vm.runInNewContext(`(${fn.toString()})(...args)`, { window, args });
      return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
    },
  };
}

// Group message as WhatsApp Web stores it: keyed by its serialized id with
// the LID participant suffix, never by the bare local id sendMessage returns.
function storeWindow({ ack = 1, type = "chat", body = "report", caption = "" } = {}) {
  const message = {
    id: { fromMe: true, remote: CHAT, id: LOCAL_ID, participant: OWN_LID, _serialized: `true_${CHAT}_${LOCAL_ID}_${OWN_LID}` },
    type, body, caption, ack, from: OWN_LID, to: CHAT, t: Math.floor(Date.now() / 1000),
  };
  const chat = { msgs: { getModelsArray: () => [message] } };
  const modules = {
    WAWebCollections: {
      Msg: { get: () => undefined, getMessagesById: async () => ({ messages: [] }) },
      Chat: { get: (wid) => (String(wid?._serialized || wid) === CHAT ? chat : undefined), getModelsArray: () => [] },
    },
    WAWebWidFactory: { createWid: (id) => ({ _serialized: id }) },
  };
  return { require: (name) => modules[name], WWebJS: { getMessageModel: (model) => ({ ...model }) } };
}

function localIdOnlyClient(window) {
  const calls = { send: 0 };
  return {
    calls,
    async sendMessage(chatId) {
      calls.send += 1;
      return { id: { fromMe: true, remote: chatId, id: LOCAL_ID } };
    },
    async getChatById() { return { async fetchMessages() { return []; } }; },
    pupPage: isolatedPage(window),
  };
}

async function testEnv(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-evaluate-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_SEND_ACK_ATTEMPTS: "2",
    ORKESTR_WHATSAPP_SEND_ACK_DELAY_MS: "0",
    ORKESTR_WHATSAPP_SEND_CONFIRMATION_ATTEMPTS: "1",
    ORKESTR_WHATSAPP_SEND_CONFIRMATION_DELAY_MS: "0",
  };
}

async function events(env) {
  const raw = await fs.readFile(path.join(env.ORKESTR_HOME, "events.jsonl"), "utf8").catch(() => "");
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("a group send returning a local id is confirmed from the browser store by its LID-serialized entry", async (t) => {
  const env = await testEnv(t);
  const client = localIdOnlyClient(storeWindow({ ack: 1 }));
  const sent = await sendWhatsAppTextWithConfirmation({ client, chatId: CHAT, text: "report", maxAttempts: 2, retryDelayMs: 0, env });
  assert.equal(client.calls.send, 1);
  assert.equal(sent.ack, 1);
  assert.equal(sent.body, "report");
  const types = (await events(env)).map((event) => event.type);
  assert.ok(!types.includes("whatsapp_local_send_confirmation_by_id_failed"), types.join(","));
  assert.ok(!types.includes("whatsapp_local_send_confirmation_unverified"), types.join(","));
});

test("a stored but not yet server-acked send is pending, not a lookup failure, and is not resent", async (t) => {
  const env = await testEnv(t);
  const client = localIdOnlyClient(storeWindow({ ack: 0 }));
  await sendWhatsAppTextWithConfirmation({ client, chatId: CHAT, text: "report", maxAttempts: 2, retryDelayMs: 0, env });
  assert.equal(client.calls.send, 1);
  const types = (await events(env)).map((event) => event.type);
  assert.ok(types.includes("whatsapp_local_send_confirmation_pending_ack"), types.join(","));
  assert.ok(!types.includes("whatsapp_local_send_confirmation_by_id_failed"), types.join(","));
});

test("store reads use the caption, not the thumbnail, as a media message's text", async (t) => {
  const env = await testEnv(t);
  const client = localIdOnlyClient(storeWindow({ type: "image", body: "/9j/thumbnail", caption: "report" }));
  const sent = await sendWhatsAppTextWithConfirmation({ client, chatId: CHAT, text: "report", maxAttempts: 2, retryDelayMs: 0, env });
  assert.equal(sent.body, "report");
});

// Text of each callback passed to a page's evaluate, by bracket matching
// (comments and string/template literal contents are skipped).
function evaluateCallbacks(source) {
  const callbacks = [];
  const marker = ".evaluate(";
  for (let start = source.indexOf(marker); start !== -1; start = source.indexOf(marker, start + 1)) {
    let depth = 0;
    let quote = "";
    for (let index = start + marker.length - 1; index < source.length; index += 1) {
      const char = source[index];
      if (quote) {
        if (char === "\\") index += 1;
        else if (char === quote) quote = "";
        continue;
      }
      if (char === "/" && source[index + 1] === "/") index = source.indexOf("\n", index);
      else if (char === "/" && source[index + 1] === "*") index = source.indexOf("*/", index) + 1;
      else if (char === "\"" || char === "'" || char === "`") quote = char;
      else if (char === "(") depth += 1;
      else if (char === ")" && --depth === 0) {
        callbacks.push(source.slice(start + marker.length, index));
        break;
      }
    }
  }
  return callbacks;
}

test("no page.evaluate callback in the connectors uses a module-level helper it does not define", async () => {
  const leaks = [];
  let checked = 0;
  for (const file of await fs.readdir(CONNECTORS)) {
    if (!file.endsWith(".js")) continue;
    const source = await fs.readFile(new URL(file, CONNECTORS), "utf8");
    const moduleNames = [...source.matchAll(/^(?:export\s+)?(?:async\s+)?(?:function\s*\*?\s*|const\s+|let\s+)([A-Za-z_$][\w$]*)/gm)]
      .map((match) => match[1]);
    for (const callback of evaluateCallbacks(source)) {
      // Function references (Puppeteer accepts a function value) are checked
      // where defined, not here.
      if (/^\s*[A-Za-z_$][\w$.]*\s*(,|$)/.test(callback)) continue;
      checked += 1;
      for (const name of moduleNames) {
        const escaped = name.replace(/\$/g, "\\$");
        if (!new RegExp(`(?<![\\w$.])${escaped}\\s*\\(`).test(callback)) continue;
        if (!new RegExp(`(?:const|let|var|function)\\s+${escaped}\\b`).test(callback)) {
          leaks.push(`${file}: ${name} in ${callback.slice(0, 80).replace(/\s+/g, " ")}`);
        }
      }
    }
  }
  assert.ok(checked >= 3, `checked ${checked} evaluate callbacks`);
  assert.deepEqual(leaks, []);
});
