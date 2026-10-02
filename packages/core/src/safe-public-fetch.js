// Outbound HTTPS to user-supplied URLs (webhook callbacks, OAuth client
// metadata documents). Resolves the host once, refuses private, local and
// other non-public addresses, connects to that validated address while
// keeping the hostname for TLS, never follows redirects, and bounds time and
// response size.
import dns from "node:dns/promises";
import https from "node:https";
import net from "node:net";

const blocked = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
]) blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["100::", 64], ["2001::", 23], ["2001:db8::", 32],
  ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
]) blocked.addSubnet(address, prefix, "ipv6");

export function publicAddress(address = "") {
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) is judged by its IPv4 address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(String(address));
  if (mapped) return publicAddress(mapped[1]);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(String(address));
  if (mappedHex) {
    const [high, low] = [parseInt(mappedHex[1], 16), parseInt(mappedHex[2], 16)];
    return publicAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  const family = net.isIP(address);
  if (!family) return false;
  return !blocked.check(address, family === 6 ? "ipv6" : "ipv4");
}

function fail(code, detail = "") {
  return Object.assign(new Error(code), { statusCode: 400, detail });
}

export function assertPublicHttpsUrl(value = "") {
  let url;
  try { url = new URL(String(value)); } catch { throw fail("url_invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname) throw fail("url_must_be_public_https");
  if (net.isIP(url.hostname.replace(/^\[|\]$/g, "")) && !publicAddress(url.hostname.replace(/^\[|\]$/g, ""))) throw fail("url_address_not_public");
  return url;
}

async function resolvePublic(hostname, lookup) {
  const bare = hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(bare) ? [{ address: bare, family: net.isIP(bare) }] : await lookup(bare, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => !publicAddress(entry.address))) throw fail("url_address_not_public", hostname);
  return addresses[0];
}

// Returns { status, headers, text }. `options.lookup` and `options.request`
// exist for tests; production uses DNS and https.
export async function safePublicFetch(value, { method = "GET", headers = {}, body = "", timeoutMs = 10_000, maxBytes = 262_144, lookup = dns.lookup, request = https.request } = {}) {
  const url = assertPublicHttpsUrl(value);
  const target = await resolvePublic(url.hostname, lookup);
  return new Promise((resolve, reject) => {
    const req = request({
      method,
      hostname: url.hostname,
      servername: net.isIP(url.hostname) ? undefined : url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      headers: { ...headers, ...(body ? { "content-length": Buffer.byteLength(body) } : {}) },
      lookup: (_host, opts, callback) => (opts?.all
        ? callback(null, [{ address: target.address, family: target.family }])
        : callback(null, target.address, target.family)),
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) { req.destroy(fail("response_too_large")); return; }
        chunks.push(chunk);
      });
      res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(fail("request_timeout")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
