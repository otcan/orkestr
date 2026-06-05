import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendThreadMessage, createThread, deleteThreadMessage, updateThreadMessage } from "../packages/core/src/threads.js";
import { listEvents } from "../packages/storage/src/store.js";

test("thread message visible edits and deletes emit revisioned events", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-message-events-"));
  const env = { ORKESTR_HOME: home };
  await createThread({ id: "thread-message-events", name: "Message Events" }, env);
  const message = await appendThreadMessage("thread-message-events", {
    role: "assistant",
    source: "manual",
    state: "completed",
    text: "Original text",
  }, env);

  const edited = await updateThreadMessage("thread-message-events", message.id, { text: "Edited text" }, env);
  const deleted = await deleteThreadMessage("thread-message-events", message.id, { deletedBy: "operator", reason: "test" }, env);
  const events = await listEvents(env, 20);
  const editEvent = events.find((event) => event.type === "thread_message_edited");
  const deleteEvent = events.find((event) => event.type === "thread_message_deleted");

  assert.equal(edited.revision, 2);
  assert.equal(deleted.revision, 3);
  assert.equal(deleted.deletedBy, "operator");
  assert.equal(editEvent.eventType, "message.edited");
  assert.equal(editEvent.previousRevision, 1);
  assert.equal(editEvent.sourceRevision, 2);
  assert.deepEqual(editEvent.changedFields, ["text"]);
  assert.equal(deleteEvent.eventType, "message.deleted");
  assert.equal(deleteEvent.previousRevision, 2);
  assert.equal(deleteEvent.sourceRevision, 3);
  assert.deepEqual(deleteEvent.changedFields, ["deletedAt"]);
});
