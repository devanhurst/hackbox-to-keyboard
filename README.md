# Hackbox → Keyboard

A desktop [Tauri](https://tauri.app) app that joins a Hackbox room **as the host**,
shows each connected player a single button, and casts that button press to an
**OS-level keypress** on the host machine — so player taps can drive any game or
app, not just the browser.

This is the cross-platform answer to the Windows-only Unity version: the web UI
lives in a WebView, and key injection is done in Rust via
[`enigo`](https://github.com/enigo-rs/enigo).

## How it works

1. The app generates and persists a stable `hostId` (UUID).
2. On connect it creates (or reuses) a room via `POST /api/rooms`, then opens a
   raw WebSocket to the relay at `wss://<host>/r/<CODE>?userId=<hostId>` using
   [`partysocket`](https://www.npmjs.com/package/partysocket). The relay treats
   any connection whose `userId` equals the room's `hostId` as the host, so this
   app *is* the host. Frames are JSON envelopes `{ type, payload }`.
3. It pushes a single full-screen `Button` view to every player who joins.
4. When a player taps, the relay forwards a `msg` frame. The app looks up that
   player's key binding and calls the `press_key` Rust command, which uses
   `enigo` to tap the key system-wide. It then re-pushes the button to re-arm it.

Hackbox migrated from socket.io to a Cloudflare relay (a Durable Object speaking
raw WebSocket); the connector in [`src/hackboxSocket.ts`](src/hackboxSocket.ts)
is ported from the hackbox client SDK and re-exposes a small `on`/`emit` surface
over that envelope protocol, plus a `"ping"`/`"pong"` keepalive.

Bindings (player → key) are stored in `localStorage`, keyed by `KeyboardEvent.code`
(physical key), so layouts and game scancode reads behave predictably.

## Develop

```bash
npm install
npm run tauri dev
```

Point the **Server URL** field at your Hackbox deployment's apex (defaults to
`https://hackbox.ca`). The app derives the HTTP API (`<origin>/api`) and the
realtime relay (`wss://<host>/r/<code>`) from it, so a single field works when
both are path-routed on one host in production. (Local dev splits them across
ports — api on `:8787`, relay on `:1999` — so point at whichever you're testing
or front them with one origin.) Click **Connect**, and share the room code. Players
join with the normal Hackbox client. For each player, click **Set key** and press
the key — or modifier combo (e.g. Shift+J, Ctrl+Cmd+Space) — you want their button
mapped to. Hold the modifiers and press the main key; Esc cancels capture.

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

**Sign it.** macOS ties the Accessibility permission to the app's code
signature. An unsigned/ad-hoc build gets a new identity on every rebuild, so the
OS forgets the grant and key injection silently stops until you re-add it. A
stable Developer ID signature makes the grant persist. With an Apple Developer
account, set `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`,
`APPLE_TEAM_ID` (plus `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` in CI)
and `tauri build` signs + notarizes.

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
