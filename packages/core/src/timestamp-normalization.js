const earliestSupportedTimestampMs = Date.UTC(2000, 0, 1);
const futureSkewMs = 366 * 24 * 60 * 60 * 1000;

function plausibleTimestampMs(value) {
  return Number.isFinite(value) &&
    value >= earliestSupportedTimestampMs &&
    value <= Date.now() + futureSkewMs;
}

export function timestampMs(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return plausibleTimestampMs(ms) ? ms : 0;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = Math.abs(value) < 10_000_000_000 ? value * 1000 : value;
    return plausibleTimestampMs(ms) ? ms : 0;
  }
  const text = String(value || "").trim();
  if (!text) return 0;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const valueAsNumber = Number(text);
    const ms = Math.abs(valueAsNumber) < 10_000_000_000 ? valueAsNumber * 1000 : valueAsNumber;
    return plausibleTimestampMs(ms) ? ms : 0;
  }
  const ms = Date.parse(text);
  return plausibleTimestampMs(ms) ? ms : 0;
}

export function canonicalTimestamp(value) {
  const ms = timestampMs(value);
  return ms ? new Date(ms).toISOString() : "";
}
