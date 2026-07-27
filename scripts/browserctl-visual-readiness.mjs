import net from "node:net";

const defaultTimeoutMs = 2_500;
const maxRectangleBytes = 2 * 1024 * 1024;

function boundedTimeout(value, fallback = defaultTimeoutMs) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(250, Math.min(10_000, Math.floor(parsed))) : fallback;
}

function timedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function connect(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(timedError("rfb_connect_timeout"));
    }, timeoutMs);
    const done = (handler) => (value) => {
      clearTimeout(timer);
      socket.off("error", onError);
      socket.off("connect", onConnect);
      handler(value);
    };
    const onError = done(reject);
    const onConnect = done(() => resolve(socket));
    socket.once("error", onError);
    socket.once("connect", onConnect);
  });
}

function createReader(socket) {
  let buffered = Buffer.alloc(0);
  let ended = false;
  let failure = null;
  const pending = [];

  const flush = () => {
    while (pending.length) {
      const next = pending[0];
      if (failure) {
        pending.shift();
        clearTimeout(next.timer);
        next.reject(failure);
        continue;
      }
      if (buffered.length >= next.length) {
        pending.shift();
        clearTimeout(next.timer);
        const value = buffered.subarray(0, next.length);
        buffered = buffered.subarray(next.length);
        next.resolve(value);
        continue;
      }
      if (ended) {
        pending.shift();
        clearTimeout(next.timer);
        next.reject(timedError("rfb_connection_closed"));
        continue;
      }
      break;
    }
  };

  socket.on("data", (chunk) => {
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
    flush();
  });
  socket.on("end", () => {
    ended = true;
    flush();
  });
  socket.on("close", () => {
    ended = true;
    flush();
  });
  socket.on("error", (error) => {
    failure = error;
    flush();
  });

  return {
    read(length, timeoutMs) {
      if (!Number.isInteger(length) || length < 0) return Promise.reject(timedError("rfb_read_length_invalid"));
      return new Promise((resolve, reject) => {
        const request = {
          length,
          resolve,
          reject,
          timer: setTimeout(() => {
            const index = pending.indexOf(request);
            if (index >= 0) pending.splice(index, 1);
            reject(timedError("rfb_read_timeout"));
          }, timeoutMs),
        };
        pending.push(request);
        flush();
      });
    },
  };
}

async function write(socket, value) {
  await new Promise((resolve, reject) => {
    socket.write(value, (error) => (error ? reject(error) : resolve()));
  });
}

function rfbFailureReason(error) {
  const code = String(error?.code || error?.message || "rfb_probe_failed").trim().toLowerCase();
  if (code.includes("refused") || code.includes("connect") || code.includes("closed") || code.includes("timeout")) return "framebuffer_unreachable";
  if (code.includes("auth")) return "framebuffer_auth_required";
  if (code.includes("protocol")) return "framebuffer_protocol_invalid";
  return "framebuffer_probe_failed";
}

function sampleRegions(width, height, edge = 96) {
  const tileWidth = Math.max(1, Math.min(edge, width));
  const tileHeight = Math.max(1, Math.min(edge, height));
  const positions = [
    [0, 0],
    [width - tileWidth, 0],
    [Math.floor((width - tileWidth) / 2), Math.floor((height - tileHeight) / 2)],
    [0, height - tileHeight],
    [width - tileWidth, height - tileHeight],
  ];
  const seen = new Set();
  return positions
    .map(([x, y]) => ({ x: Math.max(0, x), y: Math.max(0, y), width: tileWidth, height: tileHeight }))
    .filter((region) => {
      const key = `${region.x}:${region.y}:${region.width}:${region.height}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function pixelStats(pixelBuffers) {
  let samples = 0;
  let dark = 0;
  let light = 0;
  let total = 0;
  for (const pixels of pixelBuffers) {
    const pixelCount = Math.floor(pixels.length / 4);
    const stride = Math.max(1, Math.floor(pixelCount / 4096));
    for (let pixel = 0; pixel < pixelCount; pixel += stride) {
      const offset = pixel * 4;
      const brightness = (pixels[offset] + pixels[offset + 1] + pixels[offset + 2]) / 3;
      total += brightness;
      samples += 1;
      if (brightness <= 12) dark += 1;
      if (brightness >= 243) light += 1;
    }
  }
  return {
    sampleCount: samples,
    averageBrightness: samples ? Math.round(total / samples) : 0,
    darkRatio: samples ? dark / samples : 0,
    lightRatio: samples ? light / samples : 0,
  };
}

function framebufferClassification(pixelBuffers) {
  const stats = pixelStats(pixelBuffers);
  if (!stats.sampleCount) return { ok: false, status: "framebuffer_empty", stats };
  if (stats.darkRatio >= 0.985) return { ok: false, status: "black_frame", stats };
  if (stats.lightRatio >= 0.985) return { ok: false, status: "white_frame", stats };
  return { ok: true, status: "ready", stats };
}

async function configureRawPixelFormat(socket) {
  const pixelFormat = Buffer.alloc(20);
  pixelFormat[0] = 0;
  pixelFormat[4] = 32;
  pixelFormat[5] = 24;
  pixelFormat[6] = 0;
  pixelFormat[7] = 1;
  pixelFormat.writeUInt16BE(255, 8);
  pixelFormat.writeUInt16BE(255, 10);
  pixelFormat.writeUInt16BE(255, 12);
  pixelFormat[14] = 16;
  pixelFormat[15] = 8;
  pixelFormat[16] = 0;
  await write(socket, pixelFormat);

  const encodings = Buffer.alloc(8);
  encodings[0] = 2;
  encodings.writeUInt16BE(1, 2);
  encodings.writeInt32BE(0, 4);
  await write(socket, encodings);
}

async function readFramebufferUpdate(socket, reader, region, timeoutMs) {
  const request = Buffer.alloc(10);
  request[0] = 3;
  request.writeUInt16BE(region.x, 2);
  request.writeUInt16BE(region.y, 4);
  request.writeUInt16BE(region.width, 6);
  request.writeUInt16BE(region.height, 8);
  await write(socket, request);

  const type = (await reader.read(1, timeoutMs))[0];
  if (type !== 0) throw timedError(`rfb_framebuffer_update_type_${type}`);
  const header = await reader.read(3, timeoutMs);
  const rectangles = header.readUInt16BE(1);
  const pixelBuffers = [];
  for (let index = 0; index < rectangles; index += 1) {
    const rectangle = await reader.read(12, timeoutMs);
    const width = rectangle.readUInt16BE(4);
    const height = rectangle.readUInt16BE(6);
    const encoding = rectangle.readInt32BE(8);
    if (encoding !== 0) throw timedError(`rfb_encoding_${encoding}`);
    const byteLength = width * height * 4;
    if (!byteLength || byteLength > maxRectangleBytes) throw timedError("rfb_rectangle_size_invalid");
    pixelBuffers.push(await reader.read(byteLength, timeoutMs));
  }
  return pixelBuffers;
}

export async function probeRfbFramebuffer({ host = "127.0.0.1", port, timeoutMs = defaultTimeoutMs } = {}) {
  const safeTimeoutMs = boundedTimeout(timeoutMs);
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort <= 0 || numericPort > 65535) {
    return { ok: false, status: "framebuffer_port_invalid" };
  }
  let socket = null;
  try {
    socket = await connect(host, numericPort, safeTimeoutMs);
    const reader = createReader(socket);
    const banner = (await reader.read(12, safeTimeoutMs)).toString("ascii");
    if (!/^RFB 003\.(?:007|008)\n$/.test(banner)) throw timedError("rfb_protocol_invalid");
    await write(socket, Buffer.from("RFB 003.008\n", "ascii"));
    const securityCount = (await reader.read(1, safeTimeoutMs))[0];
    if (!securityCount) throw timedError("rfb_auth_required");
    const securityTypes = await reader.read(securityCount, safeTimeoutMs);
    if (!securityTypes.includes(1)) throw timedError("rfb_auth_required");
    await write(socket, Buffer.from([1]));
    const securityResult = await reader.read(4, safeTimeoutMs);
    if (securityResult.readUInt32BE(0) !== 0) throw timedError("rfb_auth_required");
    await write(socket, Buffer.from([1]));
    const serverInit = await reader.read(24, safeTimeoutMs);
    const width = serverInit.readUInt16BE(0);
    const height = serverInit.readUInt16BE(2);
    const nameLength = serverInit.readUInt32BE(20);
    if (!width || !height || nameLength > 4096) throw timedError("rfb_server_init_invalid");
    if (nameLength) await reader.read(nameLength, safeTimeoutMs);
    await configureRawPixelFormat(socket);
    const pixelBuffers = [];
    for (const region of sampleRegions(width, height)) {
      pixelBuffers.push(...await readFramebufferUpdate(socket, reader, region, safeTimeoutMs));
    }
    const classification = framebufferClassification(pixelBuffers);
    return { ...classification, width, height, regionCount: sampleRegions(width, height).length };
  } catch (error) {
    return { ok: false, status: rfbFailureReason(error), error: String(error?.message || error).slice(0, 180) };
  } finally {
    socket?.destroy();
  }
}
