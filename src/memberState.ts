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

// What an unassigned player sees: a blank screen (just their header). Players
// get this until the host assigns them a layout.
export function emptyState(headerText: string) {
  return {
    ui: {
      header: { text: headerText },
      main: {
        align: "center" as const,
        components: [] as unknown[],
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
      keys: [] as string[],
      style: {
        width: "100%",
        height,
        fontSize: size,
        fontFamily: "Fredoka One",
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
