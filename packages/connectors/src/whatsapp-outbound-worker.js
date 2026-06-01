export function createWhatsAppOutboundMirrorWorker() {
  let inFlight = null;
  return {
    run(deliverOnce) {
      if (inFlight) return inFlight;
      inFlight = Promise.resolve()
        .then(deliverOnce)
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
}
