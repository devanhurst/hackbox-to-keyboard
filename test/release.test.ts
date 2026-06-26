import { test } from "node:test";
import assert from "node:assert/strict";
// release.mjs guards its main() behind a direct-invocation check, so importing
// it here has no side effects and exposes the pure bump derivation.
import { deriveBumpLevel } from "../scripts/release.mjs";

test("feat -> minor", () => {
  assert.equal(deriveBumpLevel(["feat: add modifier bindings"]), "minor");
  assert.equal(deriveBumpLevel(["feat(ui): scoped feat"]), "minor");
});

test("fix and perf -> patch", () => {
  assert.equal(deriveBumpLevel(["fix: correct press path"]), "patch");
  assert.equal(deriveBumpLevel(["perf: debounce taps"]), "patch");
  assert.equal(deriveBumpLevel(["fix(rust): scoped fix"]), "patch");
});

test("breaking -> major (bang subject or BREAKING CHANGE footer)", () => {
  assert.equal(deriveBumpLevel(["feat!: drop legacy bindings"]), "major");
  assert.equal(deriveBumpLevel(["fix(api)!: rename field"]), "major");
  assert.equal(
    deriveBumpLevel(["feat: thing\n\nBREAKING CHANGE: removes X"]),
    "major",
  );
});

test("non-releasable types -> null (no release)", () => {
  assert.equal(deriveBumpLevel(["chore: tidy"]), null);
  assert.equal(deriveBumpLevel(["docs: readme"]), null);
  assert.equal(deriveBumpLevel(["ci: add workflow"]), null);
  assert.equal(deriveBumpLevel(["refactor: rename"]), null);
  assert.equal(deriveBumpLevel(["just a message with no prefix"]), null);
  assert.equal(deriveBumpLevel([]), null);
});

test("reconciles to the largest bump across all commits since the tag", () => {
  // chore alongside a feat still releases (minor) — the chore doesn't suppress it.
  assert.equal(deriveBumpLevel(["chore: tidy", "feat: add"]), "minor");
  // fix + feat -> minor (the larger)
  assert.equal(deriveBumpLevel(["fix: a", "feat: b"]), "minor");
  // breaking wins regardless of order
  assert.equal(deriveBumpLevel(["feat: a", "fix!: b", "chore: c"]), "major");
  // perf + fix -> patch (both patch)
  assert.equal(deriveBumpLevel(["perf: a", "fix: b"]), "patch");
});
