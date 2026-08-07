import path from "node:path";
import sharp from "sharp";

const fingerprintSize = 16;
const colorFingerprintSize = 8;
export const fingerprintAlgorithm = "ahash16-gray-color8-moments-v1";
const hexBitCounts = Array.from({ length: 16 }, (_, value) => value.toString(2).replace(/0/g, "").length);

function clean(value = "") {
  return String(value || "").trim();
}

function lower(value = "") {
  return clean(value).toLowerCase();
}

export function mediaKindForAttachment(attachment = {}) {
  const mimetype = lower(attachment.mimetype || attachment.mimeType);
  const kind = lower(attachment.kind || attachment.type);
  const extension = lower(path.extname(clean(attachment.filename || attachment.path)));
  if (mimetype.startsWith("image/") || kind === "image" || [".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(extension)) return "image";
  return "";
}

function normalizedPixelHash(raw) {
  if (!Buffer.isBuffer(raw) || raw.length !== fingerprintSize * fingerprintSize) return "";
  let sum = 0;
  for (const value of raw) sum += value;
  const average = sum / raw.length;
  let hex = "";
  for (let index = 0; index < raw.length; index += 4) {
    let value = 0;
    for (let bit = 0; bit < 4; bit += 1) {
      value = (value << 1) | (raw[index + bit] >= average ? 1 : 0);
    }
    hex += value.toString(16);
  }
  return hex;
}

function normalizedColorHash(raw, channels = 3) {
  if (!Buffer.isBuffer(raw) || raw.length < colorFingerprintSize * colorFingerprintSize * 3) return "";
  const width = colorFingerprintSize * colorFingerprintSize;
  const sums = [0, 0, 0];
  for (let index = 0; index < raw.length; index += channels) {
    sums[0] += raw[index] || 0;
    sums[1] += raw[index + 1] || 0;
    sums[2] += raw[index + 2] || 0;
  }
  const averages = sums.map((sum) => sum / width);
  const bits = [];
  for (let index = 0; index < raw.length; index += channels) {
    bits.push((raw[index] || 0) >= averages[0] ? 1 : 0);
    bits.push((raw[index + 1] || 0) >= averages[1] ? 1 : 0);
    bits.push((raw[index + 2] || 0) >= averages[2] ? 1 : 0);
  }
  let hex = "";
  for (let index = 0; index < bits.length; index += 4) {
    let value = 0;
    for (let bit = 0; bit < 4; bit += 1) value = (value << 1) | (bits[index + bit] || 0);
    hex += value.toString(16);
  }
  return hex;
}

function colorMomentsForRaw(raw, channels = 3) {
  if (!Buffer.isBuffer(raw) || raw.length < channels) return [];
  const count = Math.floor(raw.length / channels);
  if (!count) return [];
  const means = [0, 0, 0];
  for (let index = 0; index < raw.length; index += channels) {
    means[0] += raw[index] || 0;
    means[1] += raw[index + 1] || 0;
    means[2] += raw[index + 2] || 0;
  }
  for (let channel = 0; channel < 3; channel += 1) means[channel] /= count;
  const variances = [0, 0, 0];
  for (let index = 0; index < raw.length; index += channels) {
    variances[0] += Math.pow((raw[index] || 0) - means[0], 2);
    variances[1] += Math.pow((raw[index + 1] || 0) - means[1], 2);
    variances[2] += Math.pow((raw[index + 2] || 0) - means[2], 2);
  }
  return [
    ...means,
    ...variances.map((variance) => Math.sqrt(variance / count)),
  ].map((value) => Math.round(value * 100) / 100);
}

function imageInformationForRaw(raw, info = {}) {
  const channels = Number(info.channels) || 3;
  const width = Number(info.width) || colorFingerprintSize;
  const height = Number(info.height) || colorFingerprintSize;
  if (!Buffer.isBuffer(raw) || channels < 3 || width <= 0 || height <= 0) {
    return { informationScore: 0, uniqueColorBuckets: 0, lumaStddev: 0, edgeScore: 0 };
  }
  const count = Math.min(Math.floor(raw.length / channels), width * height);
  if (!count) return { informationScore: 0, uniqueColorBuckets: 0, lumaStddev: 0, edgeScore: 0 };
  const lumas = new Array(count);
  const buckets = new Set();
  let lumaSum = 0;
  for (let offset = 0; offset < count; offset += 1) {
    const index = offset * channels;
    const red = raw[index] || 0;
    const green = raw[index + 1] || 0;
    const blue = raw[index + 2] || 0;
    const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    lumas[offset] = luma;
    lumaSum += luma;
    buckets.add(`${red >> 5}:${green >> 5}:${blue >> 5}`);
  }
  const mean = lumaSum / count;
  let variance = 0;
  for (const luma of lumas) variance += Math.pow(luma - mean, 2);
  const lumaStddev = Math.sqrt(variance / count);
  let edgeTotal = 0;
  let edgePairs = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = y * width + x;
      if (offset >= count) continue;
      if (x + 1 < width && offset + 1 < count) {
        edgeTotal += Math.abs(lumas[offset] - lumas[offset + 1]);
        edgePairs += 1;
      }
      if (y + 1 < height && offset + width < count) {
        edgeTotal += Math.abs(lumas[offset] - lumas[offset + width]);
        edgePairs += 1;
      }
    }
  }
  const edgeScore = edgePairs ? edgeTotal / edgePairs : 0;
  const uniqueColorBuckets = buckets.size;
  const informationScore =
    Math.min(90, lumaStddev) +
    Math.min(90, edgeScore * 2) +
    Math.min(60, uniqueColorBuckets * 3);
  return {
    informationScore: Math.round(informationScore * 100) / 100,
    uniqueColorBuckets,
    lumaStddev: Math.round(lumaStddev * 100) / 100,
    edgeScore: Math.round(edgeScore * 100) / 100,
  };
}

export async function imageFingerprintForPath(filePath = "") {
  const resolved = clean(filePath);
  if (!resolved) return null;
  try {
    const metadata = await sharp(resolved, { failOn: "none", limitInputPixels: 64 * 1024 * 1024 }).metadata();
    const normalized = sharp(resolved, { failOn: "none", limitInputPixels: 64 * 1024 * 1024 })
      .rotate()
      .flatten({ background: { r: 255, g: 255, b: 255 } });
    const raw = await normalized
      .clone()
      .resize(fingerprintSize, fingerprintSize, { fit: "fill" })
      .greyscale()
      .raw()
      .toBuffer();
    const color = await normalized
      .clone()
      .resize(colorFingerprintSize, colorFingerprintSize, { fit: "fill" })
      .toColorspace("srgb")
      .raw()
      .toBuffer({ resolveWithObject: true });
    const value = normalizedPixelHash(raw);
    const colorValue = normalizedColorHash(color.data, color.info?.channels || 3);
    const colorMoments = colorMomentsForRaw(color.data, color.info?.channels || 3);
    const information = imageInformationForRaw(color.data, color.info);
    if (!value || !colorValue || colorMoments.length !== 6) return null;
    return {
      algorithm: fingerprintAlgorithm,
      value,
      colorValue,
      colorMoments,
      ...information,
      width: Number(metadata.width) || 0,
      height: Number(metadata.height) || 0,
    };
  } catch {
    return null;
  }
}

export function hammingDistanceHex(left = "", right = "") {
  const a = clean(left);
  const b = clean(right);
  if (!a || !b || a.length !== b.length) return Number.POSITIVE_INFINITY;
  let distance = 0;
  for (let index = 0; index < a.length; index += 1) {
    const x = Number.parseInt(a[index], 16);
    const y = Number.parseInt(b[index], 16);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return Number.POSITIVE_INFINITY;
    distance += hexBitCounts[x ^ y];
  }
  return distance;
}

export function colorMomentDistance(left = [], right = []) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== 6 || right.length !== 6) return Number.POSITIVE_INFINITY;
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = Number(left[index]);
    const b = Number(right[index]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
    sum += Math.pow(a - b, 2);
  }
  return Math.sqrt(sum);
}
