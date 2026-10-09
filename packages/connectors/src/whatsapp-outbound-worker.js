export function createWhatsAppOutboundMirrorWorker() {
  let inFlight = null;
  let followUp = null;
  const start = (deliverOnce) => {
    inFlight = Promise.resolve()
      .then(deliverOnce)
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
  return {
    run(deliverOnce) {
      return inFlight || start(deliverOnce);
    },
    // A caller that just persisted a message needs a sweep that started after
    // the write. Joining the in-flight sweep would return a snapshot without
    // that message, so queue one shared follow-up sweep instead.
    runFresh(deliverOnce) {
      if (!inFlight) return start(deliverOnce);
      followUp ||= inFlight
        .catch(() => null)
        .then(() => {
          followUp = null;
          return inFlight || start(deliverOnce);
        });
      return followUp;
    },
  };
}
