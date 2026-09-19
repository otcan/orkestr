# Unified attachment preview (ORK-502)

The preview action detects content, not the extension or declared MIME type.
The sidebar labels the selected file, type and byte count; archive entries have
an archive/entry breadcrumb and selected state. On narrow screens it becomes a
full-screen dialog with back/close, focus containment and touch-sized controls.

Text remains literal Angular interpolation. ZIP/TAR/GZIP inspection stays in the
bounded archive worker. Raster images use a canvas, not active HTML/SVG. PDFs use
the pinned PDF.js legacy build with a real module worker and canvas page renderer:
page count, previous/next, zoom and fit-width. No native PDF plugin is required.
The implementation uses the [PDF.js document/canvas API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html),
not its scripting manager, forms or annotation navigation layer.

## Security and lifecycle

- Existing encrypted preview/download transport and browser-side decryption
  remain unchanged. No remote conversion service or plaintext fallback is added.
- PDF/worker/font/CMap/WASM resources are packaged locally. Document bytes are
  passed as data; document scripts, XFA and annotation actions are not executed.
- PDF.js v6 no longer exposes the historical `isEvalSupported` option. Its core
  renderer has no dynamic Function/eval code path; no scripting bundle is loaded.
- Limits: 25 MiB input, 200 PDF pages, 8 million canvas pixels, 8192-pixel canvas
  dimension, 15-second PDF load/render watchdog. Archive limits remain 32 MiB
  expanded, 1000 entries, 2 MiB per entry and 256 KiB displayed text.
- Image dimensions are checked before browser decoding and again afterward.
  Canvas limits bound rendering output, not every browser decoder allocation.
- Close/replacement aborts fetches, fences stale results, cancels rendering,
  destroys the PDF worker/document and closes image bitmaps. A blocked worker
  fails closed rather than silently parsing the PDF on the UI thread.
- Corrupt, unsupported, password-protected and over-limit files show a download
  fallback. Oversized ordinary files still use their existing conversation
  download action; encrypted preview endpoints retain their 25 MiB cap.

Independent kill switches: `ORKESTR_PDF_PREVIEW_ENABLED=0` and
`ORKESTR_IMAGE_PREVIEW_ENABLED=0`, alongside existing text/archive switches.
Prebuilt distributions must include `pdfjs/` assets and the lazy renderer chunk.
`npm run web:verify-static` checks the new worker/helper assets.

## Validation and release gates

Unit tests cover magic detection, misleading extensions, literal HTML/SVG,
invalid image dimensions, archive entry types, hidden nested archives, malicious
archive fixtures, corrupt PDFs and page/canvas limits. A synthetic PDF is parsed
and rendered with the pinned renderer to verify actual pixels without launching
an unmanaged browser.

Before calling mobile acceptance complete, test iOS Safari and Android Chrome on
real devices: encrypted PDF/image/text/ZIP, password/corrupt/large PDF, portrait/
landscape, scrolling/pinch/fit, keyboard/focus, rapid entry switching, close while
loading, offline/retry and resource cleanup. Unit tests are not proof of physical
mobile compatibility or a hard total browser-memory limit. The text-only PDF
canvas has no searchable/selectable text layer; downloads remain available.
