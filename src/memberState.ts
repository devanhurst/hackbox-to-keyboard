// The member state we push to each player: the host's active layout rendered as
// a vertical stack of buttons.
//
// Shape mirrors what the hackbox client renders (state.ui.main.components) and
// what the server's sanitizeState expects. Each Button component emits a `msg`
// event named by `props.event` when tapped — we set that to the button's id so
// the host can map the tap back to a key. The hackbox PlayerView lays the main
// area out as a single flex column (max-width ~350px), so buttons stack
// vertically; we size them to share the screen based on how many there are.
//
// The server merges this over a dark default theme (helpers.emptyMemberState),
// so we only need to specify what differs.
import type { Layout } from "./layouts";

function buttonHeight(count: number): string {
  if (count <= 1) return "70vh";
  // Leave room for the header + margins; clamp so taps stay comfortable.
  return `${Math.max(10, Math.floor(80 / count))}vh`;
}

function fontSize(count: number): string {
  if (count <= 2) return "3rem";
  if (count <= 4) return "2rem";
  return "1.4rem";
}

// What an unassigned player sees: a centered "waiting" message. Players get
// this until the host assigns them a layout. The `Text` component + prop shape
// mirror the relay's own holding screen (defaultMemberState in
// relay/src/roomState.ts), so it's a known-valid component the client renders.
export function emptyState(headerText: string) {
  return {
    ui: {
      header: { text: headerText },
      main: {
        align: "center" as const,
        components: [
          {
            type: "Text",
            props: {
              text: "Waiting for host…",
              style: {
                align: "center",
                border: "none",
                color: "#EEE",
                background: "transparent",
                fontSize: "1.5rem",
                fontFamily: "Fredoka One",
              },
            },
          },
        ],
      },
    },
  };
}

export function layoutState(headerText: string, layout: Layout) {
  const count = layout.buttons.length;
  const height = buttonHeight(count);
  const size = fontSize(count);

  const components = layout.buttons.map((b) => ({
    type: "Button",
    props: {
      event: b.id,
      value: b.id,
      label: b.label,
      // Repeatable: the button never disables after a press, so taps map to
      // keypresses again and again without the host re-pushing to re-arm it.
      persistent: true,
      // Key(s) the player can press on their own device to fire this button.
      keys: b.playerKey ? [b.playerKey] : ([] as string[]),
      style: {
        width: "100%",
        height,
        fontSize: size,
        // The hackbox client auto-loads any `fontFamily` it finds in the pushed
        // state from Google Fonts (see processFonts in client stateHelpers), so
        // naming the family here is enough — "Open Sans" reads better than the
        // display face used elsewhere.
        fontFamily: "Open Sans",
        background: b.color,
        color: "#fff",
        border: "none",
        borderRadius: "1rem",
      },
    },
  }));

  return {
    ui: {
      header: { text: headerText },
      main: {
        align: "center" as const,
        components,
      },
    },
  };
}
