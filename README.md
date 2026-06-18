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
**overridden** individually. Save as many layouts as you like and
**export/import** them as JSON to share with friends.

This is the cross-platform answer to the Windows-only Unity version: the web UI
lives in a WebView, and key injection is done in Rust via
[`enigo`](https://github.com/enigo-rs/enigo).

## How it works

1. The app generates and persists a stable `hostId` (UUID).
2. On launch it immediately creates (or reuses) a room via `POST /api/rooms`
   against the fixed Hackbox host (`https://hackbox.ca`), then opens a raw
   WebSocket to the relay at `wss://<host>/r/<CODE>?userId=<hostId>` using
   [`partysocket`](https://www.npmjs.com/package/partysocket). The relay treats
   any connection whose `userId` equals the room's `hostId` as the host, so this
   app *is* the host. Frames are JSON envelopes `{ type, payload }`.
3. When a player joins it pushes their saved state: the layout assigned to that
   userId rendered as a stack of `Button` components (one per button), or a blank
   screen if they have none. Each button's `event` is its stable id, so the host
   can map a tap back to the right key. (The hackbox player view renders the main
   area as a single column, so buttons stack vertically and are auto-sized to
   share the screen.)
4. When a player taps, the relay forwards a `msg` frame carrying the button's id.
   The app resolves the binding for that player+button (the per-player override
   if set, otherwise the button's default) and calls the `press_key` Rust
   command, which uses `enigo` to tap the key system-wide. It then re-pushes the
   layout to re-arm the buttons.

Hackbox migrated from socket.io to a Cloudflare relay (a Durable Object speaking
raw WebSocket); the connector in [`src/hackboxSocket.ts`](src/hackboxSocket.ts)
is ported from the hackbox client SDK and re-exposes a small `on`/`emit` surface
over that envelope protocol, plus a `"ping"`/`"pong"` keepalive.

Layouts and per-player config are stored in `localStorage`. Bindings are keyed by
`KeyboardEvent.code` (physical key), so layouts and game scancode reads behave
predictably. The data model lives in [`src/layouts.ts`](src/layouts.ts):

- **Layouts** — a named list of buttons (`{ id, name, buttons }`). Each button has
  a `label`, `color`, and an optional **default** `binding`. Layouts are purely
  reusable templates; assigning one to a player is a separate step.
- **Per-player config** — `userId → { layoutId, overrides }`. `layoutId` is the
  layout assigned to that player (`null` = blank screen); `overrides` is
  `buttonId → binding`, layered over each button's default. Config persists by
  userId, so a returning player keeps their assignment.
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

The UI has two screens: the **Players** home (room code + the roster) and a
**Layouts** manager reached via **Manage layouts →**.

**Manage layouts.** The Layouts screen lists every layout with a button count.
**+ New layout** creates one (and opens the editor); **Import** brings in a
shared layout. Each row has **Edit** and **Delete**, and a **⠿** drag handle to
reorder — the order here is the order players see in their layout dropdown.

**Edit a layout.** In the editor, set the name and add buttons with **+ Add
button**. For each button set its label, colour, and a **Default key** (the key
it fires unless a player overrides it). **Duplicate** clones the layout (fresh
button ids) — the quick way to build a variant like "Duel P2" from "Duel P1".

**Assign per player.** Under **Players**, each player has a **layout dropdown**.
New players start on **No layout** (a blank screen) until you pick one — and you
can give different players different layouts.

**Set keys.** Click a key field and press the key — or modifier combo (e.g.
Shift+J, Ctrl+Cmd+Space). Hold the modifiers and press the main key; Esc cancels
capture. The Default key fields live in the layout editor; under each assigned
player every button shows its effective key — click one to set a **per-player
override** (shown highlighted) and use **↺** to revert it to the layout default.

**Share.** In the editor, **Export** copies the layout's JSON to the clipboard
and downloads a `.hackboxkb.json` file; **Import** (on the Layouts screen)
accepts pasted JSON or a file.

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

#### Signing in CI

Signing is **off by default** — the workflow builds an unsigned macOS app. To
turn it on, add these repo secrets **and** uncomment the four `APPLE_*` /
`KEYCHAIN_PASSWORD` env lines in `.github/workflows/release.yml`:

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | base64 of the cert exported as `.p12` (key included) |
| `APPLE_CERTIFICATE_PASSWORD` | the password set when exporting the `.p12` |
| `APPLE_SIGNING_IDENTITY` | `Hackbox to Keyboard (Self-Signed)` |
| `KEYCHAIN_PASSWORD` | any random string (for CI's temp keychain) |

> Don't uncomment them without the secrets set: `tauri-action` tries to import
> the certificate whenever `APPLE_CERTIFICATE` is defined, and an empty value
> fails the build.

Export the cert (Keychain Access → right-click the cert → **Export** → `.p12`),
then set the secrets with the GitHub CLI:

```bash
base64 -i cert.p12 | gh secret set APPLE_CERTIFICATE
printf '%s' 'YOUR_P12_PASSWORD' | gh secret set APPLE_CERTIFICATE_PASSWORD
gh secret set APPLE_SIGNING_IDENTITY -b "Hackbox to Keyboard (Self-Signed)"
gh secret set KEYCHAIN_PASSWORD -b "$(openssl rand -base64 24)"
rm cert.p12
```

Use the **same** cert in CI as locally so a user who grants Accessibility to one
release keeps it across future releases (the grant follows the cert).

To upgrade to notarized builds later (removes the download warning), set an
Apple Developer cert plus `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID`, which
switches `tauri-action` into notarize mode.

### Windows

Build on a Windows machine (Rust MSVC toolchain + VS C++ Build Tools; WebView2
ships with Win10/11):

```bash
npm install
npm run tauri build      # produces .msi (WiX) and .exe (NSIS) in bundle/
```

Windows needs no special permission for key injection. SmartScreen warns on an
unsigned `.exe`; an OV/EV code-signing cert removes that.

### CI (both platforms)

`.github/workflows/release.yml` builds macOS (universal) + Windows installers
and attaches them to a **draft** GitHub release whenever you push a version tag:

```bash
npm version patch        # bumps package.json, creates a commit + tag
git push --follow-tags
```

Keep `src-tauri/tauri.conf.json`'s `version` in sync with `package.json`. To
regenerate the platform icon set from a source image:

```bash
npm run tauri icon path/to/source.png
```

## Platform notes (key injection)

- **Windows** — works unprivileged.
- **macOS** — the app must be granted **Accessibility** permission
  (System Settings → Privacy & Security → Accessibility) before key injection
  works. You'll be prompted on first use.
- **Linux** — works under X11. **Wayland blocks synthetic input**; you may need
  an `enigo` backend with `libei`/XTest support, or run under X11.
