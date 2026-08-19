import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setGeneratedLocalWhatsAppGroupPicture } from "../packages/connectors/src/whatsapp-chat-picture.js";

test("local whatsapp group picture fallback uses WAWebWid for LID-era groups", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-picture-wid-"));
  const calls = [];
  const priorWindow = globalThis.window;
  const chatWid = { _serialized: "120363429022300057@g.us", wid: true };
  const client = {
    async getChatById() {
      return {
        isGroup: true,
        async setPicture() {
          throw new Error("ProfilePicThumbCollection.findImpl called with a non-WAWebWid id");
        },
      };
    },
    pupPage: {
      async evaluate(fn, id, media) {
        globalThis.window = {
          WWebJS: {
            async cropAndResizeImage(_media, options) {
              calls.push({ type: "crop", size: options.size });
              return `image-${options.size}`;
            },
          },
          require(name) {
            if (name === "WAWebWidFactory") {
              return {
                createWid(value) {
                  calls.push({ type: "createWid", value });
                  return chatWid;
                },
              };
            }
            if (name === "WAWebCollections") {
              return {
                ProfilePicThumb: {
                  get(value) {
                    calls.push({ type: "get", value });
                    return null;
                  },
                  async find(value) {
                    calls.push({ type: "find", value });
                    return { canSet: () => true };
                  },
                },
              };
            }
            if (name === "WAWebContactProfilePicThumbBridge") {
              return {
                async sendSetPicture(value, thumbnail, profilePic) {
                  calls.push({ type: "send", value, thumbnail, profilePic });
                  return { status: 200 };
                },
              };
            }
            throw new Error(`unexpected module ${name}`);
          },
        };
        try {
          return fn(id, media);
        } finally {
          globalThis.window = priorWindow;
        }
      },
    },
  };
  const MessageMedia = { fromFilePath: (filePath) => ({ filePath }) };
  const result = await setGeneratedLocalWhatsAppGroupPicture({
    client,
    MessageMedia,
    chatId: "120363429022300057@g.us",
    title: "Jobs-n8n",
    accountId: "sender",
    env: { ...process.env, ORKESTR_HOME: home },
  });

  assert.equal(result.updated, true);
  assert.equal(calls.find((call) => call.type === "get").value, chatWid);
  assert.equal(calls.find((call) => call.type === "find").value, chatWid);
  assert.equal(calls.find((call) => call.type === "send").value, chatWid);
  assert.deepEqual(calls.filter((call) => call.type === "crop").map((call) => call.size), [96, 640]);
});
