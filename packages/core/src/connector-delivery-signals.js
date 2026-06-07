let connectorDeliverySignalCount = 0;
let connectorDeliverySignalHandler = null;

const whatsappSources = new Set(["whatsapp", "whatsapp_inbound", "whatsapp_client"]);

function whatsappOrigin(message = {}) {
  return String(message.connector || "").trim().toLowerCase() === "whatsapp" ||
    whatsappSources.has(String(message.source || "").trim().toLowerCase());
}

export function markConnectorDeliverySignal(message = {}) {
  if (!whatsappOrigin(message)) return;
  connectorDeliverySignalCount += 1;
  if (connectorDeliverySignalHandler) {
    Promise.resolve(connectorDeliverySignalHandler({
      type: "thread_connector_delivery_signal",
      messageId: message.id || null,
      source: message.source || null,
      connector: message.connector || null,
      chatId: message.chatId || null,
      deliveryState: message.deliveryState || message.state || null,
    })).catch(() => {});
  }
}

export function consumeThreadConnectorDeliverySignalCount() {
  const count = connectorDeliverySignalCount;
  connectorDeliverySignalCount = 0;
  return count;
}

export function setThreadConnectorDeliverySignalHandler(handler) {
  connectorDeliverySignalHandler = typeof handler === "function" ? handler : null;
  return () => {
    if (connectorDeliverySignalHandler === handler) connectorDeliverySignalHandler = null;
  };
}
