// Preload that makes any network access fail loudly. Used to prove that the
// credential-free demo runs fully offline.
import dns from "node:dns";
import net from "node:net";

function denied() {
  throw new Error("network_access_denied_in_offline_test");
}

net.Socket.prototype.connect = denied;
dns.lookup = denied;
dns.promises.lookup = denied;
globalThis.fetch = async () => denied();
