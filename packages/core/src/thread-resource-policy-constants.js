export const THREAD_RESOURCE_TYPES = Object.freeze({ desktop: "desktop", oxrm: "oxrm", mailbox: "mailbox" });

export const THREAD_RESOURCE_PERMISSIONS = Object.freeze({
  desktop: Object.freeze(["discover", "acquire", "operate", "share"]),
  oxrm: Object.freeze(["discover", "read", "write", "execute"]),
  // `process` is deliberately separate from subscription. Receiving a
  // mailbox message is not authority to start an external-origin turn.
  mailbox: Object.freeze(["discover", "read", "subscribe", "process", "manage"]),
});
