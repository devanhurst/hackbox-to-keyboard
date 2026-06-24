#!/usr/bin/env node
// One-command release for hackbox-to-keyboard.
//
//   npm run release <patch|minor|major|X.Y.Z> [--push]
//
// Bumps the version in the four sites that MUST stay in lockstep, commits the
// change as `chore: release vX.Y.Z`, and creates an annotated `vX.Y.Z` tag.
// Pushing the tag is what triggers .github/workflows/release.yml (the signed
// macOS + Windows build), so this script does NOT push unless `--push` is given.
//
// The four version sites (see AGENTS.md / README.md):
//   1. package.json              -> "version"
//   2. src-tauri/tauri.conf.json -> "version"
//   3. src-tauri/Cargo.toml      -> [package] version
//   4. src-tauri/Cargo.lock      -> the hackbox-to-keyboard package entry
//
// Dependency-free: Node stdlib + git/cargo CLIs only.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_TAURI = join(ROOT, "src-tauri");
const DEFAULT_BRANCH = "main";
const CRATE = "hackbox-to-keyboard";

const PKG_JSON = join(ROOT, "package.json");
const TAURI_CONF = join(SRC_TAURI, "tauri.conf.json");
const CARGO_TOML = join(SRC_TAURI, "Cargo.toml");
const CARGO_LOCK = join(SRC_TAURI, "Cargo.lock");

function usage(msg) {
  if (msg) console.error(`\nerror: ${msg}\n`);
  console.error(
    [
      "Usage: npm run release <patch|minor|major|X.Y.Z> [--push]",
      "",
      "  patch|minor|major   bump the current version by that semver part",
      "  X.Y.Z               set an explicit version (must be > current)",
      "  --push              also run `git push --follow-tags` (triggers the release build)",
      "",
      "Bumps the version in package.json, src-tauri/tauri.conf.json,",
      "src-tauri/Cargo.toml and src-tauri/Cargo.lock, commits, and tags vX.Y.Z.",
      "Requires a clean working tree on the `" + DEFAULT_BRANCH + "` branch.",
    ].join("\n"),
  );
  process.exit(msg ? 1 : 0);
}

function die(msg) {
  console.error(`\nerror: ${msg}`);
  process.exit(1);
}

function git(args, opts = {}) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", ...opts }).trim();
}

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function cmpSemver(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function computeNext(current, arg) {
  const [maj, min, pat] = current;
  switch (arg) {
    case "patch":
      return [maj, min, pat + 1];
    case "minor":
      return [maj, min + 1, 0];
    case "major":
      return [maj + 1, 0, 0];
    default: {
      const explicit = parseSemver(arg);
      if (!explicit) usage(`invalid bump or version: "${arg}"`);
      return explicit;
    }
  }
}

// --- File mutators that preserve formatting ----------------------------------

function bumpJsonVersion(path, newVersion) {
  const text = readFileSync(path, "utf8");
  // Replace only the top-level "version": "..." value, leaving all other
  // formatting/whitespace untouched. The version is the first such key in both
  // package.json and tauri.conf.json.
  const re = /("version"\s*:\s*")(\d+\.\d+\.\d+)(")/;
  if (!re.test(text)) die(`could not find a "version" field in ${path}`);
  writeFileSync(path, text.replace(re, `$1${newVersion}$3`));
}

function bumpCargoToml(path, newVersion) {
  const text = readFileSync(path, "utf8");
  // Only touch the [package] version: it's the first `version = "..."` line,
  // which appears before any dependency table.
  const re = /^(version\s*=\s*")(\d+\.\d+\.\d+)(")/m;
  if (!re.test(text)) die(`could not find a [package] version in ${path}`);
  writeFileSync(path, text.replace(re, `$1${newVersion}$3`));
}

function haveCargo() {
  try {
    execFileSync("cargo", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function bumpCargoLock(newVersion) {
  // Preferred: let cargo rewrite the lockfile entry so it stays internally
  // consistent. `--precise` on the local package only touches its own entry;
  // `--offline` keeps it metadata-only (no network/registry refresh).
  if (haveCargo()) {
    try {
      execFileSync("cargo", ["update", "-p", CRATE, "--precise", newVersion, "--offline"], {
        cwd: SRC_TAURI,
        stdio: "inherit",
      });
      return;
    } catch {
      console.error("warning: `cargo update` failed; falling back to a targeted Cargo.lock edit");
    }
  } else {
    console.error("warning: cargo not found; falling back to a targeted Cargo.lock edit");
  }

  // Fallback: edit ONLY the `name = "hackbox-to-keyboard"` package entry's
  // version line, leaving every other lockfile entry untouched.
  const text = readFileSync(CARGO_LOCK, "utf8");
  const re = new RegExp(`(name = "${CRATE}"\\nversion = ")(\\d+\\.\\d+\\.\\d+)(")`);
  if (!re.test(text)) die(`could not find the ${CRATE} entry in ${CARGO_LOCK}`);
  writeFileSync(CARGO_LOCK, text.replace(re, `$1${newVersion}$3`));
}

// --- Cross-checks ------------------------------------------------------------

function readPkgVersion() {
  return JSON.parse(readFileSync(PKG_JSON, "utf8")).version;
}

function readTauriVersion() {
  return JSON.parse(readFileSync(TAURI_CONF, "utf8")).version;
}

function readCargoTomlVersion() {
  const m = /^version\s*=\s*"(\d+\.\d+\.\d+)"/m.exec(readFileSync(CARGO_TOML, "utf8"));
  return m && m[1];
}

function readCargoLockVersion() {
  const m = new RegExp(`name = "${CRATE}"\\nversion = "(\\d+\\.\\d+\\.\\d+)"`).exec(
    readFileSync(CARGO_LOCK, "utf8"),
  );
  return m && m[1];
}

function verifyAllAgree(expected) {
  const sites = {
    "package.json": readPkgVersion(),
    "src-tauri/tauri.conf.json": readTauriVersion(),
    "src-tauri/Cargo.toml": readCargoTomlVersion(),
    "src-tauri/Cargo.lock": readCargoLockVersion(),
  };
  const mismatches = Object.entries(sites).filter(([, v]) => v !== expected);
  if (mismatches.length) {
    const detail = Object.entries(sites)
      .map(([f, v]) => `  ${f}: ${v ?? "(not found)"}`)
      .join("\n");
    die(`version sites disagree after bump (expected ${expected}):\n${detail}`);
  }
}

// --- Main --------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  const push = argv.includes("--push");
  const positional = argv.filter((a) => !a.startsWith("--"));
  if (positional.length !== 1) usage(positional.length === 0 ? null : "expected exactly one bump argument");
  const bumpArg = positional[0];

  // Guard rail 1: clean working tree.
  if (git(["status", "--porcelain"])) {
    die("working tree is not clean; commit or stash changes before releasing");
  }

  // Guard rail 2: on the default branch.
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== DEFAULT_BRANCH) {
    die(`releases must be cut from \`${DEFAULT_BRANCH}\` (currently on \`${branch}\`)`);
  }

  // Compute the new version and reject anything non-increasing.
  const currentStr = readPkgVersion();
  const current = parseSemver(currentStr);
  if (!current) die(`current package.json version is not semver: "${currentStr}"`);
  const next = computeNext(current, bumpArg);
  if (cmpSemver(next, current) <= 0) {
    die(`new version ${next.join(".")} is not greater than current ${currentStr}`);
  }
  const newVersion = next.join(".");
  const tag = `v${newVersion}`;

  console.log(`Releasing ${currentStr} -> ${newVersion}`);

  // Write all four sites.
  bumpJsonVersion(PKG_JSON, newVersion);
  bumpJsonVersion(TAURI_CONF, newVersion);
  bumpCargoToml(CARGO_TOML, newVersion);
  bumpCargoLock(newVersion);

  // Guard rail 3: cross-check before committing.
  verifyAllAgree(newVersion);
  console.log("All four version sites agree.");

  // Commit + annotated tag.
  git(["add", "package.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock"]);
  git(["commit", "-m", `chore: release ${tag}`]);
  git(["tag", "-a", tag, "-m", `Release ${tag}`]);
  console.log(`Committed and tagged ${tag}.`);

  if (push) {
    git(["push", "--follow-tags", "origin", DEFAULT_BRANCH], { stdio: "inherit" });
    console.log(`Pushed ${DEFAULT_BRANCH} and ${tag} — the release build is now running.`);
  } else {
    console.log("\nNothing has been pushed. To trigger the signed release build, run:");
    console.log(`\n    git push --follow-tags origin ${DEFAULT_BRANCH}\n`);
  }
}

main();
