import { getConnectorPromptPush, runConnectorPromptPush } from "../../core/src/connector-pushes.js";
import { getGmailMessage, listGmailMessages } from "./gmail.js";

function clean(value) {
  return String(value || "").trim();
}

function gmailQuery(push = {}) {
  const query = clean(push.sourceConfig?.query || push.query);
  if (!query && push.safety?.allowBroadQuery !== true) {
    const error = new Error("connector_prompt_push_query_required");
    error.statusCode = 400;
    throw error;
  }
  return query;
}

function gmailMaxResults(push = {}) {
  const sourceMax = Number(push.sourceConfig?.maxResults || 0) || 0;
  const safetyMax = Number(push.safety?.maxItemsPerRun || 0) || 0;
  const max = sourceMax || safetyMax || 1;
  return Math.max(1, Math.min(5, Math.floor(max)));
}

export async function collectGmailPromptPushItems(push = {}, env = process.env, fetchImpl = fetch, options = {}) {
  const source = push?.id ? push : await getConnectorPromptPush(push, env);
  const query = gmailQuery(source || {});
  const listed = await listGmailMessages(
    { maxResults: gmailMaxResults(source || {}), query },
    env,
    fetchImpl,
    options,
  );
  const items = [];
  for (const message of listed.messages || []) {
    const detail = await getGmailMessage(message.id, env, fetchImpl, options);
    items.push({
      id: detail.id,
      sourceItemId: detail.id,
      threadId: detail.threadId,
      subject: detail.subject,
      from: detail.from,
      to: detail.to,
      date: detail.date || detail.internalDate,
      snippet: detail.snippet,
      text: detail.text,
      labelIds: detail.labelIds,
    });
  }
  return {
    query,
    items,
    nextPageToken: listed.nextPageToken || "",
    resultSizeEstimate: listed.resultSizeEstimate || 0,
  };
}

export async function runGmailPromptPush(pushOrId, env = process.env, fetchImpl = fetch, options = {}) {
  const push = typeof pushOrId === "string" ? await getConnectorPromptPush(pushOrId, env) : pushOrId;
  if (!push) {
    const error = new Error("connector_prompt_push_not_found");
    error.statusCode = 404;
    throw error;
  }
  if (clean(push.connector || push.source).toLowerCase() !== "gmail") {
    const error = new Error("connector_prompt_push_connector_mismatch");
    error.statusCode = 400;
    throw error;
  }
  const collected = await collectGmailPromptPushItems(push, env, fetchImpl, options);
  const result = await runConnectorPromptPush(push.id || push, collected.items, env, options);
  return {
    ...result,
    query: collected.query,
    resultSizeEstimate: collected.resultSizeEstimate,
    nextPageToken: collected.nextPageToken,
  };
}
