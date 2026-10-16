export const MAX_PDF_PAGES = 200;
export const MAX_CANVAS_PIXELS = 8_000_000;
export function assertPreviewPageCount(pages) {
  if (!Number.isInteger(pages) || pages < 1 || pages > MAX_PDF_PAGES) throw Error("PDF page limit exceeded.");
}
export function previewCanvasScale(width, height, viewportWidth, zoom = 1) {
  if (![width, height, viewportWidth, zoom].every(value => Number.isFinite(value) && value > 0)) throw Error("Invalid preview dimensions.");
  return Math.min(viewportWidth / width * Math.max(0.5, Math.min(4, zoom)), Math.sqrt(MAX_CANVAS_PIXELS / (width * height)), 8192 / Math.max(width, height));
}
