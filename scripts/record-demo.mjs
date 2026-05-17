import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { startServer } from "../apps/server/src/server.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(repoRoot, "docs", "assets", "orkestr-demo.gif");

async function commandExists(command, args = ["--version"]) {
  try {
    await execFileAsync(command, args, { timeout: 2500 });
    return true;
  } catch {
    return false;
  }
}

async function chromePath() {
  for (const command of ["google-chrome", "chromium", "chromium-browser"]) {
    if (await commandExists(command)) {
      const { stdout } = await execFileAsync("which", [command], { timeout: 2500 });
      return String(stdout || command).trim();
    }
  }
  return "";
}

function restoreEnv(prior) {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function clickText(page, text) {
  await page.evaluate((wanted) => {
    const match = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes(wanted));
    if (match instanceof HTMLButtonElement) match.click();
  }, text);
  await new Promise((resolve) => setTimeout(resolve, 350));
}

async function capture(page, filePath) {
  await page.screenshot({ path: filePath, fullPage: true });
}

export async function recordDemo() {
  if (!(await commandExists("ffmpeg", ["-version"]))) throw new Error("ffmpeg is required to build the demo GIF");
  const executablePath = await chromePath();
  if (!executablePath) throw new Error("Chrome or Chromium is required to capture the demo UI");

  const { default: puppeteer } = await import("puppeteer");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-record-demo-home-"));
  const framesDir = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-record-demo-frames-"));
  const port = Number(process.env.ORKESTR_RECORD_DEMO_PORT || 19818);
  const priorEnv = {
    ORKESTR_HOME: process.env.ORKESTR_HOME,
    ORKESTR_PORT: process.env.ORKESTR_PORT,
    ORKESTR_HOST: process.env.ORKESTR_HOST,
    ORKESTR_BROWSER_LAUNCH_DISABLED: process.env.ORKESTR_BROWSER_LAUNCH_DISABLED,
    ORKESTR_RECOVER_RUNNING_ON_START: process.env.ORKESTR_RECOVER_RUNNING_ON_START,
  };
  let server = null;
  let browser = null;

  try {
    process.env.ORKESTR_HOME = home;
    process.env.ORKESTR_PORT = String(port);
    process.env.ORKESTR_HOST = "127.0.0.1";
    process.env.ORKESTR_BROWSER_LAUNCH_DISABLED = "1";
    process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";
    server = await startServer({ port, host: "127.0.0.1" });

    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 820, deviceScaleFactor: 1 });
    await page.goto(`http://127.0.0.1:${port}/setup`, { waitUntil: "networkidle0" });
    await capture(page, path.join(framesDir, "frame-001.png"));

    await clickText(page, "Virtual Desktop Generation");
    await capture(page, path.join(framesDir, "frame-002.png"));

    await clickText(page, "Next");
    await capture(page, path.join(framesDir, "frame-003.png"));

    await clickText(page, "Next");
    await capture(page, path.join(framesDir, "frame-004.png"));

    await clickText(page, "Next");
    await clickText(page, "Next");
    await clickText(page, "Next");
    await capture(page, path.join(framesDir, "frame-005.png"));

    await fs.mkdir(path.dirname(output), { recursive: true });
    await execFileAsync("ffmpeg", [
      "-y",
      "-framerate",
      "1",
      "-i",
      path.join(framesDir, "frame-%03d.png"),
      "-vf",
      "scale=720:-1:flags=lanczos,fps=3",
      output,
    ], { cwd: repoRoot, maxBuffer: 1024 * 1024 * 8 });
    console.log(`Wrote ${path.relative(repoRoot, output)} from live /setup screenshots`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await new Promise((resolve) => server.close(resolve));
    restoreEnv(priorEnv);
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
    await fs.rm(framesDir, { recursive: true, force: true }).catch(() => {});
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await recordDemo();
}
