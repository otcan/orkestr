#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function clean(value) {
  return String(value || "").trim();
}

function envNumber(name, fallback) {
  const parsed = Number(process.env[name] || "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function intValue(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function firstJsonObject(text) {
  const source = clean(text);
  const lines = source.split(/\r?\n/g).map((line) => line.trim()).filter(Boolean);
  for (const line of lines.reverse()) {
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    try {
      return JSON.parse(line);
    } catch {
      // Continue looking for a clean JSON line.
    }
  }
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(source.slice(start, end + 1));
  throw new Error("jobs_fit_agent_invalid_json");
}

async function readStdin() {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  return JSON.parse(input || "{}");
}

function normalizeOutput(raw = {}) {
  const result = raw && typeof raw === "object" ? raw : {};
  const fitScore100 = intValue(result.fit_score_100 ?? result.fitScore100 ?? result.score100, 50, 0, 100);
  const fitScore = intValue(result.fit_score ?? result.fitScore ?? Math.ceil(fitScore100 / 10), 5, 1, 10);
  return {
    fit_score: fitScore,
    fit_score_100: fitScore100,
    role: clean(result.role || result.title).slice(0, 160),
    company: clean(result.company).slice(0, 120),
    location: clean(result.location).slice(0, 120),
    remote: clean(result.remote).slice(0, 80),
    salary: clean(result.salary).slice(0, 120),
    reason: clean(result.reason).slice(0, 800),
    why_fit: clean(result.why_fit || result.whyFit).slice(0, 1000),
    risks: Array.isArray(result.risks)
      ? result.risks.map(clean).filter(Boolean).slice(0, 6)
      : clean(result.risks).slice(0, 1000),
    next_action: clean(result.next_action || result.nextAction).slice(0, 240),
    classifier: "llm_codex",
  };
}

function candidatePayload(payload = {}) {
  const candidate = payload.candidate && typeof payload.candidate === "object" ? payload.candidate : {};
  return {
    subject: clean(candidate.subject).slice(0, 300),
    sender: clean(candidate.sender).slice(0, 200),
    snippet: clean(candidate.snippet).slice(0, 500),
    bodySnapshot: clean(candidate.bodySnapshot).slice(0, 4000),
    links: Array.isArray(candidate.links) ? candidate.links.map(clean).filter(Boolean).slice(0, 10) : [],
  };
}

function promptFor(payload = {}) {
  const candidate = candidatePayload(payload);
  const preferences = payload.preferences && typeof payload.preferences === "object" ? payload.preferences : {};
  return [
    "You are the Orkestr jobs fit classifier.",
    "Classify one Gmail-derived job candidate for the tenant's job-search queue.",
    "Return compact JSON only. Do not include markdown.",
    "",
    "Output schema:",
    "{",
    "  \"fit_score\": integer 1-10,",
    "  \"fit_score_100\": integer 0-100,",
    "  \"role\": string,",
    "  \"company\": string,",
    "  \"location\": string,",
    "  \"remote\": string,",
    "  \"salary\": string,",
    "  \"reason\": string,",
    "  \"why_fit\": string,",
    "  \"risks\": string or string[],",
    "  \"next_action\": string",
    "}",
    "",
    "Rubric:",
    "- 90-100 exceptional: directly matches target role, domain, location/work mode, and seniority.",
    "- 75-89 strong: likely worth reviewing or applying.",
    "- 60-74 possible: maybe relevant but missing important fit details.",
    "- Below 60 weak: not a good fit or not really a job posting.",
    "",
    "Rules:",
    "- Decide semantically. Do not score by keyword counting.",
    "- If this is not a real job opportunity, score below 40 and explain briefly.",
    "- Prefer evidence from subject/snippet/bodySnapshot/links, not boilerplate footers.",
    "- Do not expose unrelated mailbox content or raw long email text.",
    "- If unsure, be conservative.",
    "",
    "Candidate:",
    JSON.stringify(candidate, null, 2),
    "",
    "Tenant preferences/context:",
    JSON.stringify(preferences, null, 2),
  ].join("\n");
}

function codexArgs({ outputPath, prompt }) {
  const args = [];
  const effort = clean(process.env.ORKESTR_JOBS_FIT_AGENT_CODEX_REASONING_EFFORT || "low");
  if (effort) args.push("-c", `model_reasoning_effort=${effort}`);
  args.push("-a", "never", "exec", "--ephemeral", "--skip-git-repo-check", "--ignore-rules", "--sandbox", "read-only");
  const model = clean(process.env.ORKESTR_JOBS_FIT_AGENT_CODEX_MODEL || "");
  if (model) args.push("-m", model);
  args.push("-C", clean(process.env.ORKESTR_JOBS_FIT_AGENT_CODEX_CWD || os.tmpdir()), "-o", outputPath, prompt);
  return args;
}

async function runCodex(payload) {
  const command = clean(process.env.ORKESTR_JOBS_FIT_AGENT_CODEX_BIN || process.env.ORKESTR_CODEX_BIN || "codex");
  const timeoutMs = envNumber("ORKESTR_JOBS_FIT_AGENT_CODEX_TIMEOUT_MS", 90_000);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-jobs-fit-codex-"));
  const outputPath = path.join(tmpDir, "fit.json");
  const args = codexArgs({ outputPath, prompt: promptFor(payload) });
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = async (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.unref?.();
      child.stdout?.destroy();
      child.stderr?.destroy();
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("jobs_fit_agent_codex_timeout"));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish(error);
    });
    child.on("close", async (code) => {
      if (code !== 0) {
        finish(new Error(clean(stderr) || `jobs_fit_agent_codex_exit_${code}`));
        return;
      }
      try {
        const finalText = await fs.readFile(outputPath, "utf8").catch(() => stdout);
        finish(null, firstJsonObject(finalText || stdout));
      } catch (error) {
        finish(error);
      }
    });
  });
}

async function main() {
  const payload = await readStdin();
  const result = await runCodex(payload);
  process.stdout.write(`${JSON.stringify(normalizeOutput(result))}\n`);
}

main().catch((error) => {
  process.stderr.write(`${clean(error?.message || error) || "jobs_fit_agent_codex_failed"}\n`);
  process.exit(1);
});
