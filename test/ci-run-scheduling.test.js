// Which CI runs cancel each other, and which jobs a draft or docs-only pull
// request skips. The concurrency and job `if:` expressions are taken from the
// workflow files and evaluated with GitHub's expression rules, so the test
// proves the scheduling for every event type before a merge can.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";

const load = (name) => parse(fs.readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8"));

// Subset of the GitHub Actions expression language used by these workflows:
// literals, property paths, ! == != && || and parentheses, format() and the
// job status functions. Comparison and truthiness follow GitHub's rules.
function tokenize(source) {
  const tokens = [];
  for (let i = 0; i < source.length;) {
    const rest = source.slice(i);
    const space = /^\s+/.exec(rest);
    if (space) { i += space[0].length; continue; }
    const string = /^'((?:[^']|'')*)'/.exec(rest);
    if (string) { tokens.push({ type: "value", value: string[1].replaceAll("''", "'") }); i += string[0].length; continue; }
    const number = /^\d+(?:\.\d+)?/.exec(rest);
    if (number) { tokens.push({ type: "value", value: Number(number[0]) }); i += number[0].length; continue; }
    const word = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(rest);
    if (word) { tokens.push({ type: "word", value: word[0] }); i += word[0].length; continue; }
    const op = /^(==|!=|&&|\|\||!|\(|\)|,|\.)/.exec(rest);
    assert.ok(op, `unsupported expression syntax: ${rest}`);
    tokens.push({ type: "op", value: op[0] });
    i += op[0].length;
  }
  return tokens;
}

const truthy = (value) => !(value === false || value === null || value === undefined || value === "" || value === 0 || Number.isNaN(value));
function toNumber(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  if (typeof value === "string") return value.trim() === "" ? 0 : Number(value);
  return NaN;
}
function equal(a, b) {
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
  if (typeof a === typeof b && (typeof a !== "object" || a === null || b === null)) return a === b;
  return toNumber(a) === toNumber(b);
}

function evaluate(source, context) {
  const tokens = tokenize(source);
  let index = 0;
  const peek = (value) => tokens[index]?.type === "op" && tokens[index].value === value;
  const take = (value) => { assert.ok(peek(value), `expected ${value} in ${source}`); index += 1; };
  function primary() {
    const token = tokens[index++];
    assert.ok(token, `unexpected end of ${source}`);
    if (token.type === "value") return token.value;
    if (token.type === "op" && token.value === "(") { const value = or(); take(")"); return value; }
    assert.equal(token.type, "word", `unexpected ${token.value} in ${source}`);
    if (["true", "false", "null"].includes(token.value)) return JSON.parse(token.value);
    if (peek("(")) {
      take("(");
      const args = [];
      while (!peek(")")) { args.push(or()); if (peek(",")) take(","); }
      take(")");
      const fn = context.functions[token.value];
      assert.ok(fn, `unsupported function ${token.value}`);
      return fn(...args);
    }
    let value = context.values[token.value];
    while (peek(".")) {
      take(".");
      const key = tokens[index++].value;
      value = value === null || value === undefined ? null : value[key];
    }
    return value === undefined ? null : value;
  }
  function unary() { if (peek("!")) { take("!"); return !truthy(unary()); } return primary(); }
  function comparison() {
    let value = unary();
    while (peek("==") || peek("!=")) {
      const negate = tokens[index++].value === "!=";
      const result = equal(value, unary());
      value = negate ? !result : result;
    }
    return value;
  }
  function and() { let value = comparison(); while (peek("&&")) { take("&&"); const right = comparison(); value = truthy(value) ? right : value; } return value; }
  function or() { let value = and(); while (peek("||")) { take("||"); const right = and(); value = truthy(value) ? value : right; } return value; }
  const value = or();
  assert.equal(index, tokens.length, `unparsed input in ${source}`);
  return value;
}

const stringify = (value) => (value === null || value === undefined ? "" : String(value));
// A field such as `group: ${{ github.workflow }}-${{ ... }}` interpolates each
// expression; a field that is one whole expression keeps the value's type.
function field(text, context) {
  if (typeof text !== "string") return text;
  const parts = text.split(/\$\{\{([\s\S]*?)\}\}/);
  if (parts.length === 3 && parts[0] === "" && parts[2] === "") return evaluate(parts[1], context);
  return parts.map((part, i) => (i % 2 ? stringify(evaluate(part, context)) : part)).join("");
}

const format = (template, ...args) => String(template).replace(/\{(\d+)\}/g, (_, n) => stringify(args[Number(n)]));
const startsWith = (text, prefix) => stringify(text).toLowerCase().startsWith(stringify(prefix).toLowerCase());
const expressionContext = (github, extra = {}) => ({ values: { github, ...extra.values }, functions: { format, startsWith, ...extra.functions } });

const events = {
  pr: (run, number = 12) => ({ event_name: "pull_request", ref: `refs/pull/${number}/merge`, run_id: run, event: { pull_request: { number, draft: false } } }),
  integration: (run) => ({ event_name: "push", ref: "refs/heads/integration", run_id: run, event: {} }),
  tag: (run) => ({ event_name: "push", ref: "refs/tags/v1.2.3", run_id: run, event: {} }),
  imageCache: (run) => ({ event_name: "push", ref: "refs/heads/ci/image-cache/warm", run_id: run, event: {} }),
  dispatch: (run) => ({ event_name: "workflow_dispatch", ref: "refs/heads/integration", run_id: run, event: {} }),
  schedule: (run) => ({ event_name: "schedule", ref: "refs/heads/main", run_id: run, event: {} }),
  mergeGroup: (run) => ({ event_name: "merge_group", ref: "refs/heads/gh-readonly-queue/integration/pr-12", run_id: run, event: {} }),
};

function concurrency(workflow, github) {
  const context = expressionContext({ workflow: workflow.name, ...github });
  return { group: String(field(workflow.concurrency.group, context)).toLowerCase(), cancel: truthy(field(workflow.concurrency["cancel-in-progress"], context)) };
}

for (const name of ["ci.yml", "v2-rust.yml", "v2-browser.yml", "v2-image.yml"]) {
  test(`${name}: a newer PR or integration push cancels only its own older run`, () => {
    const workflow = load(name);
    const at = (event, run, ...args) => concurrency(workflow, events[event](run, ...args));
    for (const event of ["pr", "integration"]) {
      assert.equal(at(event, 101).group, at(event, 102).group, `${event} runs share one group`);
      assert.equal(at(event, 101).cancel, true, `${event} cancels the older run`);
    }
    assert.notEqual(at("pr", 101, 12).group, at("pr", 101, 13).group, "PRs never cancel each other");
    const isolated = ["tag", "imageCache", "dispatch", "schedule", "mergeGroup"];
    for (const event of isolated) {
      assert.notEqual(at(event, 101).group, at(event, 102).group, `${event} runs keep a unique group`);
      assert.equal(at(event, 101).cancel, false, `${event} never cancels`);
    }
    // The newest integration run can be replaced only by a newer integration push.
    const integration = at("integration", 101).group;
    for (const event of ["pr", ...isolated]) assert.notEqual(at(event, 101).group, integration, event);
  });

  test(`${name}: marking a draft ready starts a run`, () => {
    const types = load(name).on.pull_request.types;
    for (const type of ["opened", "synchronize", "reopened", "ready_for_review"]) assert.ok(types.includes(type), type);
  });
}

test("v2-publish.yml never cancels a publish run", () => {
  const workflow = load("v2-publish.yml");
  assert.deepEqual(Object.keys(workflow.on), ["push"]);
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
});

// Which jobs start, modelling GitHub's job rules: an `if:` without a status
// function also needs every `needs` job to have succeeded; always() does not.
// Every job that runs is taken to succeed.
function runningJobs(workflow, github, outputs = {}) {
  const ran = new Map();
  const pending = new Map(Object.entries(workflow.jobs));
  while (pending.size) {
    const before = pending.size;
    for (const [id, job] of pending) {
      const needs = [].concat(job.needs || []);
      if (!needs.every((need) => ran.has(need))) continue;
      const success = () => needs.every((need) => ran.get(need));
      const condition = job.if ?? "${{ success() }}";
      const explicit = /\b(?:always|success|failure|cancelled)\s*\(/.test(condition);
      const context = expressionContext(github, {
        values: { needs: Object.fromEntries(needs.map((need) => [need, { result: ran.get(need) ? "success" : "skipped", outputs: ran.get(need) ? outputs[need] || {} : {} }])) },
        functions: { success, always: () => true, cancelled: () => false, failure: () => false },
      });
      ran.set(id, truthy(field(condition, context)) && (explicit || success()));
      pending.delete(id);
    }
    assert.ok(pending.size < before, "job dependency cycle");
  }
  return [...ran].filter(([, started]) => started).map(([id]) => id).sort();
}

const pr = (draft) => ({ ...events.pr(7), event: { pull_request: { number: 12, draft } } });
const ciCheap = ["changes", "dependency-advisories", "dependency-policy", "secret-policy", "secret-scan", "syntax"];
const docsOnly = (value) => ({ changes: { "docs-only": value } });

test("ci.yml: draft and docs-only PRs run only the cheap checks", () => {
  const workflow = load("ci.yml");
  const fullPr = [...ciCheap, "build", "image", "smoke", "test", "tests"].sort();
  assert.deepEqual(runningJobs(workflow, pr(true), docsOnly("false")), ciCheap);
  assert.deepEqual(runningJobs(workflow, pr(false), docsOnly("true")), ciCheap);
  assert.deepEqual(runningJobs(workflow, pr(true), docsOnly("true")), ciCheap);
  assert.deepEqual(runningJobs(workflow, pr(false), docsOnly("false")), fullPr);
  // A failed or missing classification never skips the suite.
  assert.deepEqual(runningJobs(workflow, pr(false), docsOnly("")), fullPr);
  assert.deepEqual(runningJobs(workflow, events.integration(7), docsOnly("false")), [...fullPr, "provenance"].sort());
  assert.deepEqual(runningJobs(workflow, events.schedule(7), docsOnly("false")), ciCheap);
});

// Pull requests build the amd64 image only; the arm64 image is built on every
// other event, so each integration push still produces both (ORK-791).
const prSkips = { "v2-image.yml": ["linux-image-arm64"] };
for (const [name, cheap] of [["v2-rust.yml", ["cargo-advisories", "cargo-policy"]], ["v2-browser.yml", []], ["v2-image.yml", []]]) {
  test(`${name}: draft PRs skip every Rust, browser and image job`, () => {
    const workflow = load(name);
    const all = Object.keys(workflow.jobs).sort();
    assert.deepEqual(runningJobs(workflow, pr(true)), cheap);
    assert.deepEqual(runningJobs(workflow, pr(false)), all.filter((job) => !(prSkips[name] || []).includes(job)));
    for (const event of ["integration", "imageCache", "dispatch"]) assert.deepEqual(runningJobs(workflow, events[event](7)), all, event);
  });
}

test("v2-image.yml: pull requests build amd64 only, integration pushes both architectures", () => {
  const workflow = load("v2-image.yml");
  assert.deepEqual(runningJobs(workflow, pr(false)), ["linux-image-amd64"]);
  assert.deepEqual(runningJobs(workflow, events.integration(7)), ["linux-image-amd64", "linux-image-arm64"]);
});

// The `changes` job's own script, run against a synthetic repository.
const classifier = load("ci.yml").jobs.changes.steps.find((step) => step.id === "classify").run;
function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function commit(repo, files, message) {
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(repo, file);
    if (content === null) { fs.rmSync(target); continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "--allow-empty", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}
function classify(repo, env) {
  const output = path.join(repo, "..", `output-${Math.random().toString(16).slice(2)}`);
  fs.writeFileSync(output, "");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", classifier], { cwd: repo, encoding: "utf8", env: { PATH: process.env.PATH, GITHUB_OUTPUT: output, ...env } });
  assert.equal(result.status, 0, result.stderr);
  return { value: /^docs-only=(.*)$/m.exec(fs.readFileSync(output, "utf8"))?.[1], stdout: result.stdout };
}

test("ci.yml changes job: only docs/** and Markdown changes count as docs-only", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ci-changes-"));
  try {
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo);
    git(repo, "init", "--quiet");
    const base = commit(repo, { "README.md": "a\n", "src/app.js": "1\n", "docs/guide.md": "a\n" }, "base");
    const branch = (name, files) => { git(repo, "checkout", "--quiet", "-B", name, base); return commit(repo, files, name); };
    const pull = (head, from = base) => classify(repo, { EVENT: "pull_request", BASE: from, HEAD: head }).value;

    assert.equal(pull(branch("docs", { "docs/guide.md": "b\n", "README.md": "b\n", "v2/NOTES.md": "new\n", "docs/assets/shot.png": "png" })), "true");
    assert.equal(pull(branch("mixed", { "docs/guide.md": "c\n", "src/app.js": "2\n" })), "false");
    assert.equal(pull(branch("rename", { "src/app.js": null, "docs/app.md": "1\n" })), "false", "moving code into docs/ still changes code");
    assert.equal(pull(branch("markdown-lookalike", { "src/notes.md.js": "x\n" })), "false");
    assert.equal(pull(branch("empty", {})), "false", "no changed files runs the suite");
    // The base branch moving on with code changes does not count against a docs-only PR.
    const docsHead = branch("docs-late", { "docs/guide.md": "d\n" });
    git(repo, "checkout", "--quiet", "-B", "integration", base);
    const movedBase = commit(repo, { "src/app.js": "3\n" }, "integration moved");
    assert.equal(pull(docsHead, movedBase), "true");

    assert.equal(classify(repo, { EVENT: "push", BASE: "", HEAD: "" }).value, "false", "pushes always run the suite");
    const broken = classify(repo, { EVENT: "pull_request", BASE: "0".repeat(40), HEAD: docsHead });
    assert.equal(broken.value, "false");
    assert.match(broken.stdout, /running the full suite/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
