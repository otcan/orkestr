// Orkestr does not need puppeteer's own Chrome download (about 650 MB): the
// WhatsApp bridge uses an installed Chrome or Chromium (see
// packages/connectors/src/whatsapp-chrome-path.js), and the Docker image ships
// Chromium. Set ORKESTR_DOWNLOAD_CHROME=1 before `npm ci` to download it anyway.
module.exports = {
  skipDownload: process.env.ORKESTR_DOWNLOAD_CHROME !== "1",
};
