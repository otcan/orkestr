import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createHushVoiceTurn } from "../../packages/core/src/hush-voice.js";
import { appendThreadMessage, listThreadMessages } from "../../packages/core/src/threads.js";
import { adminPrincipal } from "../../packages/core/src/principal.js";
import { sha256 } from "../../packages/core/src/mobile-device-crypto.js";
import { SseDecoder } from "./mobile-voice-test-helpers.js";

// Called after the real HTTP pairing flow. Only runtime delivery is stubbed;
// stream requests cross the real authentication, proof and ownership checks.
export async function assertMobileVoiceHttpStreams({ baseUrl, env, device, completed, privateKey, signJwt, timedClaims }) {
  const request = (turnId, suffix = "/events", extra = {}) => {
    const route = `/api/mobile/voice-turns/${turnId}${suffix}`;
    return fetch(`${baseUrl}${route}`, {
      signal: AbortSignal.timeout(5000),
      headers: {
        authorization: `Bearer ${completed.accessToken}`,
        "x-orkestr-content-sha256": sha256(""),
        "x-orkestr-device-proof": signJwt(privateKey, timedClaims({
          aud: "orkestr.mobile.request", sid: completed.session.id, did: completed.device.id,
          ath: sha256(completed.accessToken), method: "GET", path: route,
          bodySha256: sha256(""), jti: randomUUID(),
        })), ...extra,
      },
    });
  };
  const create = (context, transcript) => createHushVoiceTurn({
    device: context, principal: adminPrincipal(), clientTurnId: randomUUID(), transcript, locale: "en-US",
  }, { env, dependencies: { requestThreadInputDelivery: () => {}, threadUsesApiAgent: () => false, runtimeStatus: async () => ({}) } });

  const foreign = await create({ ...device, deviceId: "other-fixture-device" }, "Private other device turn");
  for (const turnId of [foreign.id, randomUUID()]) {
    const denied = await request(turnId);
    assert.equal(denied.status, 404, "foreign/missing turn must be denied before starting SSE");
    assert.match(denied.headers.get("content-type"), /application\/json/);
    const payload = await denied.text();
    assert.equal(payload.includes(foreign.id), false);
    assert.equal(payload.includes("other-fixture-device"), false);
  }

  const turn = await create(device, "HTTP stream reconnect fixture");
  const first = await request(turn.id);
  assert.equal(first.status, 200);
  assert.match(first.headers.get("content-type"), /^text\/event-stream/);
  const reader = first.body.getReader(), decoder = new SseDecoder();
  let queued;
  while (!queued) {
    const chunk = await reader.read(); assert.equal(chunk.done, false);
    queued = decoder.push(Buffer.from(chunk.value)).find(event => JSON.parse(event.data).turn.status === "queued");
  }
  await reader.cancel();
  const afterDisconnect = await (await request(turn.id, "")).json();
  assert.equal(afterDisconnect.status, "queued", "disconnect does not cancel queued work");
  const input = (await listThreadMessages(device.threadId, env)).find(message => message.text === "HTTP stream reconnect fixture");
  await appendThreadMessage(device.threadId, {
    role: "assistant", state: "completed", phase: "final_answer", parentMessageId: input.id,
    text: "Completed after disconnect.",
  }, env);
  const resumed = await request(turn.id, "/events", { "Last-Event-ID": queued.id });
  const replay = new SseDecoder().push(await resumed.text());
  assert.equal(replay.length, 1);
  assert.notEqual(replay[0].id, queued.id);
  assert.equal(JSON.parse(replay[0].data).turn.answer, "Completed after disconnect.");
  const acknowledged = await request(turn.id, "/events", { "Last-Event-ID": replay[0].id });
  assert.equal(new SseDecoder().push(await acknowledged.text()).length, 0);
}
