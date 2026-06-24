# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Releasing

Cut a release with one command (run on a clean `main`):

```bash
npm run release <patch|minor|major|X.Y.Z>   # add `-- --push` to push immediately
```

`scripts/release.mjs` (dependency-free Node ESM) bumps the version, commits
`chore: release vX.Y.Z`, and creates an annotated `vX.Y.Z` tag. It does **not**
push unless `-- --push` is given — pushing the tag is what triggers
`.github/workflows/release.yml` (signed macOS universal + Windows build). After
it runs, push with `git push --follow-tags origin main`.

The version lives in **four** sites that MUST stay in lockstep; the script
updates all four and cross-checks they agree before committing:

1. `package.json` → `"version"`
2. `src-tauri/tauri.conf.json` → `"version"`
3. `src-tauri/Cargo.toml` → `[package]` `version`
4. `src-tauri/Cargo.lock` → the `name = "hackbox-to-keyboard"` entry's `version`
   (updated via `cargo update -p hackbox-to-keyboard --precise <ver> --offline`
   so the lockfile stays valid; never hand-edit other entries)

Guard rails: refuses a dirty tree, a non-`main` branch, or a non-increasing
version. Never hand-edit the four sites individually.
