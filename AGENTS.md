# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Releasing

**Releases are fully automatic on merge to `main` — never cut one by hand, run a
release command, or push a tag.** Every merge to `main` runs
`.github/workflows/release.yml`, which in a single run derives the bump, updates
the four version sites, commits + tags `vX.Y.Z`, pushes back, and then builds,
signs/notarizes, and publishes the macOS universal + Windows installers.

**Bump size comes from conventional commits** since the last `vX.Y.Z` tag
(scanning non-merge commits — history is merge commits, not squash):

- breaking (`feat!:` / `fix!:` / a `BREAKING CHANGE:` footer) → **major**
- `feat:` → **minor**
- anything else (`fix:`, `chore:`, `docs:`, no prefix, …) → **patch**
- never a no-op: every merge releases at least a patch.

`scripts/release.mjs` (dependency-free Node ESM) is the single source of truth
for the bump. CI calls `node scripts/release.mjs auto --ci`; locally it also
takes explicit args (`node scripts/release.mjs <auto|patch|minor|major|X.Y.Z>`),
but the manual entrypoint is for experimentation only — it is **not** how
releases are cut. It updates **four** sites that MUST stay in lockstep and
cross-checks they agree before committing:

1. `package.json` → `"version"`
2. `src-tauri/tauri.conf.json` → `"version"`
3. `src-tauri/Cargo.toml` → `[package]` `version`
4. `src-tauri/Cargo.lock` → the `name = "hackbox-to-keyboard"` entry's `version`
   (updated via `cargo update -p hackbox-to-keyboard --precise <ver>` — tries
   `--offline` then online, falling back to a targeted edit of only that entry;
   never hand-edit other entries)

**Loop guard (the critical correctness property):** the bump commit is
`chore: release vX.Y.Z [skip ci]`. `[skip ci]` makes GitHub skip the workflow
run the push-back to `main` would otherwise trigger. A second layer — the
`prepare` job's `if:` — also refuses any commit whose message starts with
`chore: release v`. So the release never loops.

**One consolidated workflow, not a tag trigger:** a tag pushed with the default
`GITHUB_TOKEN` does NOT start a separate `on: push: tags` workflow, so the bump,
tag, build, and publish all live in the one push-to-`main` run.

Other notes: releases auto-publish (`releaseDraft: false`), so an in-app update
ships to all clients as soon as a merge's build finishes. The bot push to `main`
uses `GITHUB_TOKEN`; if `main` is branch-protected against direct pushes, the bot
needs a bypass (no PAT otherwise required). Never hand-edit the four sites.
