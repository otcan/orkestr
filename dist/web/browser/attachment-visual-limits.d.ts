export const MAX_PDF_PAGES: number;
export const MAX_CANVAS_PIXELS: number;
export function assertPreviewPageCount(pages: number): void;
export function previewCanvasScale(width: number, height: number, viewportWidth: number, zoom?: number): number;
