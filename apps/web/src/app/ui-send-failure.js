function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function clean(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function errorMessage(error) {
  const outer = record(error);
  const nested = record(outer?.error);
  return clean(nested?.message)
    || clean(nested?.error)
    || clean(outer?.error)
    || clean(outer?.message)
    || clean(error);
}

function errorCode(error) {
  const outer = record(error);
  const nested = record(outer?.error);
  return clean(nested?.code)
    || clean(nested?.errorCode)
    || clean(outer?.code)
    || clean(outer?.name);
}

function errorStatus(error) {
  const value = Number(record(error)?.status || 0);
  return Number.isFinite(value) ? value : 0;
}

function hasErrorStatus(error) {
  const outer = record(error);
  return Boolean(outer && Object.prototype.hasOwnProperty.call(outer, "status"));
}

function technicalDescription(status, code, message) {
  const parts = [status > 0 ? `HTTP ${status}` : "", code && code !== "Error" ? code : "", message]
    .filter(Boolean);
  return [...new Set(parts)].join(" · ") || "No error details were returned by the browser.";
}

export function describeUiSendFailure(error) {
  const status = errorStatus(error);
  const code = errorCode(error);
  const message = errorMessage(error);
  const searchable = `${code} ${message}`.toLowerCase();
  const technical = technicalDescription(status, code, message);

  if (searchable.includes("attachment_retry_data_unavailable")) {
    return {
      summary: "The original attachment is no longer available in this browser.",
      detail: "The message text is preserved, but the browser cannot recover an unuploaded local file after a reload. Attach the file again and send the message.",
      technical,
      retryable: false,
    };
  }
  if (searchable.includes("larger than 25 mb") || status === 413 || searchable.includes("payload too large")) {
    return {
      summary: "An attachment is too large to send.",
      detail: "Orkestr accepts files up to 25 MB. Remove the oversized file, attach a smaller copy, and send the message again.",
      technical,
      retryable: false,
    };
  }
  if ((hasErrorStatus(error) && status === 0) || searchable.includes("failed to fetch") || searchable.includes("networkerror") || searchable.includes("network error")) {
    return {
      summary: "The browser could not reach Orkestr.",
      detail: "No delivery confirmation came back. Check the connection, then resend; Orkestr will reuse this message ID so an already accepted message is not duplicated.",
      technical,
      retryable: true,
    };
  }
  if (status === 401 || searchable.includes("unauthorized") || searchable.includes("session_expired")) {
    return {
      summary: "Your Orkestr session is no longer valid.",
      detail: "Sign in again if prompted, then resend this message. Its text and uploaded attachments are still shown here.",
      technical,
      retryable: true,
    };
  }
  if (status === 403 || searchable.includes("forbidden") || searchable.includes("access_denied")) {
    return {
      summary: "This account is not allowed to send to the thread.",
      detail: "The message was rejected before delivery. Check the selected account or thread access, then try again.",
      technical,
      retryable: true,
    };
  }
  if (status === 404 || searchable.includes("thread_not_found")) {
    return {
      summary: "This thread is no longer available.",
      detail: "Orkestr could not find the selected thread. Reload the thread list and choose an active thread before sending again.",
      technical,
      retryable: false,
    };
  }
  if (status === 409 || searchable.includes("conflict") || searchable.includes("not_ready") || searchable.includes("drain")) {
    return {
      summary: "The thread changed state before the message could be accepted.",
      detail: "The runtime may be starting, stopping, or recovering. Wait until the thread is ready, then resend the message.",
      technical,
      retryable: true,
    };
  }
  if (status === 429 || searchable.includes("rate_limit") || searchable.includes("too many requests")) {
    return {
      summary: "Orkestr is temporarily busy.",
      detail: "The request was rate-limited before delivery was confirmed. Wait a moment, then resend the same message.",
      technical,
      retryable: true,
    };
  }
  if (status >= 500) {
    return {
      summary: "Orkestr returned a server error.",
      detail: "Delivery could not be confirmed. Resend the message; its stable message ID prevents a duplicate if the server accepted the first request.",
      technical,
      retryable: true,
    };
  }
  if (status >= 400) {
    return {
      summary: "Orkestr rejected this message.",
      detail: "The request did not pass server validation. Review the technical details, correct the message or attachments, and try again.",
      technical,
      retryable: status < 422,
    };
  }
  return {
    summary: "Orkestr could not confirm delivery.",
    detail: "The message is still available here. Resend it to retry safely with the same message ID.",
    technical,
    retryable: true,
  };
}
