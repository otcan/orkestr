// Content, not filename/MIME, selects a renderer. HTML/SVG are literal text.
export const MAX_PREVIEW_PIXELS = 8_000_000;
const ascii = (b, at, count) => String.fromCharCode(...b.subarray(at, at + count));
export function previewType(bytes) {
  if (!(bytes instanceof Uint8Array)) throw Error("Invalid preview bytes.");
  const b = bytes, v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (ascii(b, 0, 5) === "%PDF-") return { kind: "pdf", mediaType: "application/pdf", typeLabel: "PDF document" };
  let mediaType = "", width = 0, height = 0;
  if (b.length >= 24 && b[0] === 137 && ascii(b, 1, 7) === "PNG\r\n\x1a\n" && ascii(b, 12, 4) === "IHDR") {
    mediaType = "image/png"; width = v.getUint32(16); height = v.getUint32(20);
  } else if (b.length >= 10 && ["GIF87a", "GIF89a"].includes(ascii(b, 0, 6))) {
    mediaType = "image/gif"; width = v.getUint16(6, true); height = v.getUint16(8, true);
  } else if (b.length >= 12 && b[0] === 255 && b[1] === 216) {
    mediaType = "image/jpeg";
    for (let p = 2; p + 4 <= Math.min(b.length, 65536);) {
      if (b[p++] !== 255) break;
      while (b[p] === 255) p++;
      const marker = b[p++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (p + 2 > b.length) break;
      const size = v.getUint16(p);
      if (size < 2 || p + size > b.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && size >= 8) {
        height = v.getUint16(p + 3); width = v.getUint16(p + 5); break;
      }
      p += size;
    }
  } else if (b.length >= 30 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    mediaType = "image/webp";
    const tag = ascii(b, 12, 4);
    const u24 = p => b[p] | (b[p + 1] << 8) | (b[p + 2] << 16);
    if (tag === "VP8X") { width = 1 + u24(24); height = 1 + u24(27); }
    else if (tag === "VP8 " && ascii(b, 23, 3) === "\x9d\x01\x2a") { width = v.getUint16(26, true) & 16383; height = v.getUint16(28, true) & 16383; }
    else if (tag === "VP8L" && b[20] === 47) { width = 1 + (b[21] | ((b[22] & 63) << 8)); height = 1 + ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 15) << 10)); }
  }
  if (mediaType) {
    if (!width || !height || width > 16384 || height > 16384 || width * height > MAX_PREVIEW_PIXELS) throw Error("Image dimensions exceed the safe preview limit or are invalid. Download instead.");
    return { kind: "image", mediaType, typeLabel: `${mediaType.slice(6).toUpperCase()} image`, width, height };
  }
  if (b[0] === 80 && b[1] === 75) return { kind: "archive", mediaType: "application/zip", typeLabel: "ZIP archive" };
  if (b[0] === 31 && b[1] === 139) return { kind: "archive", mediaType: "application/gzip", typeLabel: "GZIP archive" };
  if (b.length >= 512 && ascii(b, 257, 5) === "ustar") return { kind: "archive", mediaType: "application/x-tar", typeLabel: "TAR archive" };
  return { kind: "text", mediaType: "text/plain", typeLabel: "Plain text (literal)" };
}
