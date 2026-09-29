#!/usr/bin/env node
// Deterministic content manifest for a packaged runtime tree (the CI
// `runtime-dist` artifact or an installed release directory): sorted relative
// POSIX paths, sha256 per file, and a tree digest over the sorted lines. The
// same code runs in CI and in the deployer, so the digests are comparable.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { isMainModule } from "../main-module.mjs";

export const CONTENT_MANIFEST_SCHEMA = "orkestr.content-manifest/v1";

const sha256Hex = (value) => crypto.createHash("sha256").update(value).digest("hex");

function compareBytes(a, b) {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

// Digest over `<sha256>  <path>\n` lines in byte order. Empty trees still
// produce a stable digest.
export function treeDigest(files = []) {
  const lines = [...files].sort((a, b) => compareBytes(a.path, b.path)).map((file) => `${file.sha256}  ${file.path}\n`);
  return `sha256:${sha256Hex(lines.join(""))}`;
}

function subtreeDigests(files) {
  const groups = new Map();
  for (const file of files) {
    const top = file.path.includes("/") ? file.path.slice(0, file.path.indexOf("/")) : ".";
    if (!groups.has(top)) groups.set(top, []);
    groups.get(top).push(file);
  }
  return Object.fromEntries([...groups.keys()].sort(compareBytes).map((key) => [key, treeDigest(groups.get(key))]));
}

// Builds a manifest from an in-memory list of { path, sha256, size } entries
// (used for zip archives as well as directories).
export function manifestFromEntries(entries, { root = "." } = {}) {
  const seen = new Set();
  const files = [];
  for (const entry of entries) {
    const rel = normalizeRelativePath(entry.path);
    if (!rel) continue;
    if (seen.has(rel)) throw new Error(`content_manifest_duplicate_path:${rel}`);
    seen.add(rel);
    files.push({ path: rel, sha256: String(entry.sha256), size: Number(entry.size) || 0 });
  }
  files.sort((a, b) => compareBytes(a.path, b.path));
  return {
    schema: CONTENT_MANIFEST_SCHEMA,
    algorithm: "sha256",
    root,
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    treeDigest: treeDigest(files),
    subtrees: subtreeDigests(files),
    files,
  };
}

export function normalizeRelativePath(value = "") {
  const rel = String(value).replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (!rel) return "";
  if (path.posix.isAbsolute(rel) || rel.split("/").some((part) => part === ".." || part === "")) {
    throw new Error(`content_manifest_unsafe_path:${rel}`);
  }
  return rel;
}

function excluded(rel, exclude) {
  return exclude.some((pattern) => rel === pattern || rel.startsWith(`${pattern}/`));
}

async function walk(dir, base, exclude, out) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full).split(path.sep).join("/");
    if (excluded(rel, exclude)) continue;
    if (entry.isDirectory()) await walk(full, base, exclude, out);
    else if (entry.isSymbolicLink()) {
      const target = await fs.readlink(full);
      out.push({ path: rel, sha256: sha256Hex(`symlink:${target}`), size: 0 });
    } else if (entry.isFile()) {
      const data = await fs.readFile(full);
      out.push({ path: rel, sha256: sha256Hex(data), size: data.length });
    }
  }
}

export async function buildContentManifest(root, { exclude = [], label = "" } = {}) {
  const absolute = path.resolve(root);
  const entries = [];
  await walk(absolute, absolute, exclude.map((item) => normalizeRelativePath(item)).filter(Boolean), entries);
  return manifestFromEntries(entries, { root: label || path.basename(absolute) });
}

// Compares two manifests. `subtrees` limits the comparison to named top-level
// entries (e.g. server and launcher, which are rebuilt identically from the
// same commit); an empty list compares the whole tree.
export function compareContentManifests(expected, actual, { subtrees = [] } = {}) {
  if (!expected || !actual) return { match: false, reason: "manifest_missing", mismatched: [] };
  if (!subtrees.length) {
    return expected.treeDigest === actual.treeDigest
      ? { match: true, compared: ["*"], mismatched: [] }
      : { match: false, reason: "tree_digest_mismatch", compared: ["*"], mismatched: ["*"] };
  }
  const mismatched = subtrees.filter((name) => !expected.subtrees?.[name] || expected.subtrees[name] !== actual.subtrees?.[name]);
  return mismatched.length
    ? { match: false, reason: "subtree_digest_mismatch", compared: subtrees, mismatched }
    : { match: true, compared: subtrees, mismatched: [] };
}

// Compact summary suitable for release manifests and deployment history.
export function manifestSummary(manifest) {
  if (!manifest) return null;
  return { root: manifest.root, fileCount: manifest.fileCount, totalBytes: manifest.totalBytes, treeDigest: manifest.treeDigest, subtrees: manifest.subtrees };
}

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs({ options: { root: { type: "string" }, output: { type: "string" }, exclude: { type: "string", multiple: true }, label: { type: "string" }, summary: { type: "boolean" }, expect: { type: "string" } } });
  if (!values.root) {
    console.error("Usage: content-manifest.mjs --root DIR [--output FILE] [--exclude REL]... [--label NAME] [--summary] [--expect MANIFEST]");
    process.exit(2);
  }
  const manifest = await buildContentManifest(values.root, { exclude: values.exclude || [], label: values.label || "" });
  if (values.expect) {
    const expected = JSON.parse(await fs.readFile(values.expect, "utf8"));
    if (expected.treeDigest !== manifest.treeDigest) {
      console.error(`content_manifest_mismatch: expected ${expected.treeDigest}, got ${manifest.treeDigest}`);
      process.exit(1);
    }
  }
  const text = `${JSON.stringify(values.summary ? manifestSummary(manifest) : manifest, null, 2)}\n`;
  if (values.output) await fs.writeFile(values.output, text);
  else process.stdout.write(text);
}
