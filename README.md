# Hackbox → Keyboard

A desktop [Tauri](https://tauri.app) app that joins a Hackbox room **as the host**,
shows each connected player a **custom layout of buttons**, and casts each button
press to an **OS-level keypress** on the host machine — so player taps can drive
any game or app, not just the browser.

Build layouts with any number of buttons — each with its own label, colour, and
key — and **assign a layout per player**. Players start with a blank screen until
the host gives them one, and different players can be on different layouts. For a
game like "Duel" you might make two six-button layouts ("Duel P1" / "Duel P2",
each with four answers, accelerate, lock-in) whose keys differ, and assign one to
each player. A layout's keys are its **defaults**; any player's button can also be
**overridden** individually. Buttons can also be wired to a key on the player's
*own* keyboard (e.g. Space for a buzzer) so they don't have to tap. Save as many
layouts as you like and **export/import** them as JSON to share with friends.

This is the cross-platform answer to the Windows-only Unity version: the web UI
lives in a WebView, and key injection is done in Rust via
[`enigo`](https://github.com/enigo-rs/enigo).

## How it works

1. The app generates and persists a stable `hostId` (UUID).
2. On launch it immediately creates a fresh room via `POST /api/rooms`
   against the fixed Hackbox host (`https://hackbox.ca`) — a new code every time
   the app opens, never reused — then opens a raw
   WebSocket to the relay at `wss://<host>/r/<CODE>?userId=<hostId>` using
   [`partysocket`](https://www.npmjs.com/package/partysocket). The relay treats
   any connection whose `userId` equals the room's `hostId` as the host, so this
   app *is* the host. Frames are JSON envelopes `{ type, payload }`.
3. When a player first joins the room it pushes a blank screen (any assignment
   from a previous room is cleared on join); once the host assigns a layout it
   pushes that layout rendered as a stack of `Button` components (one per
   button). Each button's `event` is its stable id, so the host can map a tap
   back to the right key. (The hackbox player view renders the main area as a
   single column, so buttons stack vertically and are auto-sized to share the
   screen.)
4. When a player taps, the relay forwards a `msg` frame carrying the button's id.
   The app resolves the binding for that player+button (the per-player override
   if set, otherwise the button's default) and — if forwarding is allowed (see
   below) — calls the `press_key` Rust command, which uses `enigo` to tap the key
   system-wide. The binding is resolved from current config on every tap, so
   editing a button's default or a per-player override takes effect immediately;
   buttons are pushed `persistent`, so they stay armed for repeated taps without
   a re-push.

Keypress forwarding is gated by two switches. A **master switch** in the app bar
arms or pauses *all* forwarding; it starts **live** on launch and every new room,
and the host can pause it at any time to stop players driving the machine before
they're ready. Each player card also has its own **per-player switch** (on by
default) to mute one player individually. A tap only injects a key when the
master switch is live *and* that player isn't muted. While paused or muted, the
press is ignored but
the host still sees the button/player flash, so they can watch who's connected
and pressing without it touching their machine. The master state is in-memory
only (never persisted); per-player switches are saved with the rest of the
player config.

Hackbox migrated from socket.io to a Cloudflare relay (a Durable Object speaking
raw WebSocket); the connector in [`src/hackboxSocket.ts`](src/hackboxSocket.ts)
is ported from the hackbox client SDK and re-exposes a small `on`/`emit` surface
over that envelope protocol, plus a `"ping"`/`"pong"` keepalive.

Layouts and per-player config are stored in `localStorage`. Bindings are keyed by
`KeyboardEvent.code` (physical key), so layouts and game scancode reads behave
predictably. The data model lives in [`src/layouts.ts`](src/layouts.ts):

- **Layouts** — a named list of buttons (`{ id, name, buttons }`). Each button has
  a `label`, `color`, an optional **default** `binding` (the host key), and an
  optional `playerKey` (a `KeyboardEvent.key` the player can press on their own
  device, sent through as the hackbox Button's `keys` prop). Layouts are purely
  reusable templates; assigning one to a player is a separate step.
- **Per-player config** — `userId → { layoutId, overrides }`. `layoutId` is the
  layout assigned to that player (`null` = blank screen); `overrides` is
  `buttonId → binding`, layered over each button's default. A layout assignment
  is *room-scoped*: every player **starts blank when they join a room** (an
  assignment from a previous room/session never carries over), and a mid-session
  reconnect keeps whatever the host assigned. `overrides` persist by userId, so a
  player's per-button key tweaks survive across rooms.
- **Export/import** — `exportLayout`/`importLayout` (de)serialize a layout as
  JSON (`{ type: "hackbox-keyboard-layout", version, layout }`), keys included.
  Per-player config is *not* exported — it's tied to specific userIds on this
  machine.

## Develop

```bash
npm install
npm run tauri dev
```

On launch the app creates a room against `https://hackbox.ca` automatically and
shows the room code — no configuration. Share that code; players join with the
normal Hackbox client.

Run the unit tests with `npm test` — Node's built-in runner over `test/*.test.ts`,
which guards the press path ([`src/resolvePress.ts`](src/resolvePress.ts)). They
strip TypeScript natively, so they need **Node ≥ 24** (the `engines` floor in
`package.json`).

The UI has two screens: the **Players** home (room code + the roster) and a
**Layouts** manager reached via **Manage layouts →**.

**Manage layouts.** The Layouts screen lists every layout with a button count.
**+ New layout** creates one (and opens the editor); **Import** brings in a
shared layout. Each row has **Edit** and **Delete**, and a **⠿** drag handle to
reorder — the order here is the order players see in their layout dropdown.

**Edit a layout.** In the editor, set the name and add buttons with **+ Add
button**. Each button has a label, colour, and two keys:

- **Player presses** — an optional key the player can hit on their *own*
  keyboard to fire the button instead of tapping (e.g. Space for a buzzer).
  Shared by everyone on the layout; leave it as "Tap only" to disable.
- **Sends (default)** — the key pressed on *this* computer when the button
  fires, unless a player overrides it.

**Duplicate** clones the layout (fresh button ids) — the quick way to build a
variant like "Duel P2" from "Duel P1".

**Assign per player.** Under **Players**, each player has a **layout dropdown**.
New players start on **No layout** (a blank screen) until you pick one — and you
can give different players different layouts.

**Set keys.** Click a key field and press the key — or modifier combo (e.g.
Shift+J, Ctrl+Cmd+Space). Hold the modifiers and press the main key; Esc cancels
capture. To bind a **modifier on its own** (e.g. Left Shift, Right Ctrl, Left
Cmd), tap that modifier by itself — left and right are kept distinct. The Default
key fields live in the layout editor; under each assigned
player every button shows its effective key — click one to set a **per-player
override** (shown highlighted) and use **↺** to revert it to the layout default.

**Share.** In the editor, **Export** copies the layout's JSON to the clipboard
and downloads a `.hackboxkb.json` file; **Import** (on the Layouts screen) takes
that file.

The host is hardcoded ([`SERVER_URL` in `src/main.ts`](src/main.ts)); change it
there to point at a local backend (api on `:8787`, relay on `:1999`) for dev.

## Build / package

Tauri bundles natively — there's no practical cross-compile, so each OS is built
on that OS (or in CI).

### macOS

```bash
npm run tauri build                                  # Apple Silicon only
# universal (Intel + Apple Silicon):
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run tauri build -- --target universal-apple-darwin
```

Installers land in `src-tauri/target/release/bundle/` (`.app` and `.dmg`).

> If `bundle_dmg.sh` fails locally ("error running bundle_dmg.sh"), it's the
> AppleScript step that styles the DMG window — it needs an interactive Finder
> session. Prefix the build with `CI=true` to skip the styling and still get a
> working DMG: `CI=true npm run tauri build`. (CI runners set this already.)

**Sign it (free, self-signed).** macOS ties the Accessibility permission to the
app's code signature (its *designated requirement*). An unsigned/ad-hoc build
gets a new identity on every rebuild, so the OS forgets the grant and key
injection silently stops until you re-add it. Signing with a **self-signed**
code-signing cert gives a stable identity — no Apple Developer account needed —
so the grant persists. It does **not** remove the Gatekeeper "unidentified
developer" warning on *downloaded* builds (only Apple notarization, which needs
the paid account, does that); locally-built apps run without that warning.

1. Create the cert: Keychain Access → **Certificate Assistant → Create a
   Certificate…** → name `Hackbox to Keyboard (Self-Signed)`, Identity Type
   **Self-Signed Root**, Certificate Type **Code Signing**.
2. Build signed (env var keeps the identity out of the committed config):
   ```bash
   APPLE_SIGNING_IDENTITY="Hackbox to Keyboard (Self-Signed)" CI=true npm run tauri build
   ```
3. Grant Accessibility once (remove any stale entry first). Rebuilds with the
   same cert keep the grant.

#### Signing + notarization in CI

CI signs macOS builds with an Apple **Developer ID Application** certificate and
notarizes them. This removes the Gatekeeper "unidentified developer" warning and
gives a stable code signature, so the Accessibility key-injection grant survives
auto-updates (the grant follows the signing identity). It requires a paid Apple
Developer account.

**1. Create the certificate.** In Keychain Access → **Certificate Assistant →
Request a Certificate from a Certificate Authority** to generate a CSR (save to
disk). At [developer.apple.com → Certificates](https://developer.apple.com/account/resources/certificates/list)
→ **+** → **Developer ID Application**, upload the CSR, download the `.cer`, and
double-click it to install into your login keychain.

**2. Export it as `.p12`.** In Keychain Access, find the "Developer ID
Application: …" cert, expand it to confirm the **private key** is attached,
right-click → **Export** → `.p12`, and set an export password.

**3. Make an app-specific password** for notarization at
[appleid.apple.com](https://appleid.apple.com) → **Sign-In and Security →
App-Specific Passwords**.

**4. Find your Team ID** at [developer.apple.com → Membership](https://developer.apple.com/account)
(also the value in parentheses in the signing identity name).

**5. Set the secrets** (these must exist *before* the first merge that cuts a release):

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | base64 of the exported `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` export password |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Your Name (TEAMID)` |
| `KEYCHAIN_PASSWORD` | any random string (for CI's temp keychain) |
| `APPLE_ID` | your Apple ID email |
| `APPLE_PASSWORD` | the app-specific password from step 3 |
| `APPLE_TEAM_ID` | your 10-char Team ID |

```bash
base64 -i cert.p12 | gh secret set APPLE_CERTIFICATE
printf '%s' 'YOUR_P12_PASSWORD'   | gh secret set APPLE_CERTIFICATE_PASSWORD
gh secret set APPLE_SIGNING_IDENTITY -b "Developer ID Application: Your Name (TEAMID)"
gh secret set KEYCHAIN_PASSWORD -b "$(openssl rand -base64 24)"
gh secret set APPLE_ID -b "you@example.com"
printf '%s' 'xxxx-xxxx-xxxx-xxxx' | gh secret set APPLE_PASSWORD
gh secret set APPLE_TEAM_ID -b "TEAMID1234"
rm cert.p12
```

> The `APPLE_*` env lines are wired up in `.github/workflows/release.yml`. Set
> every secret above **before the first merge that cuts a release** (see
> [Releasing](#releasing-automatic-on-merge-to-main)): `tauri-action` runs
> `security import` whenever `APPLE_CERTIFICATE` is defined, and an empty/unset
> value fails the whole build.

### Windows

Build on a Windows machine (Rust MSVC toolchain + VS C++ Build Tools; WebView2
ships with Win10/11):

```bash
npm install
npm run tauri build      # produces .msi (WiX) and .exe (NSIS) in bundle/
```

Windows needs no special permission for key injection. SmartScreen warns on an
unsigned `.exe`; an OV/EV code-signing cert removes that.

### Releasing (automatic on merge to `main`)

**You never cut a release by hand — there is no command to run and no tag to
push.** Every merge to `main` ships a release. `.github/workflows/release.yml`
does the whole thing in one run: it derives the version bump, updates the four
version sites, commits and tags `vX.Y.Z`, then builds, signs/notarizes, and
publishes the macOS (universal) + Windows installers as a GitHub release.

**Your commit messages control the bump.** The workflow scans the
[conventional-commit](https://www.conventionalcommits.org) prefixes of the
commits merged since the last release tag:

| Commit(s) since last release | Release bump |
| --- | --- |
| a breaking change — `feat!:` / `fix!:` / a `BREAKING CHANGE:` footer | **major** |
| a `feat:` | **minor** |
| anything else (`fix:`, `chore:`, `docs:`, no prefix, …) | **patch** |

Every merge releases *something*: with no `feat:`/breaking commit you still get a
patch. So just merge to `main`; pick your prefixes to get the bump you want.

`scripts/release.mjs` is the single source of truth for the bump. CI invokes it
as `node scripts/release.mjs auto --ci`; it computes the new version, writes it
to **all four** lockstep sites — `package.json`, `src-tauri/tauri.conf.json`,
`src-tauri/Cargo.toml`, and the `hackbox-to-keyboard` entry in
`src-tauri/Cargo.lock` — cross-checks they agree, and commits
`chore: release vX.Y.Z [skip ci]`. The `[skip ci]` marker is the **loop guard**:
it stops the bump commit (pushed back to `main`) from triggering another release.

> The script keeps a manual entrypoint (`npm run release <patch|minor|major|X.Y.Z>`)
> for local experimentation, but it is **not** how releases are cut — merging to
> `main` is. A bump commit pushed by hand is ignored by the workflow (its message
> starts with `chore: release v`), so it will not build.

> **Setup note:** the bump commit is pushed to `main` by `github-actions[bot]`
> using the built-in `GITHUB_TOKEN`. If `main` has branch protection that blocks
> direct pushes, allow this bot to bypass it (or the push step fails). No extra
> PAT secret is required for the token-free flow used here.

To regenerate the platform icon set from a source image:

```bash
npm run tauri icon path/to/source.png
```

## Auto-updates

The app updates itself in place — users don't re-download from the releases
page. On launch it checks a signed `latest.json` manifest published with each
GitHub release (`tauri-plugin-updater`); if a newer build exists it prompts,
then downloads, verifies, installs, and relaunches. Updates are signed with a
private key the app refuses to install anything else, so the release host can't
push a malicious build.

### One-time setup

1. **Generate the signing keypair** (keep the private key secret — it never goes
   in the repo):

   ```bash
   npm run tauri signer generate -- -w ~/.tauri/hackbox.key
   ```

   This writes `~/.tauri/hackbox.key` (private) and `~/.tauri/hackbox.key.pub`
   (public), and prints both.

2. **Add the public key to config.** Paste the contents of
   `~/.tauri/hackbox.key.pub` into `plugins.updater.pubkey` in
   `src-tauri/tauri.conf.json` (replacing the `REPLACE_WITH_…` placeholder), and
   commit it. The `endpoints` there already point at this repo's
   `releases/latest/download/latest.json`.

3. **Add the private key as CI secrets** so `tauri-action` can sign updates and
   generate `latest.json`:

   ```bash
   gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/hackbox.key
   # The password you set during `signer generate` (empty string if none):
   printf '%s' 'YOUR_KEY_PASSWORD' | gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD
   ```

After that, every release produces signed update artifacts plus a `latest.json`
manifest. The endpoint resolves to the latest **published**, non-prerelease
release. Because releases now **publish automatically** on merge to `main`
(`releaseDraft: false` in `release.yml`), an in-app update goes out to all users
as soon as a merge's build finishes — there is no manual "publish the draft"
gate. Keep that in mind: merging to `main` ships to every installed client.

> The pubkey in config and the private key in CI must be from the same keypair.
> If you ever rotate the key, shipped clients trust only the **old** key, so push
> one release signed with the old key that bumps to the new pubkey before
> switching — otherwise existing installs can't accept the update.

## Platform notes (key injection)

- **Windows** — works unprivileged.
- **macOS** — the app must be granted **Accessibility** permission
  (System Settings → Privacy & Security → Accessibility) before key injection
  works. You'll be prompted on first use.
- **Linux** — works under X11. **Wayland blocks synthetic input**; you may need
  an `enigo` backend with `libei`/XTest support, or run under X11.
