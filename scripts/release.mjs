#!/usr/bin/env node
// Version-bump helper for hackbox-to-keyboard releases.
//
// Releases are AUTOMATIC: every merge to `main` runs
// .github/workflows/release.yml, which invokes this script as
//
//   node scripts/release.mjs auto --ci
//
// to derive the bump from the conventional-commit messages since the last
// release tag, write the new version to the four sites that MUST stay in
// lockstep, commit `chore: release vX.Y.Z [skip ci]`, and tag `vX.Y.Z`. The
// workflow then pushes and builds/signs/publishes in the same run. See
// AGENTS.md / README.md for the full story.
//
// This is the single source of truth for the version bump. It also keeps a
// MANUAL entrypoint (`npm run release <patch|minor|major|X.Y.Z>`) for local
// experimentation, but the manual command is NOT the way releases are cut.
//
// The four version sites:
//   1. package.json              -> "version"
//   2. src-tauri/tauri.conf.json -> "version"
//   3. src-tauri/Cargo.toml      -> [package] version
//   4. src-tauri/Cargo.lock      -> the hackbox-to-keyboard package entry
//
// Conventional-commit bump rules (every merge still releases at least a patch):
//   - breaking (`feat!:`/`fix!:`/... or a `BREAKING CHANGE:` footer) -> major
//   - `feat:`                                                        -> minor
//   - anything else (`fix:`, `chore:`, `docs:`, no prefix, ...)      -> patch
//
// Dependency-free: Node stdlib + git/cargo CLIs only.

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
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
      "Usage: node scripts/release.mjs <auto|patch|minor|major|X.Y.Z> [--ci]",
      "       npm run release <patch|minor|major|X.Y.Z>   (manual; not the release path)",
      "",
      "  auto                derive the bump from conventional commits since the last vX.Y.Z tag",
      "  patch|minor|major   bump the current version by that semver part",
      "  X.Y.Z               set an explicit version (must be > current)",
      "  --ci                CI mode: tag the commit `[skip ci]` (loop guard) and skip the",
      "                      branch-name guard; the workflow does the push/build/publish",
      "",
      "Writes the new version to package.json, src-tauri/tauri.conf.json,",
      "src-tauri/Cargo.toml and src-tauri/Cargo.lock, cross-checks they agree,",
      "commits `chore: release vX.Y.Z`, and creates the annotated `vX.Y.Z` tag.",
      "Releases are normally cut automatically on merge to `" + DEFAULT_BRANCH + "` — see README.md.",
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

function gitMaybe(args) {
  // Run a git command that is allowed to fail (returns null instead of throwing).
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
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

function bumpBy(current, level) {
  const [maj, min, pat] = current;
  switch (level) {
    case "patch":
      return [maj, min, pat + 1];
    case "minor":
      return [maj, min + 1, 0];
    case "major":
      return [maj + 1, 0, 0];
    default:
      return null;
  }
}

function computeNext(current, arg) {
  const byLevel = bumpBy(current, arg);
  if (byLevel) return byLevel;
  const explicit = parseSemver(arg);
  if (!explicit) usage(`invalid bump or version: "${arg}"`);
  return explicit;
}

// --- Conventional-commit bump derivation -------------------------------------

function lastReleaseTag() {
  // The most recent vX.Y.Z tag reachable from HEAD, or null if there are none.
  return gitMaybe(["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*"]);
}

function commitsSince(tag) {
  // Full message body of each NON-MERGE commit introduced since `tag` (or all of
  // history when `tag` is null). History is merge commits, not squash, so the
  // real change commits are the non-merge ones — those carry the conventional
  // prefixes. Records are separated by an ASCII record-separator (0x1e).
  const range = tag ? `${tag}..HEAD` : "HEAD";
  const out = execFileSync("git", ["log", range, "--no-merges", "--format=%B%x1e"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return out
    .split("\x1e")
    .map((s) => s.replace(/^\n+/, "").trimEnd())
    .filter(Boolean);
}

function deriveBumpLevel(commits) {
  // Reconcile to the largest bump any commit implies; never a no-op (>= patch).
  let level = "patch";
  for (const body of commits) {
    const subject = body.split("\n", 1)[0];
    // `type!:` / `type(scope)!:` subject, or a `BREAKING CHANGE:` footer.
    if (/^[a-zA-Z]+(\([^)]*\))?!:/.test(subject) || /^BREAKING[ -]CHANGE:/m.test(body)) {
      return "major";
    }
    if (/^feat(\([^)]*\))?:/.test(subject)) {
      level = "minor";
    }
  }
  return level;
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

function tryCargoUpdate(extraArgs) {
  try {
    execFileSync("cargo", ["update", "-p", CRATE, "--precise", ...extraArgs], {
      cwd: SRC_TAURI,
      stdio: "inherit",
    });
    return true;
  } catch {
    return false;
  }
}

function bumpCargoLock(newVersion) {
  // Preferred: let cargo rewrite the lockfile entry so it stays internally
  // consistent. `--precise` on the local package only touches its own entry.
  // Try offline first (fast, works locally where the registry cache exists),
  // then online (a fresh CI checkout has no cache), then fall back to a
  // targeted text edit. Changing only the root package's own version line keeps
  // the lockfile valid because nothing else references it by version.
  if (tryCargoUpdate([newVersion, "--offline"]) || tryCargoUpdate([newVersion])) {
    return;
  }
  console.error("warning: `cargo update` unavailable/failed; editing the Cargo.lock entry directly");

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
  const ci = argv.includes("--ci");
  const push = argv.includes("--push");
  const positional = argv.filter((a) => !a.startsWith("--"));
  if (positional.length !== 1) usage(positional.length === 0 ? null : "expected exactly one bump argument");

  // Guard rail 1: clean working tree.
  if (git(["status", "--porcelain"])) {
    die("working tree is not clean; commit or stash changes before releasing");
  }

  // Guard rail 2: on the default branch. CI controls the checked-out ref
  // (release.yml checks out `main`), so the branch-name guard is skipped there.
  if (!ci) {
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch !== DEFAULT_BRANCH) {
      die(`releases must be cut from \`${DEFAULT_BRANCH}\` (currently on \`${branch}\`)`);
    }
  }

  const currentStr = readPkgVersion();
  const current = parseSemver(currentStr);
  if (!current) die(`current package.json version is not semver: "${currentStr}"`);

  // Resolve the bump argument. `auto` derives it from conventional commits.
  let bumpArg = positional[0];
  if (bumpArg === "auto") {
    const lastTag = lastReleaseTag();
    const commits = commitsSince(lastTag);
    const level = deriveBumpLevel(commits);
    console.log(
      `auto: ${level} bump from ${commits.length} commit(s) since ${lastTag ?? "the start of history"}`,
    );
    bumpArg = level;
  }

  // Compute the new version and reject anything non-increasing.
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

  // Commit + annotated tag. In CI the commit message carries `[skip ci]` so the
  // push back to `main` does not re-trigger the release workflow (loop guard).
  git(["add", "package.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock"]);
  git(["commit", "-m", `chore: release ${tag}${ci ? " [skip ci]" : ""}`]);
  git(["tag", "-a", tag, "-m", `Release ${tag}`]);
  console.log(`Committed and tagged ${tag}.`);

  // Expose the result to the workflow (release.yml reads these step outputs).
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${newVersion}\ntag=${tag}\n`);
  }

  if (push) {
    git(["push", "--follow-tags", "origin", DEFAULT_BRANCH], { stdio: "inherit" });
    console.log(`Pushed ${DEFAULT_BRANCH} and ${tag}.`);
  } else if (!ci) {
    console.log("\nNothing has been pushed (manual run). Releases are cut automatically on merge to");
    console.log(`\`${DEFAULT_BRANCH}\`; this manual entrypoint is for local experimentation only.\n`);
  }
}

main();
