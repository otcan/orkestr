export function json(reply, statusCode, payload) {
  return reply
    .code(statusCode)
    .header("cache-control", "no-store")
    .type("application/json; charset=utf-8")
    .send(payload);
}

export function installJsonParser(app) {
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    const text = String(body || "").trim();
    if (!text) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(text));
    } catch (error) {
      done(error);
    }
  });
}

export function serverHandle(app) {
  return {
    address: () => app.server.address(),
    close: (callback) => {
      app.close()
        .then(() => callback?.())
        .catch((error) => callback?.(error));
    },
  };
}
